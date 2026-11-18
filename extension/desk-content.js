(() => {
  'use strict';
  const symbolOK = (v) => typeof v === 'string' && /^[A-Z0-9][A-Z0-9._:-]{0,48}$/.test(v);
  const correctPage = () =>
    window === window.top &&
    location.origin === 'http://127.0.0.1:' + globalThis.vsAutoConfig.deskPort &&
    ['/', '/index.html'].includes(location.pathname) &&
    document.querySelector('meta[name="vs-hype-app"]')?.content === 'vs-hype-matcher' &&
    document.title === 'VS × Hype 多品种动态对冲匹配器';
  if (!correctPage()) return;
  let port, symbol, retry, keepalive;
  function emit(value) {
    if (correctPage())
      window.dispatchEvent(new CustomEvent('vs-auto-update', { detail: JSON.stringify(value) }));
  }
  function release() {
    symbol = null;
    clearTimeout(retry);
    clearInterval(keepalive);
    const old = port;
    port = null;
    old?.disconnect();
  }
  function connect() {
    if (!symbol || !correctPage()) {
      release();
      return;
    }
    try {
      const next = chrome.runtime.connect({ name: 'vs-desk' });
      port = next;
      next.onMessage.addListener((msg) => {
        if (port !== next || !correctPage() || msg?.symbol !== symbol) return;
        if (['waiting', 'error', 'snapshot'].includes(msg.type)) emit(msg);
      });
      next.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (port !== next || !symbol) return;
        port = null;
        emit({ type: 'waiting', symbol, message: '扩展中继暂时断开，正在重新连接。' });
        retry = setTimeout(connect, 1000);
      });
      next.postMessage({ type: 'start', symbol });
    } catch {
      release();
      emit({ type: 'error', message: '扩展连接已失效，请刷新本机看板。' });
    }
  }
  window.addEventListener('vs-auto-command', (e) => {
    if (!correctPage() || e.target !== window || typeof e.detail !== 'string' || e.detail.length > 256)
      return;
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (msg?.type === 'probe') {
      emit({ type: 'ready' });
      return;
    }
    if (msg?.type === 'stop') {
      const previous = symbol;
      release();
      emit({ type: 'stopped', symbol: previous });
      return;
    }
    if (msg?.type !== 'start' || !symbolOK(msg.symbol)) return;
    if (!navigator.userActivation?.isActive) {
      emit({ type: 'error', symbol: msg.symbol, message: '请点击看板中的启动采集按钮。' });
      return;
    }
    release();
    symbol = msg.symbol;
    connect();
    keepalive = setInterval(() => {
      try {
        port?.postMessage({ type: 'ping' });
      } catch {}
    }, 20000);
  });
  window.addEventListener('pagehide', release);
  window.addEventListener('pageshow', () => emit({ type: 'ready' }));
  emit({ type: 'ready' });
})();
