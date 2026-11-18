import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemplates } from '../src/assets.js';
import { analyzeCandidate, decide, payoutAmount, projectQuotes, settleLeg } from '../src/decision.js';

const t = Date.parse('2026-11-19T01:00:00Z');
const account = () => ({
  stage: 'challenge',
  vsBalance: 10000,
  hypeCash: 409,
  vsFree: 10000,
  hypeFree: 409,
  vsUsed: 0,
  hypeUsed: 0,
  positions: []
});
const asset = (id = 'btc') => createTemplates(t).find((a) => a.id === id);
const order = (vsUsd = 18000, hypeUsd = 3000, vsLong = true) => ({ vsUsd, hypeUsd, vsLong });
const evalPlan = (o = order(), a = asset(), acc = account(), c = {}) => analyzeCandidate(a, acc, c, o, t);
const near = (x, y, tol = 1e-6) => assert.ok(Math.abs(x - y) < tol, `${x} should equal ${y}`);

test('A01 成交费用前标记净值 12005、平仓后未达 12000 时不可按结算通过', () => {
  const a = asset(),
    held = 1,
    entry = a.vs.price;
  const closing = settleLeg(a, 'vs', held, entry, a.referencePrice, {});
  assert.ok(12005 + closing.net < 12000);
  const acc = account();
  acc.vsBalance = 12005;
  acc.positions = [{ assetId: a.id, venue: 'vs', qty: 1, entry, margin: 10000 }];
  acc.vsUsed = 10000;
  acc.vsFree = 2005;
  const plan = { ...order(100000, 1000), targetQty: { vs: 1, hype: -0.01 } };
  const settled = evalPlan(plan, a, acc, { triggerMode: 'settled' });
  assert.ok(settled.currentVsEquity < 12000);
  assert.ok(settled.pass > a.referencePrice);
  const marked = evalPlan(plan, a, acc, { triggerMode: 'mark' });
  assert.equal(marked.currentVsEquity, 12005);
  assert.equal(marked.ok, false);
});

test('A02 失败情景回收报名费；只将未反映现金的外部成本另计一次', () => {
  const win = evalPlan(),
    loss = evalPlan(order(18000, 1200));
  assert.equal(win.ok, true);
  near(win.failState.personalCash, 504.773377, 1e-5);
  assert.equal(loss.checks.recovery, false);
  near(loss.failGap, -52.6906492, 1e-5);
  const acc = { ...account(), historyCost: 91, externalUnrecovered: 8 };
  const alreadyBooked = evalPlan(order(), asset(), acc);
  near(alreadyBooked.failState.personalCash, win.failState.personalCash);
  near(alreadyBooked.failGap, win.failGap - 8);
});

test('A03 通过前 Hype 先行强平，显示实际负缓冲及缺口', () => {
  const r = evalPlan(order(15000, 3600));
  assert.equal(r.ok, false);
  assert.equal(r.checks.recovery, true);
  assert.ok(r.liq < r.pass);
  near(r.buffer, r.liq - r.pass);
  assert.match(r.reasons.join(' '), /强平缓冲不足.*差/);
});

test('A05 出金只计算高于初始余额的部分', () => {
  for (const n of [9000, 9800, 10000]) assert.equal(payoutAmount(n), 0);
  assert.equal(payoutAmount(10200), 160);
});

test('A06 固定 VS 只调 Hype 不改变任何 VS 触线，改变实际全仓强平/终点现金', () => {
  const a = evalPlan(order()),
    b = evalPlan(order(18000, 1200));
  near(a.pass, b.pass);
  near(a.fail, b.fail);
  assert.notEqual(a.liq, b.liq);
  assert.notEqual(a.passState.personalCash, b.passState.personalCash);
  const fixedVs = decide(asset(), account(), {}, { mode: 'fixedVs', vsUsd: 18000, direction: 'long' }, t);
  assert.ok(fixedVs.best);
  assert.ok(fixedVs.candidates.every((r) => r.requested.vsUsd === 18000 && r.vsLong));
  const fixedH = decide(asset(), account(), {}, { mode: 'fixedHype', hypeUsd: 2500, direction: 'both' }, t);
  assert.ok(fixedH.best);
  assert.ok(fixedH.candidates.every((r) => r.requested.hypeUsd === 2500));
});

