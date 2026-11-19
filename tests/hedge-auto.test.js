import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCurrent, rules } from '../src/hedge/current.js';
import { solveAuto, compareAuto } from '../src/hedge/auto.js';
import { demoMarket, evaluateCandidate, profileInputs } from '../src/hedge/solver.js';
import { createBook } from '../src/hedge/book.js';
import { dec, out, min } from '../src/hedge/math.js';
const at = '2026-11-19T12:00:00Z',
  t = Date.parse(at);
const inputs = {
  ...rules,
  fx: '1',
  fxAt: at,
  deadline: '2026-11-20T12:00:00Z',
  B: '160',
  R: '20',
  challengeFloor: '900',
  challengeTarget: '1100',
  pfFee: '0',
  hlFee: '0',
  baseline: '1000'
};
function fixture() {
  const common = { at, qty: '0', orders: [], otherHold: '0', marginMode: 'cross', anchor: '100' };
  const q = { mark: '100', asOf: at, levels: [[['100', '30']], [['100', '30']]] };
  return {
    a: {
      pf: { ...common, equity: '1000', free: '1000' },
      hl: { ...common, equity: '120', free: '120', leverage: '5' }
    },
    m: {
      asset: 'BTC',
      pf: { ...q, symbol: 'BTC-PERP', open: true },
      hl: {
        ...q,
        symbol: 'BTC',
        sizeDecimals: 0,
        collateralToken: 0,
        maxQty: '6',
        marginTiers: [{ lowerBound: '0', maxLeverage: 10 }]
      },
      spec: {
        symbol: 'BTC-PERP',
        base: 'BTC',
        quote: 'USDC',
        sizeDecimals: 0,
        maxQty: '10',
        capitalInitMarginRatio: '0.1',
        maintMarginRatio: '0.025'
      }
    }
  };
}
const calc = (r = {}, f = fixture(), time = t) => calculateCurrent({ ...inputs, ...r }, f.a, f.m, {}, time);
test('AUTO01 auto 默认联合搜索两边空仓的最大 PF 名义额', () => {
  const x = calc();
  assert.equal(inputs.mode, 'auto');
  assert.equal(x.autoStatus, 'AUTO_FEASIBLE');
  assert.equal(x.candidate.vsNotional, '1000');
  assert.equal(x.search.complete, true);
  assert.ok(x.top.length > 1);
  assert.ok(x.eliminated.check);
});
test('AUTO02 外部已到账 100U 只增加个人保护资金', () => {
  const x = calc(),
    y = calc({ externalAt: at, external: '100' });
  assert.equal(y.protect, '220');
  assert.equal(y.marginHL, x.marginHL);
  assert.ok(dec(y.range.min).lt(x.range.min));
});
test('AUTO03 减少 Hype 抵押品限制最大可行规模', () => {
  const f = fixture();
  f.a.hl.free = '43';
  const x = calc({}, f);
  assert.ok(!x.candidate || dec(x.candidate.vsNotional).lt(1000));
});
test('AUTO04 不同乘数、结算折算及价格因子以敏感度归一', () => {
  const f = fixture();
  f.m.spec.contractMultiplier = '2';
  f.m.hl.settlementToUSDC = '0.8';
  const x = calc({ fx: '1.25' }, f),
    c = x.candidate;
  assert.ok(c);
  assert.equal(c.actualRatio, out(dec(c.hlTargetQuantity).abs().div(dec(c.vsTargetQuantity).abs().times(2))));
  assert.notEqual(c.actualRatio, out(dec(c.hlNotional).div(c.vsNotional)));
});
test('AUTO05 保留已有仓位只计差额成交费', () => {
  const f = fixture();
  f.a.pf.qty = '-3';
  f.a.hl.qty = '1';
  const x = calc({ pfFee: '0.001', hlFee: '0.001' }, f);
  for (const [k, q, d] of [
    ['pf', x.candidate.vsTargetQuantity, x.candidate.vsDeltaQuantity],
    ['hl', x.candidate.hlTargetQuantity, x.candidate.hlDeltaQuantity]
  ]) {
    assert.equal(d, out(dec(q).minus(f.a[k].qty)));
    assert.equal(x.costs[k].entry.fee, out(dec(d).abs().times('0.1')));
  }
});
test('AUTO06 未设两日波幅仍可计算最大可行仓位', () => {
  const x = calc();
  assert.ok(x.candidate);
  assert.equal(x.stressedEquity, undefined);
});
test('AUTO07 两日条件幅度与最低合法 PF 名义额，含超上限与深度不足', () => {
  const x = calc({ movePct: '5' });
  assert.equal(x.pressure[1].amount, '2000');
  assert.equal(x.pressure[-1].amount, '2000');
  assert.equal(x.candidate.vsNotional, '1000');
  assert.equal(x.stressedEquity, '1050');
  const thin = calc({ movePct: '1' });
  assert.equal(thin.pressure[1].amount, '10000');
  assert.match(thin.pressure[1].source, /下界/);
});
test('AUTO08 账户或行情单独过期禁止推荐，超期退出不虚增现金', () => {
  for (const change of [(f) => (f.a.hl.at = '2020-01-01'), (f) => (f.m.pf.asOf = '2020-01-01')]) {
    const f = fixture();
    change(f);
    const x = calc({}, f);
    assert.equal(x.autoStatus, 'AUTO_DATA_BLOCKED');
    assert.equal(x.candidate, undefined);
  }
  const x = calc({ deadline: at });
  assert.equal(x.autoStatus, 'AUTO_DEADLINE_EXIT_REQUIRED');
  assert.equal(x.deadlineExit, '120');
});
test('AUTO09 达到已证明最优的现仓保持，双边差额为零', () => {
  const f = fixture(),
    c = calc().candidate;
  f.a.pf.qty = c.vsTargetQuantity;
  f.a.hl.qty = c.hlTargetQuantity;
  const x = calc({}, f);
  assert.equal(x.autoStatus, 'AUTO_HOLD');
  assert.equal(x.candidate.vsDeltaQuantity, '0');
  assert.equal(x.candidate.hlDeltaQuantity, '0');
});
test('AUTO10 全部候选不符时给出实际缺口', () => {
  const x = calc({ B: '9000' });
  assert.equal(x.autoStatus, 'AUTO_INFEASIBLE');
  assert.ok(dec(x.eliminated.check.shortfall).gt(0));
  assert.equal(x.candidate, undefined);
});
test('AUTO11 已到账外币折算、未知估值、在途和分成分开', () => {
  const x = calc({
    externalAt: at,
    external: '100',
    externalCurrency: 'OTHER',
    externalFx: '0.8',
    externalFxAt: at,
    inTransit: '9999'
  });
  assert.equal(x.protect, '200');
  assert.equal(x.marginHL, '120');
  assert.equal(x.candidate.pressureCashAfter, out(dec(x.candidate.hlBeforePayout).plus(80)));
  const y = calc({ externalAt: at, external: '100', externalCurrency: 'OTHER' });
  assert.equal(y.protect, '120');
  assert.match(y.notices.join(' '), /估值未确认/);
});
test('AUTO12 最优性与完整枚举逐笔交叉验证，两种排序及搜索未完成状态', () => {
  const s = createBook({ id: 'grid', mode: 'demo', time: at });
  s.pf = '1000';
  s.hl = '120';
  s.B = '160';
  s.challengeTarget = '1100';
  s.challengeFloor = '900';
  s.positions = {};
  const base = demoMarket('unit');
  for (const v of ['pf', 'hl'])
    Object.assign(base[v], {
      mark: '100',
      step: '1',
      minQty: '1',
      maxQty: v === 'hl' ? '6' : '10',
      free: v === 'hl' ? '120' : '1000',
      reserve: v === 'hl' ? '20' : '0',
      leverage: '5',
      utilization: '1',
      rate: '0.001',
      bids: [
        ['99.9', '4'],
        ['99.6', '20']
      ],
      asks: [
        ['100.1', '4'],
        ['100.3', '20']
      ]
    });
  for (const objective of ['size', 'cash']) {
    const params = { objective, R: '20', g: '0', k: '0' },
      opts = { currentSnapshot: true, liveLimits: true },
      p = profileInputs(s, params, base),
      all = [];
    for (const d of [1, -1])
      for (let i = 1; i <= 10; i++)
        for (let j = 0; j <= 6; j++) {
          try {
            const c = evaluateCandidate(s, base, p, String(d * i), String(-d * j), opts);
            if (c.code === 'FEASIBLE') {
              c.worstCash = out(min(c.failureCash, c.pressureCashAfter));
              all.push(c);
            }
          } catch {}
        }
    all.sort((a, b) => compareAuto(a, b, objective));
    assert.ok(all.length > 5);
    const solved = solveAuto(s, base, params, opts);
    assert.equal(solved.searchComplete, true);
    assert.deepEqual(
      solved.candidates.map((x) => [x.vsTargetQuantity, x.hlTargetQuantity]),
      all.slice(0, 5).map((x) => [x.vsTargetQuantity, x.hlTargetQuantity])
    );
    const partial = solveAuto(s, base, params, { ...opts, searchBudget: 1 });
    assert.equal(partial.searchComplete, false);
    assert.notEqual(partial.code, 'AUTO_INFEASIBLE');
  }
});
test('自动仓位同时校验待成交敞口与跳价、资金费、延迟压力', () => {
  const f = fixture();
  f.a.hl.orders = [{ qty: '1', conditional: true }];
  assert.equal(calc({}, f).autoStatus, 'AUTO_PARTIAL');
  f.a.hl.orders = [{ qty: '2' }];
  const x = calc({}, f);
  assert.ok(dec(x.candidate.hlDeltaQuantity).gte('2'));
  assert.equal(x.adjust.hl.remaining, out(dec(x.candidate.hlDeltaQuantity).minus('2')));
  const stressed = calc({ jumpBps: '800', fundingDebit: '15', delayBps: '50' }, f);
  if (stressed.candidate) {
    assert.ok(dec(stressed.candidate.worstCash).lte(x.candidate.worstCash));
    assert.ok(stressed.candidate.constraints.some((x) => x.code === 'STRESS_FAILURE'));
  } else assert.equal(stressed.autoStatus, 'AUTO_INFEASIBLE');
});
test('未知条件单与未估值资金不能生成可执行目标，近零真实抵押品不被在途资金填充', () => {
  const f = fixture();
  f.a.pf.free = '0';
  f.a.hl.free = '1';
  const x = calc({ externalCurrency: 'OTHER', externalAt: at, external: '5000', inTransit: '5000' }, f);
  assert.equal(x.autoStatus, 'AUTO_INFEASIBLE');
  assert.equal(x.protect, '120');
  assert.equal(x.marginHL, '1');
});

