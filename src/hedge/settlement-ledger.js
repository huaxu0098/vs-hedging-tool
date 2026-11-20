import { D, dec, out } from './math.js';

// Accumulate the finite decimal postings without rounding intermediate balances.
// Precision of the sum covers the full exponent range of these particular inputs.
const Accumulator = D.clone({ precision: 256 });
export function sumPostings(values) {
  const amounts = values.map((value) => new D(value));
  const decimals = Math.max(0, ...amounts.map((x) => x.decimalPlaces()));
  const integers = Math.max(1, ...amounts.map((x) => x.e + 1));
  const required = integers + decimals + String(values.length).length + 1;
  const Sum = required <= 256 ? Accumulator : D.clone({ precision: required });
  return amounts.reduce((total, v) => total.plus(v.toFixed()), new Sum(0)).toFixed();
}

export const ledgerLabels = {
  start: '起始标记权益',
  move: '目标仓标记盈亏',
  entrySpread: '调仓 Mark 至买卖一档',
  entrySlippage: '调仓深度滑点',
  entryFee: '调仓手续费',
  exitSpread: '平仓 Mark 至买卖一档',
  exitSlippage: '平仓深度滑点',
  exitFee: '平仓手续费',
  friction: '另设终点摩擦'
};
export const settlementTolerance = '0.000000000001';

export function reconcilePostings(entries, fillSettlement) {
  const settled = sumPostings(Object.values(entries));
  const difference = sumPostings([settled, new D(fillSettlement).neg().toFixed()]);
  if (new D(difference).abs().gt(settlementTolerance)) throw Error('LEDGER_MISMATCH');
  return { settled, difference, fillSettlement };
}

// The rounding row belongs only to the four-decimal view. It is never a cash posting.
export function presentLedger(ledger, digits = 4) {
  const entries = Object.fromEntries(
    Object.entries(ledger.entries).map(([key, value]) => [key, new D(value).toFixed(digits)])
  );
  const total = new D(ledger.settled).toFixed(digits);
  const rounding = sumPostings([total, new D(sumPostings(Object.values(entries))).neg().toFixed()]);
  return { entries, total, rounding: new D(rounding).toFixed(digits) };
}

export function settlementBridge(cash, l, target, adjustment, shift, entry, exit, friction = '0') {
  const qty = dec(target),
    delta = dec(adjustment),
    unit = dec(l.multiplier).times(l.fx);
  const mark = dec(l.mark),
    exitMark = mark.plus(dec(shift).times(l.factor));
  const entryFill = delta.isZero() ? dec('0') : delta.times(unit).times(mark.minus(entry.price));
  const exitFill = qty.isZero() ? dec('0') : qty.times(unit).times(dec(exit.price).minus(exitMark));
  const move = qty.times(unit).times(exitMark.minus(mark));
  const entryBest = delta.isZero() ? null : (delta.gt(0) ? l.asks : l.bids)[0][0];
  const exitBest = qty.isZero()
    ? null
    : dec((qty.gt(0) ? l.bids : l.asks)[0][0]).plus(dec(shift).times(l.factor));
  const entrySpread = delta.isZero() ? dec('0') : delta.times(unit).times(mark.minus(entryBest));
  const exitSpread = qty.isZero() ? dec('0') : qty.times(unit).times(exitBest.minus(exitMark));
  const debit = (v) => out(dec(v).neg());
  const entries = {
    start: cash,
    move: out(move),
    entrySpread: out(entrySpread),
    entrySlippage: debit(entry.impact),
    entryFee: debit(entry.fee),
    exitSpread: out(exitSpread),
    exitSlippage: debit(exit.impact),
    exitFee: debit(exit.fee),
    friction: debit(friction)
  };
  // Independent mark-to-fill accounting from quantities, execution prices and the fee base.
  const entryNominal = delta.isZero() ? dec('0') : dec(entry.price).times(delta.abs()).times(unit);
  const exitNominal = qty.isZero() ? dec('0') : dec(exit.price).times(qty.abs()).times(unit);
  const fillSettlement = sumPostings([
    cash,
    out(move),
    out(entryFill),
    out(exitFill),
    debit(entryNominal.times(l.rate)),
    debit(exitNominal.times(l.rate)),
    debit(friction)
  ]);
  const check = reconcilePostings(entries, fillSettlement);
  return {
    ...check,
    entries,
    start: cash,
    move: out(move),
    entryFill: out(entryFill),
    exitFill: out(exitFill),
    entrySpread: out(entrySpread),
    exitSpread: out(exitSpread),
    entrySlippage: entry.impact,
    exitSlippage: exit.impact,
    entryFee: entry.fee,
    exitFee: exit.fee,
    entryPrice: entry.price,
    exitPrice: exit.price,
    entryBest,
    exitBest: exitBest?.toString() ?? null,
    entryNominal: out(entryNominal),
    exitNominal: out(exitNominal),
    rate: l.rate,
    mark: l.mark,
    target,
    adjustment,
    multiplier: l.multiplier,
    fx: l.fx,
    factor: l.factor,
    step: l.step,
    friction,
    exitMark: out(exitMark)
  };
}

