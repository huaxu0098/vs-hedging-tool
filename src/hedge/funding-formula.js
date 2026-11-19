import { dec, out, max, min, fundingInterval, normalizeExposure } from './math.js';

// Cash is already marked at the frame price. Only the changed quantity trades on entry.
export function settlementBridge(cash, l, target, adjustment, shift, entry, exit, friction = '0') {
  const qty = dec(target),
    delta = dec(adjustment);
  const unit = dec(l.multiplier).times(l.fx);
  const mark = dec(l.mark),
    exitMark = mark.plus(dec(shift).times(l.factor));
  const entryFill = delta.isZero() ? dec('0') : delta.times(unit).times(mark.minus(entry.price));
  const move = qty.times(unit).times(exitMark.minus(mark));
  const exitFill = qty.isZero() ? dec('0') : qty.times(unit).times(dec(exit.price).minus(exitMark));
  // Mark to best quote and best quote to depth-weighted fill are disjoint.
  const entrySpread = delta.isZero()
    ? dec('0')
    : delta.times(unit).times(mark.minus((delta.gt(0) ? l.asks : l.bids)[0][0]));
  const exitBest = qty.isZero()
    ? null
    : dec((qty.gt(0) ? l.bids : l.asks)[0][0]).plus(dec(shift).times(l.factor));
  const exitSpread = qty.isZero() ? dec('0') : qty.times(unit).times(exitBest.minus(exitMark));
  const settled = dec(cash)
    .plus(move)
    .plus(entrySpread)
    .plus(exitSpread)
    .minus(entry.impact)
    .minus(exit.impact)
    .minus(entry.fee)
    .minus(exit.fee)
    .minus(friction);
  return {
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
    mark: l.mark,
    target,
    adjustment,
    multiplier: l.multiplier,
    fx: l.fx,
    step: l.step,
    friction,
    exitMark: out(exitMark),
    settled: out(settled)
  };
}

function executionDrag(leg) {
  return dec(leg.entryFee)
    .plus(leg.exitFee)
    .plus(leg.friction)
    .minus(leg.entrySpread)
    .minus(leg.exitSpread)
    .plus(leg.entrySlippage)
    .plus(leg.exitSlippage);
}

export function verifyFundingPair(p, market, c, paths) {
  const Kpf = dec(normalizeExposure(c.vsTargetQuantity, market.pf));
  const Kh = dec(normalizeExposure(c.hlTargetQuantity, market.hl));
  if (Kpf.isZero() || Kpf.times(Kh).gt(0)) throw Error('HEDGE_DIRECTION_INVALID');
  const h = Kh.abs().div(Kpf.abs());
  const cost = (path) => out(executionDrag(path.hl).plus(h.times(executionDrag(path.pf))));
  const cash = fundingInterval(p, cost(paths.fail), cost(paths.pass));
  if (cash.lower == null) return { ...cash, valid: false };
  // Compare each independent calculation before display rounding.
  const impliedFail = dec(cash.C_P).plus(h.times(cash.loss)).minus(cash.failCost);
  const impliedPass = dec(cash.C_H).minus(h.times(cash.gain)).minus(cash.passCost);
  const close = (x, y) =>
    dec(x)
      .minus(y)
      .abs()
      .lte(max(1, dec(y).abs()).times('1e-38'));
  const stressed = c.endpointStress;
  const stress =
    stressed &&
    fundingInterval(
      p,
      out(dec(cash.failCost).plus(dec(c.failureCash).minus(stressed.failureCash))),
      out(dec(cash.passCost).plus(dec(c.hlBeforePayout).minus(stressed.successHypeCash)))
    );
  return {
    ...cash,
    stress,
    Kpf: out(Kpf),
    Kh: out(Kh),
    h: out(h),
    failureCash: out(impliedFail),
    successHypeCash: out(impliedPass),
    paths,
    valid:
      close(h, c.actualRatio) &&
      close(impliedFail, c.failureCash) &&
      close(impliedPass, c.hlBeforePayout) &&
      close(paths.fail.hl.settled, c.failureHypeCash) &&
      close(paths.pass.hl.settled, c.hlBeforePayout) &&
      close(paths.fail.pf.settled, p.floor) &&
      close(paths.pass.pf.settled, p.target),
    minCashHeadroom: out(min(dec(c.failureCash).minus(p.B), dec(c.hlBeforePayout).minus(p.R)))
  };
}
