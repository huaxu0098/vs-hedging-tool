const host = 'https://next.vestmarkets.com';
const socketURL = 'wss://ws.hz.vestmarkets.com/ws?version=1.0';

export function vestMarketSymbol(input) {
  const url = new URL(input);
  const match = /^\/trade\/([A-Z0-9][A-Z0-9._-]{0,48})\/?$/.exec(url.pathname);
  if (url.origin !== host || url.username || url.password || !match)
    throw Error('请填写完整的 Vest 合约页面，例如 https://next.vestmarkets.com/trade/BTC-PERP');
  return match[1];
}

export function vestPageURL(symbol) {
  return host + '/trade/' + encodeURIComponent(symbol);
}

function topPrice(side, best) {
  if (!Array.isArray(side) || !side.length) return null;
  const prices = [];
  for (const level of side) {
    if (!Array.isArray(level) || level.length < 2) return null;
    const [price, qty] = level.map(Number);
    if (!(price > 0 && Number.isFinite(price) && qty > 0 && Number.isFinite(qty))) return null;
    prices.push(price);
  }
  return best(...prices);
}

// Depth and mark have independent venue timestamps. Neither stream can renew the other.
export function vestQuoteReader(symbol) {
  let book, ticker;
  return (message, now = Date.now()) => {
    const { channel, data, tsMs } = message ?? {};
    if (!['@depth', '@ticker'].some((s) => channel === symbol + s)) return null;
    if (!data || !Number.isSafeInteger(tsMs) || tsMs <= 0 || tsMs > now + 1000)
      throw Error('Vest 消息缺少可靠的来源时间。');
    if (channel === symbol + '@depth') {
      if (book && tsMs < book.time) return null;
      const bid = topPrice(data.bids, Math.max),
        ask = topPrice(data.asks, Math.min);
      if (!(bid > 0 && ask >= bid)) throw Error('Vest 盘口暂不完整或买卖价倒挂。');
      book = { bid, ask, time: tsMs };
    } else {
      if (data.symbol !== symbol) throw Error('Vest 返回的合约与当前页面不符。');
      if (ticker && tsMs < ticker.time) return null;
      const mark = Number(data.markPrice);
      if (!(mark > 0 && Number.isFinite(mark))) throw Error('Vest 缺少有效标记价。');
      ticker = { mark, open: data.capitalStatus === 'TRADING' && data.status === 'TRADING', time: tsMs };
    }
    if (!book || !ticker) return null;
    return {
      symbol,
      bid: book.bid,
      ask: book.ask,
      mark: ticker.mark,
      open: ticker.open,
      timeSource: 'source',
      asOf: new Date(Math.min(book.time, ticker.time)).toISOString()
    };
  };
}

export function subscribeVestMarket(symbol, onQuote, onStatus) {
  let socket,
    retryTimer,
    watchdog,
    flushTimer,
    pending,
    stopped = false,
    retryMs = 1000;
  function clearTimers() {
    clearTimeout(watchdog);
    clearTimeout(flushTimer);
    pending = null;
  }
  function connect() {
    if (stopped) return;
    const read = vestQuoteReader(symbol);
    let deliveredAt = 0,
      lastReason = 'Vest 连接已断开，正在重连。';
    try {
      socket = new WebSocket(socketURL);
    } catch {
      onStatus('浏览器无法打开 Vest 公开行情连接。');
      return;
    }
    const ws = socket;
    const failed = (reason) => {
      if (stopped || socket !== ws) return;
      clearTimers();
      lastReason = reason;
      onStatus(reason);
      ws.close();
    };
    const watch = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => failed('Vest 行情等待超时，正在重连。'), 9000);
    };
    function flush() {
      flushTimer = undefined;
      if (pending && socket === ws && !stopped && ws.readyState === WebSocket.OPEN) {
        deliveredAt = Date.now();
        onQuote(pending);
        pending = null;
      }
    }
    watch();
    ws.onopen = () =>
      ws.send(
        JSON.stringify({ method: 'SUBSCRIBE', params: [symbol + '@depth', symbol + '@ticker'], id: 1 })
      );
    ws.onmessage = (event) => {
      if (socket !== ws || stopped || ws.readyState !== WebSocket.OPEN) return;
      try {
        const m = JSON.parse(event.data);
        if (m.error || m.subscription_outcomes?.some((o) => o.status !== 'registered')) {
          stopped = true;
          clearTimers();
          onStatus('Vest 未接受此精确合约订阅，请核对页面代码。');
          ws.close();
          return;
        }
        const quote = read(m);
        if (!quote) return;
        watch();
        retryMs = 1000;
        pending = quote;
        if (!flushTimer) flushTimer = setTimeout(flush, Math.max(0, 850 - (Date.now() - deliveredAt)));
      } catch (e) {
        failed(e.message);
      }
    };
    ws.onerror = () => failed('暂时连不上 Vest 公开行情，正在重连。');
    ws.onclose = () => {
      if (stopped || ws !== socket) return;
      clearTimers();
      onStatus(lastReason);
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(15000, retryMs * 2);
    };
  }
  connect();
  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    clearTimers();
    socket?.close();
  };
}
