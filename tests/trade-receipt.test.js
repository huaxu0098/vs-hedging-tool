import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const service = readFileSync(new URL('../trade-extension/service.js', import.meta.url), 'utf8');
const desk = 'http://127.0.0.1:4178/trade.html';
const tabs = [
  { id: 31, url: 'https://next.vestmarkets.com/trade/BTC-PERP' },
  { id: 32, url: 'https://app.hyperliquid.xyz/trade/BTC' }
];
function fixture() {
  const storage = new Map(),
    clicks = [];
  const order = {
    assetId: 'btc',
    expires: Date.now() + 60000,
    legs: [
      {
        venue: 'vs',
        symbol: 'BTC-PERP',
        side: 'buy',
        quantity: '0.1',
        unit: 'BTC',
        notional: 10000,
        accountContext: 'fixture-account',
        stage: 'challenge',
        currentQty: 0,
        leverage: 10,
        marginMode: 'cross'
      },
      {
        venue: 'hype',
        symbol: 'BTC',
        side: 'sell',
        quantity: '0.02',
        unit: 'BTC',
        notional: 2000,
        address: '0x' + '1'.repeat(40),
        currentQty: 0,
        leverage: 10,
        marginMode: 'cross'
      }
    ]
  };
  // New worker instances get fresh in-memory state but retain Chrome's durable storage.
  function startWorker(acknowledgeClick = () => ({ ok: true })) {
    let listener;
    const chrome = {
      runtime: {
        id: 'fixture',
        onMessage: {
          addListener(fn) {
            listener = fn;
          }
        }
      },
      action: { onClicked: { addListener() {} } },
      storage: {
        local: {
          async get(key) {
            return { [key]: structuredClone(storage.get(key)) };
          },
          async set(values) {
            for (const [key, record] of Object.entries(values)) storage.set(key, structuredClone(record));
          },
          async remove(key) {
            storage.delete(key);
          }
        }
      },
      tabs: {
        async get(id) {
          return { id, url: desk };
        },
        async query({ url }) {
          return tabs.filter((tab) => new URL(tab.url).origin === new URL(url).origin);
        },
        async sendMessage(tabId, message) {
          if (message.type === 'confirm-plan') return structuredClone(order);
          if (message.type === 'submit') {
            clicks.push(tabId);
            return acknowledgeClick();
          }
          return { ok: true };
        }
      }
    };
    runInNewContext(service, { vsAutoConfig: { deskPort: 4178 }, chrome, crypto, URL });
    return (tabId, type, fields = {}) =>
      new Promise((resolve) => {
        const sender = {
          id: chrome.runtime.id,
          frameId: 0,
          url: desk,
          tab: { id: tabId },
          documentId: String(tabId)
        };
        listener({ type, plan: order, ...fields }, sender, resolve);
      });
  }
  return { startWorker, clicks };
}

test('旧窗口核对的第一笔回执不能释放另一窗口的新委托', async () => {
  const { startWorker, clicks } = fixture();
  const send = startWorker();
  await send(1, 'execute');
  const first = (await send(2, 'status')).receipt;
  assert.equal((await send(1, 'ack', { receiptId: first.id })).receipt, null);
  const second = (await send(1, 'execute')).receipt;
  assert.notEqual(first.id, second.id);
  const stale = await send(2, 'ack', { receiptId: first.id });
  assert.equal(stale.receipt.id, second.id);
  const retry = await send(2, 'execute');
  assert.equal(retry.receipt.id, second.id);
  assert.deepEqual(clicks, [31, 32, 31, 32]);
  assert.equal((await send(2, 'ack', { receiptId: second.id })).receipt, null);
});

test('两边已收到提交但尚未回执时重启，既能恢复原记录也不会重复点击', { timeout: 2000 }, async () => {
  const { startWorker, clicks } = fixture();
  const dispatched = Promise.withResolvers();
  const beforeRestart = startWorker(() => {
    if (clicks.length === 2) dispatched.resolve();
    // Both tabs received the original submission. The worker stops before results return.
    return new Promise(() => {});
  });
  void beforeRestart(1, 'execute');
  await dispatched.promise;
  const restarted = startWorker();
  const pending = (await restarted(2, 'status')).receipt;
  assert.ok(pending.id);
  assert.equal(pending.legs.length, 2);
  assert.ok(pending.legs.every((leg) => leg.status === '提交结果待核对'));
  assert.equal((await restarted(2, 'execute')).receipt.id, pending.id);
  assert.deepEqual(clicks, [31, 32]);
});