test('A08 现有仓位仅对增减差额收费，平均价、已实现和占用独立', () => {
  const a = asset(),
    acc = account();
  acc.positions = [
    { assetId: a.id, venue: 'vs', qty: 0.1, entry: 99000, margin: 1000 },
    { assetId: a.id, venue: 'hype', qty: -0.03, entry: 101000, margin: 300 }
  ];
  Object.assign(acc, { vsUsed: 1000, vsFree: 9100, hypeUsed: 300, hypeFree: 139 });
  const o = { vsLong: true, targetQty: { vs: 0.12, hype: -0.02 } };
  const r = evalPlan(o, a, acc);
  near(r.vs.tradeQty, 0.02);
  near(r.hype.tradeQty, 0.01);
  near(r.vs.tradeFee, 0.02 * r.vs.entryPrice * a.vs.feeRate);
  near(r.hype.tradeFee, 0.01 * r.hype.entryPrice * a.hype.feeRate);
  near(r.vs.avgEntry, (0.1 * 99000 + 0.02 * r.vs.entryPrice) / 0.12);
  near(r.hype.realized, 0.01 * (101000 - r.hype.entryPrice));
  near(r.hype.avgEntry, 101000);
  near(r.hype.marginChange, -100);
  const unchanged = evalPlan({ vsLong: true, targetQty: { vs: 0.1, hype: -0.03 } }, a, acc);
  assert.equal(unchanged.vs.tradeFee, 0);
  assert.equal(unchanged.hype.tradeFee, 0);
});

test('A09 缺强平档位不推荐；手工精确价仅对已核对仓量、均价和抵押生效', () => {
  const a = asset(),
    good = evalPlan(order(), a);
  a.hype.tiers = null;
  a.hype.mmr = undefined;
  assert.equal(evalPlan(order(), a).status, 'unverified');
  assert.equal(decide(a, account(), {}, { mode: 'manual', ...order() }, t).best, null);
  Object.assign(a.hype, {
    liqPrice: good.liqMark,
    liqQty: good.hype.targetQty,
    liqEntry: good.hype.avgEntry,
    liqCollateral: good.hypeCollateral,
    liqAsOf: t,
    liqSource: 'manual',
    liqMarginMode: 'cross'
  });
  const attested = evalPlan(order(), a);
  assert.equal(attested.ok, true);
  assert.match(attested.liqSource, /手工/);
  assert.equal(evalPlan(order(18000, 3001.1), a).status, 'unverified');
  assert.equal(evalPlan(order(), a, { ...account(), hypeCash: 419, hypeFree: 419 }).status, 'unverified');
});

for (const id of ['btc', 'xau', 'us100'])
  test('A10 ' + id + ' 双边合法仓位、各自点值、通过/失败/资金回收', () => {
    const a = asset(id),
      r = decide(a, account(), {}, {}, t);
    assert.ok(r.best);
    assert.ok(r.rejected.length);
    for (const v of ['vs', 'hype']) {
      const p = r.best[v];
      near(p.qty / a[v].step, Math.round(p.qty / a[v].step));
      near(p.delta, p.targetQty * a[v].ratio * a[v].multiplier * a[v].settleUsd);
    }
    assert.ok(r.best.buffer >= a.minBuffer);
    assert.ok(r.best.failState.personalCash >= 500);
    assert.ok(r.interval.vsMax >= r.interval.vsMin);
    assert.equal(r.noTrade.fees, 0);
    assert.ok(r.limits.hype.matchedSafeUsd <= r.limits.hype.safeUsd + 2);
  });

