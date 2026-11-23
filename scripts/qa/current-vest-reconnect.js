// Disconnect only this test's public BTC subscription. The workbench keeps its own socket.
import assert from 'node:assert/strict';
import {subscribeVestMarket} from '../../src/vest-market.js';

const NativeSocket=globalThis.WebSocket;
const sockets=[];
globalThis.WebSocket=class extends NativeSocket {
  constructor(url) {
    super(url);
    sockets.push(this);
  }
};
const health={};
let initial,stop,timer;
try {
  const restored=await new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(Error('Vest 未在测试时限内完成双通道重订阅')),60000);
    stop=subscribeVestMarket('BTC-PERP',quote=>{
      const evidence={connection:health.connectionId,subscription:health.subscriptionId,
        book:quote.bookAt,mark:quote.markAt};
      if (!initial) {
        initial=evidence;
        sockets[0].close(1000,'QA controlled disconnect');
      } else if (initial.connection!==evidence.connection && Date.parse(evidence.book)>Date.parse(initial.book) &&
          Date.parse(evidence.mark)>Date.parse(initial.mark)) resolve(evidence);
    },()=>{},{includeDepth:true,onHealth:update=>Object.assign(health,update)});
  });
  assert.equal(sockets[0].readyState,NativeSocket.CLOSED);
  assert.notEqual(initial.subscription,restored.subscription);
  assert.equal(health.subscription,'streaming');
  assert.ok(health.lastDisconnectReason && health.lastReconnectAt);
  console.log(JSON.stringify({initial,restored,reconnects:health.reconnectCount,reason:health.lastDisconnectReason}));
} finally {
  clearTimeout(timer);
  stop?.();
  globalThis.WebSocket=NativeSocket;
}
