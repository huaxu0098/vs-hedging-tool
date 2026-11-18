import assert from 'node:assert/strict';
import test from 'node:test';
import { createTemplates } from '../src/assets.js';
import { evaluate } from '../src/engine.js';
import { LEDGER_KEY, bookPosition, closePosition, getLedger } from '../src/ledger.js';

function setupBrowser(t) {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const requests = [];
  let pending = Promise.resolve();
  const locks = {
    request(name, options, update) {
      requests.push({ name, mode: options.mode });
      const result = pending.then(update);
      pending = result.catch(() => {});
      return result;
    },
  };
  for (const [key, value] of Object.entries({ localStorage: storage, navigator: { locks } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  return { storage, requests };
}

const order = { vsUsd: 2000, hypeUsd: 2000, vsLong: true };

test('并发跨品种记账共用 500U，重复释放一条流水只解锁一次', async t => {
  const { requests } = setupBrowser(t);
  const templates = createTemplates();
  const btc = templates.find(asset => asset.id === 'btc');
  const gold = templates.find(asset => asset.id === 'xau');
  const expected = evaluate(btc, order, 500);
  assert.equal(expected.ok, true, expected.reasons.join(' '));
  const results = await Promise.allSettled([btc, gold, btc].map(asset => bookPosition(asset, order)));
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected']);
  const booked = getLedger();
  assert.equal(booked.capital, 500);
  assert.deepEqual(booked.entries.map(entry => entry.assetId), ['xau', 'btc']);
  const entry = booked.entries[1];
  assert.equal(entry.vsQty, expected.vs.qty);
  assert.equal(entry.hypeUsd, expected.hype.notional);
  assert.equal(booked.used, Math.round((entry.reserve + booked.entries[0].reserve) * 1e6) / 1e6);
  assert.equal(booked.available, Math.round((500 - booked.used) * 1e6) / 1e6);

  const [first, second] = await Promise.all([closePosition(entry.id), closePosition(entry.id)]);
  assert.deepEqual(first, second);
  assert.equal(first.entries[1].status, 'closed');
  assert.ok(Date.parse(first.entries[1].closedAt));
  assert.equal(getLedger().used, booked.entries[0].reserve);
  const allReleased = await closePosition(booked.entries[0].id);
  assert.equal(allReleased.available, 500);
  assert.equal(allReleased.entries.length, 2);
  assert.equal(requests.length, 6);
  assert.ok(requests.every(request => request.name === LEDGER_KEY && request.mode === 'exclusive'));
});

test('报价过期时重新拒绝记账', async t => {
  setupBrowser(t);
  const [asset] = createTemplates(Date.now() - 24 * 3600 * 1000);
  asset.maxAgeSec = 2;
  await assert.rejects(bookPosition(asset, order));
  assert.deepEqual(getLedger().entries, []);
});

test('损坏或不一致的账本拒绝读取和写入，保留原数据', async t => {
  const { storage } = setupBrowser(t);
  const [asset] = createTemplates();
  for (const raw of ['{', 'null', '{"version":1,"entries":[{}]}']) {
    storage.setItem(LEDGER_KEY, raw);
    assert.throws(getLedger, /账本数据损坏/);
    await assert.rejects(bookPosition(asset, order), /账本数据损坏/);
    assert.equal(storage.getItem(LEDGER_KEY), raw);
  }
});

test('写入失败或排他锁不可用时保留原先占用', async t => {
  const { storage } = setupBrowser(t);
  const [asset] = createTemplates();
  const booked = await bookPosition(asset, order);
  storage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(closePosition(booked.entries[0].id), /写入失败/);
  assert.deepEqual(getLedger(), booked);
  globalThis.navigator.locks = undefined;
  await assert.rejects(bookPosition(asset, order), /无法锁定/);
  assert.deepEqual(getLedger(), booked);
});
