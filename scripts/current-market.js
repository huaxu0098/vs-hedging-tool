import { subscribeVestMarket } from '../src/vest-market.js';
import { collectHype, subscribeHype, MAINNET } from '../src/hedge/adapters.js';
import { readVestSpecs } from './vest-contract.js';

const streams = new Map();
const publicAssets = new Set(['BTC', 'ETH', 'SOL']);
export async function currentMarket(asset) {
  if (!publicAssets.has(asset)) return { asset, errors: { pf: '合约映射待核实', hl: '合约映射待核实' } };
  let s = streams.get(asset);
  if (!s) {
    s = { asset, errors: {}, requested: 0 };
    streams.set(asset, s);
    s.stopHype = subscribeHype(
      { symbol: asset },
      (channel, book) => {
        if (channel === 'l2Book' && (!s.wsBook || book.occurredAt >= s.wsBook.occurredAt)) s.wsBook = book;
      },
      (status) => {
        s.wsConnected = status === 'connected';
        if (!s.wsConnected) s.wsBook = null;
      },
      () => {}
    );
    s.stop = subscribeVestMarket(
      asset + '-PERP',
      (q) => {
        s.quote = q;
        delete s.errors.pf;
      },
      (msg) => {
        s.errors.pf = msg;
      },
      { includeDepth: true }
    );
  }
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.stop();
    s.stopHype();
    streams.delete(asset);
  }, 90000);
  if (!s.pending && Date.now() - s.requested >= 1000) {
    s.requested = Date.now();
    s.pending = Promise.allSettled([
      readVestSpecs(asset + '-PERP'),
      collectHype({
        symbol: asset,
        request: async (body) => {
          const res = await fetch(MAINNET, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(4500),
            redirect: 'error'
          });
          if (!res.ok) throw Error('Hype HTTP ' + res.status);
          return res.json();
        }
      })
    ])
      .then(([v, h]) => {
        if (v.status === 'fulfilled' && v.value?.base === asset && v.value.quote === 'USDC') {
          s.spec = v.value;
          delete s.errors.spec;
        } else s.errors.spec = 'Vest 规格或标的映射未核实';
        if (h.status === 'fulfilled') {
          const d = h.value;
          if (!s.hl || d.quote.occurredAt >= s.hl.asOf) {
            s.hl = {
              symbol: d.symbol,
              mark: d.mark,
              markAt: new Date(s.requested).toISOString(),
              tiersAt: new Date(s.requested).toISOString(),
              bookSource: 'Hyperliquid REST · l2Book',
              asOf: d.quote.occurredAt,
              levels: d.quote.levels,
              receivedAt: d.receivedAt,
              sizeDecimals: d.sizeDecimals,
              maxLeverage: d.maxLeverage,
              onlyIsolated: d.onlyIsolated,
              marginTiers:
                d.marginTables?.find(([id]) => id === d.marginTableId)?.[1]?.marginTiers ??
                (Number.isInteger(d.marginTableId) && d.marginTableId > 0 && d.marginTableId < 50
                  ? [{ lowerBound: '0', maxLeverage: d.marginTableId }]
                  : null),
              collateralToken: d.collateralToken
            };
          }
          delete s.errors.hl;
        } else s.errors.hl = 'Hype 请求失败 · ' + h.reason.message;
      })
      .finally(() => {
        s.pending = null;
      });
  }
  if (s.pending) await s.pending;
  let hl = s.hl;
  if (
    hl &&
    s.wsConnected &&
    s.wsBook &&
    Date.now() - Date.parse(s.wsBook.occurredAt) < 2500 &&
    (!s.published || s.wsBook.occurredAt >= s.published.asOf)
  ) {
    hl = {
      ...hl,
      levels: s.wsBook.levels,
      asOf: s.wsBook.occurredAt,
      bookSource: 'Hyperliquid WebSocket · l2Book'
    };
  }
  if (hl && s.published && hl.asOf < s.published.asOf)
    hl = { ...hl, asOf: s.published.asOf, levels: s.published.levels, bookSource: s.published.bookSource };
  if (hl) s.published = hl;
  return { asset, pf: s.quote, spec: s.spec, specAt: s.spec?.obtainedAt, hl, errors: s.errors };
}
