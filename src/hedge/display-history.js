import { planObjectives, recordFromInspection } from './position-plans.js';
import { dec, out } from './math.js';
import { modelVersion } from './trace.js';

// The same immutable publication feeds all target views, including after a reload.
function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

function finalizeSnapshot(view) {
  const { trace, ratioScan: { plans } } = view;
  const byKey = new Map(plans?.rows.map(row => [row.key, row]));
  // Only older on-disk reports need to resolve named objectives.
  const keys = plans?.targetKeys ?? planObjectives.map(([label]) =>
    plans?.rows.find(row => row.labels.includes(label))?.key ?? null);
  const targets = keys.map(key => key == null ? null : byKey.get(key));
  if (targets.length !== planObjectives.length || targets.includes(undefined) ||
      (plans?.eligible > 0 && !plans.pending && !plans.legacy && targets.some(row => !row)))
    throw Error('目标索引与候选快照不一致');
  const pair = plans?.comparison;
  const automatic = pair && { comparison:pair, rows:[byKey.get(pair.small), byKey.get(pair.large)] };
  if (automatic && automatic.rows.some(row => !row)) throw Error('规模对照与候选快照不一致');
  return freezeTree({
    ...view, snapshotId: trace.id, quoteSnapshotId: trace.marketId ?? null,
    accountSnapshotId: trace.accountsId ?? null, rulesVersion: trace.rulesId ?? null,
    solverVersion: trace.model, calculatedAt: view.finishedAt ?? trace.at, targets,
    scale: { automatic: automatic?.rows.some(row => !row.physical)
      ? {reason:'至少一种规模没有通过保证金与清算约束的杠杆档位'} : automatic ?? null, fixed: plans?.fixed ?? null }
  });
}

export function createSolutionSnapshot(result) {
  const scan = result.ratioScan;
  const { inputs, ...trace } = result.trace;
  if (![trace.id,trace.marketId,trace.accountsId,trace.rulesId,trace.model,trace.at].every(Boolean))
    throw Error('计算快照缺少行情、账户或规则版本');
  const { sets, buckets, representative, analysis, complete } = scan;
  const { book, params, market } = scan.ctx;
  const view = {
    prices: Object.fromEntries(
      ['pf', 'hl'].map((side) => {
        const q = result.calculationMarket[side],
          c = result.currencies[side];
        return [
          side,
          {
            mark: q.mark,
            bid: q.levels?.[0]?.[0]?.[0],
            ask: q.levels?.[1]?.[0]?.[0],
            bookAt: q.bookAt ?? q.asOf,
            asOf: q.asOf,
            markAt: q.markAt,
            base: c.baseAsset,
            quote: c.quoteAsset,
            settle: c.settleAsset
          }
        ];
      })
    ),
    trace,
    finishedAt: result.finishedAt,
    stress: result.stress,
    autoStatus: result.autoStatus,
    ratioScan: {
      sets,
      recoveryFloor: scan.recoveryFloor,
      buckets,
      representative,
      analysis,
      plans: scan.plans && { targetKeys: scan.plans.targetKeys, rows: scan.plans.rows, comparison:scan.plans.comparison, fixed:scan.plans.fixed, eligible: scan.plans.eligible, pending: scan.plans.pending, pfQuote: scan.plans.pfQuote, hlQuote: scan.plans.hlQuote },
      complete,
      ctx: {
        book: { B: book.B },
        params: {
          R: params.R,
          target: params.target,
          profitBasis: params.profitBasis,
          externalPriced: params.externalPriced
        },
        market: { pf: { unit: market.pf.unit }, hl: { unit: market.hl.unit } }
      }
    }
  };
  return finalizeSnapshot(view);
}

// Read only by the renderer. The worker always starts from current inputs.
// Retain the last complete public-facing report, without order books, wallet
// payloads, the full lot grid, or any executable adjustment advice.
export function displayHistory(storage) {
  let previousKey, previous;
  function key(scope, version = modelVersion) {
    return 'vs-hype:display-history:' + version + ':' + scope;
  }
  return {
    read(scope) {
      if (scope === previousKey) return previous;
      previousKey = scope;
      previous = null;
      try {
        const saved = JSON.parse(storage.getItem(key(scope)) ?? storage.getItem(key(scope,'AUTO-0.21.1')));
        if (
          saved?.scope === scope &&
          [modelVersion,'AUTO-0.21.1'].includes(saved.view?.trace?.model) &&
          saved.view.ratioScan?.complete &&
          Array.isArray(saved.view.ratioScan.buckets) &&
          saved.view.ratioScan.ctx?.market?.pf &&
          saved.view.ratioScan.sets?.legal
        ) {
          const scan = saved.view.ratioScan;
          // Older reports kept the buffered subset separately. Preserve their
          // prices and actual cash rows while restoring only qualified members.
          const buffer = scan.analysis?.recoveryBuffer ?? scan.representative?.buffer ?? '0';
          if (scan.recoveryFloor == null && dec(buffer).gt(0)) {
            scan.recoveryFloor = out(dec(scan.ctx.book.B).plus(buffer));
            scan.sets.both = scan.sets.eligible ?? {count:0, min:null, max:null};
            for (const bin of scan.buckets) {
              bin.both = bin.eligible ?? 0;
              bin.ranges.both = bin.ranges.eligible ?? null;
            }
            scan.historicalIntersection = true;
            scan.analysis = null;
            for (const row of [scan.representative?.row, ...(scan.plans?.rows ?? [])].filter(Boolean)) {
              row.coversWithBuffer = row.fail != null && dec(row.fail).gte(scan.recoveryFloor);
              row.both = row.both && row.coversWithBuffer;
            }
          }
          // Historical all-left-open bins cannot be reclassified from extrema.
          // Keep their cash and target rows, and wait for a live grid to repopulate bins.
          if (scan.buckets.some(bin => !['below','joint','above','all'].includes(bin.edgeKey))) {
            scan.buckets = [];
            if (scan.analysis) scan.analysis.boundary = null;
          }
          if (!scan.plans && scan.representative?.row) {
            const row = recordFromInspection(scan.ctx, scan.representative.row);
            scan.plans = { legacy: true, rows: [{ ...row, labels: ['上次计算仓位'] }],
              pfQuote: saved.view.prices?.pf?.quote, hlQuote: saved.view.prices?.hl?.quote };
          }
          previous = finalizeSnapshot(saved.view);
        }
      } catch {
        /* No readable local display snapshot. */
      }
      return previous;
    },
    record(scope, snapshot) {
      if (!snapshot.ratioScan?.complete) return;
      previousKey = scope;
      previous = snapshot;
      // Rebuild references to the canonical rows on restore instead of serializing duplicate candidates.
      const { targets, scale, ...view } = snapshot;
      try {
        storage.setItem(key(scope), JSON.stringify({ scope, view }));
      } catch {
        /* Memory remains available. */
      }
    }
  };
}
