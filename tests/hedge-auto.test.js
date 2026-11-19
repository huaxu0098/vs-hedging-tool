import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRatioScan,
  inspectRatio,
  nearestRatio,
  ratioSlice,
  adjacentScale
} from '../src/hedge/ratio-scan.js';
import { sumPostings, presentLedger, reconcilePostings } from '../src/hedge/settlement-ledger.js';
import { calculateCurrent, rules, splitReserves } from '../src/hedge/current.js';
import { solveAuto, compareAuto, compareConservative } from '../src/hedge/auto.js';
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
  investedCapital: '160',
  R_success: '20',
  R_free: '20',
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
        maxLeverage: 10,
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
  assert.equal(x.autoStatus, 'AUTO_PARTIAL');
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
  f.a.hl.configuredLeverage = String(c.candidateLeverage);
  f.a.hl.currentMarginCredit = c.requiredInitialMargin;
  Object.assign(f.a.hl, {
    source: 'Hype 主网 API',
    mode: 'standard',
    otherPositions: false,
    crossMaintenance: '20',
    liquidation: c.modelLiq,
    crossPoolVerified: true,
    fee: '0',
    capacity: ['30', '30']
  });
  const x = calc(
    { adverseBps: '0.01', jumpBps: '0.01', delayBps: '0.01', fundingDebit: '0.001', B: '159' },
    f
  );
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
test('AUTO12 逐仓位逐杠杆穷举对照，含非零压力和搜索未完成状态', () => {
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
  base.hl.exchangeMaxLeverage = 5;
  base.hl.tiers[0].maxLeverage = '5';
  for (const stress of [null, { jumpBps: '5', delayBps: '3', basisBps: '1', fundingDebit: '0.02' }]) {
    const params = { objective: 'size', R: '20', g: '0', k: '0' },
      opts = { currentSnapshot: true, liveLimits: true, stress },
      p = profileInputs(s, params, base),
      all = [];
    for (const d of [1, -1])
      for (let i = 1; i <= 10; i++)
        for (let j = 0; j <= 6; j++) {
          let winner = null;
          for (let lev = 1; lev <= base.hl.exchangeMaxLeverage; lev++) {
            try {
              const market = { ...base, hl: { ...base.hl, leverage: String(lev) } };
              const c = evaluateCandidate(s, market, p, String(d * i), String(-d * j), opts);
              if (c.code !== 'FEASIBLE') continue;
              c.candidateLeverage = j ? lev : null;
              c.worstCash = out(min(c.failureCash, c.pressureCashAfter, ...c.scenarioCash));
              if (!winner || compareAuto(c, winner) < 0) winner = c;
            } catch (e) {
              assert.match(e.message, /INVALID_PRICE_ENDPOINT|CANDIDATE_ALREADY_AT_BOUNDARY/);
            }
          }
          if (winner) all.push(winner);
        }
    all.sort(compareAuto);
    assert.ok(all.length > 5);
    const solved = solveAuto(s, base, params, opts);
    assert.equal(solved.searchComplete, true);
    assert.equal(solved.code, 'AUTO_PARTIAL'); // Unit-market grids carry no verified exchange account.
    assert.deepEqual(
      solved.candidates.map((x) => [x.vsTargetQuantity, x.hlTargetQuantity, x.candidateLeverage]),
      all.slice(0, 5).map((x) => [x.vsTargetQuantity, x.hlTargetQuantity, x.candidateLeverage])
    );
    const cash = solveAuto(s, base, { ...params, objective: 'cash' }, opts);
    assert.equal(cash.searchComplete, true);
    const independentBest = all.slice().sort(compareConservative)[0];
    assert.equal(cash.selected.worstCash, independentBest.worstCash);
    assert.equal(cash.selected.vsNotional, independentBest.vsNotional);
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
  f.a.hl.configuredLeverage = '5';
  f.a.hl.source = 'Hype 主网 API';
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

test('未知数量、明确空仓及缺少实际设置的档位搜索严格区分', () => {
  const f = fixture();
  f.a.hl.qty = '';
  assert.equal(calc({}, f).qty.hl, null);
  f.a.hl.qty = '0';
  delete f.a.hl.leverage;
  assert.ok(calc({}, f).candidate);
  f.a.hl.flatConfirmedAt = at;
  const x = calc({ B: '120', R_success: '10', R_free: '10' }, f);
  assert.ok(x.candidate, x.issues.join(' '));
  assert.equal(x.leverageStatus, 'LEVERAGE_UNVERIFIED');
  assert.ok(dec(x.candidate.requiredInitialMargin).lte(f.a.hl.free));
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
    planCrossFlat: true,
    planFundedCash: '101.50'
  };
  const accounts = { pf: presetAccount(r, 'pf'), hl: presetAccount(r, 'hl') };
  assert.equal(accounts.hl.equity, '120');
  assert.equal(accounts.hl.free, '120');
  assert.equal(accounts.hl.at, undefined);
  const live = calculateCurrent(r, accounts, fixture().m, {}, t);
  assert.equal(live.autoStatus, 'AUTO_PARTIAL');
  assert.ok(live.top[1]);
  assert.equal(presetAccount({ ...r, stage: 'funded' }, 'hl').equity, '101.5');
  assert.ok(presetAccount({ ...r, planCapital: '90' }, 'hl').error);
  const broken = fixture().m;
  broken.errors = { hl: '接口断开' };
  assert.equal(calculateCurrent(r, accounts, broken, {}, t).candidate, undefined);
  assert.equal(accounts.hl.equity, '120');
});

test('LEV01 AUTO 双边合法数量和杠杆联合搜索，无杠杆输入，无静默空仓', async () => {
  const { presetAccount } = await import('../src/hedge/current-account.js');
  const f = fixture();
  delete f.a.hl.leverage;
  const x = calc({}, f),
    c = x.candidate;
  assert.ok(c);
  assert.deepEqual(
    c.leverageGrid.map((row) => row.leverage),
    Array.from({ length: 10 }, (_, i) => i + 1)
  );
  assert.ok(c.leverageGrid.filter((row) => row.status === 'pass').length > 1);
  const plan = { ...inputs, planCapital: '211', planPF: '1000' };
  assert.equal(presetAccount(plan, 'hl').qty, null);
  assert.equal(presetAccount({ ...plan, planCrossFlat: true }, 'hl').qty, '0');
});

test('LEV02 相同仓位各档保证金、跨档强平根、跳价与调仓延迟均可独立复算', async () => {
  const { evaluateLeverageGrid } = await import('../src/hedge/leverage.js');
  const s = createBook({ id: 'tier', mode: 'demo', time: at });
  Object.assign(s, {
    pf: '1000',
    hl: '120',
    B: '160',
    challengeFloor: '900',
    challengeTarget: '1100',
    positions: {}
  });
  const m = demoMarket('unit');
  for (const leg of [m.pf, m.hl])
    Object.assign(leg, {
      mark: '100',
      step: '1',
      rate: '0',
      bids: [['100', '100']],
      asks: [['100', '100']],
      free: leg === m.hl ? '120' : '1000',
      reserve: '0',
      leverage: '10',
      utilization: '1'
    });
  Object.assign(m.hl, {
    exchangeMaxLeverage: 10,
    tiers: [
      { from: '0', mmr: '0.05', deduction: '0', maxLeverage: '10' },
      { from: '450', mmr: '0.1', deduction: '22.5', maxLeverage: '5' }
    ]
  });
  const p = profileInputs(s, { R: '20', g: '0', k: '0' }, m);
  const solve = (opts) =>
    evaluateLeverageGrid(s, m, p, '10', '-4', { currentSnapshot: true, liveLimits: true, ...opts });
  const clean = solve({});
  for (const row of clean.leverageGrid) {
    assert.equal(row.initial, out(dec('400').div(row.leverage)));
    assert.equal(row.maintenance, '20');
    assert.equal(row.liquidation, out(dec('542.5').div('4.4')));
    assert.equal(row.baseEquity, '80');
    assert.equal(row.stressedEquity, null);
    assert.equal(row.surplus, '58');
  }
  const stress = solve({ stress: { jumpBps: '100', basisBps: '0', delayBps: '50', fundingDebit: '1' } });
  assert.equal(stress.stressedEquity, '73'); // 120 - 4*(111-100) - 2 delay - 1 funding
  assert.equal(stress.stressedMaintenance, '22.2');
  assert.equal(stress.stressedSurplus, '50.8');
  assert.equal(stress.stressLiqMark, out(dec('539.5').div('4.4')));
  assert.ok(stress.constraints.some((x) => x.code === 'STRESS_FAILURE' && x.status === 'fail'));
  assert.ok(stress.stress.some((x) => x.name.includes('原仓')));
});

test('LEV03 最大杠杆仍无法跨过缓冲时搜较小规模；全部失败则无解', () => {
  const largest = calc().candidate;
  const x = calc({ minBuffer: '22' });
  assert.ok(x.candidate, x.issues.join(' '));
  assert.ok(dec(x.candidate.vsNotional).lt(largest.vsNotional));
  assert.ok(x.candidate.priceBuffer == null || dec(x.candidate.priceBuffer).gte('22'));
  assert.ok(
    x.rejections.some((row) => row.candidate.leverageGrid?.every((level) => level.status === 'fail'))
  );
  const impossible = calc({ minMaintenanceSurplus: '2000' });
  assert.equal(impossible.autoStatus, 'AUTO_INFEASIBLE');
  assert.equal(impossible.candidate, undefined);
});

test('LEV04 排序逐项比较名义额、最差现金、缓冲、保证金，完全并列选低杠杆', () => {
  const c = calc().candidate,
    sort = (patch) => compareAuto(c, { ...c, ...patch }, 'size');
  assert.ok(sort({ vsNotional: out(dec(c.vsNotional).minus(1)), worstCash: '100000' }) < 0);
  assert.ok(sort({ worstCash: out(dec(c.worstCash).minus(1)) }) < 0);
  assert.ok(sort({ stressPriceBuffer: '0' }) < 0);
  assert.ok(sort({ initialMargin: ['100000', '100000'], candidateLeverage: 1 }) > 0);
  assert.ok(compareAuto({ ...c, candidateLeverage: 3 }, { ...c, candidateLeverage: 4 }, 'size') < 0);
});

test('LEV05 未读取当前设置仍能计算条件仓位；历史规划与手填杠杆不定义搜索范围', () => {
  const f = fixture();
  delete f.a.hl.leverage;
  const a = calc({ planLeverage: '1' }, f);
  f.a.hl.leverage = '2';
  const b = calc({ planLeverage: '99' }, f);
  assert.equal(a.leverageStatus, 'LEVERAGE_UNVERIFIED');
  assert.equal(a.configuredLeverage, null);
  assert.ok(a.candidate.candidateLeverage > 2);
  assert.deepEqual(a.candidate.leverageGrid, b.candidate.leverageGrid);
});

test('LEV06 模式、全仓资格、合约上限或维持表不完整时无实盘杠杆结论', () => {
  for (const change of [
    (f) => delete f.a.hl.marginMode,
    (f) => (f.a.hl.marginMode = 'isolated'),
    (f) => (f.m.hl.onlyIsolated = true),
    (f) => delete f.m.hl.maxLeverage,
    (f) => delete f.m.hl.marginTiers,
    (f) => (f.m.hl.marginTiers = [{ lowerBound: '30', maxLeverage: 5 }]),
    (f) => (f.a.hl.crossPoolVerified = false)
  ]) {
    const f = fixture();
    change(f);
    const x = calc({}, f);
    assert.equal(x.leverageStatus, 'LEVERAGE_UNVERIFIED');
    assert.equal(x.candidate, undefined);
    assert.ok(x.issues.length);
  }
});

test('LEV07 只读账户新快照能改变可用档位，已用保证金只按原仓释放一次', async () => {
  const { accountSnapshot } = await import('../src/hedge/current-account.js');
  const user = '0x' + '1'.repeat(40),
    calls = [];
  async function snap(level) {
    return accountSnapshot(
      user,
      'BTC',
      async (body) => {
        calls.push(body.type);
        const summary = { accountValue: '120', totalMarginUsed: '0' };
        const byType = {
          clearinghouseState: {
            time: t,
            marginSummary: summary,
            crossMarginSummary: summary,
            assetPositions: [],
            withdrawable: '120'
          },
          frontendOpenOrders: [],
          userAbstraction: 'disabled',
          activeAssetData: {
            user,
            coin: 'BTC',
            leverage: { type: 'cross', value: level },
            availableToTrade: ['120', '120'],
            maxTradeSzs: ['100', '100']
          },
          userFees: {}
        };
        return byType[body.type];
      },
      () => t
    );
  }
  const f = fixture();
  f.a.hl = await snap(3);
  const first = calc({}, f);
  f.a.hl = await snap(7);
  const second = calc({}, f);
  assert.equal(first.configuredLeverage, 3);
  assert.equal(second.configuredLeverage, 7);
  assert.equal(first.candidate.candidateLeverage, second.candidate.candidateLeverage);
  assert.deepEqual(
    [...new Set(calls)],
    ['clearinghouseState', 'frontendOpenOrders', 'userAbstraction', 'activeAssetData', 'userFees']
  );
  const c = second.candidate;
  Object.assign(f.a.hl, {
    qty: c.hlTargetQuantity,
    currentMarginCredit: '15',
    directionalFree: ['50', '50']
  });
  const next = calc({}, f).candidate;
  assert.ok(next);
  assert.equal(
    next.constraints.find((v) => v.code === 'hl_FREE_RESERVE').actual,
    out(dec('65').minus(next.requiredInitialMargin))
  );
});

test('LEV08 按合法最终数量重算档位与清算，跨边界复核', () => {
  const f = fixture();
  f.m.hl.maxLeverage = 8;
  f.m.hl.marginTiers = [
    { lowerBound: '0', maxLeverage: 10 },
    { lowerBound: '400', maxLeverage: 6 }
  ];
  f.m.hl.sizeDecimals = 0;
  f.m.hl.contractMultiplier = '2';
  const x = calc({}, f);
  assert.ok(x.candidate);
  for (const c of x.top) {
    const qty = dec(c.hlTargetQuantity);
    assert.ok(qty.isInteger());
    const n = qty.abs().times(200);
    assert.equal(c.hlNotional, out(n));
    assert.equal(c.exchangeMaxLeverage, n.gte(400) ? 6 : 8);
    assert.equal(c.requiredInitialMargin, out(n.div(c.candidateLeverage)));
    assert.equal(c.maintenanceMargin, out(n.gte(400) ? dec('20').plus(n.minus(400).div(12)) : n.div(20)));
  }
});

function fortyLevels() {
  const f = fixture();
  f.m.hl.maxLeverage = 40;
  f.m.hl.marginTiers[0].maxLeverage = 40;
  return f;
}
test('LEV09 全仓 4 至 40 档均通过，精算选择 4 倍', () => {
  const c = calc({}, fortyLevels()).candidate;
  const passing = c.leverageGrid.filter((row) => row.status === 'pass');
  assert.deepEqual(
    passing.map((row) => row.leverage),
    Array.from({ length: 37 }, (_, i) => i + 4)
  );
  assert.equal(c.candidateLeverage, 4);
  assert.equal(c.requiredInitialMargin, passing[0].initial);
  assert.ok(
    c.leverageGrid.slice(0, 3).every((row) => row.status === 'fail' && dec(row.constraint.shortfall).gt(0))
  );
});
test('LEV10 高档位只释放初始保证金，维持、强平、权益及现金结果一致', () => {
  const f = fortyLevels();
  const c = calc({}, f).candidate;
  const four = c.leverageGrid[3],
    forty = c.leverageGrid[39];
  assert.equal(four.initial, '100');
  assert.equal(forty.initial, '10');
  for (const key of ['maintenance', 'liquidation', 'stressedEquity', 'surplus', 'buffer'])
    assert.equal(four[key], forty[key], key);
  f.m.hl.maxLeverage = 4; // Keep the actual maintenance schedule identical.
  const capped = calc({}, f).candidate;
  for (const key of [
    'vsTargetQuantity',
    'hlTargetQuantity',
    'failureHypeCash',
    'hlBeforePayout',
    'worstCash'
  ])
    assert.equal(c[key], capped[key], key);
});
test('LEV11 档位证据区分交易所上限、当前设置、最低可行档与有效杠杆', () => {
  const f = fortyLevels();
  Object.assign(f.a.hl, { source: 'Hype 主网 API', crossPoolVerified: true, configuredLeverage: 7 });
  const x = calc({}, f),
    c = x.candidate;
  assert.deepEqual([c.exchangeMaxLeverage, x.configuredLeverage, c.candidateLeverage], [40, 7, 4]);
  assert.equal(c.effectiveLeverage, out(dec(c.hlNotional).div(x.cash.hl)));
  assert.ok(dec(c.leverageGrid[2].constraint.shortfall).gt(0));
  assert.equal(x.leverageStatus, 'LEVERAGE_UNVERIFIED');
});
test('STATE01 缺失、显式零、规划及未核实账户均只能产生条件方案；完整验证可通过', () => {
  const f = fortyLevels();
  const stress = { adverseBps: '0.1', jumpBps: '0.1', delayBps: '0.1', fundingDebit: '0.01', B: '159' };
  const base = calc(stress, f);
  Object.assign(f.a.hl, {
    source: 'Hype 主网 API',
    mode: 'standard',
    otherPositions: false,
    crossMaintenance: '0',
    crossPoolVerified: true,
    configuredLeverage: base.candidate.candidateLeverage,
    fee: '0',
    capacity: ['30', '30']
  });
  assert.equal(calc(stress, f).autoStatus, 'AUTO_FEASIBLE');
  for (const field of ['adverseBps', 'jumpBps', 'delayBps', 'fundingDebit'])
    for (const value of ['', '0']) {
      const x = calc({ ...stress, [field]: value }, f);
      assert.ok(x.candidate);
      assert.equal(x.autoStatus, 'AUTO_PARTIAL');
      assert.match(x.unverified.join(' '), value ? /零压力/ : /压力未配置/);
    }
  delete f.a.hl.configuredLeverage;
  assert.equal(calc(stress, f).autoStatus, 'AUTO_PARTIAL');
});
test('STATE02 失败端单列 Hype 结算现金和已到账外部资金，抵押池不变', () => {
  const x = calc({ external: '45', externalAt: at, inTransit: '70' });
  const c = x.candidate;
  assert.equal(x.protect, '165');
  assert.equal(x.marginHL, '120');
  assert.equal(c.externalReceived, '45');
  assert.equal(c.failureCash, out(dec(c.failureHypeCash).plus('45')));
  assert.equal(c.cashBeforePayout, out(dec(c.hlBeforePayout).plus('45')));
});
test('STATE03 考核期应分额为零，Funded 到账前后分别结算', () => {
  const c = calc({ external: '10', externalAt: at }).candidate;
  assert.equal(c.expectedUserPayout, '0');
  assert.equal(c.hlBeforePayout, out(dec(c.pressureCashAfter).minus('10')));
  const f = fixture();
  f.m.spec.fundedInitMarginRatio = '0.1';
  const funded = calc(
    { stage: 'funded', fundedFloor: '900', fundedTarget: '1100', external: '10', externalAt: at },
    f
  ).candidate;
  assert.equal(funded.expectedUserPayout, '80');
  assert.equal(funded.pressureCashAfter, out(dec(funded.hlBeforePayout).plus('10').plus('80')));
});
test('双方案共享可复算快照，行情、规则或账户变化产生不同依据', () => {
  const f = fixture(),
    x = calc({}, f),
    evidence = JSON.parse(x.trace.inputs);
  assert.ok(x.conservative.candidate);
  assert.ok(dec(x.conservative.candidate.worstCash).gte(x.maximum.candidate.worstCash));
  const replay = calculateCurrent(
    evidence.rules,
    evidence.accounts,
    evidence.market,
    evidence.rates,
    Date.parse(x.trace.at)
  );
  assert.equal(replay.trace.id, x.trace.id);
  assert.deepEqual(replay.maximum, x.maximum);
  assert.deepEqual(replay.conservative, x.conservative);
  assert.notEqual(calc({ B: '159' }, f).trace.rulesId, x.trace.rulesId);
  f.a.hl.free = '119';
  assert.notEqual(calc({}, f).trace.accountsId, x.trace.accountsId);
  f.m.hl.levels[0][0][1] = '28';
  assert.notEqual(calc({}, f).trace.marketId, x.trace.marketId);
});

test('OPT01 双目标的名义额牺牲与现金缓冲按同帧端点相减，滑块以现金下限重新求解', () => {
  const r = { pfFee: '0.0005', hlFee: '0.0005', R_success: '15', R_free: '15' };
  const x = calc(r),
    mid = calc({ ...r, riskPreference: '50' }),
    last = calc({ ...r, riskPreference: '100' });
  const size = x.maximum.candidate,
    cash = x.conservative.candidate;
  assert.equal(x.comparison.pfReduction, '300');
  assert.equal(x.comparison.reductionRatio, '0.3');
  assert.equal(x.comparison.successGain, out(dec(cash.hlBeforePayout).minus(size.hlBeforePayout)));
  assert.equal(mid.preference.floor, out(dec(size.worstCash).plus(dec(x.comparison.worstGain).div(2))));
  assert.ok(dec(mid.candidate.worstCash).gte(mid.preference.floor));
  assert.equal(mid.candidate.vsNotional, '900');
  assert.equal(last.candidate.vsNotional, cash.vsNotional);
});
test('OPT02 搜索范围记录双边方向、步长和数量上限，预算中断不能证明最优', () => {
  const f = fixture(),
    full = calc({}, f);
  assert.equal(full.domain.length, 2);
  assert.equal(full.domain[0].pf.step, '1');
  const partial = calculateCurrent(inputs, f.a, f.m, {}, t, { searchBudget: 1 });
  assert.equal(partial.search.complete, false);
  assert.ok(!partial.maximum?.complete);
  assert.equal(full.trace.model, 'AUTO-0.15');
});
test('OPT03 PF 虚拟保证金、目标 Hype 初始、其他占用及调仓后真实可用分别核验', () => {
  const f = fixture();
  f.a.hl.otherHold = '10';
  f.a.hl.free = '110';
  f.a.hl.flatConfirmedAt = at;
  const x = calc({ external: '20', externalAt: at }, f);
  const c = x.candidate;
  assert.equal(x.marginHL, '110');
  assert.equal(x.protect, '140');
  assert.equal(c.otherInitialMargin, '10');
  assert.equal(c.availableAfter, out(dec('110').minus(c.requiredInitialMargin)));
  assert.equal(c.initialMargin[0], out(dec(c.vsNotional).div(10)));
});
test('OPT04 缺失及显式零只生成基础路径，实际配置才产生压力权益', () => {
  for (const value of ['', '0']) {
    const x = calc({ jumpBps: value }),
      c = x.candidate;
    assert.equal(c.scenario, 'base');
    assert.equal(c.stressedEquity, null);
    assert.ok(c.baseEquity);
    assert.ok(c.leverageGrid.every((row) => row.stressedEquity === null));
    assert.equal(x.autoStatus, 'AUTO_PARTIAL');
  }
  const c = calc({ B: '159', jumpBps: '1' }).candidate;
  assert.equal(c.scenario, 'configured_stress');
  assert.ok(c.stressedEquity);
});
test('OPT05 两腿各自新鲜仍触发相对时间熔断，包括标记价及手工快照字段', () => {
  const f = fixture();
  f.m.hl.markAt = new Date(t - 1001).toISOString();
  for (const mode of ['auto', 'keepPF', 'keepHL']) {
    const x = calc({ mode, quoteSkewMs: '1000' }, f);
    assert.equal(x.timing.quoteSkew, 1001);
    assert.equal(x.adjust, undefined);
    assert.equal(x.candidate, undefined);
    assert.match(x.issues.join(' '), /行情熔断/);
  }
  delete f.m.hl.markAt;
  f.a.pf.freeAt = new Date(t - 121000).toISOString();
  const x = calc({}, f);
  assert.equal(x.autoStatus, 'AUTO_DATA_BLOCKED');
  assert.equal(x.adjust, undefined);
  assert.match(x.issues.join(' '), /账户熔断/);
});
test('OPT06 独立清算核对覆盖正反向、多档、真实现仓参考不符和无正价交点', async () => {
  const { crossCheckRoot } = await import('../src/hedge/cross-check.js');
  const leg = {
    fx: '1',
    multiplier: '1',
    tiers: [
      { from: '0', mmr: '0.05' },
      { from: '450', mmr: '0.1' }
    ]
  };
  assert.ok(
    dec(crossCheckRoot(leg, '-4', '120', '100', '0'))
      .minus(dec('542.5').div('4.4'))
      .abs()
      .lt('1e-20')
  );
  assert.ok(
    dec(crossCheckRoot(leg, '4', '120', '100', '0'))
      .minus(dec('280').div('3.8'))
      .abs()
      .lt('1e-20')
  );
  assert.equal(crossCheckRoot(leg, '1', '200', '100', '0'), null);
  const f = fixture();
  Object.assign(f.a.hl, {
    source: 'Hype 主网 API',
    mode: 'standard',
    crossPoolVerified: true,
    otherPositions: false,
    qty: '1',
    fee: '0',
    crossMaintenance: '5',
    liquidation: '98',
    currentMarginCredit: '10',
    capacity: ['30', '30'],
    configuredLeverage: 5
  });
  const x = calc({ B: '159' }, f);
  assert.equal(x.audit.status, '条件估算');
  assert.match(x.audit.gaps.join(' '), /强平参考/);
  delete f.a.hl.otherPositions;
  assert.match(calc({}, f).audit.gaps.join(' '), /全账户/);
});
test('OPT07 双空仓当前 h 无定义，候选 h 来源于真实目标的每点盈亏', () => {
  const x = calc();
  assert.equal(x.currentH, undefined);
  assert.ok(dec(x.candidate.actualRatio).gt(0));
});
test('OPT08 规划空仓及权益不进入真实输入，混用来源也触发阻断', async () => {
  const { presetAccount, manualAccount } = await import('../src/hedge/current-account.js');
  const r = { ...inputs, planPF: '1000', planCapital: '211', planCrossFlat: true };
  const state = { assets: {}, shared: {} },
    f = fixture();
  for (const k of ['hl', 'pf']) {
    const live = manualAccount(state, 'BTC', k);
    assert.equal(live.qty, undefined);
    assert.equal(live.equity, undefined);
    assert.equal(presetAccount(r, k).qty, '0');
  }
  f.a.hl = presetAccount(r, 'hl');
  const x = calc({}, f);
  assert.equal(x.autoStatus, 'AUTO_DATA_BLOCKED');
  assert.equal(x.candidate, undefined);
});
test('DATA01 时间差合格时仍分别拒绝过期盘口、缺少独立标记时间或倒挂深度', () => {
  for (const field of ['bookAt', 'markAt']) {
    const f = fixture();
    f.m.hl[field] = new Date(t - 5100).toISOString();
    f.m.pf.asOf = new Date(t - 4600).toISOString();
    f.m.hl.asOf = f.m.pf.asOf;
    const x = calc({}, f);
    assert.ok(x.timing.quoteSkew < 3000);
    assert.equal(x.autoStatus, 'AUTO_DATA_BLOCKED');
    assert.equal(x.adjust, undefined);
  }
  const f = fixture();
  f.m.hl.bookSource = 'Hyperliquid WebSocket · l2Book';
  assert.equal(calc({}, f).candidate, undefined);
  f.m.hl.markAt = at;
  f.m.hl.levels = [[['102', '1']], [['101', '1']]];
  assert.match(calc({}, f).issues.join(' '), /深度无效/);
});
test('UX02 LIQ01 LEV12 模型交点与实际账户参考独立，双端显示可比约束', () => {
  const x = calc();
  assert.equal(x.audit.mathMatches, true);
  assert.match(x.audit.exchangeCheck, /未取得/);
  assert.equal(x.configuredLeverage, null);
  assert.ok(x.maximum.candidate.candidateLeverage);
  const { maximum, conservative, comparison } = x;
  assert.equal(
    comparison.maintenanceChange,
    out(dec(conservative.candidate.maintenanceMargin).minus(maximum.candidate.maintenanceMargin))
  );
  assert.equal(
    comparison.hypeChange,
    out(dec(conservative.candidate.hlNotional).minus(maximum.candidate.hlNotional))
  );
  assert.equal(
    comparison.surplusChange,
    out(dec(conservative.candidate.baseSurplus).minus(maximum.candidate.baseSurplus))
  );
  assert.notEqual(x.autoStatus, 'AUTO_FEASIBLE');
});
test('SEARCH01 有界证明披露原始数量对、实际精算、剪枝和预算退出', () => {
  const f = fixture(),
    x = calc({}, f);
  assert.equal(x.search.gridPairs, '140');
  assert.equal(x.search.method, 'branch_and_bound');
  assert.ok(x.search.exactPairs > 0 && x.search.leverageRows >= x.search.exactPairs);
  const y = calculateCurrent(inputs, f.a, f.m, {}, t, { searchBudget: 1 });
  assert.equal(y.search.stoppedByBudget, true);
  assert.equal(y.search.complete, false);
});
test('OPT09 迟滞仅保留最新快照上仍合法的目标，同时保留原始数学差额', () => {
  const f = fixture(),
    x = calc({}, f),
    c = x.candidate;
  const previous =
    x.top.find(
      (row) =>
        row.hlTargetQuantity === c.hlTargetQuantity &&
        dec(row.vsTargetQuantity).minus(c.vsTargetQuantity).abs().eq('1')
    ) ??
    x.top.find(
      (row) =>
        row.vsTargetQuantity === c.vsTargetQuantity &&
        dec(row.hlTargetQuantity).minus(c.hlTargetQuantity).abs().eq('1')
    );
  assert.ok(previous);
  const pair = [previous.vsTargetQuantity, previous.hlTargetQuantity];
  const run = (r, prior) => calculateCurrent({ ...inputs, ...r }, f.a, f.m, {}, t, { priorTarget: prior });
  const held = run({ rebalanceSteps: '2' }, pair);
  assert.equal(held.advice.source, 'previous');
  assert.deepEqual(held.advice.pair, pair);
  assert.equal(held.adjust.hl.remaining, pair[1]);
  assert.equal(held.candidate.actualRatio, c.actualRatio);
  assert.equal(run({ rebalanceSteps: '0' }, pair).advice.source, 'current');
  assert.equal(run({ rebalanceSteps: '90' }, ['0', '0']).advice.source, 'current');
});
test('OPT10 每项未配置压力附独立入口，缺少账户、杠杆、期限可定位', () => {
  const x = calc({ deadline: '' });
  assert.equal(x.autoStatus, 'AUTO_PARTIAL');
  for (const id of ['hl-source', 'deadline', 'adverseBps', 'fundingDebit', 'delayBps', 'jumpBps'])
    assert.ok(
      x.missingFields.some((item) => item.id === id),
      id
    );
});
test('OPT11 未确认截止时间时，配置波幅仍不产生两日通过结论', () => {
  const x = calc({ deadline: '', movePct: '3' });
  assert.equal(x.deadline, null);
  assert.equal(x.stressedEquity, undefined);
  assert.deepEqual(x.pressure, {});
  assert.ok(x.candidate);
  assert.equal(calc({ deadline: at }).autoStatus, 'AUTO_DEADLINE_EXIT_REQUIRED');
});
test('OPT12 失败端现金从当前权益、真实成交滑点、开平费用及外部资金逐项复算', () => {
  const f = fixture();
  f.a.pf.qty = '-2';
  f.a.hl.qty = '1';
  f.m.hl.levels = [[['99.9', '30']], [['100.2', '30']]];
  const x = calc({ pfFee: '0.0001', hlFee: '0.0005', external: '15', externalAt: at, k: '0.1' }, f),
    b = x.bridge;
  assert.equal(b.start, '120');
  assert.equal(b.external, '15');
  assert.ok(dec(b.settled).minus(x.candidate.failureHypeCash).abs().lt('1e-35'));
  assert.ok(dec(b.settled).plus(b.external).minus(x.candidate.failureCash).abs().lt('1e-35'));
  assert.ok(dec(b.exitFee).gt(0));
  assert.ok(dec(b.exitFill).lt(0));
});

test('CASH03 固定仓位改变杠杆只改变抵押占用和可用额度', () => {
  const c = calc().candidate;
  const [low, high] = [4, 8].map((n) => c.leverageGrid.find((x) => x.leverage === n));
  assert.equal(low.status, 'pass');
  assert.equal(high.status, 'pass');
  assert.equal(low.marginUsed, '100');
  assert.equal(high.marginUsed, '50');
  assert.equal(low.freeAfter, '20');
  assert.equal(high.freeAfter, '70');
  assert.equal(low.postEntryEquity, high.postEntryEquity);
  assert.equal(low.successEquity, high.successEquity);
  assert.equal(low.liquidation, high.liquidation);
  assert.equal(c.actualRatio, '0.4');
});
test('CASH04 成功权益留存与抵押品留存独立，旧 R 只迁移至成功端', () => {
  assert.deepEqual(splitReserves({ R: '23' }), { R_success: '23', R_free: '0' });
  const base = calc(),
    success = calc({ R_success: '35' }),
    free = calc({ R_free: '60' });
  assert.equal(success.funding.upper, '0.85');
  assert.equal(base.funding.upper, '1');
  assert.equal(success.candidate.candidateLeverage, base.candidate.candidateLeverage);
  assert.equal(free.funding.upper, base.funding.upper);
  assert.equal(free.candidate.candidateLeverage, 7);
  assert.equal(free.candidate.actualRatio, base.candidate.actualRatio);
  assert.equal(free.candidate.hlBeforePayout, base.candidate.hlBeforePayout);
  assert.equal(free.candidate.leverageGrid[3].constraint.shortfall, '40');
});
function depthFixture() {
  const f = fixture();
  f.m.hl.levels = [
    [
      ['99.99', '0.25'],
      ['99.98', '25']
    ],
    [
      ['100.01', '0.25'],
      ['100.02', '25']
    ]
  ];
  return calc({ pfFee: '0.0001', hlFee: '0.0005' }, f);
}
function checkJournal(ledger) {
  assert.equal(sumPostings(Object.values(ledger.entries)), ledger.settled);
  const view = presentLedger(ledger);
  assert.ok(dec(sumPostings([...Object.values(view.entries), view.rounding])).eq(view.total));
  assert.ok(dec(ledger.difference).abs().lte('1e-12'));
  for (const k of ['entry', 'exit']) {
    assert.equal(out(dec(ledger[k + 'Nominal']).times(ledger.rate)), ledger[k + 'Fee']);
    assert.ok(dec(ledger.entries[k + 'Slippage']).lte(0));
  }
}
test('CASH05 失败路径两本账与成交均价独立对账，漏项阻断', () => {
  const x = depthFixture();
  for (const ledger of Object.values(x.paths.fail)) checkJournal(ledger);
  const h = x.paths.fail.hl;
  assert.ok(dec(h.exitSlippage).gt(0));
  assert.equal(h.settled, x.candidate.failureHypeCash);
  assert.throws(
    () => reconcilePostings({ ...h.entries, exitSlippage: '0' }, h.fillSettlement),
    /LEDGER_MISMATCH/
  );
  assert.equal(sumPostings(['409', '92.0379', '0.4112', '-0.4277', '-0.5254', '-0.4794']), '500.0166');
  assert.equal(sumPostings(['500.0166', '-0.0160', '-500.0007']), '-0.0001');
});
test('CASH06 成功路径同一账本，平仓滑点同量同盘口不变，费用按终点成交价重算', () => {
  const x = depthFixture();
  for (const ledger of Object.values(x.paths.pass)) checkJournal(ledger);
  const h = x.paths.pass.hl;
  assert.equal(h.settled, x.candidate.hlBeforePayout);
  assert.equal(h.exitSlippage, x.paths.fail.hl.exitSlippage);
  assert.notEqual(h.exitFee, x.paths.fail.hl.exitFee);
  assert.deepEqual(Object.keys(h.entries), Object.keys(x.paths.fail.hl.entries));
  assert.equal(
    sumPostings(['409', '-307.7263', '0.4112', '-0.4277', '-0.0160', '-0.5254', '-0.6793']),
    '100.0365'
  );
});
test('FORM13 当前 PF 权益随账户快照和已持仓标记价重估', () => {
  const f = fixture();
  f.a.pf.equity = '1010';
  f.a.pf.qty = '2';
  f.a.pf.anchor = '95';
  const x = calc({}, f);
  assert.equal(x.funding.E, '1020');
  assert.equal(x.funding.loss, '120');
  assert.equal(x.funding.gain, '80');
  assert.ok(dec(x.funding.lower).eq(dec('40').div('120')));
  assert.equal(x.funding.upper, '1.25');
});
test('FORM14 触及边界停止普通求解，达标仍待扣费净结算', () => {
  for (const [E, why] of [
    ['900', /失败/],
    ['1100', /目标已到，待平台确认结算/]
  ]) {
    const f = fixture();
    f.a.pf.equity = E;
    const x = calc({}, f);
    assert.match(x.notices.join(), why);
    assert.equal(x.candidate, undefined);
    assert.equal(x.range, null);
  }
  const f = fixture();
  f.a.pf.equity = '1100';
  f.a.pf.qty = '2';
  f.m.spec.contractMultiplier = '2';
  const x = calc({ pfFee: '0.01' }, f);
  assert.equal(x.settlePF, '1096');
  assert.match(x.notices.join(), /净结算尚待确认/);
  assert.equal(x.candidate, undefined);
});
test('FORM15 非正距离、颠倒边界和到期状态没有新增仓位', () => {
  for (const patch of [{ challengeFloor: '1010' }, { challengeTarget: '999' }, { challengeFloor: '1101' }]) {
    const x = calc(patch);
    assert.equal(x.candidate, undefined);
    assert.equal(x.range, null);
    assert.ok(x.notices.length);
  }
  const end = calc({ deadline: at });
  assert.equal(end.candidate, undefined);
  assert.equal(end.autoStatus, 'AUTO_DEADLINE_EXIT_REQUIRED');
});
test('SEARCH02 复核剪枝区间上界、已达下界及预算截断', () => {
  const x = calc(),
    p = x.search.proof;
  assert.equal(p.complete, true);
  assert.equal(p.omitted, 0);
  assert.ok(p.rows.length);
  assert.equal(p.lower, x.candidate.vsNotional);
  assert.equal(p.lower, p.upper);
  assert.equal(p.optimalityTolerance, '0');
  for (const row of p.rows) {
    assert.ok(
      row.rule === 'invalidPrice' ? dec(row.upper).lte(row.threshold) : dec(row.upper).lt(row.threshold)
    );
    if (!row.affineDomain) continue;
    const [a, b] = row.affineDomain;
    for (let i = row.from; i <= row.to; i++) {
      const value =
        a === b
          ? dec(row.left)
          : dec(row.right)
              .minus(row.left)
              .times(i - a)
              .div(b - a)
              .plus(row.left);
      assert.ok(value.minus(row.upper).lte('1e-40'));
    }
  }
  const f = fixture(),
    partial = calculateCurrent(inputs, f.a, f.m, {}, t, { searchBudget: 1 });
  assert.equal(partial.search.proof.complete, false);
  assert.ok(dec(partial.search.proof.upper).gte(p.lower));
});
test('SNAP01 八项资金规则或权益改变均产生新快照，候选和流水来自同一版本', () => {
  const ids = new Set();
  for (const [patch, side, balance] of [
    [{}],
    [{ B: '163' }],
    [{}, 'hl', '119'],
    [{ external: '3', externalAt: at }],
    [{}, 'pf', '1004'],
    [{ challengeFloor: '895' }],
    [{ challengeTarget: '1095' }],
    [{ R_success: '25' }],
    [{ R_free: '30' }]
  ]) {
    const f = fixture();
    if (side) f.a[side].equity = balance;
    const x = calc(patch, f);
    assert.ok(!ids.has(x.trace.id));
    ids.add(x.trace.id);
    assert.equal(x.paths.fail.hl.start, x.funding.C_H);
    assert.equal(x.paths.pass.pf.start, x.funding.E);
    assert.equal(x.paths.pass.hl.settled, x.candidate.hlBeforePayout);
    assert.equal(x.autoStatus, 'AUTO_PARTIAL');
  }
});

function scanFixture(overrides = {}, f = fixture()) {
  f.m.spec.fundedInitMarginRatio ??= '0.1';
  return calculateCurrent({ ...inputs, ...overrides }, f.a, f.m, {}, t, { scanRatios: true });
}
test('RANGE01 修改六个资金条件使比例集合与仓位风险随同一快照重算', () => {
  const x = scanFixture({});
  for (const patch of [
    { B: '189' },
    { challengeFloor: '935' },
    { challengeTarget: '1240' },
    { R_success: '100' }
  ]) {
    const n = scanFixture({ ...patch });
    assert.notEqual(n.trace.id, x.trace.id);
    assert.notDeepEqual(n.ratioScan.sets, x.ratioScan.sets);
  }
  for (const [side, value] of [
    ['pf', '1020'],
    ['hl', '110']
  ]) {
    const f = fixture();
    f.a[side].equity = value;
    const n = scanFixture({}, f);
    assert.notDeepEqual(n.ratioScan.sets, x.ratioScan.sets);
  }
});
test('RANGE02 买卖盘、深度及标记价重算相同数量的现金、费用与占用率', () => {
  const p = { sign: -1, i: 10, j: 4 },
    x = scanFixture(),
    a = inspectRatio(x.ratioScan.ctx, p, 'fail'),
    f = fixture();
  f.m.hl = {
    ...f.m.hl,
    mark: '101',
    levels: [
      [
        ['100.99', '0.25'],
        ['100.95', '25']
      ],
      [
        ['101.01', '0.25'],
        ['101.05', '25']
      ]
    ]
  };
  const y = scanFixture({ hlFee: '0.0005' }, f),
    b = inspectRatio(y.ratioScan.ctx, p, 'fail');
  assert.notEqual(a.hypeValue, b.hypeValue);
  assert.notEqual(a.fail, b.fail);
  assert.notEqual(a.imRate, b.imRate);
  assert.equal(a.h, b.h);
  assert.ok(dec(b.paths.fail.hl.exitSlippage).gt(0));
});
test('RANGE03 小网格逐点穷举对照整段扫描，方向、现仓、费用、压力、Funded 和多档维持保证金', () => {
  for (const variant of ['flat', 'fees', 'stress', 'held', 'tier', 'funded']) {
    const f = fixture(),
      r = {};
    if (['fees', 'stress', 'tier'].includes(variant)) {
      f.m.hl.levels = [
        [
          ['99.99', '0.25'],
          ['99.98', '25']
        ],
        [
          ['100.01', '0.25'],
          ['100.02', '25']
        ]
      ];
      r.pfFee = '0.0001';
      r.hlFee = '0.0005';
    }
    if (variant === 'stress')
      Object.assign(r, {
        jumpBps: '25',
        delayBps: '10',
        fundingDebit: '2',
        minBuffer: '0.2',
        minMaintenanceSurplus: '5'
      });
    if (variant === 'held') {
      f.a.pf.qty = '-2';
      f.a.hl.qty = '1';
      f.a.hl.currentMarginCredit = '20';
      f.a.hl.free = '100';
    }
    if (variant === 'tier') f.m.hl.marginTiers.push({ lowerBound: '350', maxLeverage: 5 });
    if (variant === 'funded') Object.assign(r, { stage: 'funded', fundedTarget: '1100', fundedFloor: '900' });
    const s = scanFixture(r, f).ratioScan;
    assert.ok(s.complete);
    const counts = {
      risk: 0,
      protect: 0,
      survive: 0,
      profit: 0,
      both: 0,
      failProfit: 0,
      passProfit: 0,
      afterCreditProfit: 0,
      loss: 0
    };
    for (const sign of [-1, 1])
      for (let i = 1; i <= 10; i++)
        for (let j = 0; j <= 6; j++) {
          let row;
          try {
            row = inspectRatio(s.ctx, { sign, i, j });
          } catch (err) {
            assert.match(err.message, /INVALID_PRICE_ENDPOINT|数值必须大于零/);
            continue;
          }
          const flags = {
            risk: row.physical,
            protect: row.physical && row.covers,
            survive: row.physical && row.survives,
            profit: row.profitable,
            both: row.physical && row.covers && row.survives,
            failProfit: row.failProfitable,
            passProfit: row.passProfitable,
            afterCreditProfit: row.physical && row.funded != null && dec(row.funded.ifCreditedNet).gt(0),
            loss: row.physical && dec(row.successNet).lt(0)
          };
          for (const [key, v] of Object.entries(flags)) {
            assert.equal(
              ratioSlice(s, sign, i, key).some(([a, b]) => j >= a && j <= b),
              v,
              [variant, sign, i, j, key].join('/')
            );
            if (v) counts[key]++;
          }
        }
    for (const [key, n] of Object.entries(counts)) assert.equal(s.sets[key].count, n);
  }
});
test('RANGE04 本金保护可行，考核成功全平时无净盈利比例', () => {
  const s = scanFixture({}).ratioScan;
  assert.ok(s.sets.protect.count > 0);
  assert.equal(s.sets.profit.count, 0);
  assert.equal(s.sets.passProfit.min, null);
});
test('RANGE05 失败平仓路径严格正收益；恰好收回本金不计盈利', () => {
  const s = scanFixture({}).ratioScan;
  assert.ok(s.sets.failProfit.count > 0);
  const row = inspectRatio(s.ctx, s.sets.failProfit.min);
  assert.ok(dec(row.failNet).gt(0));
  assert.ok(row.paths.fail.hl.exitPrice);
  assert.ok(s.sets.protect.count > s.sets.failProfit.count);
  const lowerProtection = scanFixture({ B: '130' }).ratioScan;
  assert.equal(lowerProtection.sets.profit.count, 0);
  assert.equal(
    lowerProtection.sets.high.count + lowerProtection.sets.both.count,
    lowerProtection.sets.legal.count
  );
});
test('RANGE06 任意 h 定位合法步长；同一 h 的不同规模可以分别查看', () => {
  const s = scanFixture({}).ratioScan;
  const p = nearestRatio(s, '0.5', 'both'),
    r = inspectRatio(s.ctx, p);
  assert.equal(r.h, '0.5');
  assert.ok(r.physical && r.survives && r.covers);
  const other = inspectRatio(s.ctx, { i: 4, j: 2, sign: p.sign });
  assert.equal(other.h, r.h);
  assert.notEqual(other.hypeValue, r.hypeValue);
  assert.ok(r.initial && r.bufferRate && r.imRate);
  const near = nearestRatio(s, '0.501');
  assert.equal(inspectRatio(s.ctx, near).h, '0.5');
});
test('RANGE07 无保护和现金交集时仍可检查淘汰比例与缺口', () => {
  const s = scanFixture({ B: '300' }).ratioScan;
  assert.equal(s.sets.both.count, 0);
  assert.equal(s.sets.profit.count, 0);
  const r = inspectRatio(s.ctx, s.sets.risk.min);
  assert.ok(dec(r.shortfall).gt(0));
});
test('RANGE08 搜索预算耗尽不得宣布全局无解，忽略旧版保存的路径选择', () => {
  const x = scanFixture(),
    a = buildRatioScan(x.ratioScan.ctx, { maxVisits: 1 });
  assert.equal(a.complete, false);
  assert.equal(scanFixture({ scanEndpoint: 'fail' }).trace.id, x.trace.id);
});
test('RANGE09 规划与实际快照独立，未确认空仓或权益时不可产生扫描结果', () => {
  const f = fixture();
  f.a.hl.qty = null;
  assert.equal(scanFixture({}, f).ratioScan, undefined);
  const x = scanFixture();
  assert.equal(x.autoStatus, 'AUTO_PARTIAL');
  assert.equal(x.ratioScan.ctx.book.hl, '120');
  const unconfirmed = scanFixture({ investedCapital: '' }).ratioScan;
  assert.equal(unconfirmed.sets.profit.count, 0);
  assert.ok(unconfirmed.sets.protect.count);
  assert.equal(inspectRatio(unconfirmed.ctx, unconfirmed.defaultPoint).successNet, null);
});
test('RANGE10 / PATH01、PATH02 考核两端自动结算并排除 PF 虚拟盈利', () => {
  const s = scanFixture().ratioScan;
  const row = inspectRatio(s.ctx, s.defaultPoint);
  assert.equal(row.funded, null);
  assert.equal(row.payout, '0');
  assert.equal(row.successNet, out(dec(row.success).minus(s.ctx.book.B)));
  assert.equal(row.failNet, out(dec(row.fail).minus(s.ctx.book.B)));
  assert.equal(row.paths.pass.pf.settled, inputs.challengeTarget);
});
test('RANGE11 Funded 自动提供分成到账条件，实际回执未知时不增加个人现金', () => {
  const rules = { stage: 'funded', fundedTarget: '1100', fundedFloor: '900' };
  const s = scanFixture(rules).ratioScan;
  const a = inspectRatio(s.ctx, s.defaultPoint);
  assert.equal(a.funded.eligible, '80');
  assert.equal(a.funded.received, null);
  assert.ok(s.sets.afterCreditProfit.count > s.sets.profit.count);
  assert.ok(dec(a.funded.ifCreditedNet).minus(a.successNet).eq(80));
  assert.equal(a.deadline.status, 'notApplicable');
  const waiting = scanFixture({ ...rules, receivable: '80' });
  assert.ok(waiting.ratioScan && !waiting.candidate);
  const paid = scanFixture({
    ...rules,
    receivedPayout: '80',
    receivedPayoutAt: at,
    external: '80',
    externalAt: at
  });
  assert.equal(paid.autoStatus, 'AUTO_CYCLE_SETTLED');
  assert.equal(paid.receipt.cash, '200');
  assert.equal(paid.marginHL, '120');
  const receivedHL = scanFixture({
    ...rules,
    receivedPayout: '80',
    receivedPayoutAt: at,
    receiptSource: 'hl'
  });
  assert.equal(receivedHL.receipt.cash, '120');
  assert.equal(receivedHL.receipt.net, '-40');
  assert.equal(receivedHL.marginHL, '120');
});
test('PATH03 在同一笔 15.3739% 仓位同时核算两端，不将失败回本归类为净盈利', () => {
  const orig = scanFixture().ratioScan.ctx;
  const market = structuredClone(orig.market);
  for (const l of [market.pf, market.hl]) {
    Object.assign(l, {
      mark: '100',
      bids: [['100', '200']],
      asks: [['100', '200']],
      step: '0.0001',
      free: l === market.pf ? '10000' : '409',
      maxQty: '200'
    });
  }
  const ctx = {
    ...orig,
    market,
    book: {
      ...orig.book,
      pf: '10000',
      hl: '409',
      B: '500',
      challengeFloor: '9400',
      challengeTarget: '12000'
    },
    params: { ...orig.params, profitBasis: '500', R: '100', k: '1.24' }
  };
  const row = inspectRatio(ctx, { sign: -1, i: 1000000, j: 153739 });
  assert.equal(row.h, '0.153739');
  assert.ok(dec(row.fail).minus('500').abs().lt('0.01'));
  assert.ok(dec(row.success).minus('100').abs().lt('1'));
  assert.ok(dec(row.successNet).lt('-399'));
  assert.ok(row.both && row.covers && !row.successCoversPrincipal && !row.profitable);
});
test('PATH04、PATH05 双路径交集为同组仓位的精确交集，单侧回本不算盈利', () => {
  const s = scanFixture().ratioScan;
  assert.ok(s.sets.both.count && s.sets.failProfit.count && !s.sets.profit.count);
  assert.ok(dec(s.sets.both.max.h).lte(s.sets.survive.max.h));
  for (const sign of [-1, 1])
    for (let i = 1; i <= 10; i++)
      for (let j = 0; j <= 6; j++) {
        const has = (k) => ratioSlice(s, sign, i, k).some(([lo, hi]) => lo <= j && j <= hi);
        assert.equal(has('both'), has('protect') && has('survive'));
        assert.equal(has('profit'), has('failProfit') && has('passProfit'));
      }
  const earning = scanFixture({ investedCapital: '100' }).ratioScan;
  assert.ok(earning.sets.profit.count > 0);
});
test('PATH06 换资金或行情即重建四个集合及每组仓位结算', () => {
  const before = scanFixture();
  const f = fixture();
  f.m.hl.mark = '101';
  const after = scanFixture({ R_success: '110', investedCapital: '90', B: '150' }, f);
  assert.notEqual(after.trace.id, before.trace.id);
  for (const k of ['protect', 'survive', 'both', 'profit'])
    assert.notDeepEqual(after.ratioScan.sets[k], before.ratioScan.sets[k], k);
  const q = { i: 10, j: 4, sign: 1 };
  assert.notEqual(
    inspectRatio(before.ratioScan.ctx, q).hypeValue,
    inspectRatio(after.ratioScan.ctx, q).hypeValue
  );
});
test('PATH07 到期价格未知保持未知，明确截止压力路径才结算，先触线即终止', () => {
  const row = (rules = {}) => {
    const s = scanFixture(rules).ratioScan;
    return inspectRatio(s.ctx, s.defaultPoint);
  };
  assert.equal(row({ movePct: '5' }).deadline.status, 'unknown');
  const endpoint = { deadlineMark: '100', deadlineAsset: 'BTC', deadlineBound: inputs.deadline };
  assert.equal(row(endpoint).deadline.cash, '120');
  assert.equal(row({ ...endpoint, deadlineAsset: 'ETH' }).deadline.status, 'unknown');
  assert.equal(row({ ...endpoint, deadlineMark: '200' }).deadline.status, 'firstBoundary');
  assert.equal(calc({ deadline: new Date(t - 1000).toISOString() }).deadlineExit, undefined);
});
test('PATH08 分桶覆盖每个方向和规模，同一比例的不同仓位独立计数', () => {
  const s = scanFixture().ratioScan;
  for (const key of ['legal', 'protect', 'survive', 'both', 'profit'])
    assert.equal(
      s.buckets.reduce((n, b) => n + b[key], 0),
      s.sets[key].count
    );
  for (const b of s.buckets) assert.ok(b.both <= b.survive && b.both <= b.protect);
  const a = inspectRatio(s.ctx, { sign: 1, i: 4, j: 2 }),
    b = inspectRatio(s.ctx, { sign: 1, i: 8, j: 4 });
  assert.equal(a.h, b.h);
  assert.notEqual(a.hypeValue, b.hypeValue);
  const next = adjacentScale(s, { sign: 1, i: 4, j: 2 }, 1);
  assert.deepEqual(next, { sign: 1, i: 6, j: 3 });
  assert.deepEqual(adjacentScale(s, next, -1), { sign: 1, i: 4, j: 2 });
});

test('PATH01 固定现仓仍自动结算两端，范围仅包含所固定的方向与数量', () => {
  const f = fixture();
  f.a.pf.qty = '4';
  f.a.hl.qty = '-2';
  f.a.hl.currentMarginCredit = '40';
  for (const mode of ['keepPF', 'keepHL']) {
    const s = scanFixture({ mode }, f).ratioScan;
    assert.ok(s.complete && s.sets.legal.count);
    const row = inspectRatio(s.ctx, s.defaultPoint);
    assert.ok(row.fail && row.success && row.sign === 1);
    assert.equal(mode === 'keepPF' ? row.pf : row.hl, mode === 'keepPF' ? '4' : '-2');
    assert.ok(
      s.cells.every(
        (c) => c.sign === 1 && (mode === 'keepPF' ? c.from === 4 && c.to === 4 : c.lo === 2 && c.hi === 2)
      )
    );
  }
});

test('PATH03 先强平的路径标出中断，分开另一端的结算', () => {
  const s = scanFixture().ratioScan;
  const row = inspectRatio(s.ctx, { sign: 1, i: 2, j: 6 });
  assert.match(row.passStop, /Hype/);
  assert.equal(row.failStop, null);
  assert.ok(!row.both && !row.profitable);
});
