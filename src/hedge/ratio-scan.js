import { auditCross } from './cross-check.js';
import { dec, out, max, profitSplit, normalizeExposure } from './math.js';
import { legalSegments, position, unit } from './ratio-domain.js';
import {
  pathMetrics,
  metricRow,
  newReport,
  includeBand,
  finishReport,
  subsetGroups,
  mergeReport,
  recoveryCushion
} from './range-report.js';
import { evaluateLeverageGrid } from './leverage.js';
import { profileInputs, validateMargin, projectSettlementEquity, pathDislocation, continuousTiers } from './solver.js';

const decimal = (v) => dec(String(v));
const lotValue = (leg) => unit(leg).times(leg.step);
const keys = [
  'legal',
  'risk',
  'protect',
  'survive',
  'both',
  'loss',
  'profit',
  'failProfit',
  'passProfit',
  'afterCreditProfit'
];
export function scanContext(book, market, params, checks) {
  return {
    book,
    market: {
      ...market,
      hl: {
        ...market.hl,
        leverage: String(market.hl.exchangeMaxLeverage),
        currentMarginCredit: market.hl.currentMarginCredit ?? '0'
      }
    },
    params,
    checks
  };
}
const gcd = (a, b) => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a || 1n;
};
// After multiplication by a positive PF lot index, each condition has the form
// a+b*i+c*j+d*i*j >= 0. Finite decimal coefficients are compared as integers.
// A strict inequality removes exactly the zero boundary.
function plane(values, strict = false) {
  const places = Math.max(...values.map((v) => decimal(v).decimalPlaces()));
  let n = values.map((v) => BigInt(decimal(v).times(decimal(10).pow(places)).toFixed(0)));
  let divisor = 0n;
  for (const x of n) if (x) divisor = divisor === 0n ? (x < 0n ? -x : x) : gcd(divisor, x);
  if (divisor > 1n) n = n.map((x) => x / divisor);
  if (strict) n[0]--;
  return n;
}
function clipRange(range, n, i) {
  if (!range) return null;
  const [lo, hi] = range,
    offset = n[0] + n[1] * i,
    slope = n[2] + n[3] * i;
  const left = offset + slope * BigInt(lo),
    right = offset + slope * BigInt(hi);
  if (left >= 0n && right >= 0n) return range;
  if (left < 0n && right < 0n) return null;
  if (left < 0n) return [lo + Number((-left + slope - 1n) / slope), hi];
  return [lo, lo + Number(left / -slope)];
}
function applyBands(band, planes, i) {
  for (const n of planes) {
    band = clipRange(band, n, i);
    if (!band) break;
  }
  return band;
}
function compact(planes, pf, hl) {
  const lo = BigInt(pf.lo),
    hi = BigInt(pf.hi),
    firstHypeLot = BigInt(hl.lo),
    lastHypeLot = BigInt(hl.hi);
  const seen = new Set(),
    result = [];
  for (const n of planes) {
    const id = n.join('/');
    if (seen.has(id)) continue;
    seen.add(id);
    const at = (i, j) => n[0] + n[1] * i + n[2] * j + n[3] * i * j;
    const corners = [at(lo, firstHypeLot), at(hi, firstHypeLot), at(lo, lastHypeLot), at(hi, lastHypeLot)];
    if (corners.every((x) => x < 0n)) return [[-1n, 0n, 0n, 0n]];
    if (!corners.every((x) => x >= 0n)) result.push(n);
  }
  return result;
}
function pfBoundary(ctx, pf, p) {
  const l = ctx.market.pf,
    h = ctx.market.hl,
    denominator = pf.slope.abs(),
    direction = pf.slope.cmp(0);
  const shifts = [p.floor, p.target].map((target) => [
    decimal(target).minus(pf.settled[0]).times(direction),
    pf.settled[1].times(-direction)
  ]);
  const valid = [],
    risk = [];
  const one = (a, b, strict = false) => plane([a, b, 0, 0], strict);
  for (const [k, [a, b]] of shifts.entries()) {
    const direction = pf.sign * (k === 0 ? -1 : 1);
    valid.push(one(a.times(direction), b.times(direction), true));
    for (const leg of [l, h])
      valid.push(one(a.times(leg.factor), denominator.times(leg.mark).plus(b.times(leg.factor)), true));
    const notional = lotValue(l),
      change = notional.times(l.factor);
    valid.push(
      one(
        denominator.times(pf.exit[0]).plus(a.times(change)),
        denominator.times(pf.exit[1]).plus(b.times(change)),
        true
      )
    );
    for (const [sa, sb] of [
      [decimal(0), decimal(0)],
      [a, b]
    ])
      for (const tier of l.tiers) {
        const x = change.times(decimal(pf.sign).minus(tier.mmr));
        risk.push(
          one(
            denominator
              .times(pf.marked[0].minus(l.otherMaintenance ?? l.hold).plus(tier.deduction))
              .plus(x.times(sa)),
            denominator.times(pf.marked[1].minus(notional.times(l.mark).times(tier.mmr))).plus(x.times(sb)),
            true
          )
        );
      }
  }
  return { denominator, shifts, valid, risk };
}
function cell(ctx, p, pfSegment, hypeSegment, common) {
  const { book, market, checks } = ctx,
    l = market.hl,
    { denominator, shifts } = common;
  const nonflat = hypeSegment.hi > 0,
    u = lotValue(l),
    factor = decimal(l.factor),
    signed = u.times(hypeSegment.sign);
  const extra = decimal(p.k),
    funding = decimal(nonflat ? (checks.stress?.fundingDebit ?? 0) : 0);
  const delay = unit(l)
    .times(l.mark)
    .times(checks.stress?.delayBps ?? 0)
    .div(10000);
  const debit = hypeSegment.absDelta.map((v, k) => v.times(delay).plus(k === 0 ? funding : 0));
  const shock = decimal(l.mark)
    .times(max(checks.adverseBps ?? 0, checks.stress?.jumpBps ?? 0))
    .div(10000)
    .times(-hypeSegment.sign);
  const zero = [decimal(0), decimal(0)];
  const shiftPx = (s, bump = 0) => [s[0].times(factor), s[1].times(factor).plus(denominator.times(bump))];
  function project(line, exposure, priceShift, threshold, strict = false) {
    return plane(
      [
        0,
        denominator.times(line[0].minus(threshold)),
        exposure.times(priceShift[0]),
        denominator.times(line[1]).plus(exposure.times(priceShift[1]))
      ],
      strict
    );
  }
  const valid = [...common.valid],
    risk = [...common.risk],
    protect = [],
    survive = [],
    failProfit = [],
    passProfit = [],
    afterCreditProfit = [],
    loss = [];
  const feesLine = hypeSegment.settled.map((v, k) => v.minus(k === 0 ? extra : 0));
  const payout = p.stage === 'funded' ? profitSplit(p.target, p.baseline, p.share).user : null;
  const threshold = decimal(p.B).minus(book.external);
  const extraBuffer = decimal(ctx.params.recoveryBuffer ?? 0);
  const buffered = [], fundedGuard = [];
  const roundFloor = payout != null && p.C_ref != null
    ? decimal(p.C_ref).plus(p.contributions).minus(p.withdrawals).plus(p.g).minus(payout).minus(book.external)
    : null;
  const costBasis =
    ctx.params.profitBasis == null ? null : decimal(ctx.params.profitBasis).minus(book.external);
  for (const k of [0, 1]) {
    for (const stressed of [false, true]) {
      const s = shiftPx(shifts[k], stressed && nonflat ? shock : 0);
      const line = feesLine.map((v, j) => (stressed ? v.minus(debit[j]) : v));
      const cash = (floor, strict = false) => project(line, hypeSegment.slope.div(factor), s, floor, strict);
      (k === 0 ? protect : survive).push(cash(k === 0 ? threshold : p.R));
      if (k === 1 && roundFloor != null) fundedGuard.push(cash(stressed ? roundFloor : roundFloor.minus(p.inTransit)));
      if (k === 0 && extraBuffer.gt(0)) buffered.push(cash(threshold.plus(extraBuffer)));
      if (k === 1 && stressed && costBasis != null) {
        const n = cash(costBasis);
        loss.push(n.map((v, i) => (i === 0 ? -v - 1n : -v)));
      }
      if (costBasis != null) (k === 0 ? failProfit : passProfit).push(cash(costBasis, true));
      if (k === 1 && costBasis != null && payout != null)
        afterCreditProfit.push(cash(costBasis.minus(payout), true));
      valid.push(plane([s[0], denominator.times(l.mark).plus(s[1]), 0, 0], true));
      if (nonflat) valid.push(project(hypeSegment.exit, u, s, 0, true));
    }
  }
  const buffer = decimal(checks.minPriceBuffer ?? '0').times(-hypeSegment.sign);
  const riskAt = (s, withdraw, strict = true) => {
    for (const tier of l.tiers) {
      const margin = [
        hypeSegment.marked[0]
          .minus(l.otherMaintenance ?? l.hold)
          .plus(tier.deduction)
          .minus(withdraw[0]),
        hypeSegment.marked[1].minus(u.times(l.mark).times(tier.mmr)).minus(withdraw[1])
      ];
      const exposure = signed.minus(u.times(tier.mmr));
      risk.push(project(margin, exposure, s, nonflat ? '1e-36' : 0, strict && nonflat));
      if (nonflat) risk.push(project(margin, exposure, s, checks.minMaintenanceSurplus ?? 0));
    }
  };
  riskAt(zero, zero);
  for (const s of shifts) riskAt(shiftPx(s), zero);
  if (nonflat && !buffer.isZero()) riskAt(shiftPx(shifts[1], buffer), zero);
  if (checks.stress || !shock.isZero()) {
    riskAt(zero, debit);
    for (const s of shifts) riskAt(shiftPx(s, nonflat ? shock : 0), debit);
    riskAt(shiftPx(shifts[1], nonflat ? shock.plus(buffer) : 0), debit);
  }
  const excursion = nonflat ? pathDislocation(l,hypeSegment.sign,checks) : decimal(0);
  const envelope = excursion.isZero() ? [] : [zero,...shifts].map(s => shiftPx(s,excursion));
  for (const point of envelope) {
    risk.push(plane([point[0],denominator.times(l.mark).plus(point[1]),0,0],true));
    riskAt(point,[funding,decimal(0)]);
  }
  // Both signs of a configured basis move need a valid native price even
  // when a move improves the position's cash (e.g. a short near zero).
  if (nonflat && checks.basisBps != null && decimal(checks.basisBps).gt(0)) {
    const down=decimal(l.mark).times(checks.basisBps).div(10000).neg();
    for (const s of shifts) {
      const point=shiftPx(s,down);
      risk.push(plane([point[0],denominator.times(l.mark).plus(point[1]),0,0],true));
    }
  }
  const ref = position(book, 'hl');
  if (
    nonflat &&
    hypeSegment.lo === hypeSegment.hi &&
    hypeSegment.step.times(hypeSegment.lo).times(hypeSegment.sign).eq(ref) &&
    l.currentLiquidation != null
  ) {
    for (const s of [zero, ...shifts.flatMap((v) => [shiftPx(v), shiftPx(v, shock)])]) {
      const a = s[0].times(hypeSegment.sign),
        b = denominator.times(decimal(l.mark).minus(l.currentLiquidation)).plus(s[1]).times(hypeSegment.sign);
      risk.push(
        plane([a, b, 0, 0], true),
        plane([a, b.minus(denominator.times(checks.minPriceBuffer ?? 0)), 0, 0])
      );
    }
  }
  if (envelope.length && hypeSegment.lo === hypeSegment.hi &&
      hypeSegment.step.times(hypeSegment.lo).times(hypeSegment.sign).eq(ref) && l.currentLiquidation != null) {
    for (const [a,b] of envelope) risk.push(plane([a.times(hypeSegment.sign),
      denominator.times(decimal(l.mark).minus(l.currentLiquidation)).plus(b).times(hypeSegment.sign),0,0],true));
  }
  if (costBasis == null) for (const group of [loss, failProfit, passProfit]) group.push([-1n, 0n, 0n, 0n]);
  if (costBasis == null || payout == null) afterCreditProfit.push([-1n, 0n, 0n, 0n]);
  const groups = Object.fromEntries(
    Object.entries({ valid, risk, protect, survive, failProfit, passProfit, afterCreditProfit, loss }).map(
      ([k, v]) => [k, compact(v, pfSegment, hypeSegment)]
    )
  );
  return {
    fundedGuard: fundedGuard.length ? compact(fundedGuard, pfSegment, hypeSegment) : null,
    buffered: buffered.length ? compact(buffered, pfSegment, hypeSegment) : null,
    metrics: pathMetrics(ctx, pfSegment, hypeSegment, common, feesLine, debit, nonflat ? shock : decimal(0)),
    sign: pfSegment.sign,
    from: pfSegment.lo,
    to: pfSegment.hi,
    lo: hypeSegment.lo,
    hi: hypeSegment.hi,
    ...groups
  };
}
function slices(c, i) {
  const n = BigInt(i);
  const legal = applyBands([c.lo, c.hi], c.valid, n),
    risk = applyBands(legal, c.risk, n);
  const protect = applyBands(risk, c.protect, n),
    survive = applyBands(risk, c.survive, n);
  const intersect = (a, b) =>
    a && b && Math.max(a[0], b[0]) <= Math.min(a[1], b[1])
      ? [Math.max(a[0], b[0]), Math.min(a[1], b[1])]
      : null;
  const failProfit = applyBands(risk, c.failProfit, n),
    passProfit = applyBands(risk, c.passProfit, n);
  const joint = intersect(protect, survive);
  const both = c.buffered ? applyBands(joint, c.buffered, n) : joint;
  return {
    legal,
    risk,
    eligible: c.fundedGuard ? applyBands(both, c.fundedGuard, n) : both,
    protect,
    survive,
    both,
    afterCreditProfit: applyBands(risk, c.afterCreditProfit, n),
    loss: applyBands(risk, c.loss, n),
    failProfit,
    passProfit,
    profit: intersect(failProfit, passProfit)
  };
}
function highRiskBands({ legal, both }) {
  if (!legal) return [];
  if (!both) return [legal];
  return [
    [legal[0], both[0] - 1],
    [both[1] + 1, legal[1]]
  ].filter(([a, b]) => a <= b);
}
function empty() {
  return { count: 0, min: null, max: null };
}
function add(set, lo, hi, i, sign) {
  set.count += hi - lo + 1;
  // Compare integer fractions. Number multiplication is exact on the ordinary small grid.
  const cmp = (j, p) =>
    Math.max(j, i, p.i, p.j) < 67108864
      ? Math.sign(j * p.i - p.j * i)
      : Number(BigInt(j) * BigInt(p.i) - BigInt(p.j) * BigInt(i));
  if (!set.largest || set.largest.i < i) set.largest = { sign, i, j: lo };
  const lower = set.min ? cmp(lo, set.min) : -1;
  const upper = set.max ? cmp(hi, set.max) : 1;
  if (lower < 0) { set.min = { i, j: lo, sign }; set.minCount = 1; }
  else if (lower === 0) set.minCount++;
  if (upper > 0) { set.max = { i, j: hi, sign }; set.maxCount = 1; }
  else if (upper === 0) set.maxCount++;
}
function deadlinePath(ctx, c, p) {
  if (p.stage === 'funded') return { status: 'notApplicable' };
  const price = ctx.params.deadlineMark;
  if (!ctx.book.challengeDeadlineAt || price == null) return { status: 'unknown' };
  if (c.code !== 'FEASIBLE') return { status: 'risk' };
  const shift = decimal(price).minus(ctx.market.pf.mark).div(ctx.market.pf.factor);
  for (const key of ['fail', 'pass']) {
    const boundary = decimal(c.lines[key]);
    if (shift.times(boundary).gt(0) && shift.abs().gte(boundary.abs()))
      return { status: 'firstBoundary', key };
  }
  const stress = c.endpointStress;
  const hlShift = shift.plus(decimal(stress?.priceShock ?? 0).div(ctx.market.hl.factor));
  const hl = projectSettlementEquity(ctx.book, ctx.market, 'hl', c.hlTargetQuantity, out(hlShift))
    .minus(p.k ?? 0)
    .minus(stress?.delayDebit ?? 0)
    .minus(stress?.fundingDebit ?? 0);
  return {
    status: 'scenario',
    at: ctx.book.challengeDeadlineAt,
    mark: price,
    cash: out(hl.plus(ctx.book.external))
  };
}
function stoppedBeforeExit(ctx, c, key, audit, initial) {
  if (initial !== 'pass') return initial === 'fail' ? '开仓约束未满足，目标仓位无法建立' : '开仓保证金未验证';
  const cases = audit[key], beforeFill = cases.beforeFill?.firstBreach;
  if (beforeFill) return 'Hype 原仓在延迟成交前先触线 ' + beforeFill.mark + '，实际清算成交及结余未知';
  for (const test of Object.values(cases)) {
    if (test.firstBreach) return 'Hype 途中首次触线 ' + test.firstBreach.mark + '，实际清算成交及结余未知';
    if (test.status === 'fail' || test.pfStatus === 'fail') return '路径提前终止，终点不可用于结算';
    if (test.status !== 'pass' || !test.proof?.continuous ||
        (test.pfStatus && test.pfStatus !== 'pass')) return '路径风险未充分验证';
  }
  if (c.code === 'FEASIBLE') return null;
  if (c.constraints.some(x => (x.code === 'hl_INTRAPATH_' + key || x.name === 'Hype 成交延迟（原仓）') && x.status === 'fail'))
    return 'Hype 途中压力路径触线或价格越界';
  const shift = c.lines[key],
    stress = c.endpointStress;
  const adjusted = decimal(shift).plus(decimal(stress?.priceShock ?? 0).div(ctx.market.hl.factor));
  const root = c.stressLiqMark ?? c.liqMark;
  const signed = decimal(c.hlTargetQuantity).cmp(0);
  const exitMark = decimal(ctx.market.hl.mark).plus(adjusted.times(ctx.market.hl.factor));
  if (signed && root != null && exitMark.minus(root).times(signed).lte(0)) return 'Hype 先触强平线';
  for (const [venue, quantity, endpoint, debit] of [
    ['pf', c.vsTargetQuantity, shift, '0'],
    [
      'hl',
      c.hlTargetQuantity,
      out(adjusted),
      out(decimal(stress?.delayDebit ?? 0).plus(stress?.fundingDebit ?? 0))
    ]
  ]) {
    if (decimal(quantity).isZero()) continue;
    const path = validateMargin(ctx.book, ctx.market, venue, quantity, ['0', endpoint], undefined, debit).at(
      -1
    );
    if (path.status === 'fail') return (venue === 'pf' ? 'PF' : 'Hype') + ' 先触维持保证金线';
  }
  return null;
}
// Detailed witnesses are materialized only for displayed lot pairs, at that
// pair's own leverage. Classification of the full grid uses the same extrema.
function auditHypePaths(ctx,c) {
  const {book,checks} = ctx, leg = ctx.market.hl;
  const market = {...ctx.market,hl:{...leg,leverage:String(c.candidateLeverage ?? leg.leverage)}};
  const q = c.hlTargetQuantity, factor = decimal(leg.factor);
  const excursion = pathDislocation(leg,decimal(q).cmp(0),checks).div(factor);
  const stress = c.endpointStress;
  const delay = decimal(leg.mark).times(checks.stress?.delayBps ?? 0).div(10000).div(factor);
  const old = c.hlCurrentQuantity;
  const delayed = !delay.isZero() && !decimal(old).isZero();
  function walk(model, target, shifts, debit, free) {
    if (shifts.some(s => decimal(leg.mark).plus(decimal(s).times(factor)).lte(0)))
      return {status:'fail',reason:'路径标记价越界',checkpoints:[]};
    return validateMargin(book,model,'hl',target,shifts,checks.catalog,debit,{openFree:free}).at(-1);
  }
  const result = {};
  for (const key of ['fail','pass']) {
    const end = c.lines[key];
    const paths = {base:walk(market,q,['0',end],'0',c.availableAfter)};
    // Quotes are compared in Hype quote units only to identify the side of
    // the basis. The resulting native move goes into the usual quanto ledger.
    const basis = checks.basisBps, fx = checks.basisRate;
    if (basis != null && fx != null) {
      const pfEnd=decimal(market.pf.mark).plus(decimal(end).times(market.pf.factor));
      const hlEnd=decimal(leg.mark).plus(decimal(end).times(factor));
      const gap=hlEnd.minus(pfEnd.div(fx));
      const width=decimal(leg.mark).times(basis).div(10000);
      const dir=gap.cmp(0) || -decimal(q).cmp(0) || 1;
      const closing=gap.abs().lt(width) ? gap.abs() : width;
      for (const [name,offset] of [['basisWiden',width.times(dir)],['basisNarrow',closing.times(-dir)]]) {
        const shift=out(decimal(end).plus(offset.div(factor)));
        paths[name] = {...walk(market,q,['0',shift],'0',c.availableAfter),
          shift,offset:out(offset),gapBefore:out(gap),gapAfter:out(gap.plus(offset)),
          adverse:offset.times(q).lt(0),referenceRate:fx};
      }
    }
    // A widening absolute premium can help either side. Signed shocks describe
    // the economics of this particular position independently of the premium.
    const side=decimal(q).cmp(0);
    if (basis != null && side) {
      const adverse=decimal(leg.mark).times(basis).div(10000).times(-side);
      for (const [name,offset] of [['basisAdverse',adverse],['basisFavorable',adverse.neg()]]) {
        const shift=out(decimal(end).plus(offset.div(factor)));
        paths[name]={...walk(market,q,['0',shift],'0',c.availableAfter),shift,nativeOffset:out(offset)};
      }
    }
    if (!excursion.isZero()) {
      const shifted=out(decimal(end).plus(excursion));
      const debit=checks.stress?.fundingDebit ?? '0';
      paths.asyncExit={...walk(market,q,['0',out(excursion),shifted],debit,c.availableAfter),
        shift:shifted,nativeOffset:out(excursion.times(factor)),debit};
    }
    if (!excursion.isZero())
      paths.dislocation = walk(market,q,['0',out(excursion),out(decimal(end).plus(excursion)),end],
        checks.stress?.fundingDebit ?? '0',c.availableAfter);
    if (stress) {
      const shifted = out(decimal(end).plus(decimal(stress.priceShock).div(factor)));
      paths.delayedFill = walk(market,q,['0',shifted],out(decimal(stress.fundingDebit).plus(stress.delayDebit)),c.availableAfter);
    }
    if (delayed) {
      const before = {...market,hl:{...leg,leverage:leg.configuredLeverage ?? leg.leverage}};
      paths.beforeFill = walk(before,old,['0',out(delay),out(delay.neg())],'0',leg.free);
    }
    // Preserve the independent closing shift/debit for settlement at this PF boundary.
    paths.base.shift=end;
    if (paths.dislocation) {
      paths.dislocation.shift=end;
      paths.dislocation.debit=checks.stress?.fundingDebit ?? '0';
    }
    if (paths.delayedFill) {
      paths.delayedFill.shift=out(decimal(end).plus(decimal(stress.priceShock).div(factor)));
      paths.delayedFill.debit=out(decimal(stress.fundingDebit).plus(stress.delayDebit));
    }
    if (c.code!=='FEASIBLE')
      paths.base.pfStatus=validateMargin(book,market,'pf',c.vsTargetQuantity,['0',end],checks.catalog).at(-1).status;
    result[key] = paths;
  }
  return result;
}
export function inspectRatio(ctx, point, { includeLeverageGrid = false, includePathAudit = false, fixedLeverage = null } = {}) {
  const { market, book, checks, params } = ctx,
    p = profileInputs(book, params, market);
  const pf = out(decimal(market.pf.step).times(point.i).times(point.sign)),
    hl = out(decimal(market.hl.step).times(point.j).times(-point.sign));
  const c = evaluateLeverageGrid(book, market, p, pf, hl, { ...checks, scanRiskOnly: true }, fixedLeverage);
  const path = c.endpointStress,
    fail = decimal(path?.failureCash ?? c.failureCash),
    success = decimal(path?.successHypeCash ?? c.hlBeforePayout);
  const basis = params.profitBasis;
  const successNet = basis == null ? null : success.plus(book.external).minus(basis),
    failNet = basis == null ? null : fail.minus(basis);
  const short = max(0, decimal(p.B).minus(fail));
  const ratio = (val, base) => (val == null || !decimal(base).gt(0) ? null : out(decimal(val).div(base)));
  const excess = c.stressedSurplus ?? c.baseSurplus,
    equity = c.stressedEquity ?? c.baseEquity;
  const buffer = c.stressPriceBuffer ?? c.priceBuffer;

  const covers = fail.gte(p.B),
    survives = success.gte(p.R);
  const coversWithBuffer = fail.gte(decimal(p.B).plus(params.recoveryBuffer ?? 0));
  const successPersonal = success.plus(book.external);
  const funded =
    p.stage === 'funded'
      ? {
          eligible: c.expectedUserPayout,
          ifCredited: out(successPersonal.plus(c.expectedUserPayout)),
          ifCreditedNet: successNet == null ? null : out(successNet.plus(c.expectedUserPayout)),
          pending: params.pendingPayout ?? null,
          received: params.receivedPayout ?? null
        }
      : null;
  const entry = c.constraints.filter(x => /_(INITIAL_MARGIN|FREE_RESERVE|AVAILABLE|UTILIZATION|SWITCH_MARGIN|SWITCH_TIER|ORDER_LEVERAGE|TIER_LEVERAGE)$/.test(x.code));
  const audit = auditHypePaths(ctx,c);
  const statusOf = list => list.some(x => x.status === 'fail') ? 'fail'
    : !list.length || list.some(x => x.status !== 'pass') ? 'unknown' : 'pass';
  const initial = statusOf(entry);
  const failStop = stoppedBeforeExit(ctx,c,'fail',audit,initial);
  const passStop = stoppedBeforeExit(ctx,c,'pass',audit,initial);
  const physical = c.code === 'FEASIBLE' && !failStop && !passStop;
  const pathTests = Object.values(audit).flatMap(group => Object.values(group));
  const pathStatus = statusOf(pathTests.map(test => ({
    status:test.firstBreach || test.pfStatus==='fail' || test.status==='fail' ? 'fail'
      : test.proof?.continuous && (!test.pfStatus || test.pfStatus==='pass') ? test.status : 'unknown'
  })));
  const maintenance = statusOf(c.constraints.filter(x => /MAINTENANCE_PATH$/.test(x.code)));
  return {
    ...point,
    pf,
    hl,
    h: c.actualRatio,
    pathAudit:includePathAudit ? audit : null,
    crossChecked:!!(audit && checks.crossAccount && auditCross(market.hl,checks.crossAccount,c,false).gaps.length===0),
    verification:{
      failureFunds:coversWithBuffer ? 'pass' : 'fail', successFunds:survives ? 'pass' : 'fail',
      initial, maintenance, path:pathStatus,
      liquidation:statusOf(c.constraints.filter(x => /MAINTENANCE|REFERENCE_LIQ|INTRAPATH|PRICE_BUFFER|MARGIN_UNVERIFIED/.test(x.code))),
      stress:checks.fullStress ? statusOf([
        ...c.constraints.filter(x => x.name || /STRESS|INTRAPATH/.test(x.code)),
        ...Object.values(audit??{}).flatMap(group=>Object.values(group))
      ]) : 'unknown'
    },
    pfValue: c.vsNotional,
    hypeValue: c.hlNotional,
    failStop, passStop,
    // The legal-grid report also describes inadmissible sizes. Keep its counterfactual
    // valuations out of the reachable cash fields supplied to any plan.
    ...(failStop || passStop ? {conditionalEndpoints:{
      failure:out(fail), successHype:out(success), successPersonal:out(successPersonal)
    }} : {}),
    fail: failStop ? null : out(fail),
    success: passStop ? null : out(success),
    failNet: failStop || failNet == null ? null : out(failNet),
    successNet: passStop || successNet == null ? null : out(successNet),
    successPersonal: passStop ? null : out(successPersonal),
    failureVsProtection: out(fail.minus(p.B)),
    cushion: recoveryCushion(out(fail), p.B),
    successCoversPrincipal: successPersonal.gte(p.B),
    funded,
    deadline: deadlinePath(ctx, c, p),
    successChange: out(success.minus(p.C_hl)),
    shortfall: out(short),
    gapRate: ratio(short, p.B),
    reserveHeadroom: out(success.minus(p.R)),
    consumption: ratio(max(0, decimal(p.C_hl).minus(success)), p.C_hl),
    initial: c.requiredInitialMargin,
    maintenance: c.maintenanceMargin ?? null,
    otherInitial: c.otherInitialMargin ?? null,
    baseSurplus: c.baseSurplus ?? null,
    stressSurplus: c.stressedSurplus ?? null,
    imRate: ratio(c.requiredInitialMargin, p.C_hl),
    surplus: excess,
    surplusRate: excess == null || equity == null ? null : out(decimal(excess).div(max(equity, '1e-12'))),
    liquidation: c.stressLiqMark ?? c.liqMark,
    buffer,
    bufferRate: ratio(buffer, market.hl.mark),
    free: c.availableAfter,
    lev: c.candidateLeverage,
    ...(includeLeverageGrid && { leverageGrid: c.leverageGrid ?? [] }),
    payout: c.expectedUserPayout,
    physical,
    covers,
    survives,
    coversWithBuffer,
    both: physical && coversWithBuffer && survives,
    failProfitable: physical && failNet != null && failNet.gt(0),
    passProfitable: physical && successNet != null && successNet.gt(0),
    profitable: physical && failNet != null && failNet.gt(0) && successNet.gt(0),
    reason: c.constraints.find((x) => x.status !== 'pass'),
    lines: c.lines,
    paths: c.paths,
    stress: path
  };
}
function scanSegments(ctx, venue, sign) {
  const segments = legalSegments(ctx, venue, sign);
  if (ctx.params.mode !== (venue === 'pf' ? 'keepPF' : 'keepHL')) return segments;
  const index = position(ctx.book, venue).times(sign).div(ctx.market[venue].step);
  if (!index.isInteger() || index.lt(0) || !Number.isSafeInteger(index.toNumber())) return [];
  const lot = index.toNumber();
  return segments.filter((s) => s.lo <= lot && lot <= s.hi).map((s) => ({ ...s, lo: lot, hi: lot }));
}

