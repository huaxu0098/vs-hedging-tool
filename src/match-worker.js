import { decide, analyzeCandidate, projectQuotes } from './decision.js';
self.onmessage = ({ data }) => {
  const { id, asset, account, config, request, inspected, pinned } = data;
  try {
    const now = Date.now();
    const result = decide(asset, account, config, request, now);
    const candidate = inspected
      ? analyzeCandidate(asset, account, config, inspected, now)
      : (result.best ?? result.review);
    const comparison = pinned ? analyzeCandidate(asset, account, config, pinned, now) : null;
    const targets = (config.targets ?? [config.payoutTarget]).map((target) => {
      if (account.stage === 'challenge' && (!candidate?.ok || candidate.passState?.reachable !== true))
        return { target, ok: false, reason: '本阶段未通过风控，无法从该终点续算' };
      const order = candidate?.requested;
      const futureCash = candidate?.passState?.hypeCash;
      const fund =
        account.stage === 'funded'
          ? account
          : {
              ...account,
              stage: 'funded',
              vsBalance: config.vsStart,
              vsEquity: config.vsStart,
              vsUsed: 0,
              vsFree: config.vsStart,
              hypeCash: futureCash,
              hypeEquity: futureCash,
              hypeUsed: candidate?.otherHold ?? 0,
              hypeFree: futureCash - (candidate?.otherHold ?? 0),
              positions: []
            };
      // Compare the same position against several funded targets from the same account starting point.
      const nextAsset =
        account.stage === 'challenge' && Number.isFinite(candidate?.pass)
          ? projectQuotes(asset, candidate.pass)
          : asset;
      const c = order
        ? analyzeCandidate(nextAsset, fund, { ...config, payoutTarget: target }, order, now)
        : null;
      return {
        target,
        price: c?.pass,
        payout: c?.passState?.reachable === true ? c.passState.payout : null,
        cash: c?.passState?.reachable === true ? c.passState.hypeCash : null,
        reason: c?.reasons?.[0],
        ok: c?.ok
      };
    });
    self.postMessage({ id, result, candidate, comparison, targets });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
