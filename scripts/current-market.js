import { subscribeVestMarket } from '../src/vest-market.js';
import { collectHype, subscribeHype, MAINNET } from '../src/hedge/adapters.js';
import { readVestSpecs } from './vest-contract.js';

async function publicInfo(body) {
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

let tokenIndex, tokenRequest;
async function readTokenIndex() {
  if (tokenIndex && Date.now() - tokenIndex.at < 60000) return tokenIndex;
  tokenRequest ??= publicInfo({ type: 'spotMeta' })
    .then(({ tokens }) => {
      tokenIndex = {
        at: Date.now(),
        tokens: new Map(tokens.filter((x) => x.isCanonical).map((x) => [x.index, x]))
      };
      return tokenIndex;
    })
    .finally(() => {
      tokenRequest = null;
    });
  return tokenRequest;
}
// Deduplicate a source's outstanding request across tabs. A stalled dependency
// must not reduce the refresh frequency of either venue's native prices.
function refreshSource(stream, source, read) {
  const previous = stream.reads[source];
  if (previous && (previous.pending || Date.now() - previous.at < 1000)) return previous.pending;
  const current = { at: Date.now() };
  stream.reads[source] = current;
  current.pending = read(current.at).finally(() => {
    current.pending = null;
  });
  return current.pending;
}

const streams = new Map();
const publicAssets = new Set(['BTC', 'ETH', 'SOL']);
export async function currentMarket(asset, { partial = false } = {}) {
  if (!publicAssets.has(asset)) return { asset, errors: { pf: '合约映射待核实', hl: '合约映射待核实' } };
  let s = streams.get(asset);
  if (!s) {
    s = { asset, errors: {}, reads: {}, startedAt: Date.now() };
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
  const specTask = refreshSource(s, 'vestSpec', () =>
    readVestSpecs(asset + '-PERP').then(
      (spec) => {
        s.spec = spec;
        if (spec?.symbol === asset + '-PERP') {
          delete s.errors.spec;
          s.specStatus = 'ok';
        } else {
          s.specStatus = 'unlisted';
          s.errors.spec = 'Vest 合约列表中没有 ' + asset + '-PERP';
        }
      },
      (error) => {
        s.spec = null;
        s.specStatus = 'unavailable';
        s.errors.spec = 'Vest exchangeInfo 获取失败 · ' + error.message;
      }
    )
  );
  const tokenTask = refreshSource(s, 'collateral', () =>
    readTokenIndex().then(
      (index) => {
        s.tokenIndex = index;
      },
      () => {
        s.tokenIndex = null;
      }
    )
  );
  const hypeTask = refreshSource(s, 'hype', (at) => {
    const requestedAt = new Date(at).toISOString();
    return collectHype({ symbol: asset, request: publicInfo })
      .then((d) => {
        // The collateral dictionary and the Vest spec are independent of the
        // native perpetual book. Publish price observations as soon as available.
        const newestBook = !s.hl || d.quote.occurredAt >= s.hl.asOf;
        s.hl = {
          symbol: d.symbol,
          mark: d.mark,
          oracle: d.oracle,
          assetId: d.assetId,
          markAt: requestedAt,
          tiersAt: requestedAt,
          bookSource: newestBook ? 'Hyperliquid REST · l2Book' : s.hl.bookSource,
          asOf: newestBook ? d.quote.occurredAt : s.hl.asOf,
          levels: newestBook ? d.quote.levels : s.hl.levels,
          receivedAt: d.receivedAt,
          sizeDecimals: d.sizeDecimals,
          maxLeverage: d.maxLeverage,
          onlyIsolated: d.onlyIsolated,
          marginTiers:
            d.marginTables?.find(([id]) => id === d.marginTableId)?.[1]?.marginTiers ??
            (Number.isInteger(d.marginTableId) && d.marginTableId > 0 && d.marginTableId < 50
              ? [{ lowerBound: '0', maxLeverage: d.marginTableId }]
              : null),
          contract: d.contract,
          collateralToken: d.collateralToken
        };
        delete s.errors.hl;
      })
      .catch((error) => {
        s.errors.hl = 'Hype 请求失败 · ' + error.message;
      });
  });
  if (!partial) await Promise.allSettled([specTask, hypeTask, tokenTask]);
  let hl = s.hl;
  if (
    hl &&
    s.wsConnected &&
    s.wsBook &&
    Date.now() - Date.parse(s.wsBook.occurredAt) < 2500 &&
    s.wsBook.occurredAt >= hl.asOf &&
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
  if (hl) {
    const token = s.tokenIndex?.tokens.get(hl.collateralToken);
    hl = {
      ...hl,
      contract: {
        ...hl.contract,
        settleAsset: token?.name === hl.contract.settleAsset ? token.name : null,
        collateralEvidence: token
          ? {
              index: token.index,
              name: token.name,
              tokenId: token.tokenId,
              asOf: new Date(s.tokenIndex.at).toISOString(),
              source: 'Hyperliquid spotMeta.tokens'
            }
          : null
      }
    };
    s.published = hl;
  }
  const errors = { ...s.errors };
  if (Date.now() - s.startedAt > 10000) {
    if (!s.quote) errors.pf ||= 'Vest 未收到匹配合约的有效盘口与标记价，正在重试';
    if (!hl) errors.hl ||= 'Hyperliquid 未收到该永续合约的行情，正在重试';
  }
  return {
    asset,
    pf: s.quote,
    spec: s.spec,
    specAt: s.spec?.obtainedAt,
    hl,
    specStatus: s.specStatus ?? 'loading',
    errors
  };
}
