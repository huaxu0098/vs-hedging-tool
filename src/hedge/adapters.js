import { dec, out, positive, nonnegative } from './math.js';
import { iso } from './book.js';
import { parseVSText } from '../vs-parser.js';
const check = (ok, code) => {
  if (!ok) throw Error(code);
};
const norm = (n) => out(dec(typeof n === 'number' && Number.isFinite(n) ? String(n) : n));
const date = (t) => new Date(t).toISOString();
export const MAINNET = 'https://api.hyperliquid.xyz/info';
export const WS = 'wss://api.hyperliquid.xyz/ws';
export const infoTypes = new Set([
  'metaAndAssetCtxs',
  'l2Book',
  'clearinghouseState',
  'activeAssetData',
  'frontendOpenOrders',
  'userAbstraction',
  'userFees',
  'userFills',
  'userFunding',
  'spotClearinghouseState'
]);
export function poolKey(address, dex, token) {
  return [address.toLowerCase(), dex, token].map(encodeURIComponent).join('/');
}
export function accountMode(raw) {
  return ['disabled', 'standard'].includes(raw) ? 'standard' : 'UNSUPPORTED_MARGIN_MODE';
}
export function readAccount(raw, scope) {
  check(
    raw && Array.isArray(raw.assetPositions) && raw.marginSummary && raw.withdrawable != null,
    'INVALID_ACCOUNT_SCHEMA'
  );
  return {
    ...scope,
    source: 'api',
    verification: 'unverified',
    id: scope.id ?? 'hl/' + scope.user + '/' + scope.dex + '/' + (raw.time ?? scope.receivedAt),
    occurredAt: raw.time ? date(raw.time) : null,
    equity: norm(raw.marginSummary.accountValue),
    used: norm(raw.marginSummary.totalMarginUsed),
    withdrawable: norm(raw.withdrawable),
    pool: poolKey(scope.user, scope.dex, scope.token ?? 'unknown'),
    positions: raw.assetPositions.map(({ position: p }) => ({
      symbol: p.coin,
      qty: norm(p.szi),
      entry: p.entryPx && norm(p.entryPx),
      pnl: norm(p.unrealizedPnl),
      margin: norm(p.marginUsed),
      liquidation: p.liquidationPx && norm(p.liquidationPx),
      leverage: p.leverage
    })),
    raw
  };
}
export function normalizeFlows(rows, type, scope) {
  check(Array.isArray(rows), 'INVALID_FLOW_SCHEMA');
  return rows.map((r) => {
    if (type === 'fill') {
      check(r.tid != null && r.coin && r.feeToken && r.time && r.side && r.sz != null, 'INVALID_FILL_SCHEMA');
      return {
        ...scope,
        id: [scope.user, scope.dex, r.coin, 'fill', r.tid].join('/'),
        source: 'api',
        occurredAt: date(r.time),
        type: 'fill',
        asset: r.coin,
        closedPnl: norm(r.closedPnl),
        currency: r.feeToken,
        fee: norm(r.fee),
        rebate: dec(norm(r.fee)).lt(0) ? out(dec(norm(r.fee)).neg()) : '0',
        amount:
          r.feeToken === (scope.token ?? (scope.dex === '' ? 'USDC' : null))
            ? out(dec(norm(r.closedPnl)).minus(norm(r.fee)))
            : null,
        raw: r
      };
    }
    const d = r.delta ?? r;
    check(r.time && d.coin && d.usdc != null, 'INVALID_FUNDING_SCHEMA');
    return {
      ...scope,
      id: [scope.user, scope.dex, d.coin, 'funding', r.time].join('/'),
      source: 'api',
      occurredAt: date(r.time),
      type: 'funding',
      asset: d.coin,
      currency: 'USDC',
      amount: norm(d.usdc),
      raw: r
    };
  });
}
export function decodeWS(msg, scope) {
  const d = msg.data;
  const matches = () => check(d?.user?.toLowerCase() === scope.user?.toLowerCase(), 'WRONG_ACCOUNT');
  if (msg.channel === 'clearinghouseState') {
    matches();
    check(d.dex === scope.dex && d.clearinghouseState, 'INVALID_WS_WRAPPER');
    return readAccount(d.clearinghouseState, scope);
  }
  if (msg.channel === 'allDexsClearinghouseState') {
    matches();
    check(Array.isArray(d.clearinghouseStates), 'INVALID_WS_WRAPPER');
    return d.clearinghouseStates.map(([dex, state]) => readAccount(state, { ...scope, dex }));
  }
  if (msg.channel === 'userFills' || msg.channel === 'userFundings') {
    matches();
    const fills = msg.channel === 'userFills';
    return normalizeFlows(fills ? d.fills : d.fundings, fills ? 'fill' : 'funding', scope);
  }
  if (msg.channel === 'l2Book') {
    check(
      d?.coin === scope.symbol && Number.isFinite(d.time) && d.levels?.length === 2,
      'INVALID_BOOK_SCHEMA'
    );
    return {
      symbol: d.coin,
      occurredAt: date(d.time),
      receivedAt: scope.receivedAt,
      source: 'api',
      id: d.coin + '/' + d.time,
      levels: d.levels.map((side) =>
        side.slice(0, 5).map((l) => [out(positive(norm(l.px))), out(nonnegative(norm(l.sz)))])
      )
    };
  }
  return null;
}
// Coverage is proved by explicit ids or an ordered cursor within the same stream.
// Native REST account snapshots do not expose a fill/funding cursor; time alone
// does not establish whether a receipt has already changed the balance.
export function reconcileAnchor(anchor, flows) {
  const seen = new Map(),
    covered = new Set(anchor.coveredIds ?? []),
    unknown = [];
  let cash = dec(anchor.balance);
  for (const e of flows) {
    if (e.amount == null || e.pool !== anchor.pool || e.currency !== anchor.currency) {
      unknown.push(e.id);
      continue;
    }
    if (seen.has(e.id)) {
      if (seen.get(e.id) !== e.amount) throw Error('CONFLICTING_EVENT');
      continue;
    }
    seen.set(e.id, e.amount);
    if (covered.has(e.id)) continue;
    if (!(
      Number.isSafeInteger(e.cursor) &&
      Number.isSafeInteger(anchor.cursor) &&
      e.stream &&
      e.stream === anchor.stream
    )) {
      unknown.push(e.id);
      continue;
    }
    if (e.cursor > anchor.cursor) cash = cash.plus(dec(e.amount));
  }
  return {
    balance: out(cash),
    ref: anchor.ref,
    auditIds: [...seen.keys()],
    unresolved: [...new Set(unknown)],
    verified: unknown.length === 0
  };
}
export function freshness({
  vs,
  hl,
  account,
  connected = true,
  now = Date.now(),
  quoteMs = 5000,
  accountMs = 30000
}) {
  const issues = connected ? [] : ['API_DISCONNECTED'];
  for (const [name, s, limit] of [
    ['VS_QUOTE', vs, quoteMs],
    ['HL_QUOTE', hl, quoteMs],
    ['ACCOUNT', account, accountMs]
  ]) {
    const age = now - Date.parse(s?.occurredAt);
    if (!Number.isFinite(age) || age < 0 || age > limit) issues.push(name + '_STALE');
  }
  return issues;
}
export function versionGate() {
  let version = 0;
  return { next: () => ++version, current: (v) => v === version };
}
export async function collectHype({ symbol, user = '', now = Date.now(), request }) {
  check(/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(symbol), 'INVALID_SYMBOL');
  const dex = symbol.includes(':') ? symbol.split(':')[0] : '';
  if (user) check(/^0x[\da-f]{40}$/i.test(user), 'INVALID_PUBLIC_ADDRESS');
  const query =
    request ??
    (async (r) => {
      check(infoTypes.has(r.type), 'READ_ONLY');
      const res = await fetch('/api/hype-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ network: 'mainnet', request: r }),
        signal: AbortSignal.timeout(9000)
      });
      if (!res.ok) throw Error('Info HTTP ' + res.status);
      return res.json();
    });
  const [meta, book] = await Promise.all([
    query({ type: 'metaAndAssetCtxs', ...(dex ? { dex } : {}) }),
    query({ type: 'l2Book', coin: symbol })
  ]);
  check(meta?.[0]?.universe && Array.isArray(meta[1]), 'INVALID_META_SCHEMA');
  const i = meta[0].universe.findIndex((a) => a.name === symbol && !a.isDelisted);
  check(i >= 0, 'UNLISTED_ASSET');
  const ctx = meta[1][i],
    spec = meta[0].universe[i];
  const scope = { user: user.toLowerCase(), dex, symbol, receivedAt: date(Date.now()) };
  const result = {
    ...scope,
    quote: decodeWS({ channel: 'l2Book', data: book }, scope),
    mark: norm(ctx.markPx),
    oracle: norm(ctx.oraclePx),
    funding: norm(ctx.funding),
    sizeDecimals: spec.szDecimals,
    maxLeverage: spec.maxLeverage,
    marginTables: meta[0].marginTables,
    marginTableId: spec.marginTableId,
    collateralToken: meta[0].collateralToken,
    source: 'api',
    unresolved: ['PF_RULES', 'FX', 'CANDIDATE_MARGIN']
  };
  if (user) {
    const mode = await query({ type: 'userAbstraction', user });
    result.mode = mode;
    const standard = accountMode(mode) === 'standard';
    const queries = {
      state: { type: 'clearinghouseState', user, ...(dex ? { dex } : {}) },
      capacity: { type: 'activeAssetData', user, coin: symbol },
      fees: { type: 'userFees', user },
      fills: { type: 'userFills', user },
      funding: { type: 'userFunding', user, startTime: now - 86400000 }
    };
    if (!standard) {
      result.unresolved.push('UNSUPPORTED_MARGIN_MODE');
      queries.spot = { type: 'spotClearinghouseState', user };
    }
    const replies = await Promise.allSettled(Object.values(queries).map(query));
    const data = {};
    Object.keys(queries).forEach((key, k) => {
      if (replies[k].status === 'fulfilled') data[key] = replies[k].value;
      else result.unresolved.push(key + ': ' + replies[k].reason.message);
    });
    if (data.state) result.account = readAccount(data.state, scope);
    if (data.capacity) {
      check(
        data.capacity.coin === symbol &&
          data.capacity.user.toLowerCase() === user.toLowerCase() &&
          data.capacity.availableToTrade?.length === 2 &&
          data.capacity.maxTradeSzs?.length === 2,
        'INVALID_CAPACITY'
      );
      result.capacity = data.capacity;
    }
    result.coverage = { fills: '接口返回的最近成交', fundingSince: date(now - 86400000), cursor: null };
    result.fees = data.fees;
    if (data.spot) result.spot = data.spot;
    result.flows = [
      ...normalizeFlows(data.fills ?? [], 'fill', scope),
      ...normalizeFlows(data.funding ?? [], 'funding', scope)
    ].filter((e) => (e.asset.includes(':') ? e.asset.split(':')[0] : '') === dex);
  }
  return result;
}
export function subscribeHype(scope, receive, onStatus, refresh) {
  let closed = false,
    ws,
    retry,
    tries = 0;
  function connect() {
    if (closed) return;
    ws = new WebSocket(WS);
    ws.onopen = () => {
      tries = 0;
      onStatus('connected');
      refresh();
      const subscriptions = [{ type: 'l2Book', coin: scope.symbol }];
      if (scope.user)
        subscriptions.push(
          { type: 'clearinghouseState', user: scope.user, dex: scope.dex },
          { type: 'userFills', user: scope.user },
          { type: 'userFundings', user: scope.user }
        );
      subscriptions.forEach((subscription) => ws.send(JSON.stringify({ method: 'subscribe', subscription })));
    };
    ws.onmessage = ({ data }) => {
      if (closed) return;
      try {
        const raw = JSON.parse(data),
          msg = decodeWS(raw, { ...scope, receivedAt: date(Date.now()) });
        if (msg) receive(raw.channel, msg);
      } catch (e) {
        onStatus(e.message);
      }
    };
    ws.onerror = () => onStatus('API_DISCONNECTED');
    ws.onclose = () => {
      if (!closed) {
        onStatus('API_DISCONNECTED');
        retry = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(++tries, 5)));
      }
    };
  }
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  };
}
export function manualVs(text, currency, receivedAt) {
  check(['U', 'USD', 'USDC', 'USDT', 'EUR'].includes(currency), 'UNKNOWN_CURRENCY');
  check(!/(?:\d,\d{1,2}(?![\d,])|\d{4,},\d{3})/.test(text), 'AMBIGUOUS_NUMERIC_FORMAT');
  const parsed = parseVSText(text),
    recognized = {};
  const json = /^\s*\{/.test(text) ? JSON.parse(text) : null;
  if (json?.currency && json.currency !== currency) throw Error('CURRENCY_MISMATCH');
  if (!json && /(?:balance|equity|margin|余额|净值|保证金)[^\n]*?\d[\d,.]*\s+([A-Z]{2,10})\b/gi.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      if (!/(?:balance|equity|margin|余额|净值|保证金)/i.test(line)) continue;
      const unit = line.match(/\d[\d,.]*\s+([A-Z]{2,10})\s*$/)?.[1];
      if (unit && unit !== currency) throw Error('CURRENCY_MISMATCH');
    }
  }
  if (/[¥￥€£]/.test(text) && !(currency === 'EUR' && text.includes('€') && !/[¥￥£]/.test(text)))
    throw Error('CURRENCY_MISMATCH');
  const codes = [...text.matchAll(/\b(?:USD[TC]?|EUR|HKD|CNY|JPY|GBP)\b/g)].map((m) => m[0]);
  if (codes.some((x) => x !== currency)) throw Error('CURRENCY_MISMATCH');
  for (const k of ['balance', 'equity', 'used', 'free', 'mark', 'bid', 'ask']) {
    const x = parsed.account?.[k] ?? parsed[k];
    if (x == null) continue;
    const lex = json?.account?.[k] ?? json?.quote?.[k] ?? json?.[k];
    recognized[k] = typeof lex === 'string' ? out(dec(lex.replaceAll(',', ''))) : norm(x);
  }
  check(Object.keys(recognized).length || Array.isArray(parsed.account?.positions), 'NO_RECOGNIZED_FIELDS');
  return {
    source: 'manual',
    symbol: json?.symbol ?? null,
    accountId: json?.accountId ?? null,
    currency,
    receivedAt: iso(receivedAt),
    occurredAt: parsed.timeSource === 'source' ? parsed.asOf : null,
    accountAt: parsed.account?.asOf ?? null,
    stage: parsed.account?.stage,
    positions: parsed.account?.positions ?? null,
    fields: recognized,
    evidence: text,
    confidence: '待人工核对',
    id: 'vs/' + crypto.randomUUID(),
    verification: 'unconfirmed'
  };
}
