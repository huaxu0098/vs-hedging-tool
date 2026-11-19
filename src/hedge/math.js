import Decimal from 'decimal.js';

export const D = Decimal.clone({
  precision: 48,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -60,
  toExpPos: 70
});
export function dec(value) {
  if (
    !(value instanceof D) &&
    (typeof value !== 'string' ||
      !/^[+-]?(?:\d{1,80}(?:\.\d{0,80})?|\.\d{1,80})(?:e[+-]?\d{1,2})?$/i.test(value))
  )
    throw Error('需要有限的十进制字符串');
  const n = new D(value);
  if (!n.isFinite()) throw Error('数值不是有限金额');
  return n;
}
export const out = (value) => dec(value).toString();
export function nonnegative(value) {
  const x = dec(value);
  if (x.lt(0)) throw Error('数值不得为负');
  return x;
}
export function positive(value) {
  const x = dec(value);
  if (x.lte(0)) throw Error('数值必须大于零');
  return x;
}
export const max = (...xs) => D.max(...xs);
export const min = (...xs) => D.min(...xs);
export function ratio(value) {
  const n = nonnegative(value);
  if (n.gt(1)) throw Error('费率或分成须介于零与一');
  return n;
}

export function profitSplit(e, baseline, share) {
  const gross = max(0, dec(e).minus(positive(baseline))),
    user = gross.times(ratio(share));
  return { gross: out(gross), user: out(user), platform: out(gross.minus(user)) };
}
export function ruleState(p) {
  if (!['challenge', 'funded'].includes(p.stage)) throw Error('未知阶段');
  const e = dec(p.E),
    target = positive(p.target);
  if (e.lte(nonnegative(p.floor))) return p.stage === 'challenge' ? 'CHALLENGE_FAILED' : 'FUNDED_FAILED';
  if (p.stage === 'funded' && target.lte(positive(p.baseline))) return 'NO_PAYOUT_TARGET';
  if (target.lte(e))
    return p.stage === 'challenge' ? 'CHALLENGE_PASS_PENDING_SETTLEMENT' : 'REFERENCE_REACHED';
  return null;
}
function amounts(p) {
  const hl = dec(p.C_hl),
    protect = hl.plus(nonnegative(p.C_external)),
    total = protect.plus(nonnegative(p.inTransit));
  return {
    hl,
    protect,
    total,
    payout: dec(p.stage === 'funded' ? profitSplit(p.target, p.baseline, p.share).user : '0')
  };
}
export function endpointCash(p, h, failureUnit, successUnit, k = '0') {
  const { hl, protect, total, payout } = amounts(p),
    frac = nonnegative(h),
    cost = nonnegative(k);
  const fail = protect.plus(frac.times(failureUnit)).minus(cost),
    expense = frac.times(successUnit).plus(cost);
  const before = total.minus(expense),
    after = before.plus(payout);
  const gain = p.C_ref == null ? null : after
    .minus(dec(p.C_ref))
    .minus(nonnegative(p.contributions ?? '0'))
    .plus(nonnegative(p.withdrawals ?? '0'));
  return {
    h: out(frac),
    fail: out(fail),
    before: out(before),
    hlBefore: out(hl.minus(expense)),
    after: out(after),
    gain: gain === null ? null : out(gain),
    payout: out(payout)
  };
}
function bounds(p, loss, gain, k) {
  const { hl, total, protect, payout } = amounts(p),
    floor = nonnegative(p.B),
    reserve = nonnegative(p.R),
    required = nonnegative(p.g);
  if (loss.lte(0) || gain.lte(0))
    return {
      code: 'NONPOSITIVE_RECOVERY',
      selected: null,
      failureUnit: out(loss),
      successUnit: out(gain),
      searchComplete: true
    };
  const low = max(0, floor.minus(protect).plus(k).div(loss)),
    cash = hl.minus(reserve).minus(k).div(gain);
  const profit =
    p.stage === 'funded' && p.C_ref != null
      ? total
          .plus(payout)
          .minus(dec(p.C_ref))
          .minus(required)
          .minus(k)
          .minus(nonnegative(p.contributions ?? '0'))
          .plus(nonnegative(p.withdrawals ?? '0'))
          .div(gain)
      : null;
  const high = profit === null ? cash : min(cash, profit),
    cashBinds = profit === null || cash.lte(profit);
  const atMinimum = endpointCash(p, low, loss, gain, k);
  return {
    min: out(low),
    max: out(high),
    cashMax: out(cash),
    profitMax: profit?.toString() ?? null,
    failureUnit: out(loss),
    successUnit: out(gain),
    upperSource: cashBinds ? 'CASH_BEFORE_PAYOUT' : 'PROFIT_TARGET_UNATTAINABLE',
    atMinimum,
    code: low.gt(high) ? (cashBinds ? 'CASH_BEFORE_PAYOUT' : 'PROFIT_TARGET_UNATTAINABLE') : 'FEASIBLE',
    selected: low.gt(high) ? null : atMinimum,
    searchComplete: true
  };
}
export function solveBudgetBounds(p) {
  const terminal = ruleState(p);
  if (terminal) return { code: terminal, selected: null };
  return bounds(p, dec(p.E).minus(p.floor), dec(p.target).minus(p.E), nonnegative(p.k));
}
export const timeoutCash = (cash, h, x, k) =>
  out(
    dec(cash)
      .minus(nonnegative(h).times(dec(x)))
      .minus(nonnegative(k))
  );