test('两边权益独立过期时均不判定失败、通过、提款或退出现金；新改数量不会续期', () => {
  for (const side of ['pf', 'hl'])
    for (const equity of ['899', '1101']) {
      const f = fixture();
      f.a.pf.equity = equity;
      f.a[side].equityAt = '2020-01-01T00:00:00Z';
      f.a[side].qtyAt = at;
      const x = calc({}, f);
      assert.equal(x.cash[side], null);
      assert.equal(x.range, undefined);
      assert.equal(x.settlePF, undefined);
      assert.equal(x.candidate, undefined);
      assert.equal(x.dataState, '数据过期');
      assert.doesNotMatch(x.notices.join(' '), /已触及|目标已到|已到提款/);
      const funded = calc({ stage: 'funded', fundedFloor: '900', fundedTarget: '1100' }, f);
      assert.equal(funded.claim, undefined);
      const due = calc({ deadline: at }, f);
      assert.equal(due.deadlineExit, undefined);
    }
});

test('保护金不复用旧 Hype 权益，保证金与外部现金独立确认', () => {
  const f = fixture();
  Object.assign(f.a.hl, { equity: '400', free: '12', equityAt: '2020-01-01' });
  let x = calc({ external: '10', externalAt: at }, f);
  assert.equal(x.protect, null);
  assert.equal(x.marginHL, '12');
  assert.equal(x.externalValue, '10');
  f.a.hl.equityAt = at;
  f.a.hl.freeAt = '2020-01-01';
  x = calc({ external: '10', externalAt: at }, f);
  assert.equal(x.protect, '410');
  assert.equal(x.marginHL, null);
  assert.equal(x.candidate, undefined);
  f.a.hl.freeAt = at;
  x = calc({ external: '10', externalAt: '2020-01-01' }, f);
  assert.equal(x.protect, null);
  assert.equal(x.externalValue, '0');
  assert.equal(x.marginHL, '12');
});

