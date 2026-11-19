import { vestContract } from '../src/hedge/contract-currencies.js';
const infoURL = 'https://api-gateway.hz.vestmarkets.com/v3/exchangeInfo';
let inflight;
let symbols;
let expires = 0;
let obtainedAt;

// Only public contract identities are retained; clients cannot select an upstream URL.
export async function readVestSpecs(symbol) {
  if (!/^[A-Z0-9][A-Z0-9._-]{0,48}$/.test(symbol ?? '')) return null;
  if (!symbols || Date.now() >= expires) {
    if (!inflight)
      inflight = (async () => {
        const r = await fetch(infoURL, { signal: AbortSignal.timeout(4500), redirect: 'error' });
        if (!r.ok) throw Error('Vest 合约规格暂不可用。');
        const data = await r.json();
        if (!Array.isArray(data.symbols)) throw Error('Vest 合约列表不完整。');
        const parsed = new Map();
        for (const item of data.symbols) {
          if (typeof item.symbol === 'string') parsed.set(item.symbol, item);
        }
        obtainedAt = new Date().toISOString();
        symbols = parsed;
        expires = Date.now() + 60000;
      })().finally(() => {
        inflight = undefined;
      });
    await inflight;
  }
  const spec = symbols.get(symbol);
  return spec ? { ...spec, contract: vestContract(spec), obtainedAt } : null;
}

export async function readVestContract(symbol) {
  const item = await readVestSpecs(symbol);
  return item?.contract.quoteAsset ? { symbol: item.symbol, quote: item.contract.quoteAsset } : null;
}
