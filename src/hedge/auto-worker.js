import { calculateCurrent } from './current.js';

import { MarketRevaluation } from './scan-refresh.js';

let cache,
  previousTargets = [];
self.onmessage = ({ data }) => {
  const { version, r, a, m, rates, t } = data;
  try {
    const start = performance.now();
    const startedAt = new Date().toISOString();
    if (!data.reprice || !cache) {
      cache = new MarketRevaluation();
      previousTargets = [];
    }
    cache.hits = {};
    const result = calculateCurrent(r, a, m, rates, t, {
      priorTarget: data.priorTarget,
      scanRatios: true,
      marketCache: cache,
      seedTargets: previousTargets
    });
    result.revaluation = { marketOnly: data.reprice, reused: cache.hits };
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
