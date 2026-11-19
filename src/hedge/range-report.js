import { D, dec, out, max } from './math.js';
import { unit, position } from './ratio-domain.js';

export const reportGroups = ['protect', 'survive', 'both', 'profit'];
export const subsetGroups = ['legal', 'protect', 'survive', 'both', 'failProfit', 'passProfit', 'profit'];
const metrics = ['failure', 'success', 'failureFee', 'successFee'];

// Store a path metric as (a*i + b*i² + c*j + d*i*j) / (den*i).
// Scaling finite decimal coefficients together allows exact ordering even at a thin cash boundary.
function integerCoefficients(values) {
  const digits = Math.max(...values.map((v) => v.decimalPlaces()));
  const scale = new D(10).pow(digits);
  return values.map((v) => BigInt(v.times(scale).toFixed(0)));
}
// Clip an integer lot interval to b + m*j >= 0 (or > 0).
function clipLinear(range, b, m, strict = false) {
  if (!range) return null;
  const [lo, hi] = range;
  const [intercept, slope] = integerCoefficients([b, m]);
  const left = intercept + slope * BigInt(lo) - (strict ? 1n : 0n);
  const right = intercept + slope * BigInt(hi) - (strict ? 1n : 0n);
  if (left >= 0n && right >= 0n) return range;
  if (left < 0n && right < 0n) return null;
  return left < 0n ? [lo + Number((-left + slope - 1n) / slope), hi] : [lo, lo + Number(left / -slope)];
}
// On a maintenance tier the liquidation mark is (a+b*j)/(den*j).
// Tier notional, positive-price and adverse-direction tests are linear in j.
function liquidationPieces(ctx, hl, common, debit, shock) {
  const leg = ctx.market.hl,
    u = unit(leg).times(leg.step),
    sign = hl.sign,
    mark = dec(leg.mark);
  if (!hl.hi) return [];
  const [x, y] = common.shifts[1],
    d = common.denominator,
    pieces = [];
  function add(range, a, b, den) {
    if (!range) return;
    const coeff = integerCoefficients([
      mark.plus(shock).times(d).plus(y.times(leg.factor)).times(den).minus(b.times(d)).times(sign),
      x.times(leg.factor).times(den).times(sign),
      a.neg().times(d).times(sign),
      d.times(den)
    ]);
    pieces.push({ range, coeff, lower: a.times(sign).gte(0) });
  }
  for (const [n, tier] of leg.tiers.entries()) {
    const den = u.times(dec(String(sign)).minus(tier.mmr)).times(sign);
    const a = dec(leg.otherMaintenance ?? leg.hold)
      .minus(hl.marked[0])
      .plus(debit[0])
      .minus(tier.deduction)
      .times(sign);
    const b = u.times(sign).times(mark).minus(hl.marked[1]).plus(debit[1]).times(sign);
    let range = clipLinear([Math.max(1, hl.lo), hl.hi], a, b, true);
    range = clipLinear(range, a.neg().times(sign), den.times(mark).minus(b).times(sign));
    range = clipLinear(range, a.times(u).minus(den.times(tier.from)), b.times(u));
    if (leg.tiers[n + 1])
      range = clipLinear(range, den.times(leg.tiers[n + 1].from).minus(a.times(u)), b.times(u).neg(), true);
    add(range, a, b, den);
  }
  if (
    hl.lo === hl.hi &&
    leg.currentLiquidation != null &&
    hl.step.times(hl.lo).times(sign).eq(position(ctx.book, 'hl'))
  )
    add([hl.lo, hl.hi], dec('0'), dec(leg.currentLiquidation), dec('1'));
  return pieces;
}
export function pathMetrics(ctx, pf, hl, { shifts, denominator }, feesLine, debit, shock) {
  const p = ctx.market.pf,
    h = ctx.market.hl;
  const pu = unit(p).times(p.step),
    hu = unit(h).times(h.step);
  const zero = dec('0'),
    d = denominator;
  const cashBase = feesLine[0].minus(debit[0]).plus(ctx.book.external);
  const cashSlope = feesLine[1].minus(debit[1]).plus(hl.slope.times(shock).div(h.factor));
  // Fee is the sum on actual adjustment fills and closing fills of both venues.
  const baseFee = pf.entry[0].plus(pf.exit[0]).times(p.rate).plus(hl.entry[0].plus(hl.exit[0]).times(h.rate));
  const pfFee = pf.entry[1].plus(pf.exit[1]).times(p.rate);
  const hlFee = hl.entry[1].plus(hl.exit[1]).plus(hu.times(shock)).times(h.rate);
  const pfShiftFee = pu.times(p.factor).times(p.rate),
    hlShiftFee = hu.times(h.factor).times(h.rate);
  const cash = [],
    fee = [];
  for (const [a, b] of shifts) {
    cash.push(
      integerCoefficients([
        cashBase.times(d),
        zero,
        hl.slope.times(a),
        cashSlope.times(d).plus(hl.slope.times(b)),
        d
      ])
    );
    fee.push(
      integerCoefficients([
        baseFee.times(d).plus(pfShiftFee.times(a)),
        pfFee.times(d).plus(pfShiftFee.times(b)),
        hlShiftFee.times(a),
        hlFee.times(d).plus(hlShiftFee.times(b)),
        d
      ])
    );
  }
  return {
    money: [cash[0], cash[1], fee[0], fee[1]],
    margin: hl.marginBands,
    liquidation: liquidationPieces(ctx, hl, { shifts, denominator }, debit, shock)
  };
}
export function newReport() {
  return {
    count: 0,
    long: 0,
    pfMin: Infinity,
    pfMax: 0,
    hlMin: Infinity,
    hlMax: 0,
    buffer: { min: null },
    margin: { max: null },
    extrema: metrics.map(() => ({ min: null, max: null }))
  };
}
export function metricRow(model, i) {
  const n = BigInt(i);
  return {
    money: model.money.map(([a, b, c, d, den]) => [n * (a + b * n), c + d * n, den * n]),
    margin: model.margin,
    liquidation: model.liquidation.map(({ range, coeff: [u, v, w, d], lower }) => ({
      range,
      lower,
      m: u * n + v,
      b: w * n,
      d: d * n
    }))
  };
}
function update(pair, key, numerator, denominator, i, j, sign) {
  const prev = pair[key];
  if (
    !prev ||
    (key === 'min' ? numerator * prev.d < prev.n * denominator : numerator * prev.d > prev.n * denominator)
  ) {
    pair[key] = { n: numerator, d: denominator, point: { i, j, sign } };
  }
}
export function includeBand(report, row, i, lo, hi, sign) {
  report.count += hi - lo + 1;
  if (sign > 0) report.long += hi - lo + 1;
  report.pfMin = Math.min(i, report.pfMin);
  report.pfMax = Math.max(i, report.pfMax);
  report.hlMin = Math.min(lo, report.hlMin);
  report.hlMax = Math.max(hi, report.hlMax);
  // With i fixed each metric is affine in j. Endpoints give the exact extrema,
  // including costs at every book-depth boundary (a new cell starts there).
  const low = BigInt(lo),
    high = BigInt(hi);
  for (const band of row.margin) {
    const j = Math.min(hi, band.to);
    if (j >= Math.max(lo, band.from)) update(report.margin, 'max', BigInt(j), BigInt(band.lev), i, j, sign);
  }
  for (const piece of row.liquidation) {
    const from = Math.max(lo, piece.range[0]),
      to = Math.min(hi, piece.range[1]);
    if (from > to) continue;
    const j = piece.lower ? from : to,
      n = BigInt(j);
    update(report.buffer, 'min', piece.m * n + piece.b, piece.d * n, i, j, sign);
  }
  row.money.forEach(([offset, slope, den], k) => {
    const left = offset + slope * low,
      right = offset + slope * high;
    update(report.extrema[k], 'min', slope < 0n ? right : left, den, i, slope < 0n ? hi : lo, sign);
    update(report.extrema[k], 'max', slope < 0n ? left : right, den, i, slope < 0n ? lo : hi, sign);
  });
}
// Union of disjoint ratio bins. Fractions and their actual candidate witnesses
// travel together, so total extrema remain traceable to a member of this group.
export function mergeReport(total, part) {
  if (!part.count) return;
  total.count += part.count;
  total.long += part.long;
  for (const side of ['pf', 'hl']) {
    total[side + 'Min'] = Math.min(total[side + 'Min'], part[side + 'Min']);
    total[side + 'Max'] = Math.max(total[side + 'Max'], part[side + 'Max']);
  }
  function merge(target, source, key) {
    const x = source[key];
    if (x) update(target, key, x.n, x.d, x.point.i, x.point.j, x.point.sign);
  }
  merge(total.buffer, part.buffer, 'min');
  merge(total.margin, part.margin, 'max');
  part.extrema.forEach((pair, i) => {
    merge(total.extrema[i], pair, 'min');
    merge(total.extrema[i], pair, 'max');
  });
}
export function finishReport(raw, ctx, p) {
  if (!raw.count) return null;
  const fields = {};
  const witnesses = {};
  metrics.forEach((name, k) => {
    const { min, max } = raw.extrema[k];
    fields[name] = [min, max].map((x) => out(new D(x.n.toString()).div(x.d.toString())));
    witnesses[name] = [min.point, max.point];
  });
  for (const [key, leg] of [
    ['pf', ctx.market.pf],
    ['hl', ctx.market.hl]
  ]) {
    const q = [raw[key + 'Min'], raw[key + 'Max']].map((v) => dec(leg.step).times(v));
    fields[key + 'Qty'] = q.map(out);
    fields[key + 'Value'] = q.map((v) => out(v.times(unit(leg)).times(leg.mark)));
  }
  const value = (ex) => (ex ? new D(ex.n.toString()).div(ex.d.toString()) : null);
  const m = value(raw.margin.max);
  fields.maxMargin =
    m == null ? null : out(m.times(ctx.market.hl.step).times(unit(ctx.market.hl)).times(ctx.market.hl.mark));
  fields.maxMarginRate =
    fields.maxMargin != null && dec(p.C_hl).gt(0) ? out(dec(fields.maxMargin).div(p.C_hl)) : null;
  fields.minBuffer = raw.buffer.min ? out(value(raw.buffer.min)) : null;
  fields.minBufferRate = fields.minBuffer == null ? null : out(dec(fields.minBuffer).div(ctx.market.hl.mark));
  witnesses.maxMargin = raw.margin.max?.point ?? null;
  witnesses.minBuffer = raw.buffer.min?.point ?? null;
  fields.successHype = fields.success.map((v) => out(dec(v).minus(ctx.book.external)));
  const ratio = (amount, base) => (dec(base).gt(0) ? out(max(0, amount).div(base)) : null);
  fields.gapRate = fields.failure
    .slice()
    .reverse()
    .map((v) => ratio(dec(p.B).minus(v), p.B));
  fields.consumption = fields.success
    .slice()
    .reverse()
    .map((v) => ratio(dec(p.C_hl).plus(ctx.book.external).minus(v), p.C_hl));
  return { count: raw.count, pfLong: raw.long, pfShort: raw.count - raw.long, ...fields, witnesses };
}

export function recoveryCushion(cash, principal) {
  const amount = dec(cash).minus(principal);
  // One cent is the dashboard's monetary display threshold, not an eligibility constraint.
  return {
    amount: out(amount),
    rate: dec(principal).gt(0) ? out(amount.div(principal)) : null,
    thin: amount.gte(0) && amount.lte('0.01')
  };
}
