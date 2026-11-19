import { dec, out } from './math.js';
import { evaluateLeverageGrid } from './leverage.js';
import { fundingProof, profileInputs } from './solver.js';

export function comparePlans(maximum, conservative) {
  if (!maximum || !conservative) return null;
  const sacrifice = dec(maximum.vsNotional).minus(conservative.vsNotional);
  const change = (x, y) => (x == null || y == null ? null : out(dec(y).minus(x)));
  const surplus = (c) => c.stressedSurplus ?? c.baseSurplus;
  const distance = (c) => c.stressPriceBuffer ?? c.priceBuffer;
  return {
    hypeChange: change(maximum.hlNotional, conservative.hlNotional),
    failureChange: change(maximum.failureCash, conservative.failureCash),
    maintenanceChange: change(maximum.maintenanceMargin, conservative.maintenanceMargin),
    surplusChange: change(surplus(maximum), surplus(conservative)),
    distanceChange: change(distance(maximum), distance(conservative)),
    leverageChange: change(maximum.candidateLeverage?.toString(), conservative.candidateLeverage?.toString()),
    pfReduction: out(sacrifice),
    reductionRatio: out(sacrifice.div(maximum.vsNotional)),
    successGain: out(dec(conservative.hlBeforePayout).minus(maximum.hlBeforePayout)),
    worstGain: out(dec(conservative.worstCash).minus(maximum.worstCash))
  };
}

// Preserve an existing or last-advised pair only after testing it against this
// frame's cash floor, leverage grid, fees, pending orders and risk constraints.
export function adjustmentTarget(book, market, params, checks, picked, prior, threshold) {
  const exact = [picked.vsTargetQuantity, picked.hlTargetQuantity];
  const current = [picked.vsCurrentQuantity, picked.hlCurrentQuantity];
  const steps = dec(threshold);
  if (!steps.isInteger() || steps.lt(0)) throw Error('迟滞阈值须为非负整数步');
  const profile = profileInputs(book, params, market);
  for (const [source, pair] of [
    ['existing', current],
    ['previous', prior]
  ]) {
    if (!pair || pair.length !== 2 || dec(pair[0]).isZero() || pair.every((q, i) => dec(q).eq(exact[i])))
      continue;
    if (
      !pair.every((q, i) => {
        const l = i ? market.hl : market.pf;
        return dec(q).times(exact[i]).gte(0) && dec(q).minus(exact[i]).abs().lt(steps.times(l.step));
      })
    )
      continue;
    try {
      const c = evaluateLeverageGrid(book, market, profile, ...pair, checks);
      if (c.code !== 'FEASIBLE' || !fundingProof(profile, market, c).valid) continue;
      if (params.cashFloor != null && dec(c.worstAvailableCash).lt(params.cashFloor)) continue;
      if (
        source === 'existing' &&
        c.candidateLeverage != null &&
        !c.leverageGrid.some(
          (row) => row.leverage === Number(market.hl.configuredLeverage) && row.status === 'pass'
        )
      )
        continue;
      return { pair, leverage: c.candidateLeverage, source, threshold: out(steps) };
    } catch (e) {
      if (e.message === 'LEDGER_MISMATCH') throw e;
      /* Invalidated old target; use the new solution. */
    }
  }
  return { pair: exact, leverage: picked.candidateLeverage, source: 'current', threshold: out(steps) };
}
