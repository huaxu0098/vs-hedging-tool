import { collectHype, decodeWS, MAINNET, WS } from '../../src/hedge/adapters.js';
const address = '0x' + '0'.repeat(40),
  now = Date.now(),
  log = { at: new Date(now).toISOString(), scope: 'BTC / 主网公开零地址', requests: [] };
async function request(query) {
  const response = await fetch(MAINNET, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json();
  log.requests.push({
    type: query.type,
    http: response.status,
    shape: Array.isArray(body)
      ? 'array:' + body.length
      : body && typeof body === 'object'
        ? Object.keys(body).slice(0, 7)
        : body
  });
  if (!response.ok) throw Error('HTTP ' + response.status);
  return body;
}
try {
  const data = await collectHype({ symbol: 'BTC', user: address, request });
  log.rest = {
    mark: data.mark,
    dex: data.dex,
    mode: data.mode,
    accountValue: data.account?.equity,
    capacityRead: !!data.capacity,
    unresolved: data.unresolved
  };
} catch (e) {
  log.restError = e.message;
}
try {
  log.ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(WS),
      timer = setTimeout(() => {
        socket.close();
        reject(Error('WS timeout'));
      }, 12000);
    socket.onopen = () =>
      socket.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin: 'BTC' } }));
    socket.onerror = () => {
      clearTimeout(timer);
      reject(Error('WS connection error'));
    };
    socket.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data);
        if (msg.channel !== 'l2Book') return;
        const q = decodeWS(msg, { symbol: 'BTC', receivedAt: new Date().toISOString() });
        clearTimeout(timer);
        socket.close();
        resolve({ channel: msg.channel, asOf: q.occurredAt, depth: q.levels.map((x) => x.length) });
      } catch (e) {
        clearTimeout(timer);
        socket.close();
        reject(e);
      }
    };
  });
} catch (e) {
  log.wsError = e.message;
}
console.log(JSON.stringify(log, null, 2));
if (log.restError || log.wsError || log.requests.some((r) => r.http !== 200)) process.exitCode = 1;
