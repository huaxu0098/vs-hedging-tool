importScripts('config.js');

const desks = new Map();
const sources = new Map();
let generation = 0;
const validSymbol = (s) => typeof s === 'string' && /^[A-Z0-9][A-Z0-9._:-]{0,48}$/.test(s);
const localOrigin = 'http://127.0.0.1:' + globalThis.vsAutoConfig.deskPort;

function allowed(port) {
  const sender = port.sender;
  if (
    sender?.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !Number.isInteger(sender.tab?.id) ||
    !sender.url
  )
    return false;
  try {
    const url = new URL(sender.url);
    if (port.name === 'vs-desk')
      return url.origin === localOrigin && ['/', '/index.html'].includes(url.pathname);
    return (
      port.name === 'vs-source' &&
      url.origin === 'https://next.vestmarkets.com' &&
      url.pathname.startsWith('/trade/')
    );
  } catch {
    return false;
  }
}

function post(port, message) {
  try {
    port.postMessage(message);
  } catch {
    /* The disconnect listener releases this document. */
  }
}

function reconcile() {
  const chosen = new Map();
  for (const desk of desks.values()) {
    const matching = [...sources.values()].filter((s) => s.symbol && s.symbol === desk.symbol);
    const source = matching.length === 1 ? matching[0] : null;
    if (source) chosen.set(source.port, true);
    const state = source ? 'connected' : matching.length > 1 ? 'ambiguous' : 'waiting';
    if (desk.source === source && desk.state === state) continue;
    desk.source = source;
    desk.state = state;
    if (!desk.symbol) continue;
    const message =
      state === 'ambiguous'
        ? '有多个相同品种的 VS 页面，无法确定账户来源。'
        : source
          ? '已找到对应 VS 页面，等待读取可见行情。'
          : '等待同一浏览器中的 ' + desk.symbol + ' VS 交易页。';
    post(desk.port, source?.last ?? { type: 'waiting', symbol: desk.symbol, message });
  }
  for (const s of sources.values()) {
    const wanted = chosen.has(s.port);
    if (wanted === s.enabled) continue;
    s.enabled = wanted;
    s.last = null;
    s.token = ++generation;
    post(s.port, { type: wanted ? 'enable' : 'disable', symbol: s.symbol, token: s.token });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (!allowed(port)) {
    port.disconnect();
    return;
  }
  if (port.name === 'vs-desk') {
    const desk = { port, symbol: null, source: null, state: null };
    desks.set(port, desk);
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'start' && validSymbol(msg.symbol)) {
        desk.symbol = msg.symbol;
        desk.state = null;
        reconcile();
      } else if (msg?.type === 'stop') {
        desk.symbol = null;
        reconcile();
      }
    });
    port.onDisconnect.addListener(() => {
      desks.delete(port);
      reconcile();
    });
    return;
  }
  const src = { port, symbol: null, token: 0, enabled: false, last: null };
  sources.set(port, src);
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'route') {
      const symbol = validSymbol(msg.symbol) ? msg.symbol : null;
      if (src.symbol !== symbol) {
        src.symbol = symbol;
        src.enabled = false;
        src.token = ++generation;
        src.last = null;
        reconcile();
      }
      return;
    }
    if (
      !src.enabled ||
      msg?.token !== src.token ||
      msg.symbol !== src.symbol ||
      !['error', 'waiting', 'snapshot'].includes(msg.type)
    )
      return;
    const update = { type: msg.type, symbol: src.symbol };
    if (msg.type === 'snapshot') {
      if (msg.snapshot?.symbol !== src.symbol) return;
      update.snapshot = msg.snapshot;
    }
    if (typeof msg.message === 'string') update.message = msg.message.slice(0, 240);
    src.last = update;
    for (const d of desks.values()) if (d.source === src && d.symbol === src.symbol) post(d.port, update);
  });
  port.onDisconnect.addListener(() => {
    sources.delete(port);
    reconcile();
  });
});
