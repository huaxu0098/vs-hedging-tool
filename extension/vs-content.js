(() => {
  'use strict';
  if (window !== window.top || location.origin !== 'https://next.vestmarkets.com') return;
  const symbolOK = (s) => typeof s === 'string' && /^[A-Z0-9][A-Z0-9._:-]{0,48}$/.test(s);
  function routeSymbol() {
    if (location.origin !== 'https://next.vestmarkets.com') return null;
    const match = /^\/trade\/([^/]+)\/?$/.exec(location.pathname);
    try {
      const s = match && decodeURIComponent(match[1]).toUpperCase();
      return symbolOK(s) ? s : null;
    } catch {
      return null;
    }
  }
  let port = null,
    route,
    active = null,
    observer,
    debounce,
    watchdog,
    reconnect,
    lastMessage,
    suspended = false;
  const seen = new Map(); // Per-document freshness survives stop/start, never goes to disk.
  globalThis.isVestReaderActive = (symbol) =>
    !!active && active.symbol === symbol && routeSymbol() === symbol;
  function stopScan() {
    globalThis.resetVestAccountBinding?.(document);
    active = null;
    observer?.disconnect();
    clearTimeout(debounce);
    lastMessage = null;
  }
  function post(msg) {
    try {
      port?.postMessage(msg);
    } catch {}
  }
  function updateRoute() {
    const next = routeSymbol();
    if (route === next) return;
    stopScan();
    route = next;
    post({ type: 'route', symbol: route });
  }
  function send(kind, fields = {}) {
    if (!active || active.symbol !== routeSymbol()) return;
    const msg = { type: kind, ...fields, symbol: active.symbol, token: active.token };
    const key = JSON.stringify(msg);
    if (key === lastMessage) return;
    lastMessage = key;
    post(msg);
  }
  const numeric = (n) => typeof n === 'number' && Number.isFinite(n);
  function sourceTime(source) {
    if (source == null) return null;
    const ms = typeof source === 'number' ? source : Date.parse(source);
    if (!Number.isFinite(ms) || ms <= 0 || ms > Date.now()) throw Error('VS 页面时间无效或晚于本机时间。');
    return new Date(ms).toISOString();
  }
  function fieldClock(fields, values, source, accountSnapshot = false) {
    const provided = sourceTime(source);
    for (const [key, value] of Object.entries(values)) {
      const fingerprint = JSON.stringify(value);
      const prior = fields.get(key);
      if (!prior || prior.fingerprint !== fingerprint) {
        fields.set(key, {
          fingerprint,
          asOf: provided ?? new Date().toISOString(),
          timeSource: provided ? 'source' : 'capture'
        });
      } else if (provided && (provided <= prior.asOf || accountSnapshot)) {
        // A timestamp explicitly labelled as an account snapshot attests the
        // visible fields in that snapshot. A market timestamp alone cannot
        // prove a stationary top-of-book field was independently refreshed.
        prior.asOf = provided;
        prior.timeSource = 'source';
      }
    }
    // Keep the clocks of temporarily absent fields. Removing an older number
    // must neither reveal a newer group age nor refresh it on reappearance.
    let oldest = null;
    for (const field of fields.values()) {
      if (
        !oldest ||
        field.asOf < oldest.asOf ||
        (field.asOf === oldest.asOf && field.timeSource === 'capture')
      )
        oldest = field;
    }
    return oldest;
  }
  function position(row) {
    if (
      !row ||
      typeof row.symbol !== 'string' ||
      !symbolOK(row.symbol.toUpperCase()) ||
      !numeric(row.qty) ||
      !numeric(row.entry) ||
      row.entry <= 0
    )
      throw Error('VS 持仓字段不完整。');
    const out = { symbol: row.symbol.toUpperCase(), qty: row.qty, entry: row.entry };
    for (const k of ['upnl', 'marginUsed']) if (numeric(row[k])) out[k] = row[k];
    return out;
  }
  function capture(raw) {
    const symbol = active.symbol,
      snapshot = { symbol };
    let memory = seen.get(symbol);
    if (!memory) {
      memory = { quote: new Map(), account: new Map(), positionDetails: new Map() };
      seen.set(symbol, memory);
    }
    if (seen.size > 32) seen.delete(seen.keys().next().value);
    const quote = raw.quote;
    if (quote) {
      for (const k of ['bid', 'ask', 'mark']) if (numeric(quote[k]) && quote[k] > 0) snapshot[k] = quote[k];
      if (snapshot.bid && snapshot.ask && snapshot.bid > snapshot.ask) throw Error('VS 页面买卖价交叉。');
      if (snapshot.bid || snapshot.ask || snapshot.mark) {
        const visible = {};
        for (const k of ['bid', 'ask', 'mark']) if (snapshot[k] != null) visible[k] = snapshot[k];
        const ts = fieldClock(memory.quote, visible, quote.asOf);
        snapshot.asOf = ts.asOf;
        snapshot.timeSource = ts.timeSource;
      }
      if (typeof quote.open === 'boolean') snapshot.open = quote.open;
    }
    if (raw.account) {
      const inAccount = raw.account,
        a = {};
      const binding = inAccount.accountContext;
      const bound = typeof binding === 'string' && /^[a-f0-9-]{36}$/i.test(binding);
      for (const k of ['balance', 'equity', 'used', 'free']) if (numeric(inAccount[k])) a[k] = inAccount[k];
      if (['challenge', 'funded'].includes(inAccount.stage)) a.stage = inAccount.stage;
      if (Array.isArray(inAccount.positions))
        a.positions = inAccount.positions.map(position).sort((x, y) => x.symbol.localeCompare(y.symbol));
      if (Object.keys(a).length || bound) {
        const fields = { ...a };
        if (a.positions) {
          // The extractor emits a list only for an identifiable positions
          // table. An explicit empty list is a real change. Temporarily lost
          // optional cells in an existing row do not refresh its fingerprint.
          const details = new Map();
          fields.positions = a.positions.map((row) => {
            const merged = { ...memory.positionDetails.get(row.symbol), ...row };
            details.set(row.symbol, merged);
            return merged;
          });
          memory.positionDetails = details;
        }
        if (bound) {
          a.accountContext = binding;
          const evidence = inAccount.outcome;
          if (evidence && ['passed', 'failed'].includes(evidence.status) && evidence.asOf) {
            a.outcome = {
              status: evidence.status,
              asOf: sourceTime(evidence.asOf),
              symbol,
              accountContext: binding,
              source: 'vest-page'
            };
          }
        }
        const ts = Object.keys(fields).length
          ? fieldClock(memory.account, fields, inAccount.asOf, true)
          : fieldClock((memory.identity ??= new Map()), { binding }, inAccount.asOf ?? a.outcome?.asOf, true);
        a.asOf = ts.asOf;
        a.timeSource = ts.timeSource;
        snapshot.account = a;
      }
    }
    return snapshot;
  }
  function scan() {
    updateRoute();
    if (!active) return;
    try {
      const raw = globalThis.readVisibleVest(document, location);
      if (!raw || raw.symbol !== active.symbol || (raw.reason && !raw.quote && !raw.account)) {
        send('waiting', { message: raw?.reason || 'VS 当前页面未显示匹配品种。' });
        return;
      }
      const snapshot = capture(raw);
      if (!snapshot.asOf && !snapshot.account) {
        send('waiting', { message: raw.reason || 'VS 未显示可识别的行情或账户字段。' });
        return;
      }
      send('snapshot', { snapshot, ...(raw.reason ? { message: raw.reason } : {}) });
    } catch (err) {
      send('error', { message: err?.message || 'VS 页面当前无法读取。' });
    }
  }
  function scheduleScan() {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      scan();
    }, 120);
  }
  function connect() {
    if (suspended) return;
    try {
      const next = chrome.runtime.connect({ name: 'vs-source' });
      port = next;
      route = undefined;
      updateRoute();
      next.onMessage.addListener((msg) => {
        if (next !== port) return;
        stopScan();
        debounce = null;
        if (msg?.type !== 'enable' || !Number.isInteger(msg.token) || msg.symbol !== routeSymbol()) return;
        active = { symbol: msg.symbol, token: msg.token };
        observer = new MutationObserver(scheduleScan);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true
        });
        scan();
      });
      next.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (next !== port) return;
        port = null;
        stopScan();
        if (!suspended) reconnect = setTimeout(connect, 1500);
      });
    } catch {
      stopScan();
    }
  }
  function wake() {
    suspended = false;
    clearInterval(watchdog);
    watchdog = setInterval(() => {
      updateRoute();
      if (active) scan();
    }, 1000);
    if (!port) connect();
  }
  window.addEventListener('pagehide', () => {
    suspended = true;
    clearTimeout(reconnect);
    clearInterval(watchdog);
    stopScan();
    const old = port;
    port = null;
    old?.disconnect();
  });
  window.addEventListener('pageshow', () => {
    if (suspended) wake();
  });
  window.addEventListener('popstate', updateRoute);
  wake();
})();
