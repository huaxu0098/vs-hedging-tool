import { recordFromInspection } from './position-plans.js';
import { dec, out } from './math.js';
import { modelVersion } from './trace.js';

// Read only by the renderer. The worker always starts from current inputs.
// Retain the last complete public-facing report, without order books, wallet
// payloads, the full lot grid, or any executable adjustment advice.
export function displayHistory(storage) {
  let previousKey, previous;
  function key(scope) {
    return 'vs-hype:display-history:' + modelVersion + ':' + scope;
  }
  return {
    read(scope) {
      if (scope === previousKey) return previous;
      previousKey = scope;
      previous = null;
      try {
        const saved = JSON.parse(storage.getItem(key(scope)));
        if (
          saved?.scope === scope &&
          saved.view?.trace?.model === modelVersion &&
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
          previous = saved.view;
        }
      } catch {
        /* No readable local display snapshot. */
      }
      return previous;
    },
    record(scope, result) {
      const scan = result.ratioScan;
      if (!scan?.complete) return;
      const { id, at, model } = result.trace;
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
        trace: { id, at, model },
        finishedAt: result.finishedAt,
        stress: result.stress,
        autoStatus: result.autoStatus,
        ratioScan: {
          sets,
          recoveryFloor: scan.recoveryFloor,
          buckets,
          representative,
          analysis,
          plans: scan.plans && { rows: scan.plans.rows, comparison:scan.plans.comparison, fixed:scan.plans.fixed, eligible: scan.plans.eligible, pending: scan.plans.pending, pfQuote: scan.plans.pfQuote, hlQuote: scan.plans.hlQuote },
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
      previousKey = scope;
      previous = view;
      try {
        storage.setItem(key(scope), JSON.stringify({ scope, view }));
      } catch {
        /* Memory remains available. */
      }
    }
  };
}