export function buildRatioScan(ctx, { maxVisits = 3500000, cache } = {}) {
  const legs = {};
  for (const venue of ['pf', 'hl']) {
    const calc = () => [1, -1].map((sign) => scanSegments(ctx, venue, sign));
    const leg = ctx.market[venue];
    legs[venue] = cache
      ? cache.reuse(
          'lots-' + venue,
          [
            ctx.market.id,
            ctx.params.mode,
            leg,
            ctx.book[venue],
            Object.values(ctx.book.positions).filter((p) => p.venue === venue)
          ],
          calc
        )
      : calc();
  }
  const scan = () => scanLotRanges(ctx, maxVisits, legs, cache);
  if (!cache) return scan();
  // Quantity changes deeper than the executable frontier leave all affine
  // segments unchanged. Reuse the exact subdivision and its subset reports.
  const terms = ['pf', 'hl'].map((side) => {
    const { bids, asks, ...rest } = ctx.market[side];
    return rest;
  });
  const { now, ...checks } = ctx.checks;
  const previous = cache.reuse('ranges', [ctx.book, ctx.params, checks, terms, legs, maxVisits], scan);
  return { ...previous, ctx };
}
function scanLotRanges(ctx, maxVisits, legs, cache) {
  if (!['pf','hl'].every(v=>continuousTiers(ctx.market[v].tiers)))
    throw Error('路径风险未充分验证：保证金档位不连续或斜率无法核实');
  const p = profileInputs(ctx.book, ctx.params, ctx.market);
  const constant = decimal(normalizeExposure(ctx.market.hl.step, ctx.market.hl)).div(
    normalizeExposure(ctx.market.pf.step, ctx.market.pf)
  );
  const guarded = p.stage === 'funded' && p.C_ref != null;
  const groups = guarded ? [...keys, 'eligible'] : keys;
  const sets = Object.fromEntries([...groups, 'high'].map((k) => [k, empty()])),
    cells = [];
  let visits = 0,
    complete = true;
  const old = position(ctx.book, 'hl');
  const delay = decimal(ctx.market.hl.mark)
    .times(ctx.checks.stress?.delayBps ?? 0)
    .div(10000)
    .div(ctx.market.hl.factor);
  const oldPath = ctx.checks.stress
    ? validateMargin(ctx.book, ctx.market, 'hl', out(old), ['0', out(delay), out(delay.neg())],undefined,'0',{openFree:ctx.market.hl.free}).at(-1)
    : null;
  for (const sign of [1, -1]) {
    const hypeSegment = legs.hl[sign > 0 ? 1 : 0];
    for (const pfSegment of legs.pf[sign > 0 ? 0 : 1]) {
      const common = pfBoundary(ctx, pfSegment, p);
      for (const h of hypeSegment) {
        const c = cell(ctx, p, pfSegment, h, common);
        if (
          oldPath &&
          (oldPath.status !== 'pass' ||
            (h.hi > 0 && decimal(oldPath.actual).lt(ctx.checks.minMaintenanceSurplus ?? 0)))
        )
          c.risk = [[-1n, 0n, 0n, 0n]];
        c.legalScales = [];
        cells.push(c);
        c.scannedTo = c.from - 1;
        if (!complete) continue;
        for (let i = c.from; i <= c.to; i++) {
          if (++visits > maxVisits) {
            complete = false;
            break;
          }
          c.scannedTo = i;
          const bands = slices(c, i);
          if (bands.legal) {
            const last = c.legalScales.at(-1);
            if (last && last[1] === i - 1) last[1] = i;
            else c.legalScales.push([i, i]);
          }
          for (const k of groups) if (bands[k]) add(sets[k], ...bands[k], i, sign);
          for (const band of highRiskBands(bands)) add(sets.high, ...band, i, sign);
        }
      }
    }
  }
  for (const set of Object.values(sets)) {
    if (!Number.isSafeInteger(set.count)) throw Error('扫描数量超过安全计数范围');
    for (const side of ['min', 'max'])
      if (set[side]) set[side].h = out(constant.times(set[side].j).div(set[side].i));
  }
  const { buckets, pageIndex } = reportBuckets(ctx, p, sets, cells, cache);
  return {
    buckets, pageIndex,
    recoveryFloor: out(decimal(p.B).plus(ctx.params.recoveryBuffer ?? 0)),
    constant: out(constant),
    sets,
    cells,
    complete,
    visits,
    ctx,
    defaultPoint: sets.both.largest ?? sets.protect.min ?? sets.risk.min ?? sets.legal.min
  };
}
// Actual executable fractions, including zero, partition the already scanned domain.
// Boundaries are compared as lot-index fractions, without rounding to the displayed %.
export const scalesPerBlock = 128;

