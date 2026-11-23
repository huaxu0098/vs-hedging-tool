import { calculateCurrent } from './current.js';

import { MarketRevaluation } from './scan-refresh.js';

let cache, cashSeed,
  previousTargets = [];
self.onmessage = ({ data }) => {
  const { version, r, a, m, rates, t } = data;
  try {
    const start = performance.now();
    const startedAt = new Date().toISOString();
    if (!data.reprice || !cache) {
      cache = new MarketRevaluation();
      previousTargets = [];
      cashSeed=null;
    }
    cache.hits = {};
    const result = calculateCurrent(r, a, m, rates, t, {
      openingCapacity:data.openingCapacity, priorTarget: data.priorTarget,
      scanRatios: true,
      baseObjectives: true,
      marketCache: cache,
      cashSeed,seedTargets: previousTargets
    });
    result.revaluation = { marketOnly: data.reprice, reused: cache.hits };
    const winner=result.ratioScan?.plans?.cashPriority?.row;
    cashSeed=winner?{sign:winner.sign,i:winner.i,j:winner.j}:null;
    previousTargets = (result.top ?? [])
      .map((c) => ({
        vsTargetQuantity: c.vsTargetQuantity,
        hlTargetQuantity: c.hlTargetQuantity
      }))
      .filter((s) => s.vsTargetQuantity != null && s.hlTargetQuantity != null);
    result.startedAt = startedAt;
    result.finishedAt = new Date().toISOString();
    result.solveMs = Math.round(performance.now() - start);
    self.postMessage({ version, result });
  } catch (e) {
    self.postMessage({ version, error: e.message });
  }
};
