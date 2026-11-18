import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG as config, analyzeCandidate, decide } from '../src/decision.js';
import { createTemplates } from '../src/assets.js';
import {
  applySimulation,
  createSimulation,
  accountView,
  firstPayout,
  historyCsv,
  valueAt
} from '../src/simulation.js';
import { compareRounds, makeDemo, parseCandles, previewScenario, runReplay, DEMOS } from '../src/replay.js';

const now = Date.parse('2026-01-05T09:30:00Z');
const assets = createTemplates(now);
const asset = assets[0];
const context = { assets, asset, now, config };
const seed = () => createSimulation(config, now);
const best = (s, a = asset) => {
  const r = decide(a, accountView(s, assets, config), config, {}, now);
  assert.ok(r.best, r.reasons.join('、'));
  return r.best;
};
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + ' vs ' + b);
const adopt = (values, s = seed()) =>
  applySimulation(
    s,
    {
      type: 'adopt',
      account: { stage: 'challenge', vsBalance: 10000, hypeCash: 409, positions: [], ...values }
    },
    context
  );

test('双账本 500 含报名费；生成候选与预览不会修改资金或流水', () => {
  const s = seed();
  const copy = structuredClone(s);
  assert.equal(s.hypeCash, 409);
  assert.equal(s.vsBalance, 10000);
  assert.equal(s.fees.registration, 91);
  const r = best(s);
  const preview = previewScenario(s, 'success', { ...context, order: r.requested });
  assert.deepEqual(s, copy);
  assert.equal(preview.state.stage, 'funded');
  assert.equal(preview.state.vsBalance, 10000);
  assert.equal(preview.state.received, 0);
  assert.ok(preview.state.fees.hype > 0 && preview.state.fees.vs > 0);
  assert.equal(preview.state.fees.registration, 91);
  approx(preview.state.hypeCash, 409 + preview.state.realized.hype - preview.state.fees.hype);
});

test('各腿按差量计费；多品种保证金汇总，平仓后费用不可返还', () => {
  const s = seed(),
    r = best(s);
  const opened = applySimulation(s, { type: 'target', order: r.requested }, context);
  const view = accountView(opened, assets, config, 12);
  approx(view.hypeUsed, r.hype.margin + 12);
  approx(opened.hypeCash, 409 - r.hype.tradeFee);
  const same = { ...r.requested, targetQty: { vs: r.vs.targetQty, hype: r.hype.targetQty } };
  const rerun = analyzeCandidate(asset, accountView(opened, assets, config), config, same, now);
  assert.equal(rerun.vs.tradeFee, 0);
  assert.equal(rerun.hype.tradeFee, 0);
  const gold = assets.find((a) => a.id === 'xau'),
    another = best(opened, gold);
  const two = applySimulation(
    opened,
    { type: 'target', order: another.requested },
    { ...context, asset: gold }
  );
  assert.equal(two.positions.length, 4);
  approx(accountView(two, assets).hypeUsed, r.hype.margin + another.hype.margin);
  const one = applySimulation(two, { type: 'close' }, { ...context, asset: gold });
  assert.equal(one.positions.length, 2);
  assert.ok(one.fees.hype > two.fees.hype);
  const flat = applySimulation(one, { type: 'day' }, context);
  assert.equal(flat.positions.length, 0);
  assert.equal(flat.day, 2);
  assert.equal(accountView(flat, assets).hypeUsed, 0);
  approx(flat.hypeCash, 409 + flat.realized.hype - flat.fees.hype);
  assert.ok(flat.hypeCash < 409);
});

test('扣费前 12005，实际可结算净值不足 12000 时禁止过关；显式标记判定独立', () => {
  const a = structuredClone(asset);
  a.vs.feeRate = 0.001;
  const local = { ...context, asset: a, assets: [a] };
  const s = applySimulation(
    seed(),
    {
      type: 'adopt',
      account: {
        stage: 'challenge',
        vsBalance: 12005,
        hypeCash: 409,
        positions: [{ assetId: a.id, venue: 'vs', qty: 0.08, entry: a.vs.price, margin: 800 }]
      }
    },
    local
  );
  const val = valueAt(s, [a], config);
  assert.equal(val.vsEquity, 12005);
  assert.ok(val.vsSettled < 12000);
  assert.throws(() => applySimulation(s, { type: 'event', event: 'success' }, local), /尚未达到/);
  const accepted = applySimulation(
    s,
    { type: 'event', event: 'success' },
    { ...local, config: { ...config, triggerMode: 'mark' } }
  );
  assert.equal(accepted.stage, 'funded');
  assert.equal(accepted.positions.length, 0);
});

test('考核失败的回本与未回本两种实际平仓结果', () => {
  const original = seed(),
    r = best(original);
  const p = previewScenario(original, 'failure', { ...context, order: r.requested });
  assert.equal(p.state.status, 'failed');
  assert.ok(p.state.hypeCash >= 500);
  const d = makeDemo('challengeFail', asset, config, now);
  const failed = runReplay(d.state, d.candles, d.assets, config);
  assert.equal(failed.last.event, 'failure');
  assert.ok(failed.state.hypeCash < 500);
});

