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
export function vestQuoteReader(symbol, includeDepth = false, onClock = () => {}) {
  let book, ticker;
  return (message, now = Date.now()) => {
    const { channel, data, tsMs } = message ?? {};
    if (!['@depth', '@ticker'].some((s) => channel === symbol + s)) return null;
    if (!data || !Number.isSafeInteger(tsMs) || tsMs <= 0 || tsMs > now + 1000)
      throw Error('Vest 消息缺少可靠的来源时间。');
    if (channel === symbol + '@depth') {
      if (data.symbol!=null && data.symbol!==symbol) throw Error('Vest 盘口合约不符。');
      if (book && tsMs < book.time) return null;
      const bid = topPrice(data.bids, Math.max),
        ask = topPrice(data.asks, Math.min);
      if (!(bid > 0 && ask >= bid)) throw Error('Vest 盘口暂不完整或买卖价倒挂。');
      book = { bid, ask, time: tsMs };
      onClock('lastBookAt',tsMs);
      if (includeDepth) {
        const levels = (rows, sign) => rows.slice().sort((a, b) => sign * (Number(a[0]) - Number(b[0])))
          .slice(0, 5).map(([px, qty]) => [String(px), String(qty)]);
        book.levels = [levels(data.bids, -1), levels(data.asks, 1)];
      }
    } else {
      if (data.symbol !== symbol) throw Error('Vest 返回的合约与当前页面不符。');
      if (ticker && tsMs < ticker.time) return null;
      const mark = Number(data.markPrice);
      if (!(mark > 0 && Number.isFinite(mark))) throw Error('Vest 缺少有效标记价。');
      onClock('lastMarkAt',tsMs);
      ticker = { mark, open: data.capitalStatus === 'TRADING' && data.status === 'TRADING', time: tsMs };
    }
    if (!book || !ticker) return null;
    return {
      symbol,
      ...(includeDepth
        ? {
            levels: book.levels,
            bookAt: new Date(book.time).toISOString(),
            markAt: new Date(ticker.time).toISOString()
          }
        : {}),
      bid: book.bid,
      ask: book.ask,
      mark: ticker.mark,
      open: ticker.open,
      timeSource: 'source',
      asOf: new Date(Math.min(book.time, ticker.time)).toISOString()
    };
  };
}

let nextConnection = 0;
const iso = stamp => new Date(stamp).toISOString();

export function subscribeVestMarket(symbol, onQuote, onStatus, {includeDepth=false,onHealth=()=>{},random=Math.random}={}) {
  let socket, retiring, retry, watchdog, flushTimer, stopped=false, attempts=0, failures=0, parseErrors=0;
  function clearTimers() {
    clearTimeout(watchdog);
    clearTimeout(flushTimer);
    watchdog=flushTimer=null;
  }
  function retire(reason) {
    if (stopped || retry) return;
    clearTimers();
    retiring=socket;
    socket=null;
    const cap=Math.min(60000,2000*2**Math.min(failures++,5));
    const delay=Math.floor(cap*(0.5+random()*0.5));
    onHealth({connected:false,subscription:'disconnected',stableSince:null,lastDisconnectReason:reason,
      nextRetryAt:iso(Date.now()+delay)});
    onStatus(reason);
    try { retiring?.close(); } catch { /* The socket may already be closed. */ }
    retry=setTimeout(connect,delay);
  }
  function connect() {
    retry=null;
    if (stopped || socket) return;
    if (retiring && retiring.readyState!=null && retiring.readyState!==3) {
      retry=setTimeout(connect,1000);
      return;
    }
    retiring=null;
    const id=++nextConnection;
    const clocks={lastBookAt:null,lastMarkAt:null};
    const read=vestQuoteReader(symbol,includeDepth,(key,stamp)=>{
      if(stamp!==clocks[key]) {clocks[key]=stamp;onHealth({[key]:iso(stamp)});}
    });
    onHealth({connectionId:id,subscriptionId:null,connected:false,subscription:'connecting',reconnectCount:attempts,
      lastReconnectAt:attempts?iso(Date.now()):null,lastMessageAt:null,lastBookAt:null,lastMarkAt:null,lastValidQuoteAt:null,
      stableSince:null,nextRetryAt:null});
    attempts++;
    let ws;
    try {ws=socket=new WebSocket(socketURL);} catch {retire('Vest 建连失败');return;}
    const active=()=>!stopped && socket===ws;
    let opened=0, subscribed=false, stableSince=null, lastFresh=0, lastStamp=0, delivered=0, pending=null, state='connecting';
    function transition(value) {
      if(value!==state) {state=value;onHealth({subscription:value,stableSince:stableSince==null?null:iso(stableSince)});}
    }
    function watch() {
      if(!active()) return;
      const now=Date.now();
      if(!subscribed) {retire('Vest WebSocket 建连超时');return;}
      const age=lastFresh?now-lastFresh:now-opened;
      if(age>=12000) {
        const missing=Object.entries(clocks).filter(([,t])=>t==null || now-t>3000).map(([k])=>k==='lastBookAt'?'盘口':'Mark');
        retire('Vest '+missing.join(' / ')+' 持续未更新');return;
      }
      if(age>3000) {stableSince=null;transition('stale');}
      watchdog=setTimeout(watch,500);
    }
    watchdog=setTimeout(watch,8000);
    ws.onopen=()=>{
      if(!active() || subscribed) return;
      opened=Date.now();subscribed=true;
      onHealth({connected:true,subscriptionId:id});
      transition('subscribing');
      try {ws.send(JSON.stringify({method:'SUBSCRIBE',params:[symbol+'@depth',symbol+'@ticker'],id}));}
      catch {retire('Vest 发送订阅失败');return;}
      clearTimeout(watchdog);watch();
    };
    ws.onmessage=({data})=>{
      if(!active() || !subscribed) return;
      const now=Date.now();
      onHealth({lastMessageAt:iso(now)});
      let quote;
      try {
        const m=JSON.parse(data);
        if(m.error || m.subscription_outcomes?.some(o=>o.status!=='registered')) {retire('Vest 订阅被拒绝');return;}
        if(m.subscription_outcomes?.length && state==='subscribing') transition('registered');
        quote=read(m,now);
      } catch(error) {
        onHealth({parseErrors:++parseErrors,lastParseError:error.message});
        return;
      }
      const stamp=Date.parse(quote?.asOf);
      if(!quote || stamp<lastStamp || now-stamp>3000) return;
      if(stamp>lastStamp) {
        if(!lastFresh || now-lastFresh>3000) {
          stableSince=now;
          if(state==='streaming') onHealth({stableSince:iso(now)});
        }
        lastFresh=lastStamp=stamp;
        stableSince??=now;
        transition('streaming');
        if(now-stableSince>=60000) failures=0;
      }
      pending=quote;
      function publish() {
        flushTimer=null;
        if(active() && pending && Date.now()-Date.parse(pending.asOf)<=3000) {
          delivered=Date.now();onQuote(pending);
        }
        pending=null;
      }
      if(!flushTimer) {
        if(now-delivered>=200) publish();
        else flushTimer=setTimeout(publish,200-(now-delivered));
      }
    };
    ws.onerror=()=>{if(active()) retire('Vest WebSocket 连接错误');};
    ws.onclose=event=>{if(active()) retire('Vest WebSocket 关闭 '+(event?.code??'')+' '+(event?.reason??''));};
  }
  connect();
  return ()=>{stopped=true;clearTimeout(retry);clearTimers();socket?.close();};
}