export function exactEndpoint({ N, direction, fV, fH, basis, y, h, cash }) {
  const n = positive(N),
    fv = ratio(fV),
    fh = ratio(fH),
    net = dec(y),
    fraction = nonnegative(h);
  if (![1, -1].includes(direction) || !['flat_before_entry', 'open_mark_snapshot'].includes(basis))
    throw Error('方向或权益基准缺失');
  const denom = new D(1).minus(fv.times(direction));
  if (denom.lte(0)) return { code: 'INVALID_PRICE_ENDPOINT' };
  const opening = basis === 'flat_before_entry' ? n : new D(0);
  const gross = net.plus(opening.plus(n).times(fv)).div(denom),
    exit = n.plus(gross.times(direction));
  if (exit.lte(0)) return { code: 'INVALID_PRICE_ENDPOINT' };
  const traded = opening.plus(exit),
    coefficient = gross.plus(traded.times(fh)),
    delta = fraction.times(coefficient).neg();
  return {
    code: 'OK',
    gross: out(gross),
    exitNotional: out(exit),
    pfFees: out(traded.times(fv)),
    hlFees: out(traded.times(fh).times(fraction)),
    net: out(net),
    unit: out(coefficient),
    delta: out(delta),
    cash: out(dec(cash).plus(delta))
  };
}
export function solveExactBounds(p, terms) {
  const terminal = ruleState(p);
  if (terminal) return { code: terminal, selected: null };
  const endpoint = (value) =>
    exactEndpoint({ ...terms, y: out(dec(value).minus(p.E)), h: '1', cash: p.C_hl });
  const fail = endpoint(p.floor),
    pass = endpoint(p.target);
  if (fail.code !== 'OK' || pass.code !== 'OK') return { code: 'INVALID_PRICE_ENDPOINT', selected: null };
  return bounds(p, dec(fail.unit).neg(), dec(pass.unit), new D(0));
}
export function discreteBounds(range, pfSensitivity, hlPerLot, step) {
  if (!range.selected) return { ...range, neighbors: [] };
  const scale = positive(pfSensitivity).div(positive(hlPerLot)),
    grid = positive(step);
  const low = dec(range.min).times(scale).div(grid),
    high = dec(range.max).times(scale).div(grid);
  const first = low.ceil(),
    last = high.floor();
  return {
    code: first.gt(last) ? 'NO_DISCRETE_MATCH' : 'FEASIBLE',
    first: out(first.times(grid)),
    last: out(last.times(grid)),
    neighbors: [out(low.floor().times(grid)), out(first.times(grid))]
  };
}
export function normalizeExposure(q, spec) {
  if (spec.type !== 'linear' || spec.mappingVerified !== true) throw Error('UNSUPPORTED_INSTRUMENT');
  return out(dec(q).times(positive(spec.multiplier)).times(positive(spec.fx)).times(positive(spec.factor)));
}
export function estimateFill(q, quotes, multiplier = '1') {
  const qty = dec(q);
  if (qty.isZero()) return null;
  let left = qty.abs(),
    value = new D(0),
    previous = null;
  const levels = qty.gt(0) ? quotes.asks : quotes.bids;
  for (const [price, size] of levels ?? []) {
    const px = positive(price),
      available = positive(size);
    if (previous && (qty.gt(0) ? px.lt(previous) : px.gt(previous))) throw Error('盘口档位无序');
    previous = px;
    const take = min(left, available);
    value = value.plus(take.times(px));
    left = left.minus(take);
    if (left.isZero()) break;
  }
  if (!left.isZero()) throw Error('INSUFFICIENT_DEPTH');
  return { price: out(value.div(qty.abs())), notional: out(value.times(positive(multiplier))) };
}
