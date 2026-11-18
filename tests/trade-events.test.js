import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTemplates } from '../src/assets.js';
import { applySimulation, createSimulation } from '../src/simulation.js';
import { readTradeEvents } from '../src/trade-events.js';

const ledger = JSON.parse(readFileSync(new URL('../fixtures/ledger-example.json', import.meta.url)));

test('同一时刻开平仓分别取最近成交；账户失败不归因于当前品种', () => {
  const btc = readTradeEvents(ledger, 'btc'),
    gold = readTradeEvents(ledger, 'xau');
  assert.equal(btc.latest.label, '平仓');
  assert.equal(btc.latest.fills.length, 2);
  assert.equal(btc.latest.vsNet, ledger.history[3].gross - ledger.history[3].fee);
  assert.equal(btc.latest.hypeNet, ledger.history[4].gross - ledger.history[4].fee);
  assert.equal(btc.latest.receipt, null);
  assert.equal(btc.accountEvent.kind, 'challenge-fail');
  assert.equal(btc.accountEvent.assetId, null);
  assert.equal(btc.accountEvent.vsNet, null);
  assert.equal(gold.latest, null);
  assert.deepEqual(gold.positions, []);
  assert.deepEqual(gold.accountEvent, btc.accountEvent);
});

test('首次模拟出金只使用入账流水的收款字段，不能从 Hype 现金或累计款反推', () => {
  const now = Date.parse('2026-01-05T09:30:00Z'),
    assets = createTemplates(now);
  const ctx = { now, assets, asset: assets[0] };
  const seed = createSimulation({}, now);
  assert.equal(readTradeEvents(seed, 'btc').accountEvent, null);
  const adopted = applySimulation(
    seed,
    {
      type: 'adopt',
      account: {
        stage: 'funded',
        vsBalance: 10200,
        hypeCash: 409,
        positions: []
      }
    },
    ctx
  );
  const paid = applySimulation(adopted, { type: 'withdraw' }, ctx);
  const view = readTradeEvents(paid, 'btc');
  assert.equal(view.latest, null);
  assert.equal(view.accountEvent.receipt, 160);
  assert.equal(view.accountEvent.hypeCash, 569);
  delete paid.history.at(-1).receipt;
  assert.equal(readTradeEvents(paid, 'btc').accountEvent.receipt, null);
});

test('当前持仓按品种取已存均价和数量；冲突观察不产生实际强平或出金', () => {
  const s = createSimulation();
  s.positions = [
    {
      assetId: 'btc',
      venue: 'hype',
      qty: -0.01,
      entry: 100000,
      margin: 100,
      asset: { hype: { qtyUnit: 'BTC' } }
    },
    { assetId: 'xau', venue: 'vs', qty: 0.1, entry: 2500, margin: 12 }
  ];
  s.observation = {
    revision: s.revision,
    pending: false,
    proofs: [
      {
        event: 'success',
        time: 1000,
        assets: [{ id: 'btc' }, { id: 'xau' }],
        cash: 0,
        status: 'withdrawn'
      },
      { event: 'liquidation', time: 1001, assets: [{ id: 'btc' }], cash: -400, status: 'liquidated' }
    ]
  };
  const v = readTradeEvents(s, 'btc');
  assert.deepEqual(
    v.positions.map((p) => [p.qty, p.unit, p.entry]),
    [[-0.01, 'BTC', 100000]]
  );
  assert.deepEqual(v.pending.events, ['success', 'liquidation']);
  assert.equal(v.pending.ambiguous, true);
  assert.equal(v.pending.cash, undefined);
  assert.equal(v.accountEvent, null);
  assert.equal(v.latest, null);
  assert.equal(readTradeEvents(s, 'sol').pending, null);
  s.revision++;
  assert.equal(readTradeEvents(s, 'btc').pending, null);
});

test('旧账本的占用释放无成交与已实现盈亏，旧流水缺值保持未知', () => {
  const old = {
    version: 1,
    entries: [
      { id: 'a', assetId: 'btc', status: 'closed', reserve: 201, vsQty: 0.02 },
      { id: 'b', assetId: 'xau', status: 'open', reserve: 105 }
    ]
  };
  const v = readTradeEvents(old, 'btc');
  assert.equal(v.latest, null);
  assert.equal(v.accountEvent, null);
  assert.deepEqual(v.positions, []);
  assert.deepEqual(
    v.legacyReservations.map((r) => [r.label, r.reserve]),
    [['旧账本已释放占用', 201]]
  );
  const missing = { history: [{ label: '平仓', assetId: 'btc', venue: 'vs', qty: -1, gross: 0 }] };
  assert.equal(readTradeEvents(missing, 'btc', old).latest.vsNet, null);
  assert.equal(readTradeEvents(missing, 'btc', old).latest.hypeNet, null);
  assert.equal(readTradeEvents(missing, 'btc', old).latest.fills[0].gross, 0);
});
