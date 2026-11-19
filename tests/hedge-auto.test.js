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
  f.a.hl.configuredLeverage = String(c.candidateLeverage);
  f.a.hl.currentMarginCredit = c.requiredInitialMargin;
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
    assert.deepEqual(
      solved.candidates.map((x) => [x.vsTargetQuantity, x.hlTargetQuantity, x.candidateLeverage]),
      all.slice(0, 5).map((x) => [x.vsTargetQuantity, x.hlTargetQuantity, x.candidateLeverage])
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
  f.a.hl.configuredLeverage = '5';
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
  const x = calc({ B: '120', R: '10' }, f);
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
  assert.equal(live.autoStatus, 'AUTO_FEASIBLE');
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
    assert.equal(row.stressedEquity, '80');
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
  assert.ok(sort({ initialMargin: ['100000', '100000'], candidateLeverage: 1 }) < 0);
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
    return accountSnapshot(user, 'BTC', async (body) => {
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
    });
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
