import { vestContract, vestExchangeInfoUrl } from '../src/hedge/contract-currencies.js';
const infoURL = vestExchangeInfoUrl;
let inflight;
let symbols;
let exchangeMeta = null;
let systemMeta = null;
let expires = 0;
let obtainedAt;
let lastRefreshError = null;

async function fetchExchangeInfoWithRetry() {
  let lastErr;
  for (const timeoutMs of [6000, 8000]) {
    try {
      const r = await fetch(infoURL, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!r.ok) throw Error('Vest exchangeInfo HTTP ' + r.status);
      const data = await r.json();
      if (!Array.isArray(data.symbols)) throw Error('Vest exchangeInfo symbols 列表缺失');
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Only public contract identities are retained; clients cannot select an upstream URL.
export async function readVestSpecs(symbol) {
  if (!/^[A-Z0-9][A-Z0-9._-]{0,48}$/.test(symbol ?? '')) return null;
  if (!symbols || Date.now() >= expires) {
    if (!inflight)
      inflight = (async () => {
        try {
          const data = await fetchExchangeInfoWithRetry();
          const parsed = new Map();
          for (const item of data.symbols) {
            if (typeof item.symbol === 'string') parsed.set(item.symbol, item);
          }
          obtainedAt = new Date().toISOString();
          exchangeMeta = data.exchange ? { ...data.exchange, obtainedAt } : { obtainedAt };
          systemMeta = data.system ?? null;
          symbols = parsed;
          lastRefreshError = null;
          expires = Date.now() + 60000;
        } catch (err) {
          lastRefreshError = err?.message || String(err);
          // If we already have a verified specification in memory, retain it during transient upstream hiccups
          if (symbols) {
            expires = Date.now() + 15000;
            return;
          }
          throw Error('Vest 合约规格暂不可用（' + lastRefreshError + '）');
        }
      })().finally(() => {
        inflight = undefined;
      });
    await inflight;
  }
  const spec = symbols.get(symbol);
  if (!spec) return null;
  const contract = vestContract({ ...spec, obtainedAt }, exchangeMeta);
  return {
    ...spec,
    exchange: exchangeMeta,
    system: systemMeta,
    contract,
    specSource: infoURL,
    specVersion: contract.specVersion,
    obtainedAt,
    lastRefreshError
  };
}

export async function readVestContract(symbol) {
  const item = await readVestSpecs(symbol);
  return item?.contract.quoteAsset
    ? {
        symbol: item.symbol,
        base: item.contract.baseAsset,
        quote: item.contract.quoteAsset,
        settlement: item.contract.settleAsset,
        specVersion: item.specVersion,
        obtainedAt: item.obtainedAt
      }
    : null;
}
