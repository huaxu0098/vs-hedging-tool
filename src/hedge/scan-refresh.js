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
    ...[market.pf,market.hl].map(q => [q.bookAt ?? q.asOf, q.markAt ?? q.asOf, q.bid, q.ask]),
    market.termReference, market.hl.funding, market.hl.oracle,
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

// Dispatch changed economics immediately when the worker is idle. Source-clock
// heartbeats alone are coalesced; the publication guard still checks freshness.
export function refreshDelay(previous, market, elapsed) {
  if (!previous || changedQuotes(previous,market).length) return 0;
  return Math.max(0,1000-elapsed);
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

// Describe executable changes separately from mere advancement of a source clock.
export function changedQuotes(previous,current) {
  const changed=[];
  for(const [side,label] of [['pf','Vest'],['hl','Hype']]) {
    const a=previous[side],b=current[side];
    const parts=[];
    for(const [k,name] of [[0,'Bid'],[1,'Ask']])
      if(a[name.toLowerCase()]!==b[name.toLowerCase()] || a.levels[k][0]?.[0]!==b.levels[k][0]?.[0]) parts.push(name);
    if(a.mark!==b.mark) parts.push('Mark');
    if(b.levels.some((levels,k)=>levels.length!==a.levels[k].length ||
        levels.some(([px,size],i)=>size!==a.levels[k][i]?.[1] || i>0 && px!==a.levels[k][i]?.[0]))) parts.push('深度');
    if(parts.length) changed.push(label+' '+parts.join('/'));
  }
  return changed;
}