// The last admissible Hype lot on this side of a cut. A strict cut
// excludes only exact multiples, including zero. All three consumers
// (aggregation, candidate lookup and pagination) use this same operation.
export function lastLotAtRatio(edge, i) {
  if (!edge) return Infinity;
  const numerator = BigInt(edge.j) * BigInt(i), denominator = BigInt(edge.i);
  const quotient = numerator / denominator;
  return Number(edge.inclusive === false && numerator % denominator === 0n ? quotient - 1n : quotient);
}

function reportBuckets(ctx, p, sets, cells, cache) {
  const joint = sets.both;
  const gridEdge = (point, inclusive) => ({i:point.i, j:point.j, inclusive});
  const buckets = joint.min ? [
    {edgeKey:'below', above:null, through:joint.min.h, throughLots:gridEdge(joint.min,false)},
    {edgeKey:'joint', above:joint.min.h, through:joint.max.h, throughLots:gridEdge(joint.max,true)},
    {edgeKey:'above', above:joint.max.h, through:null, throughLots:null}
  ] : [{edgeKey:'all', above:null, through:null, throughLots:null}];
  const counted = [...subsetGroups, 'risk', ...(sets.eligible ? ['eligible'] : [])];
  const accumulators = () => Object.fromEntries(counted.map((key) => [key, newReport()]));
  const totals = accumulators();
  for (const bin of buckets) bin.stats = accumulators();
  const ratios = buckets.map(bin => bin.throughLots);
  const blockMaps = Array.from({ length:buckets.length + 1 }, () => new Map());
  function addBlock(map, id, legal, both) {
    let block = map.get(id);
    if (!block) map.set(id, block = {legal:0, both:0});
    block.legal += legal;
    block.both += both;
  }
  function summarizeCell(cell) {
    const parts = new Map();
    for (let i = cell.from; i <= cell.scannedTo; i++) {
      const bands = slices(cell, i);
      if (!bands.legal) continue;
      const limits = ratios.map(edge => lastLotAtRatio(edge, i));
      const row = metricRow(cell.metrics, i);
      for (const key of counted) {
        if (!bands[key]) continue;
        const [lo, hi] = bands[key];
        let start = lo;
        for (let n = 0; n < buckets.length && start <= hi; n++) {
          const end = Math.min(hi, limits[n] ?? hi);
          if (end < start) continue;
          if (!parts.has(n)) parts.set(n, {});
          const part = parts.get(n);
          if (key === 'legal' || key === 'both') {
            const block = (1 + Math.floor((i - 1) / scalesPerBlock)) * cell.sign;
            addBlock(part.blocks ??= new Map(), block, key === 'legal' ? end-start+1 : 0, key === 'both' ? end-start+1 : 0);
          }
          includeBand((part[key] ??= newReport()), row, i, start, end, cell.sign);
          start = end + 1;
        }
      }
    }
    return parts;
  }
  // A tick at one depth level can change just a few executable cells. Reuse
  // the exact subtotal only if lot bounds, inequalities, cash/fee/risk models
  // AND the bin edges still match. Never reuse a previous candidate sample.
  const nextCells = new Map();
  for (const cell of cells) {
    let subtotal;
    if (cache) {
      const signature = JSON.stringify([cell, ratios], (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      subtotal = cache.cells?.get(signature);
      if (subtotal) cache.hits.subsetCells = (cache.hits.subsetCells ?? 0) + 1;
      subtotal ??= summarizeCell(cell);
      nextCells.set(signature, subtotal);
    } else subtotal = summarizeCell(cell);
    for (const [n, part] of subtotal) {
      for (const key of counted) if (part[key]) mergeReport(buckets[n].stats[key], part[key]);
      for (const [id, {legal, both}] of part.blocks ?? []) {
        addBlock(blockMaps[n + 1], id, legal, both);
        addBlock(blockMaps[0], id, legal, both);
      }
    }
    delete cell.metrics;
  }
  if (cache) cache.cells = nextCells;
  const result = buckets.map(({ stats, ...bin }) => {
    const ranges = {};
    for (const key of counted) {
      mergeReport(totals[key], stats[key]);
      bin[key] = stats[key].count;
      ranges[key] = finishReport(stats[key], ctx, p);
    }
    return { ...bin, ranges };
  });
  for (const key of counted) {
    if (totals[key].count !== sets[key].count) throw Error('分段与总计不一致 · ' + key);
    sets[key].range = finishReport(totals[key], ctx, p);
  }
  if (joint.count) {
    const qualified = result.find(bin => bin.edgeKey === 'joint').ranges.both;
    if (qualified?.count !== joint.count) throw Error('双路径交集成员落在闭区间之外');
    if (decimal(qualified.failure[0]).lt(decimal(p.B).plus(ctx.params.recoveryBuffer ?? 0)) ||
        decimal(qualified.successHype[0]).lt(p.R)) throw Error('双路径交集现金低于当前门槛');
    // All qualifying members occupy one closed ratio band. Publish its audited
    // record to both views, including fees, position ranges and risk witnesses.
    joint.range = qualified;
  }
  const pageIndex = blockMaps.map((map, n) => {
    const blocks = Array.from(map, ([id, counts]) => ({
      sign:Math.sign(id), first:1 + (Math.abs(id)-1)*scalesPerBlock, ...counts
    })).sort((a,b) => b.sign - a.sign || a.first - b.first);
    for (const kind of ['legal','both']) {
      const expected = n ? result[n-1][kind] : sets[kind].count;
      if (blocks.reduce((sum, block) => sum+block[kind], 0) !== expected) throw Error('仓位分段索引未对账');
    }
    return blocks;
  });
  return { buckets:result, pageIndex };
}
export function ratioSlice(scan, sign, i, kind = 'legal') {
  const bands = [];
  for (const c of scan.cells) {
    if (c.sign !== sign || i < c.from || i > c.scannedTo) continue;
    const all = slices(c, i);
    if (kind === 'high') bands.push(...highRiskBands(all));
    else if (all[kind]) bands.push(all[kind]);
  }
  return bands.sort((a, b) => a[0] - b[0]);
}

// Ratio membership is independent of how the percentage is formatted.
export function ratioBin(buckets, point) {
  return buckets.findIndex(bin => point.j <= lastLotAtRatio(bin.throughLots, point.i));
}

export function exactRatio(market, pfQty, hlQty) {
  // Multiply the supplied finite decimals as integers. Rounding a converted
  // exposure before reducing the fraction makes proportional sizes disagree.
  function exposure(qty, leg) {
    // Preserve the contract eligibility and positive-factor checks of the exposure model.
    normalizeExposure('1', leg);
    let coefficient = 1n, scale = 0;
    for (const value of [qty, leg.multiplier, leg.fx, leg.factor]) {
      const [whole, fraction = ''] = decimal(value).abs().toFixed().split('.');
      coefficient *= BigInt(whole + fraction);
      scale += fraction.length;
    }
    return {coefficient, scale};
  }
  const hl = exposure(hlQty, market.hl), pf = exposure(pfQty, market.pf);
  const n = hl.coefficient * 10n ** BigInt(Math.max(0, pf.scale-hl.scale));
  const d = pf.coefficient * 10n ** BigInt(Math.max(0, hl.scale-pf.scale));
  const factor = gcd(n,d);
  return (n / factor).toString() + '/' + (d / factor).toString();
}

// Hold one leg and direction constant. For a fixed Hype leg, transpose the
// existing bilinear legality constraints to clip the PF integer axis exactly.
export function neighborPoints(scan, point) {
  const fixedHL = scan.ctx.params.mode === 'keepHL';
  const axis = fixedHL ? 'i' : 'j';
  const center = point[axis];
  let bands;
  if (fixedHL) {
    bands = [];
    for (const c of scan.cells) {
      if (c.sign !== point.sign || point.j < c.lo || point.j > c.hi || c.scannedTo < c.from) continue;
      const planes = c.valid.map(([a, b, h, cross]) => [a, h, b, cross]);
      const band = applyBands([c.from, c.scannedTo], planes, BigInt(point.j));
      if (band) bands.push(band);
    }
  } else bands = ratioSlice(scan, point.sign, point.i);
  const lots = new Set([center]);
  for (const [lo, hi] of bands) {
    const before = Math.min(hi, center - 1),
      after = Math.max(lo, center + 1);
    for (const lot of [before - 1, before, after, after + 1]) if (lo <= lot && lot <= hi) lots.add(lot);
  }
  const ordered = [...lots].sort((a, b) => a - b);
  const index = ordered.indexOf(center);
  return ordered
    .slice(Math.max(0, index - 2), index + 3)
    .map((lot) => ({ i: point.i, j: point.j, sign: point.sign, [axis]: lot }));
}

// Integer multiples of the reduced pair retain the exact same sensitivity ratio.
export function adjacentScale(scan, point, direction, kind = 'legal') {
  if (![1, -1].includes(direction)) throw Error('规模方向无效');
  const divisor = Number(gcd(BigInt(point.i), BigInt(point.j)));
  const pfLots = point.i / divisor,
    hlLots = point.j / divisor;
  const maxPF = scan.cells.reduce(
    (limit, c) => (c.sign === point.sign ? Math.max(limit, c.scannedTo) : limit),
    0
  );
  for (
    let multiple = divisor + direction;
    multiple > 0 && multiple <= Math.floor(maxPF / pfLots);
    multiple += direction
  ) {
    const i = multiple * pfLots,
      j = multiple * hlLots;
    if (ratioSlice(scan, point.sign, i, kind).some(([lo, hi]) => lo <= j && j <= hi))
      return { sign: point.sign, i, j };
  }
  return null;
}

// For each PF lot and each admissible Hype interval the closest sensitivity is
// floor/ceil(target*i/K), clamped to that interval. No fixed ratio step is used.
export function nearestRatio(scan, ratio, kind = 'legal') {
  const target = decimal(ratio).div(scan.constant);
  if (target.lt(0)) return null;
  const n = target.toNumber();
  let best = null,
    err = Infinity;
  for (const cell of scan.cells) {
    for (let i = cell.from; i <= cell.scannedTo; i++) {
      const groups =
        kind === 'legal' ? { legal: applyBands([cell.lo, cell.hi], cell.valid, BigInt(i)) } : slices(cell, i);
      for (const band of kind === 'high' ? highRiskBands(groups) : [groups[kind]]) {
        if (!band) continue;
        const k = n * i;
        for (const j of [Math.floor(k), Math.ceil(k)]) {
          const q = Math.min(band[1], Math.max(band[0], j)),
            d = Math.abs(q / i - n);
          if (d > err + Number.EPSILON * Math.max(1, n) * 8) continue;
          const cmp = best
            ? decimal(q)
                .minus(target.times(i))
                .abs()
                .times(best.i)
                .cmp(decimal(best.j).minus(target.times(best.i)).abs().times(i))
            : -1;
          if (cmp < 0 || (cmp === 0 && i > best.i)) {
            best = { sign: cell.sign, i, j: q };
            err = d;
          }
        }
      }
    }
  }
  return best;
}
