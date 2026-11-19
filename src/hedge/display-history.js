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
        )
          previous = saved.view;
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
        stress: result.stress,
        autoStatus: result.autoStatus,
        ratioScan: {
          sets,
          buckets,
          representative,
          analysis,
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