test('首次出金按可结算净利计算，9000 和 9800 均不可提，10200 可提 160', () => {
  for (const balance of [9000, 9800]) {
    const s = adopt({ stage: 'funded', vsBalance: balance });
    assert.equal(firstPayout(s.vsBalance, config), 0);
    assert.throws(() => applySimulation(s, { type: 'withdraw' }, context), /可提款额为零/);
  }
  const terminal = applySimulation(
    adopt({ stage: 'funded', vsBalance: 10200 }),
    { type: 'withdraw' },
    context
  );
  assert.equal(terminal.received, 160);
  assert.equal(terminal.hypeCash, 569);
  assert.equal(terminal.status, 'withdrawn');
  assert.throws(() => applySimulation(terminal, { type: 'withdraw' }, context), /结束/);
  assert.equal(firstPayout(10200, config), 160);
});

test('日内未到线多日结转及连续交易的固定费率模型', () => {
  const s = seed(),
    r = best(s);
  let idle = s;
  for (let i = 0; i < 5; i++) idle = applySimulation(idle, { type: 'day' }, context);
  assert.equal(idle.day, 6);
  assert.equal(idle.hypeCash, 409);
  assert.equal(idle.fees.hype, 0);
  const rounds = compareRounds(s, asset, assets, config, r.requested, now);
  assert.deepEqual(
    rounds.rows.map((x) => x.n),
    [1, 2, 3, 5]
  );
  assert.ok(rounds.rows.every((x) => x.hypeCost > 0 && x.vsCost > 0));
  approx(rounds.rows[3].hypeCost, rounds.rows[0].hypeCost * 5);
  assert.equal(rounds.wait, rounds.stop);
  assert.equal(rounds.rebuy, 318);
  const abandoned = applySimulation(s, { type: 'abandon' }, context);
  const next = applySimulation(abandoned, { type: 'rebuy' }, context);
  assert.equal(next.hypeCash, 318);
  assert.equal(next.fees.registration, 182);
});

test('六个情景覆盖五种结局及同柱不确定；触线后立即停止', () => {
  for (const kind of Object.keys(DEMOS)) {
    const d = makeDemo(kind, asset, config, now);
    const extra = { ...d.candles.at(-1), ts: now + 3000 };
    const r = runReplay(d.state, [...d.candles, extra], d.assets, config);
    if (kind === 'day') {
      assert.equal(r.last.event, 'none');
      const flat = applySimulation(r.state, { type: 'day' }, { assets: r.assets, config, now: extra.ts });
      assert.equal(flat.positions.length, 0);
      assert.equal(flat.day, 2);
      continue;
    }
    assert.equal(r.steps.length, 2);
    if (kind === 'ambiguous') {
      assert.equal(r.last.event, 'uncertain');
      assert.match(r.last.reason, /顺序不确定/);
      assert.deepEqual(r.last.alternatives.map((x) => x.event).sort(), ['failure', 'success']);
      assert.equal(r.last.worst.cash, Math.min(...r.last.alternatives.map((x) => x.cash)));
      assert.equal(r.state.received, 0);
      assert.equal(r.state.stage, 'challenge');
    }
    if (kind === 'payout') assert.ok(r.state.received > 0 && r.state.status === 'withdrawn');
    if (kind === 'challengePass') assert.equal(r.state.stage, 'funded');
    if (kind === 'challengeFail' || kind === 'fundedFail') assert.equal(r.state.status, 'failed');
  }
});

test('CSV 多品种及错误区间，模拟账本审计 CSV 含实际成交与费用', async () => {
  const csv = await readFile(new URL('../fixtures/multi-asset-candles.csv', import.meta.url), 'utf8');
  const bars = parseCandles(csv, assets);
  assert.deepEqual([...new Set(bars.map((r) => r.assetId))], ['btc', 'xau', 'us100']);
  assert.throws(
    () => parseCandles('time,asset,open,high,low,close\n2026-01-01,BTC,100,99,60,90', assets),
    /区间无效/
  );
  const s = seed(),
    r = best(s),
    close = previewScenario(s, 'close', { ...context, order: r.requested });
  const exported = historyCsv(close.state);
  assert.match(exported, /gross,fee/);
  assert.match(exported, /开仓/);
  assert.match(exported, /平仓/);
});

test('导入保留外部未回收成本，已开本地仓位需先结清', () => {
  const imported = adopt({ externalUnrecovered: 17, hypeCash: 457 });
  assert.equal(accountView(imported, assets, config).externalUnrecovered, 17);
  const r = best(seed());
  const held = applySimulation(seed(), { type: 'target', order: r.requested }, context);
  assert.throws(() => adopt({}, held), /先结清/);
});

