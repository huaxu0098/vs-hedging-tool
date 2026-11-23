import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeHypeMarket } from '../src/hedge/adapters.js';

test('Hype 新连接必须重新确认两条订阅、心跳、盘口与 Mark；单通道过期即隔离旧连接',t=>{
  t.mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:100000});
  const sockets=[],h={},original=globalThis.WebSocket;
  globalThis.WebSocket=class {
    sent=[];
    constructor(){sockets.push(this);}
    send(s){this.sent.push(JSON.parse(s));}
    frame(channel,data){this.onmessage({data:JSON.stringify({channel,data})});}
    close(){}
  };
  const stop=subscribeHypeMarket('BTC',()=>{},update=>Object.assign(h,update));
  t.after(()=>{stop();globalThis.WebSocket=original;});
  const open=ws=>{
    ws.onopen();
    assert.deepEqual(ws.sent.map(m=>m.subscription?.type??m.method),['l2Book','activeAssetCtx','ping']);
    assert.ok(ws.sent[0].subscription.fast);
    for(const m of ws.sent.slice(0,2)) ws.frame('subscriptionResponse',m);
  };
  const book=(ws,coin='BTC')=>ws.frame('l2Book',{coin,time:Date.now(),levels:[[{px:'10',sz:'1'}],[{px:'11',sz:'1'}]]});
  const mark=ws=>ws.frame('activeAssetCtx',{coin:'BTC',ctx:{oraclePx:'10',funding:'0',markPx:'10'}});
  const first=sockets[0];open(first);
  for(let i=0;i<2;i++){t.mock.timers.tick(100);mark(first);book(first);}
  assert.notEqual(h.subscription,'streaming');
  first.frame('pong',{});assert.equal(h.subscription,'streaming');
  for(let i=0;i<4;i++){t.mock.timers.tick(850);mark(first);}
  assert.equal(h.subscription,'stale');assert.equal(h.continuous,false);
  t.mock.timers.tick(600);
  const next=sockets[1];open(next);next.frame('pong',{});
  for(let i=0;i<2;i++){t.mock.timers.tick(100);mark(next);book(next,'ETH');book(first);}
  assert.equal(h.lastBookAt,null);
  assert.notEqual(h.subscription,'streaming');
  book(next);t.mock.timers.tick(100);book(next);
  assert.equal(h.subscription,'streaming');assert.equal(h.reconnectCount,1);
});
