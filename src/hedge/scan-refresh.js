// Timestamps determine validity before scheduling. Re-observing identical market
// values must not enqueue another full search or renew the old result's trace.
export function scanKeys(rules, accounts, market, rates, scope) {
  const { obtainedAt, ...spec } = market.spec;
  const { collateralEvidence, ...hlContract } = market.hl.contract;
  const { asOf, ...collateral } = collateralEvidence ?? {};
  const config = (q) => {
    const {
      levels,
      mark,
      markAt,
      oracle,
      funding,
      bookAt,
      bookSource,
      asOf,
      receivedAt,
      tiersAt,
      contract,
      bid,
      ask,
      ...terms
    } = q;
    return terms;
  };
  const context = JSON.stringify([
    scope,
    rules,
    accounts,
    spec,
    hlContract,
    collateral,
    config(market.pf),
    config(market.hl)
  ]);
  const values = JSON.stringify([
    market.pf.mark,
    market.hl.mark,
    market.pf.levels,
    market.hl.levels,
    Object.entries(rates)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, q]) => [name, q?.currency, q?.quote, q?.bid, q?.ask, q?.source])
  ]);
  return { context, key: context + values };
}

// Small changes are coalesced against the last dispatch, never against the
// last incoming tick. A continuous stream therefore has a bounded wait.
export function refreshDelay(previous, market, elapsed, previousBasis, nextBasis) {
  if (!previous) return 0;
  const material = ['pf', 'hl'].some((k) => {
    const before = Number(previous[k].mark);
    const tick = Number(k === 'pf' ? market.spec?.minTickSize : market.hl?.tickSize) || 0;
    return Math.abs(Number(market[k].mark) - before) >= Math.max(tick, before * 0.00001);
  });
  const basisMoved =
    previousBasis != null &&
    nextBasis != null &&
    Math.abs(Number(nextBasis) - Number(previousBasis)) >= 0.00001;
  return Math.max(0, (material || basisMoved ? 400 : 1800) - elapsed);
}

// Keep one exact value per stage and side in this worker. Reusing a venue's
// grid requires identical economics; clocks are checked before this point.
export class MarketRevaluation {
  slots = new Map();
  hits = {};
  reuse(slot, inputs, compute) {
    const key = JSON.stringify(inputs);
    const old = this.slots.get(slot);
    if (old?.key === key) {
      this.hits[slot] = (this.hits[slot] ?? 0) + 1;
      return old.value;
    }
    const value = compute();
    this.slots.set(slot, { key, value });
    return value;
  }
}