test('有仓时轮次比较使用副本结清；一次性平仓费用与后续等待费用各自核算', () => {
  const initial = seed(),
    r = best(initial),
    s = applySimulation(initial, { type: 'target', order: r.requested }, context);
  const copy = structuredClone(s);
  const rows = compareRounds(s, asset, assets, config, r.requested, now);
  assert.deepEqual(s, copy);
  assert.ok(rows.once.vs.fee > 0 && rows.once.hype.fee > 0);
  const flattened = applySimulation(s, { type: 'day' }, context);
  approx(rows.start.hypeCash, flattened.hypeCash);
  approx(rows.wait, flattened.hypeCash);
  approx(rows.once.hype.fee, flattened.fees.hype - s.fees.hype);
});

test('多品种回放纳入其他全仓仓位的维持风险；缺少其他仓位验证时暂停', () => {
  const mixed = structuredClone(assets),
    btc = mixed[0],
    gold = mixed.find((a) => a.id === 'xau');
  btc.hype.marginMode = 'isolated';
  const common = { ...context, asset: btc, assets: mixed };
  const s = applySimulation(
    seed(),
    {
      type: 'adopt',
      account: {
        stage: 'challenge',
        vsBalance: 10000,
        hypeCash: 209,
        positions: [
          { assetId: 'btc', venue: 'vs', qty: 0.02, entry: 100000, margin: 200 },
          { assetId: 'btc', venue: 'hype', qty: -0.02, entry: 100000, margin: 200 },
          { assetId: 'xau', venue: 'hype', qty: 1, entry: 2510, margin: 100 }
        ]
      }
    },
    common
  );
  const bar = { assetId: 'btc', ts: now + 1000, open: 1e5, low: 1e5, high: 1e5, close: 1e5 };
  const r = runReplay(s, [bar], mixed, config);
  assert.equal(r.last.event, 'liquidation');
  assert.equal(r.state.status, 'liquidated');
  gold.hype.tiersVerified = false;
  assert.throws(() => runReplay(s, [bar], mixed, config), /维持档位无法验证/);
});

test('报价断连、冻结、过期、缺盘口在平仓／结转／提款／条件预览及回放入口均阻止写入', () => {
  const d = makeDemo('payout', asset, config, now);
  const before = structuredClone(d.state);
  for (const mutate of [
    (a) => {
      a.sourceIssues = ['Hype API 断连'];
    },
    (a) => {
      a.feedMode = 'frozen';
    },
    (a) => {
      a.hype.asOf = new Date(now - 2e6).toISOString();
    },
    (a) => {
      a.hype.bid = 101000;
      a.hype.ask = 100000;
    },
    (a) => {
      a.feedMode = 'live';
      a.hype.bid = null;
      a.hype.ask = null;
    }
  ]) {
    const a = structuredClone(d.assets[0]);
    mutate(a);
    const local = { asset: a, assets: [a], now, config };
    for (const type of ['close', 'day', 'settle-now', 'withdraw', 'abandon']) {
      assert.throws(() => applySimulation(d.state, { type }, local), /行情|报价|买一/);
    }
    assert.throws(() => previewScenario(d.state, 'close', local), /行情|报价|买一/);
    if (a.sourceIssues?.length || a.feedMode === 'frozen' || a.feedMode === 'live')
      assert.throws(() => runReplay(d.state, d.candles, [a], config), /行情|报价|买一/);
  }
  assert.deepEqual(d.state, before);
});

test('首次触线观察不产生交易；后续报价不能覆盖早先事件，同柱冲突不能直接结算', async (t) => {
  const { observeSimulationRisk, getSimulation, SIM_KEY, actSimulation } =
    await import('../src/simulation.js');
  const values = new Map();
  const fake = {
    localStorage: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
    navigator: {
      locks: { request: (k, opts, fn) => Promise.resolve((typeof opts === 'function' ? opts : fn)()) }
    }
  };
  for (const [key, value] of Object.entries(fake)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (old) Object.defineProperty(globalThis, key, old);
      else delete globalThis[key];
    });
  }
  const d = makeDemo('challengePass', asset, config, now);
  values.set(SIM_KEY, JSON.stringify(d.state));
  const a = structuredClone(d.assets[0]);
  a.vs.price *= 1.005;
  a.vs.asOf = new Date(now + 100).toISOString(); // New VS observation, older Hype quote.
  let local = { asset: a, assets: [a], config, now: now + 100, legacyUsed: 0 };
  const first = await observeSimulationRisk(local);
  assert.equal(first.pending, true);
  assert.deepEqual(
    first.proofs.map((p) => p.event),
    ['success']
  );
  assert.equal(getSimulation().history.length, d.state.history.length);
  await assert.rejects(actSimulation({ type: 'observed-event' }, local), /顺序不确定/);
  // Both venues now report the same time but the late packet reveals a liquidation.
  a.hype.price = 170000;
  a.hype.asOf = a.vs.asOf;
  const conflict = await observeSimulationRisk(local);
  assert.deepEqual(
    conflict.proofs.map((p) => p.event),
    ['success', 'liquidation']
  );
  assert.ok(conflict.proofs.every((p) => Number.isFinite(p.cash)));
  await assert.rejects(actSimulation({ type: 'observed-event' }, local), /顺序不确定/);
  await assert.rejects(actSimulation({ type: 'day' }, local), /先发生的触线/);
});
