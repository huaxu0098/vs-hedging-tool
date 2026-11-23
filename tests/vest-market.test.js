import test from 'node:test';
import assert from 'node:assert/strict';
import { vestMarketSymbol, vestQuoteReader, vestPageURL, subscribeVestMarket } from '../src/vest-market.js';

const symbol = 'BTC-PERP',
  now = 200000;
const ticker = (tsMs) => ({
  channel: symbol + '@ticker',
  tsMs,
  data: { symbol, markPrice: '101', capitalStatus: 'TRADING', status: 'TRADING' }
});
const depth = (tsMs) => ({
  channel: symbol + '@depth',
  tsMs,
  data: {
    bids: [
      ['99', '1'],
      ['100', '2']
    ],
    asks: [
      ['102', '1'],
      ['101', '2']
    ]
  }
});

test('Vest 交易地址绑定精确 HTTPS 来源和合约', () => {
  assert.equal(vestMarketSymbol(vestPageURL(symbol) + '?x=1'), symbol);
  for (const url of [
    'https://next.vestmarkets.com.evil.test/trade/BTC-PERP',
    'http://next.vestmarkets.com/trade/BTC-PERP',
    'https://next.vestmarkets.com/market/BTC',
    'https://x@next.vestmarkets.com/trade/BTC',
    'https://next.vestmarkets.com/trade/BTC%2FUSD'
  ])
    assert.throws(() => vestMarketSymbol(url));
});
test('Vest 公共行情只采用同合约的标记和盘口，使用两者中较早的源时间', () => {
  const read = vestQuoteReader(symbol);
  assert.equal(read(ticker(now - 20), now), null);
  assert.equal(read({ ...depth(now), channel: 'ETH-PERP@depth' }, now), null);
  assert.deepEqual(read(depth(now - 10), now), {
    symbol,
    bid: 100,
    ask: 101,
    mark: 101,
    open: true,
    timeSource: 'source',
    asOf: new Date(now - 20).toISOString()
  });
  assert.equal(read(depth(now), now).asOf, new Date(now - 20).toISOString());
  assert.equal(read(depth(now - 50), now), null);
  const m = ticker(now);
  m.data.capitalStatus = 'HALTED';
  assert.equal(read(m, now).open, false);
});
test('Vest 报价缺来源、时间在未来、盘口倒挂或标记串品种时不采信', () => {
  for (const m of [
    { ...ticker(now), tsMs: null },
    depth(now + 5000),
    { ...depth(now), data: { bids: [[102, 1]], asks: [[100, 1]] } },
    { ...ticker(now), data: { symbol: 'ETH-PERP', markPrice: 1 } }
  ])
    assert.throws(() => vestQuoteReader(symbol)(m, now));
});


test('Vest 三秒停止交付，持续断流才重连，并隔离旧连接的回调',t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now});
  const sockets=[], quotes=[], health={};
  class Socket {
    readyState=1;
    requests=[];
    constructor(){sockets.push(this);}
    send(msg){this.requests.push(JSON.parse(msg));}
    close(){this.readyState=2;}
    message(value){this.onmessage({data:JSON.stringify(value)});}
  }
  const original=globalThis.WebSocket;
  globalThis.WebSocket=Socket;
  t.after(()=>{globalThis.WebSocket=original;});
  const stop=subscribeVestMarket(symbol,q=>quotes.push(q),()=>{},
    {random:()=>0,onHealth:update=>Object.assign(health,update)});
  try {
    const first=sockets[0];
    first.onopen();first.onopen();
    assert.equal(first.requests.length,1);
    first.message(depth(now));first.message(ticker(now));
    first.onmessage({data:'bad json'});
    assert.equal(health.parseErrors,1);
    t.mock.timers.tick(3500);
    first.message({result:null});first.message(ticker(Date.now()));
    assert.equal(health.subscription,'stale');
    assert.equal(health.connected,true);
    assert.equal(Date.parse(health.lastBookAt),now);
    assert.equal(Date.parse(health.lastMarkAt),Date.now());
    t.mock.timers.tick(9000);
    assert.equal(health.connected,false);
    assert.match(health.lastDisconnectReason,/盘口/);
    t.mock.timers.tick(1000);
    assert.equal(sockets.length,1);
    first.readyState=3;
    t.mock.timers.tick(1000);
    const next=sockets[1];next.onopen();
    assert.notEqual(first.requests[0].id,next.requests[0].id);
    assert.deepEqual(next.requests[0].params,[symbol+'@depth',symbol+'@ticker']);
    assert.equal(health.reconnectCount,1);
    const count=quotes.length;
    first.message(ticker(Date.now()));next.message(depth(Date.now()));
    assert.equal(quotes.length,count);
    next.message(ticker(Date.now()));
    assert.equal(quotes.at(-1).asOf,new Date(Date.now()).toISOString());
    next.onerror();
    assert.equal(Date.parse(health.nextRetryAt)-Date.now(),2000);
  } finally {stop();}
});

test('Vest 连续失败按带抖动退避并封顶，只有持续有效双流才能恢复初始等待',t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now});
  const sockets=[], health={};
  const original=globalThis.WebSocket;
  globalThis.WebSocket=class {
    readyState=1;
    constructor(){sockets.push(this);}
    send(){}
    close(){this.readyState=3;}
  };
  t.after(()=>{globalThis.WebSocket=original;});
  const stop=subscribeVestMarket(symbol,()=>{},()=>{},{random:()=>0.5,onHealth:update=>Object.assign(health,update)});
  try {
    for(const delay of [1500,3000,6000,12000,24000,45000,45000]){
      const ws=sockets.at(-1);
      ws.onopen();
      for(const frame of [depth(Date.now()),ticker(Date.now())]) ws.onmessage({data:JSON.stringify(frame)});
      ws.onerror();
      assert.equal(Date.parse(health.nextRetryAt)-Date.now(),delay);
      const count=sockets.length;
      t.mock.timers.tick(delay-1);assert.equal(sockets.length,count);
      t.mock.timers.tick(1);assert.equal(sockets.length,count+1);
    }
    const stable=sockets.at(-1);stable.onopen();
    for(let i=0;i<62;i++) {
      for(const frame of [depth(Date.now()),ticker(Date.now())]) stable.onmessage({data:JSON.stringify(frame)});
      t.mock.timers.tick(1000);
    }
    stable.onerror();
    assert.equal(Date.parse(health.nextRetryAt)-Date.now(),1500);
  } finally {stop();}
});
