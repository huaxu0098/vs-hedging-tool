import { dec, out, max, normalizeExposure, profitSplit } from './math.js';
import { legalSegments, position, unit } from './ratio-domain.js';
import { evaluateLeverageGrid } from './leverage.js';
import { profileInputs, validateMargin } from './solver.js';

const decimal = (v) => dec(String(v));
const lotValue = (leg) => unit(leg).times(leg.step);
const paths = ['fail', 'pass', 'paid'];
const keys = ['legal', 'risk', 'protect', 'survive', 'both', 'loss', 'profit', 'joint'];
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
function cell(ctx, p, endpoint, pfSegment, hypeSegment, common) {
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
    profit = [],
    loss = [],
    round = [];
  const feesLine = hypeSegment.settled.map((v, k) => v.minus(k === 0 ? extra : 0));
  const successPayout =
    p.stage === 'funded' ? decimal(profitSplit(p.target, p.baseline, p.share).user) : decimal(0);
  const threshold = decimal(p.B).minus(book.external);
  const costBasis =
    ctx.params.profitBasis == null ? null : decimal(ctx.params.profitBasis).minus(book.external);
  const selected = endpoint === 'fail' ? 0 : 1;
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
      if (k === selected && paths.includes(endpoint))
        profit.push(cash(costBasis.minus(endpoint === 'paid' ? successPayout : 0), true));
      if (k === 1 && p.stage === 'funded' && book.ref != null)
        round.push(
          cash(
            decimal(book.ref)
              .plus(p.g)
              .plus(book.roundIn)
              .minus(book.roundOut)
              .minus(book.external)
              .minus(successPayout)
          )
        );
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
  if (costBasis == null) loss.push([-1n, 0n, 0n, 0n]);
  const groups = Object.fromEntries(
    Object.entries({ valid, risk, protect, survive, profit, loss, round }).map(([k, v]) => [
      k,
      compact(v, pfSegment, hypeSegment)
    ])
  );
  return {
    sign: pfSegment.sign,
    from: pfSegment.lo,
    to: pfSegment.hi,
    lo: hypeSegment.lo,
    hi: hypeSegment.hi,
    ...groups
  };
}
function slices(c, i, endpoint) {
  const n = BigInt(i);
  const legal = applyBands([c.lo, c.hi], c.valid, n),
    risk = applyBands(legal, c.risk, n);
  const protect = applyBands(risk, c.protect, n),
    survive = applyBands(risk, c.survive, n);
  const profit = endpoint ? applyBands(risk, c.profit, n) : null;
  const both = applyBands(applyBands(protect, c.survive, n), c.round, n),
    loss = applyBands(risk, c.loss, n);
  const joint = endpoint
    ? applyBands(applyBands(applyBands(profit, c.protect, n), c.survive, n), c.round, n)
    : null;
  return { legal, risk, protect, survive, both, loss, profit, joint };
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
export function inspectRatio(ctx, point, endpoint) {
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
  const selected =
    basis == null
      ? null
      : endpoint === 'fail'
        ? failNet
        : endpoint === 'pass'
          ? successNet
          : endpoint === 'paid' && p.stage === 'funded'
            ? successNet.plus(c.expectedUserPayout)
            : null;
  const short = max(0, decimal(p.B).minus(fail));
  const ratio = (val, base) => (val == null || !decimal(base).gt(0) ? null : out(decimal(val).div(base)));
  const excess = c.stressedSurplus ?? c.baseSurplus,
    equity = c.stressedEquity ?? c.baseEquity;
  const buffer = c.stressPriceBuffer ?? c.priceBuffer;
  const physical = c.code === 'FEASIBLE';
  const covers = fail.gte(p.B),
    survives = success.gte(p.R);
  const roundOk =
    book.ref == null ||
    p.stage !== 'funded' ||
    success
      .plus(book.external)
      .plus(c.expectedUserPayout)
      .minus(book.ref)
      .minus(book.roundIn)
      .plus(book.roundOut)
      .gte(p.g);
  return {
    ...point,
    pf,
    hl,
    h: c.actualRatio,
    pfValue: c.vsNotional,
    hypeValue: c.hlNotional,
    fail: out(fail),
    success: out(success),
    failNet: failNet == null ? null : out(failNet),
    successNet: successNet == null ? null : out(successNet),
    net: selected == null ? null : out(selected),
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
    profitable: physical && selected != null && selected.gt(0),
    joint: physical && covers && survives && roundOk && selected != null && selected.gt(0),
    reason: c.constraints.find((x) => x.status !== 'pass'),
    paths: c.paths,
    stress: path
  };
}
export function buildRatioScan(ctx, requested = '', preferred = null, { maxVisits = 3500000 } = {}) {
  const p = profileInputs(ctx.book, ctx.params, ctx.market);
  const endpoint =
    ctx.params.profitBasis != null &&
    paths.includes(requested) &&
    (requested !== 'paid' || p.stage === 'funded')
      ? requested
      : '';
  const constant = decimal(normalizeExposure(ctx.market.hl.step, ctx.market.hl)).div(
    normalizeExposure(ctx.market.pf.step, ctx.market.pf)
  );
  const sets = Object.fromEntries([...keys, 'high'].map((k) => [k, empty()])),
    cells = [];
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
    const hypeSegment = legalSegments(ctx, 'hl', -sign);
    for (const pfSegment of legalSegments(ctx, 'pf', sign)) {
      const common = pfBoundary(ctx, pfSegment, p);
      for (const h of hypeSegment) {
        const c = cell(ctx, p, endpoint, pfSegment, h, common);
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
          const bands = slices(c, i, endpoint);
          for (const k of keys) if (bands[k]) add(sets[k], ...bands[k], i, sign);
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
  const target = preferred
    ? {
        i: decimal(preferred.vsTargetQuantity).abs().div(ctx.market.pf.step).toNumber(),
        j: decimal(preferred.hlTargetQuantity).abs().div(ctx.market.hl.step).toNumber(),
        sign: decimal(preferred.vsTargetQuantity).cmp(0)
      }
    : null;
  return {
    endpoint,
    constant: out(constant),
    sets,
    cells,
    complete,
    visits,
    ctx,
    defaultPoint:
      target ?? sets.joint.largest ?? sets.both.largest ?? sets.protect.min ?? sets.risk.min ?? sets.legal.min
  };
}
export function ratioSlice(scan, sign, i, kind = 'legal') {
  const bands = [];
  for (const c of scan.cells) {
    if (c.sign !== sign || i < c.from || i > c.to) continue;
    const all = slices(c, i, scan.endpoint);
    if (kind === 'high') bands.push(...highRiskBands(all));
    else if (all[kind]) bands.push(all[kind]);
  }
  return bands.sort((a, b) => a[0] - b[0]);
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
        kind === 'legal'
          ? { legal: applyBands([cell.lo, cell.hi], cell.valid, BigInt(i)) }
          : slices(cell, i, scan.endpoint);
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