// Verify a candidate against independent inputs before publishing its cash. Existing
// unrealized PnL is already included in the snapshot's starting marked equity.
export function checkSignedPath(ledger, leg, target, delta, startEquity, shift) {
  const q = dec(target), d = dec(delta), mark = dec(leg.mark);
  const unit = dec(leg.multiplier).times(leg.fx);
  const exitMark = mark.plus(dec(shift).times(leg.factor));
  const closeEnough = (x,y) => x != null && dec(x).minus(y).abs().lte(settlementTolerance);
  if (!ledger || unit.lte(0) || !dec(leg.factor).gt(0) ||
      !q.eq(ledger.target) || !d.eq(ledger.adjustment) || !mark.eq(ledger.mark) ||
      !dec(leg.multiplier).eq(ledger.multiplier) || !dec(leg.fx).eq(ledger.fx) ||
      !closeEnough(ledger.start,startEquity) || !closeEnough(ledger.exitMark,exitMark))
    throw Error('候选方向、规格或账本起点与行情快照不一致');
  const move = q.times(unit).times(exitMark.minus(mark));
  const entry = d.isZero() ? dec('0') : d.times(unit).times(mark.minus(ledger.entryPrice));
  const exit = q.isZero() ? dec('0') : q.times(unit).times(dec(ledger.exitPrice).minus(exitMark));
  const fee = (quantity, price) => quantity.isZero() ? dec('0') :
    quantity.abs().times(unit).times(price).times(leg.rate);
  const openFee = fee(d,ledger.entryPrice), closeFee = fee(q,ledger.exitPrice);
  const marked = dec(startEquity).plus(entry).minus(openFee).plus(move);
  const settled = marked.plus(exit).minus(closeFee).minus(ledger.friction);
  if (!closeEnough(ledger.move,move) || !closeEnough(ledger.entryFill,entry) ||
      !closeEnough(ledger.exitFill,exit) || !closeEnough(ledger.entryFee,openFee) ||
      !closeEnough(ledger.exitFee,closeFee) || !closeEnough(ledger.settled,settled))
    throw Error('候选价格盈亏、成交费用与结算权益不一致');
  return {target, adjustment:delta, mark:leg.mark, entryPrice:ledger.entryPrice,
    multiplier:leg.multiplier, settlementPerQuote:leg.fx, startEquity, markPnl:out(move),
    fillPnl:out(entry.plus(exit)), grossPnl:out(move.plus(entry).plus(exit)),
    entryFee:ledger.entryFee, closeFee:ledger.exitFee, friction:ledger.friction,
    markedEquity:out(marked), finalEquity:ledger.settled};
}

export function checkPFBoundary(ledger, target, side, threshold, trigger) {
  const sign = dec(target).cmp(0), up = side === 'pass' ? 1 : -1;
  const marked = dec(ledger.start).plus(ledger.entryFill).minus(ledger.entryFee).plus(ledger.move);
  const equity = trigger === 'mark_equity' ? marked : dec(ledger.settled);
  if (!dec(ledger.target).eq(target) || dec(ledger.exitMark).cmp(ledger.mark) !== sign*up ||
      dec(ledger.move).cmp(0) !== up || equity.minus(threshold).abs().gt(settlementTolerance))
    throw Error('PF 方向、触线价格与规则权益不一致');
}
