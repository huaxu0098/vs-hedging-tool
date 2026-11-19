import { dec, out, max, min, fundingInterval, normalizeExposure } from './math.js';

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
