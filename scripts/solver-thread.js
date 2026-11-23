import { parentPort } from 'node:worker_threads';
import { calculateCurrent } from '../src/hedge/current.js';
import { MarketRevaluation } from '../src/hedge/scan-refresh.js';

let cache = null;
let cashSeed = null;
let previousTargets = [];

function serializeCollection(result, market) {
  const collection = result.ratioScan?.plans?.collection;
  if (!collection) return null;
  const ctx = result.ratioScan?.ctx;
  return {
    collection,
    marketUnits: ctx?.market
      ? {
          pf: { unit: ctx.market.pf.unit, step: ctx.market.pf.step, mark: ctx.market.pf.mark },
          hl: { unit: ctx.market.hl.unit, step: ctx.market.hl.step, mark: ctx.market.hl.mark }
        }
      : {
          pf: { unit: market?.pf?.unit ?? '', step: market?.pf?.step ?? null, mark: market?.pf?.mark ?? null },
          hl: { unit: market?.hl?.unit ?? '', step: market?.hl?.step ?? null, mark: market?.hl?.mark ?? null }
        },
    bookSummary: ctx?.book
      ? {
          pf: ctx.book.pf,
          hl: ctx.book.hl,
          B: ctx.book.B,
          stage: ctx.book.stage
        }
      : null
  };
}

parentPort.on('message', (msg) => {
  const { jobId, configVersion, marketVersion, r, a, m, rates, t, reprice, openingCapacity } = msg;
  const startedAt = new Date().toISOString();
  const startMs = performance.now();
  try {
    if (!reprice || !cache) {
      cache = new MarketRevaluation();
      previousTargets = [];
      cashSeed = null;
    }
    cache.hits = {};
    const result = calculateCurrent(r, a, m, rates, t, {
      openingCapacity: openingCapacity !== false,
      scanRatios: true,
      baseObjectives: true,
      marketCache: cache,
      cashSeed,
      seedTargets: previousTargets
    });
    const winner = result.ratioScan?.plans?.cashPriority?.row;
    cashSeed = winner ? { sign: winner.sign, i: winner.i, j: winner.j } : null;
    previousTargets = (result.top ?? [])
      .map((c) => ({
        vsTargetQuantity: c.vsTargetQuantity,
        hlTargetQuantity: c.hlTargetQuantity
      }))
      .filter((s) => s.vsTargetQuantity != null && s.hlTargetQuantity != null);

    const finishedAt = new Date().toISOString();
    const solveMs = Math.round(performance.now() - startMs);
    const compact = serializeCollection(result, m);

    parentPort.postMessage({
      jobId,
      configVersion,
      marketVersion,
      ok: true,
      startedAt,
      finishedAt,
      solveMs,
      reprice: Boolean(reprice),
      timings: compact?.collection?.timings ?? null,
      cacheHits: cache.hits,
      traceId: result.trace?.id ?? null,
      marketId: result.trace?.marketId ?? null,
      autoStatus: result.autoStatus ?? null,
      issues: result.issues ?? [],
      notices: result.notices ?? [],
      timing: result.timing ?? null,
      evaluationClose: result.evaluationClose ?? null,
      deriveMoves: result.deriveMoves === true,
      expiryOutcome: result.expiryOutcome ?? null,
      ...compact
    });
  } catch (error) {
    parentPort.postMessage({
      jobId,
      configVersion,
      marketVersion,
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      solveMs: Math.round(performance.now() - startMs),
      error: error?.message || String(error)
    });
  }
});
