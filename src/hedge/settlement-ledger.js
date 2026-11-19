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