test('A10 外部已冻结保证金减少可开额度、全仓缓冲与后续可动用现金', () => {
  const a = asset(),
    orig = evalPlan(order(), a);
  const locked = { ...account(), hypeUsed: 100, hypeFree: 309 };
  const r = evalPlan(order(), a, locked);
  assert.ok(r.limits.hype.safeUsd < orig.limits.hype.safeUsd);
  assert.ok(r.buffer < orig.buffer);
  near(r.passState.availableCash, r.passState.hypeCash - 100);
  assert.equal(r.ok, false);
});

test('A10 逐腿取整失真时阻断；实际比率本身无需接近 100%', () => {
  const a = asset('xau');
  a.hype.step = 0.5;
  a.hype.minQty = 0.5;
  const coarse = evalPlan(order(18000, 3000), a);
  assert.match(coarse.reasons.join(' '), /取整后无解/);
  assert.ok(evalPlan().ratio < 0.3);
});

test('A12 断连、过期和未知标的熔断', () => {
  for (const update of [
    (a) => {
      a.sourceIssues = ['Hype API 已断连'];
    },
    (a) => {
      a.vs.asOf = new Date(t - 901000).toISOString();
    },
    (a) => {
      a.hype.benchmark = 'not-the-same';
    },
    (a) => {
      a.hype.quoteUsd = null;
    },
    (a) => {
      a.vs.type = 'inverse';
    }
  ]) {
    const a = asset();
    update(a);
    const r = decide(a, account(), {}, {}, t);
    assert.equal(r.best, null);
    assert.equal(r.status, 'unverified');
    assert.ok(r.reasons.length);
  }
});

test('盘口逐档成交及冲击成本只扣一次；超出已知深度不以部分成交冒充', () => {
  const a = asset(),
    h = a.hype;
  h.book = {
    bids: [
      [99999, 0.01],
      [99990, 0.1]
    ],
    asks: [
      [100001, 0.015],
      [100010, 0.1]
    ]
  };
  const r = evalPlan({ vsLong: true, targetQty: { vs: 0.18, hype: -0.03 } }, a);
  near(r.hype.entryPrice, (99999 * 0.01 + 99990 * 0.02) / 0.03);
  near(r.hype.tradeFee, Math.abs(r.hype.tradeQty) * r.hype.entryPrice * h.feeRate);
  near(r.hype.currentGross, -Math.abs(r.hype.targetQty) * (100000 - r.hype.entryPrice));
  const tooBig = evalPlan(order(18000, 20000), a);
  assert.match(tooBig.reasons.join(' '), /深度不足/);
});

test('强平落在更高的维持档位时使用新档费率和连续扣减额', () => {
  const a = asset(),
    base = evalPlan();
  a.hype.tiers = [
    { lowerBound: 0, mmr: 0.005, deduction: 0, maxLeverage: 100 },
    { lowerBound: 3100, mmr: 0.03, deduction: 77.5, maxLeverage: 20 }
  ];
  const r = evalPlan(order(), a);
  assert.ok(r.liq < base.liq);
  assert.ok(r.liq * r.hype.qty > 3100);
  near(
    r.hypeCollateral + r.hype.targetQty * (r.liqMark - r.hype.avgEntry),
    r.hype.qty * r.liqMark * 0.03 - 77.5
  );
  a.hype.tiers[1].deduction = 0;
  assert.equal(evalPlan(order(), a).status, 'unverified');
});

test('续航以重置后的真实持仓求解提供证据，低现金只够本阶段', () => {
  const r = evalPlan();
  assert.equal(r.runway.ok, false);
  assert.match(r.runway.label, /仅可完成本阶段/);
  const acc = { ...account(), hypeCash: 1000, hypeFree: 1000 };
  const funded = evalPlan(order(), asset(), acc);
  assert.ok(funded.runway.witness);
  const next = {
    ...account(),
    stage: 'funded',
    hypeCash: funded.passState.hypeCash,
    hypeFree: funded.passState.hypeCash
  };
  const proof = evalPlan(funded.runway.witness, projectQuotes(asset(), funded.pass), next);
  near(proof.pass, funded.runway.witness.pass);
  near(funded.runway.witness.startRef, funded.pass);
  assert.equal(proof.ok, true);
  assert.ok(proof.passState.payout > 0);
});

