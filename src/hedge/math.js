import Decimal from '../../node_modules/decimal.js/decimal.mjs';

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
    target = dec(p.target);
  if (dec(p.floor).lt(0) || dec(p.floor).gte(target)) return 'INVALID_PF_RULES';
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
// For a given pair the PF's own execution drag changes the common-factor move
// needed to reach its net boundary. The opposite leg bears h times that drag.
export function fundingInterval(p, failCost = p.k ?? '0', passCost = p.k ?? '0') {
  const terminal = ruleState(p);
  if (terminal) return { code: terminal };
  const loss = dec(p.E).minus(p.floor), gain = dec(p.target).minus(p.E);
  return cashInterval(p, loss, gain, failCost, passCost);
}
function cashInterval(p, loss, gain, failCost, passCost) {
  const personal = dec(p.C_hl).plus(nonnegative(p.C_external));
  const protectedCash = nonnegative(p.B), retained = nonnegative(p.R);
  const recoveryNeed = max('0', protectedCash.minus(personal).plus(failCost));
  const spendable = dec(p.C_hl).minus(retained).minus(passCost);
  const lower = recoveryNeed.div(loss), upper = spendable.div(gain);
  const fail = h => personal.plus(loss.times(h)).minus(failCost);
  const before = h => dec(p.C_hl).minus(gain.times(h)).minus(passCost);
  return { code: lower.gt(upper) ? 'NO_CASH_INTERSECTION' : 'CASH_INTERSECTION',
    B: p.B, C_H: p.C_hl, C_E: p.C_external, C_P: out(personal), R: p.R,
    E: p.E, F: p.floor, T: p.target, loss: out(loss), gain: out(gain),
    failCost, passCost, recoveryNeed: out(recoveryNeed), spendable: out(spendable), lower: out(lower), upper: out(upper),
    successShortfallAtLower: out(max(0, dec(p.R).minus(before(lower)))),
    failureShortfallAtUpper: upper.lt(0) ? null : out(max(0, dec(p.B).minus(fail(upper)))),
    reserveShortfallAtZero: out(max(0, dec(p.R).minus(before(dec('0')))))
  };
}

function bounds(p, loss, gain, k) {
  const { total, payout } = amounts(p),
    required = nonnegative(p.g);
  if (loss.lte(0) || gain.lte(0))
    return {
      code: 'NONPOSITIVE_RECOVERY',
      selected: null,
      failureUnit: out(loss),
      successUnit: out(gain),
      searchComplete: true
    };
  const interval = cashInterval(p, loss, gain, k, k);
  const low = dec(interval.lower), cash = dec(interval.upper);
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
function walkDepth(qty, quotes, detailed) {
  const levels = qty.gt(0) ? quotes.asks : quotes.bids;
  let left = qty.abs(), notional = new D(0), visible = new D(0), used = 0, previous = null, lastFill = null;
  for (const [price,size] of levels ?? []) {
    const px = positive(price), available = positive(size);
    if (previous && (qty.gt(0) ? px.lt(previous) : px.gt(previous))) throw Error('盘口档位无序');
    previous = px;
    if (detailed) visible = visible.plus(available);
    if (left.isZero()) continue;
    const take = min(left,available);
    notional = notional.plus(take.times(px));
    left = left.minus(take);
    lastFill = px;
    used++;
    if (left.isZero() && !detailed) break;
  }
  return {left,notional,used,visible,lastFill};
}
export function estimateFill(q, quotes, multiplier = '1') {
  const qty = dec(q);
  if (qty.isZero()) return null;
  const {left,notional} = walkDepth(qty,quotes,false);
  if (!left.isZero()) throw Error('INSUFFICIENT_DEPTH');
  return {price:out(notional.div(qty.abs())),notional:out(notional.times(positive(multiplier)))};
}

// Same book walk as execution. A partial book cannot price the full order.
export function fillEvidence(q, leg, displacement = '0') {
  const qty = dec(q), target = qty.abs(), buy = qty.gt(0);
  const result = {status:'unknown',target:out(target),side:buy?'ask':'bid',visible:null,covered:null,
    uncovered:null,coverageRatio:null,levels:null,topSize:null,best:null,vwap:null,slippage:null,spreadCost:null};
  if (qty.isZero()) return {...result,status:'noTrade',covered:'0',uncovered:'0',levels:0};
  const side = buy ? leg.asks : leg.bids;
  if (!Array.isArray(side)) return result;
  if (!side.length) return {...result,status:'insufficient',visible:'0',covered:'0',coverageRatio:'0',uncovered:out(target),levels:0};
  let book;
  try { book=walkDepth(qty,leg,true); } catch { return result; }
  const {left,notional,used,visible}=book;
  const shift = dec(displacement), best = dec(side[0][0]);
  Object.assign(result,{visible:out(visible),covered:out(target.minus(left)),uncovered:out(left),
    coverageRatio:out(target.minus(left).div(target)),
    levels:used,topSize:side[0][1],best:out(best.plus(shift))});
  if (left.gt(0)) return {...result,status:'insufficient'};
  const bid=leg.bids?.[0]?.[0], ask=leg.asks?.[0]?.[0];
  if (bid==null || ask==null) return result;
  try {
    if (positive(bid).gt(positive(ask)) || dec(bid).plus(shift).lte(0) || book.lastFill.plus(shift).lte(0)) return result;
  } catch { return result; }
  const unit=positive(leg.multiplier).times(positive(leg.fx));
  return {...result,status:'covered',vwap:out(notional.div(target).plus(shift)),
    slippage:out(notional.minus(target.times(best)).abs().times(unit)),
    spreadCost:out(dec(ask).minus(bid).div(2).times(target).times(unit))};
}
