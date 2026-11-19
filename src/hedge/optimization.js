import { dec, out, min } from './math.js';
import { evaluateLeverageGrid } from './leverage.js';
import { profileInputs } from './solver.js';

export function comparePlans(maximum, conservative) {
  if (!maximum || !conservative) return null;
  const sacrifice = dec(maximum.vsNotional).minus(conservative.vsNotional);
  return {
    pfReduction: out(sacrifice),
    reductionRatio: out(sacrifice.div(maximum.vsNotional)),
    successGain: out(dec(conservative.hlBeforePayout).minus(maximum.hlBeforePayout)),
    worstGain: out(dec(conservative.worstCash).minus(maximum.worstCash))
  };
}

export function failureBridge(cash, c, market, costs, friction) {
  const qty = dec(c.hlTargetQuantity),
    delta = dec(c.hlDeltaQuantity);
  const l = market.hl,
    unit = dec(l.multiplier).times(l.fx);
  const mark = dec(l.mark),
    exitMark = mark.plus(dec(c.lines.fail).times(l.factor));
  const entryFill = delta.isZero() ? dec('0') : delta.times(unit).times(mark.minus(costs.entry.price));
  const move = qty.times(unit).times(exitMark.minus(mark));
  const exitFill = qty.isZero() ? dec('0') : qty.times(unit).times(dec(costs.fail.price).minus(exitMark));
  const fees = dec(costs.entry.fee).plus(costs.fail.fee);
  return {
    start: cash,
    move: out(move),
    entryFill: out(entryFill),
    exitFill: out(exitFill),
    entryFee: costs.entry.fee,
    exitFee: costs.fail.fee,
    friction,
    external: c.externalReceived,
    exitMark: out(exitMark),
    settled: out(dec(cash).plus(move).plus(entryFill).plus(exitFill).minus(fees).minus(friction))
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
      if (c.code !== 'FEASIBLE') continue;
      if (
        params.cashFloor != null &&
        min(c.failureCash, c.pressureCashAfter, ...c.scenarioCash).lt(params.cashFloor)
      )
        continue;
      if (
        source === 'existing' &&
        c.candidateLeverage != null &&
        !c.leverageGrid.some(
          (row) => row.leverage === Number(market.hl.configuredLeverage) && row.status === 'pass'
        )
      )
        continue;
      return { pair, leverage: c.candidateLeverage, source, threshold: out(steps) };
    } catch {
      /* Invalidated old target; use the new solution. */
    }
  }
  return { pair: exact, leverage: picked.candidateLeverage, source: 'current', threshold: out(steps) };
}