test('结束的周期不得再推荐', () => {
  for (const status of ['withdrawn', 'failed', 'liquidated', 'abandoned'])
    assert.equal(decide(asset(), { ...account(), status }, {}, {}, t).best, null);
});

test('交易所返回的参考强平价只随原钱包原持仓使用，现金/仓位变化作废', () => {
  const a = asset(),
    acc = account(),
    leg = a.hype;
  const position = {
    assetId: a.id,
    symbol: 'BTC',
    venue: 'hype',
    qty: -0.03,
    entry: 100000,
    margin: 300,
    marginMode: 'cross',
    liqPrice: 113000
  };
  Object.assign(acc, { positions: [position], hypeUsed: 300, hypeFree: 109, hypeEquity: 409 });
  Object.assign(leg, {
    tiers: null,
    tiersVerified: false,
    marginVerified: false,
    liqSource: 'api',
    liqPrice: 113000,
    liqAsOf: t,
    liqMarginMode: 'cross',
    liqQty: -0.03,
    liqEntry: 100000,
    account: { cash: 409, free: 109, used: 300, equity: 409, positions: [{ ...position, marginUsed: 300 }] }
  });
  const exact = { vsLong: true, targetQty: { vs: 0.18, hype: -0.03 } };
  const r = evalPlan(exact, a, acc);
  assert.equal(r.liq, 113000);
  assert.match(r.liqSource, /只读账户/);
  const changed = evalPlan(exact, a, { ...acc, hypeCash: 419, hypeEquity: 419, hypeFree: 119 });
  assert.equal(changed.status, 'unverified');
  assert.equal(changed.liq, null);
  const changedSize = evalPlan({ vsLong: true, targetQty: { vs: 0.18, hype: -0.031 } }, a, acc);
  assert.equal(changedSize.liq, null);
});

test('手工单一合格仓位也给出已实际验算的失败对照，损坏盘口不会使决策进程崩溃', () => {
  const r = decide(asset(), account(), {}, { mode: 'manual', ...order() }, t);
  assert.ok(r.best);
  assert.ok(r.rejected.length);
  assert.equal(r.rejected[0].ok, false);
  const a = asset();
  a.hype.book = { bids: [null], asks: [] };
  const broken = decide(a, account(), {}, {}, t);
  assert.equal(broken.best, null);
  assert.match(broken.reasons.join(' '), /盘口/);
});

test('金额按成交 VWAP、真实买卖档与入场滑点整步重算，两方向实际成交均不超预算', () => {
  for (const vsLong of [true, false]) {
    const a = asset(),
      h = a.hype;
    h.mark = 100070;
    h.price = 100000;
    h.slippageBps = 8;
    h.book = {
      bids: [
        [99999, 0.004],
        [99970, 0.011],
        [99945, 0.07]
      ],
      asks: [
        [100001, 0.004],
        [100080, 0.011],
        [100110, 0.07]
      ]
    };
    a.vs.slippageBps = 12;
    const input = order(18321.78, 3217.83, vsLong),
      r = evalPlan(input, a);
    for (const v of ['vs', 'hype']) {
      const p = r[v],
        requested = input[v + 'Usd'];
      assert.ok(p.tradeNotional <= requested + 1e-9);
      near(p.notional, p.tradeNotional);
      near(p.tradeFee, p.tradeNotional * a[v].feeRate);
      near(p.markNotional, p.qty * (a[v].mark ?? a[v].price) * a[v].multiplier * a[v].settleUsd);
      assert.notEqual(p.notional, p.markNotional);
      const more = evalPlan(
        {
          vsLong,
          targetQty: {
            vs: r.vs.targetQty + (v === 'vs' ? Math.sign(r.vs.targetQty) * a.vs.step : 0),
            hype: r.hype.targetQty + (v === 'hype' ? Math.sign(r.hype.targetQty) * h.step : 0)
          }
        },
        a
      );
      assert.ok(more[v].tradeNotional > requested);
    }
    // The book is 2 wide even though a distinct mark is 70 above the midpoint.
    near(r.hype.spreadCost, r.hype.qty);
    assert.ok(Math.abs(r.hype.basisCost) > r.hype.spreadCost);
  }
});

