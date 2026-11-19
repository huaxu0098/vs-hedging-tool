import { dec, out, max, profitSplit, normalizeExposure } from './math.js';
import { legalSegments, position, unit } from './ratio-domain.js';
import {
  pathMetrics,
  metricRow,
  newReport,
  includeBand,
  finishReport,
  reportGroups,
  recoveryCushion
} from './range-report.js';
import { evaluateLeverageGrid } from './leverage.js';
import { profileInputs, validateMargin, projectSettlementEquity } from './solver.js';

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
  const costBasis =
    ctx.params.profitBasis == null ? null : decimal(ctx.params.profitBasis).minus(book.external);
  for (const k of [0, 1]) {
    for (const stressed of [false, true]) {
      const s = shiftPx(shifts[k], stressed && nonflat ? shock : 0);
      const line = feesLine.map((v, j) => (stressed ? v.minus(debit[j]) : v));
      const cash = (floor, strict = false) => project(line, hypeSegment.slope.div(factor), s, floor, strict);
      (k === 0 ? protect : survive).push(cash(k === 0 ? threshold : p.R));
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
  if (costBasis == null) for (const group of [loss, failProfit, passProfit]) group.push([-1n, 0n, 0n, 0n]);
  if (costBasis == null || payout == null) afterCreditProfit.push([-1n, 0n, 0n, 0n]);
  const groups = Object.fromEntries(
    Object.entries({ valid, risk, protect, survive, failProfit, passProfit, afterCreditProfit, loss }).map(
      ([k, v]) => [k, compact(v, pfSegment, hypeSegment)]
    )
  );
  return {
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
  return {
    legal,
    risk,
    protect,
    survive,
    both: intersect(protect, survive),
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
  if (!set.min || cmp(lo, set.min) < 0) set.min = { i, j: lo, sign };
  if (!set.max || cmp(hi, set.max) > 0) set.max = { i, j: hi, sign };
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
function stoppedBeforeExit(ctx, c, key) {
  if (c.code === 'FEASIBLE') return null;
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
export function inspectRatio(ctx, point) {
  const { market, book, checks, params } = ctx,
    p = profileInputs(book, params, market);
  const pf = out(decimal(market.pf.step).times(point.i).times(point.sign)),
    hl = out(decimal(market.hl.step).times(point.j).times(-point.sign));
  const c = evaluateLeverageGrid(book, market, p, pf, hl, { ...checks, scanRiskOnly: true });
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
  const physical = c.code === 'FEASIBLE';
  const covers = fail.gte(p.B),
    survives = success.gte(p.R);
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
  return {
    ...point,
    pf,
    hl,
    h: c.actualRatio,
    pfValue: c.vsNotional,
    hypeValue: c.hlNotional,
    failStop: stoppedBeforeExit(ctx, c, 'fail'),
    passStop: stoppedBeforeExit(ctx, c, 'pass'),
    fail: out(fail),
    success: out(success),
    failNet: failNet == null ? null : out(failNet),
    successNet: successNet == null ? null : out(successNet),
    successPersonal: out(successPersonal),
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
    imRate: ratio(c.requiredInitialMargin, p.C_hl),
    surplus: excess,
    surplusRate: excess == null || equity == null ? null : out(decimal(excess).div(max(equity, '1e-12'))),
    liquidation: c.stressLiqMark ?? c.liqMark,
    buffer,
    bufferRate: ratio(buffer, market.hl.mark),
    free: c.availableAfter,
    lev: c.candidateLeverage,
    payout: c.expectedUserPayout,
    physical,
    covers,
    survives,
    both: physical && covers && survives,
    failProfitable: physical && failNet != null && failNet.gt(0),
    passProfitable: physical && successNet != null && successNet.gt(0),
    profitable: physical && failNet != null && failNet.gt(0) && successNet.gt(0),
    reason: c.constraints.find((x) => x.status !== 'pass'),
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

export function buildRatioScan(ctx, { maxVisits = 3500000 } = {}) {
  const p = profileInputs(ctx.book, ctx.params, ctx.market);
  const constant = decimal(normalizeExposure(ctx.market.hl.step, ctx.market.hl)).div(
    normalizeExposure(ctx.market.pf.step, ctx.market.pf)
  );
  const sets = Object.fromEntries([...keys, 'high'].map((k) => [k, empty()])),
    cells = [];
  const reports = Object.fromEntries(reportGroups.map((k) => [k, newReport()]));
  let visits = 0,
    complete = true;
  const old = position(ctx.book, 'hl');
  const delay = decimal(ctx.market.hl.mark)
    .times(ctx.checks.stress?.delayBps ?? 0)
    .div(10000)
    .div(ctx.market.hl.factor);
  const oldPath = ctx.checks.stress
    ? validateMargin(ctx.book, ctx.market, 'hl', out(old), ['0', out(delay), out(delay.neg())]).at(-1)
    : null;
  for (const sign of [1, -1]) {
    const hypeSegment = scanSegments(ctx, 'hl', -sign);
    for (const pfSegment of scanSegments(ctx, 'pf', sign)) {
      const common = pfBoundary(ctx, pfSegment, p);
      for (const h of hypeSegment) {
        const c = cell(ctx, p, pfSegment, h, common);
        if (
          oldPath &&
          (oldPath.status !== 'pass' ||
            (h.hi > 0 && decimal(oldPath.actual).lt(ctx.checks.minMaintenanceSurplus ?? 0)))
        )
          c.risk = [[-1n, 0n, 0n, 0n]];
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
          if (bands.risk) {
            const row = metricRow(c.metrics, i);
            for (const key of reportGroups)
              if (bands[key]) includeBand(reports[key], row, i, ...bands[key], sign);
          }
          for (const k of keys) if (bands[k]) add(sets[k], ...bands[k], i, sign);
          for (const band of highRiskBands(bands)) add(sets.high, ...band, i, sign);
        }
      }
    }
  }
  for (const key of reportGroups) sets[key].range = finishReport(reports[key], ctx, p);
  for (const set of Object.values(sets)) {
    if (!Number.isSafeInteger(set.count)) throw Error('扫描数量超过安全计数范围');
    for (const side of ['min', 'max'])
      if (set[side]) set[side].h = out(constant.times(set[side].j).div(set[side].i));
  }
  const buckets = reportBuckets(ctx, p, sets, cells);
  return {
    buckets,
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
function reportBuckets(ctx, p, sets, cells) {
  const edges = [
    { i: 1, j: 0, h: '0' },
    ...reportGroups.flatMap((k) => [sets[k].min, sets[k].max]).filter(Boolean)
  ];
  const cmp = (a, b) => Number(BigInt(a.j) * BigInt(b.i) - BigInt(b.j) * BigInt(a.i));
  edges.sort(cmp);
  const cuts = edges.filter((point, k) => k === 0 || cmp(point, edges[k - 1]) !== 0);
  const counted = ['legal', ...reportGroups];
  const buckets = [...cuts, null].map((edge, n) => ({
    above: cuts[n - 1]?.h ?? null,
    through: edge?.h ?? null,
    throughLots: edge ? { i: edge.i, j: edge.j } : null,
    ...Object.fromEntries(counted.map((k) => [k, 0])),
    stats: newReport()
  }));
  const ratios = cuts.map((c) => [BigInt(c.j), BigInt(c.i)]);
  for (const cell of cells) {
    for (let i = cell.from; i <= cell.scannedTo; i++) {
      const bands = slices(cell, i);
      if (!bands.legal) continue;
      const limits = ratios.map(([a, b]) => Number((a * BigInt(i)) / b));
      const row = bands.risk ? metricRow(cell.metrics, i) : null;
      for (const key of [...counted, 'risk']) {
        if (!bands[key]) continue;
        const [lo, hi] = bands[key];
        let start = lo;
        for (let n = 0; n < buckets.length && start <= hi; n++) {
          const end = Math.min(hi, limits[n] ?? hi);
          if (end < start) continue;
          if (key === 'risk') includeBand(buckets[n].stats, row, i, start, end, cell.sign);
          else buckets[n][key] += end - start + 1;
          start = end + 1;
        }
      }
    }
    delete cell.metrics;
  }
  return buckets.map(({ stats, ...bin }) => ({ ...bin, range: finishReport(stats, ctx, p) }));
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