test('未知数量、明确空仓及缺实际杠杆的全额抵押条件求解严格区分', () => {
  const f = fixture();
  f.a.hl.qty = '';
  assert.equal(calc({}, f).qty.hl, null);
  f.a.hl.qty = '0';
  delete f.a.hl.leverage;
  assert.equal(calc({}, f).candidate, undefined);
  f.a.hl.flatConfirmedAt = at;
  const x = calc({ B: '120', R: '10' }, f);
  assert.ok(x.candidate, x.issues.join(' '));
  assert.equal(x.autoStatus, 'AUTO_PARTIAL');
  assert.match(x.sizingAssumption, /实际杠杆未录入/);
  assert.ok(dec(x.candidate.hlNotional).lte(f.a.hl.free));
  f.a.hl.marginMode = 'isolated';
  assert.equal(calc({}, f).candidate, undefined);
});

test('空白、显式零、部分和非零压力；零两日波幅可计算', () => {
  const unspecified = calc();
  assert.equal(unspecified.stress.missing.length, 4);
  assert.ok(unspecified.candidate);
  const zero = calc({ movePct: '0', adverseBps: '0', delayBps: '0', jumpBps: '0', fundingDebit: '0' });
  assert.equal(zero.stress.zero.length, 4);
  assert.equal(zero.stress.missing.length, 0);
  assert.equal(zero.stressedEquity, '1000');
  assert.ok(zero.candidate);
  const partial = calc({ jumpBps: '1', fundingDebit: '0' });
  assert.equal(partial.stress.missing.length, 2);
  const configured = calc({ jumpBps: '1', delayBps: '1', adverseBps: '1', fundingDebit: '0.01' });
  assert.equal(configured.stress.positive.length, 4);
});