test('手工净值与已结算余额及持仓必须可勾稽；非初始余额改变触线距离', () => {
  const a = asset(),
    baseline = evalPlan();
  const progressed = evalPlan(order(), a, { ...account(), vsBalance: 10800, vsEquity: 10800, vsFree: 10800 });
  assert.ok(progressed.pass < baseline.pass && progressed.fail < baseline.fail);
  assert.equal(
    evalPlan(order(), a, { ...account(), vsBalance: 10800, vsEquity: 12000 }).status,
    'unverified'
  );
});

test('实际成交名义下限用于新仓与差额，资金可开金额未达门槛时上限归零', () => {
  const a = asset();
  a.hype.minNotional = 10;
  const tiny = evalPlan(order(18000, 3), a);
  assert.match(tiny.reasons.join(' '), /差额成交名义额低于/);
  const acc = account();
  acc.positions = [{ assetId: a.id, venue: 'hype', qty: -0.03, entry: 100000, margin: 300 }];
  acc.hypeUsed = 300;
  acc.hypeFree = 109;
  assert.match(
    evalPlan({ vsLong: true, targetQty: { vs: 0.18, hype: -0.03002 } }, a, acc).reasons.join(' '),
    /差额成交名义额低于/
  );
  const empty = decide(a, { ...account(), hypeCash: 0.5, hypeFree: 0.5 }, { minCash: 0 }, {}, t);
  assert.equal(empty.limits.hype.maxUsd, 0);
});

test('固定任意一边时，可以找到仅一个合法数量步长宽的交集', () => {
  const a = asset();
  a.minBuffer = 1951;
  const h = decide(a, account(), {}, { mode: 'fixedVs', vsUsd: 18000, direction: 'long' }, t);
  assert.equal(h.matchedCount, 1);
  near(h.best.hype.qty, 0.02982);
  a.minBuffer = 1931.5;
  const v = decide(a, account(), {}, { mode: 'fixedHype', hypeUsd: 3000, direction: 'long' }, t);
  assert.equal(v.matchedCount, 1);
  near(v.best.vs.qty, 0.18098);
});

test('A08 已有最佳仓位增加 5% 时，差额采用整数步数相减且双账本记录相同成交', async () => {
  const { createSimulation, accountView, applySimulation } = await import('../src/simulation.js');
  const assets = createTemplates(t);
  const asset = assets[0];
  const context = { asset, assets, now: t, config: {} };
  const start = createSimulation({}, t);
  const best = decide(asset, accountView(start, assets), {}, {}, t).best;
  const opened = applySimulation(start, { type: 'target', order: best.requested }, context);
  const larger = {
    ...best.requested,
    vsUsd: best.requested.vsUsd * 1.05,
    hypeUsd: best.requested.hypeUsd * 1.05
  };
  const account = accountView(opened, assets);
  const r = analyzeCandidate(asset, account, {}, larger, t);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.vs.tradeQty, 0.0016);
  assert.equal(r.hype.tradeQty, -0.00025);
  const booked = applySimulation(opened, { type: 'target', order: larger }, context);
  assert.deepEqual(booked.positions.map((p) => p.qty), [0.03372, -0.0052]);
  assert.deepEqual(booked.history.slice(-2).map((e) => e.qty), [r.vs.tradeQty, r.hype.tradeQty]);

  const offGrid = analyzeCandidate(asset, account, {}, {
    vsLong: true, targetQty: { vs: 0.033721, hype: -0.0052 }
  }, t);
  assert.match(offGrid.reasons.join(' '), /目标数量与方向或步长不一致/);
});
