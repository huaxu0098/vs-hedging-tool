import { requiredSpotAssets } from './quote-currencies.js';

// Each new source book or mark is a different observation, even at equal prices.
// Economic stage caches remain reusable independently of publication identity.
export function scanKeys(rules, accounts, market, rates, scope) {
  const { obtainedAt, ...spec } = market.spec;
  const { collateralEvidence, ...hlContract } = market.hl.contract;
  const { asOf, ...collateral } = collateralEvidence ?? {};
  const config = (q) => {
    const {
      levels,
      mark,
      markAt,
      markSource,
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
  const converted = requiredSpotAssets(spec.contract, hlContract, rules);
  const values = JSON.stringify([
    ...[market.pf,market.hl].map(q => [q.bookAt ?? q.asOf, q.markAt ?? q.asOf]),
    market.pf.mark,
    market.hl.mark,
    market.pf.levels,
    market.hl.levels,
    Object.entries(rates)
      .filter(([name]) => converted.has(name))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, q]) => [name, q?.currency, q?.quote, q?.bid, q?.ask, q?.source])
  ]);
  return { context, key: context + values };
}

// Small changes are coalesced against the last dispatch, never against the
// last incoming tick. A continuous stream therefore has a bounded wait.
export function refreshDelay(previous, market, elapsed) {
  if (!previous) return 0;
  const material = ['pf', 'hl'].some((venue) => {
    const prices = (book) => [book.mark, book.levels?.[0]?.[0]?.[0], book.levels?.[1]?.[0]?.[0]];
    const old = prices(previous[venue]);
    const tick = Number(venue === 'pf' ? market.spec?.minTickSize : market.hl?.tickSize) || 0;
    return prices(market[venue]).some((value, i) =>
      Math.abs(Number(value) - Number(old[i])) >= Math.max(tick, Number(old[i]) * 0.00001)
    );
  });
  return Math.max(0, (material ? 400 : 1800) - elapsed);
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