test('首选、第二优与淘汰行都来自当次枚举和约束，不足两个候选时不补造', () => {
  const x = calc();
  assert.equal(x.maximum.amount, x.top[0].vsNotional);
  assert.notDeepEqual(x.top[0], x.top[1]);
  assert.ok(x.top.every((c) => c.constraints.length && c.constraints.every((v) => v.status === 'pass')));
  assert.ok(x.rejections.some((c) => c.why && dec(c.check.shortfall).gt(0)));
  assert.deepEqual(calc({ B: '90000' }).top, []);
});

test('预设按本金扣一次报名费，隔离账户来源；未开户也能继续实时计算', async () => {
  const { presetAccount } = await import('../src/hedge/current-account.js');
  const r = {
    ...inputs,
    planPF: '1000',
    planCapital: '211',
    registration: '91',
    planLeverage: '5',
    planFundedCash: '101.50'
  };
  const accounts = { pf: presetAccount(r, 'pf'), hl: presetAccount(r, 'hl') };
  assert.equal(accounts.hl.equity, '120');
  assert.equal(accounts.hl.free, '120');
  assert.equal(accounts.hl.at, undefined);
  const live = calculateCurrent(r, accounts, fixture().m, {}, t);
  assert.equal(live.autoStatus, 'AUTO_FEASIBLE');
  assert.ok(live.top[1]);
  assert.equal(presetAccount({ ...r, stage: 'funded' }, 'hl').equity, '101.5');
  assert.ok(presetAccount({ ...r, planCapital: '90' }, 'hl').error);
  const broken = fixture().m;
  broken.errors = { hl: '接口断开' };
  assert.equal(calculateCurrent(r, accounts, broken, {}, t).candidate, undefined);
  assert.equal(accounts.hl.equity, '120');
});
