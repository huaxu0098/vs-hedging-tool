import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseVSText } from '../src/vs-parser.js';
import { MAINNET, TESTNET } from '../src/feeds.js';

const allowedLeg = new Set(['symbol', 'open', 'bid', 'ask', 'mark', 'asOf', 'timeSource', 'account']);
const allowedAccount = new Set(['balance', 'equity', 'used', 'free', 'stage', 'positions', 'asOf']);
const allowedPosition = new Set(['symbol', 'qty', 'entry', 'upnl', 'marginUsed']);
const isRecord = (o) => o && typeof o === 'object' && !Array.isArray(o);
const exact = (o, keys) => isRecord(o) && Object.keys(o).every((k) => keys.has(k));
const assetPattern = /^[\w-]{1,90}$/;

function send(res, code, value, headers = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(JSON.stringify(value));
}
async function readBody(req, limit = 25000) {
  if (
    !String(req.headers['content-type'] || '')
      .toLowerCase()
      .startsWith('application/json')
  )
    throw Error('仅接收 JSON。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Error('发送内容过大。');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (!isRecord(body)) throw Error('JSON 对象无效。');
  return body;
}
function infoBody(body) {
  if (!exact(body, new Set(['network', 'request'])) || !['mainnet', 'testnet'].includes(body.network))
    return false;
  const r = body.request;
  if (!isRecord(r)) return false;
  const dex = r.dex === undefined || (typeof r.dex === 'string' && /^[\w-]{1,48}$/.test(r.dex));
  if (r.type === 'metaAndAssetCtxs') return dex && exact(r, new Set(['type', 'dex']));
  if (r.type === 'userNonFundingLedgerUpdates')
    return exact(r, new Set(['type','user','startTime'])) && /^0x[\da-fA-F]{40}$/.test(r.user) &&
      Number.isSafeInteger(r.startTime) && r.startTime > 0 && r.startTime <= Date.now();
  const wallet = typeof r.user === 'string' && /^0x[\da-fA-F]{40}$/.test(r.user);
  if (['userAbstraction', 'userFees', 'userFills', 'spotClearinghouseState', 'extraAgents', 'subAccounts', 'userRole'].includes(r.type))
    return wallet && exact(r, new Set(['type', 'user']));
  if (['spotMeta', 'meta', 'allMids'].includes(r.type)) return exact(r, new Set(['type']));
  if (r.type === 'userFunding')
    return (
      wallet &&
      Number.isSafeInteger(r.startTime) &&
      r.startTime >= 0 &&
      r.startTime <= Date.now() &&
      exact(r, new Set(['type', 'user', 'startTime']))
    );
  if (r.type === 'activeAssetData')
    return (
      wallet &&
      typeof r.coin === 'string' &&
      /^[\w.:-]{1,80}$/.test(r.coin) &&
      exact(r, new Set(['type', 'user', 'coin']))
    );
  if (r.type === 'l2Book')
    return (
      exact(r, new Set(['type', 'coin'])) && typeof r.coin === 'string' && /^[\w.:-]{1,80}$/.test(r.coin)
    );
  return (
    ['clearinghouseState', 'frontendOpenOrders'].includes(r.type) &&
    exact(r, new Set(['type', 'dex', 'user'])) &&
    dex &&
    /^0x[\da-fA-F]{40}$/.test(r.user)
  );
}
function compactSnapshot(input) {
  if (
    !exact(input, allowedLeg) ||
    !exact(input.account ?? {}, allowedAccount) ||
    !['source', 'capture'].includes(input.timeSource) ||
    (input.open !== undefined && typeof input.open !== 'boolean') ||
    !Number.isFinite(Date.parse(input.asOf))
  )
    throw Error('快照字段或时间无效。');
  const positions = input.account?.positions;
  if (
    positions !== undefined &&
    (!Array.isArray(positions) || positions.length > 50 || positions.some((p) => !exact(p, allowedPosition)))
  )
    throw Error('持仓字段无效。');
  for (const key of ['bid', 'ask', 'mark'])
    if (input[key] !== undefined && !(Number.isFinite(input[key]) && input[key] > 0))
      throw Error('报价无效。');
  for (const key of ['balance', 'equity', 'used', 'free'])
    if (input.account?.[key] !== undefined && !Number.isFinite(input.account[key]))
      throw Error('账户数值无效。');
  if (input.symbol !== undefined && !/^[\w.:/-]{1,64}$/.test(input.symbol)) throw Error('合约代码无效。');
  if (
    !Object.keys(input).some((k) => ['bid', 'ask', 'mark'].includes(k)) &&
    !Object.keys(input.account ?? {}).length
  )
    throw Error('缺少报价或账户字段。');
  const data = parseVSText(JSON.stringify(input));
  data.timeSource = input.timeSource;
  return data;
}

export function makeBridge() {
  let pairing = null,
    latest = null,
    version = 0;
  return async function handle(req, res, pathname) {
    if (!pathname.startsWith('/api/')) return false;
    const origin = req.headers.origin,
      localOrigin = 'http://' + req.headers.host;
    const paired = pairing && Date.now() < pairing.expires && origin === pairing.origin;
    if (pathname === '/api/vs-snapshot') {
      if (!paired) {
        send(res, 403, { error: '来源尚未配对或已过期。' });
        return true;
      }
      const cors = {
        'Access-Control-Allow-Origin': pairing.origin,
        Vary: 'Origin',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '0'
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return true;
      }
      const expected = Buffer.from('Bearer ' + pairing.token),
        actual = Buffer.from(req.headers.authorization ?? '');
      if (req.method !== 'POST' || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        send(res, 403, { error: '配对认证失败。' }, cors);
        return true;
      }
      const current = pairing;
      try {
        const input = await readBody(req);
        if (
          current !== pairing ||
          Date.now() >= current.expires ||
          !exact(input, new Set(['assetId', 'snapshot'])) ||
          input.assetId !== current.assetId
        )
          throw Error('配对或品种不符。');
        const snapshot = compactSnapshot(input.snapshot);
        if (
          Date.parse(snapshot.asOf) > Date.now() + 1000 ||
          (latest && Date.parse(snapshot.asOf) < Date.parse(latest.snapshot.asOf))
        )
          throw Error('旧快照或未来时间。');
        latest = {
          assetId: current.assetId,
          snapshot,
          sequence: ++version,
          receivedAt: new Date().toISOString()
        };
        send(res, 202, { accepted: true }, cors);
      } catch (error) {
        send(res, 400, { error: error.message }, cors);
      }
      return true;
    }
    if (
      (origin && origin !== localOrigin) ||
      req.headers['sec-fetch-site'] === 'cross-site' ||
      (req.method !== 'GET' && origin !== localOrigin)
    ) {
      send(res, 403, { error: '仅匹配器本机页面可访问。' });
      return true;
    }
    try {
      if (pathname === '/api/bridge/pair' && req.method === 'POST') {
        const input = await readBody(req, 500);
        const url = new URL(input.origin);
        if (
          !exact(input, new Set(['origin', 'assetId'])) ||
          url.protocol !== 'https:' ||
          url.origin !== input.origin ||
          url.username ||
          url.password ||
          !assetPattern.test(input.assetId)
        )
          throw Error('请填写 VS 页面的完整 HTTPS 来源和品种。');
        pairing = {
          assetId: input.assetId,
          origin: url.origin,
          token: randomBytes(32).toString('base64url'),
          expires: Date.now() + 600000
        };
        latest = null;
        send(res, 200, pairing);
      } else if (pathname === '/api/bridge/revoke' && req.method === 'POST') {
        pairing = null;
        latest = null;
        send(res, 200, { revoked: true });
      } else if (pathname === '/api/bridge/latest' && req.method === 'GET') {
        send(res, 200, latest);
      } else if (pathname === '/api/hype-info' && req.method === 'POST') {
        const body = await readBody(req, 900);
        if (!infoBody(body)) {
          send(res, 400, { error: '仅支持只读行情和账户信息。' });
          return true;
        }
        let upstream;
        try {
          upstream = await fetch(body.network === 'mainnet' ? MAINNET : TESTNET, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body.request),
            signal: AbortSignal.timeout(4000),
            redirect: 'error',
            cache: 'no-store'
          });
          if (!upstream.ok) {
            send(res, upstream.status, { error: '只读上游返回 ' + upstream.status });
            return true;
          }
          send(res, 200, await upstream.json());
        } catch {
          send(res, 504, { error: 'Hype 上游超时或断连。' });
        }
      } else send(res, 404, { error: '本机端点不存在。' });
    } catch (error) {
      send(res, 400, { error: error.message });
    }
    return true;
  };
}
