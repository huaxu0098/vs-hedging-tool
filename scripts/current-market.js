import { subscribeVestMarket } from '../src/vest-market.js';
import { collectHype, MAINNET } from '../src/hedge/adapters.js';
import { readVestSpecs } from './vest-contract.js';

const streams = new Map();
const publicAssets = new Set(['BTC', 'ETH', 'SOL']);
export async function currentMarket(asset) {
  if (!publicAssets.has(asset)) return { asset, errors: { pf: '合约映射待核实', hl: '合约映射待核实' } };
  let s = streams.get(asset);
  if (!s) {
    s = { asset, errors: {}, requested: 0 };
    streams.set(asset, s);
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
              asOf: d.quote.occurredAt,
              levels: d.quote.levels,
              receivedAt: d.receivedAt,
              sizeDecimals: d.sizeDecimals,
              maxLeverage: d.maxLeverage,
              marginTiers: d.marginTables?.find(([id]) => id === d.marginTableId)?.[1]?.marginTiers,
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
  return { asset, pf: s.quote, spec: s.spec, hl: s.hl, errors: s.errors };
}
