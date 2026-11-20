import { searchLiquidityMaximum } from '../src/hedge/liquidity-search.js';
import { unitContract, usdQuote } from '../fixtures/hedge-currency-contracts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRatioScan,
  inspectRatio,
  nearestRatio,
  ratioSlice,
  adjacentScale
} from '../src/hedge/ratio-scan.js';
import { createSolutionSnapshot, displayHistory, publicationState } from '../src/hedge/display-history.js';
import { pagePoints, planRecord, recordFromInspection, pointKey, scaleComparison, segmentPage } from '../src/hedge/position-plans.js';
import { ratioChanges } from '../src/hedge/ratio-analysis.js';
import { exactRatio, ratioBin } from '../src/hedge/ratio-scan.js';
import { MarketRevaluation } from '../src/hedge/scan-refresh.js';
import { sumPostings, presentLedger, reconcilePostings } from '../src/hedge/settlement-ledger.js';
import { calculateCurrent, rules, splitReserves } from '../src/hedge/current.js';
import { solveAuto, compareAuto, compareConservative } from '../src/hedge/auto.js';
import { demoMarket, evaluateCandidate, profileInputs, validateMargin } from '../src/hedge/solver.js';
import { createBook } from '../src/hedge/book.js';
import { dec, out, min, fillEvidence } from '../src/hedge/math.js';
const at = '2026-11-19T12:00:00Z',
  t = Date.parse(at);
const inputs = {
  ...rules,
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
        contract: unitContract('BTC'),
        collateralToken: 0,
        maxLeverage: 10,
        maxQty: '6',
        marginTiers: [{ lowerBound: '0', maxLeverage: 10 }]
      },
      spec: {
        symbol: 'BTC-PERP',
        base: 'BTC',
        contract: unitContract('BTC-PERP'),
        quote: 'USDC',
        sizeDecimals: 0,
        maxQty: '10',
        capitalInitMarginRatio: '0.1',
        maintMarginRatio: '0.025'
      }
    }
  };
}
const calc = (r = {}, f = fixture(), time = t) => calculateCurrent({ ...inputs, ...r }, f.a, f.m, f.rates ?? {}, time);
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
  f.m.spec.contract.contractMultiplier = '2';
  f.m.hl.contract = unitContract('BTC', 'USD');
  f.rates = { USDC: usdQuote('USDC', '1.25', '1.25', at) };
  const x = calc({}, f),
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
    { adverseBps: '0.01', asyncBps:'0.01', jumpBps: '0.01', delayBps: '0.01', fundingDebit: '0.001', B: '159' },
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
  assert.equal(unspecified.stress.missing.length, 5);
  assert.ok(unspecified.candidate);
  const zero = calc({ movePct: '0', asyncBps:'0', adverseBps: '0', delayBps: '0', jumpBps: '0', fundingDebit: '0' });
  assert.equal(zero.stress.zero.length, 5);
  assert.equal(zero.stress.missing.length, 0);
  assert.equal(zero.stressedEquity, '1000');
  assert.ok(zero.candidate);
  const partial = calc({ jumpBps: '1', fundingDebit: '0' });
  assert.equal(partial.stress.missing.length, 3);
  const configured = calc({ jumpBps: '1', delayBps: '1', adverseBps: '1', asyncBps:'1', fundingDebit: '0.01' });
  assert.equal(configured.stress.positive.length, 5);
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
  assert.equal(stress.stressedMaintenance, '22.3'); // 4 × 111.5 × 5% during the transient lag
  assert.equal(stress.stressedSurplus, '50.7');
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
  f.m.hl.contract.contractMultiplier = '2';
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
test('STATE01 压力输入缺失、显式零、账户未核实或未进行逐仓验算时保持条件状态', () => {
  const f = fortyLevels();
  const stress = { adverseBps: '0.1', asyncBps:'0.1', jumpBps: '0.1', delayBps: '0.1', fundingDebit: '0.01', B: '159' };
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
  const preflight=calc(stress,f);
  assert.equal(preflight.autoStatus,'AUTO_PARTIAL');
  assert.ok(preflight.unverified.includes('未执行逐仓盘口与价格压力核验'));
  for (const field of ['adverseBps', 'asyncBps', 'jumpBps', 'delayBps', 'fundingDebit'])
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
  assert.equal(full.trace.model, 'AUTO-0.21.8');
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
test('盘口时差 1088 ms 超过阈值时停止发起求解，恢复到边界后重新接受', () => {
  const f=fixture();
  f.m.hl.markAt=at;
  const check=lag=>{
    f.m.hl.bookAt=new Date(t-lag).toISOString();
    return calculateCurrent({...inputs,quoteSkewMs:'1000'},f.a,f.m,{},t,{deferAuto:true});
  };
  assert.ok(check(0).needsSearch);
  const blocked=check(1088);
  assert.equal(blocked.timing.quoteSkew,1088);
  assert.ok(!blocked.needsSearch && !blocked.candidate);
  assert.match(blocked.issues.join(' '),/行情熔断/);
  assert.ok(check(1000).needsSearch);
});
test('盘口时差 10727 ms 即使各腿仍在 TTL 内也暂停，恢复时须重新核准快照',()=>{
  const f=fixture(), constraints={...inputs,quoteSecs:'20',quoteSkewMs:'3000'};
  f.m.hl.markAt=at;
  function atSkew(lag) {
    f.m.hl.bookAt=new Date(t-lag).toISOString();
    return calculateCurrent(constraints,f.a,f.m,{},t,{deferAuto:true});
  }
  assert.ok(atSkew(0).needsSearch);
  const breach=atSkew(10727);
  assert.equal(breach.timing.quoteSkew,10727);
  assert.equal(breach.timing.quoteLimit,3000);
  assert.ok(!breach.needsSearch && !breach.adjust && !breach.candidate);
  assert.match(breach.issues.join(' '),/行情熔断/);
  assert.ok(!atSkew(3001).needsSearch);
  assert.ok(atSkew(3000).needsSearch);
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
  f.m.spec.contract.contractMultiplier = '2';
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
  return calculateCurrent({ ...inputs, ...overrides }, f.a, f.m, f.rates ?? {}, t, { scanRatios: true });
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
test('RANGE03 / AUTOSEL08 小网格逐点穷举对照整段扫描，方向、现仓、费用、压力、Funded 和多档维持保证金', () => {
  for (const variant of ['flat', 'fees', 'stress', 'held', 'tier', 'funded', 'combined','reference']) {
    const f = fixture(),
      r = {};
    if (['fees', 'stress', 'tier', 'combined'].includes(variant)) {
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
    if (['stress', 'combined'].includes(variant))
      Object.assign(r, {
        jumpBps: '25',
        delayBps: '10',
        fundingDebit: '2',
        minBuffer: '0.2',
        minMaintenanceSurplus: '5'
      });
    if (['held', 'combined','reference'].includes(variant)) {
      f.a.pf.qty = '-2';
      f.a.hl.qty = '1';
      f.a.hl.currentMarginCredit = '20';
      f.a.hl.free = '100';
    }
    if (['tier', 'combined'].includes(variant))
      f.m.hl.marginTiers.push({ lowerBound: '350', maxLeverage: 5 });
    if (variant === 'reference') f.a.hl.liquidation = '80';
    if (variant === 'combined') {
      f.m.spec.contract.contractMultiplier = '1.5';
      f.m.hl.contract = { ...unitContract('BTC', 'USDT', 'USD'), settlement: 'quanto-1:1' };
      f.rates = { USDC: usdQuote('USDC', '1.05', '1.05', at), USDT: usdQuote('USDT', '0.98', '0.98', at) };
      Object.assign(r, { external: '80', externalAt: at });
    }
    if (variant === 'funded') Object.assign(r, { stage: 'funded', fundedTarget: '1100', fundedFloor: '900' });
    const s = scanFixture(r, f).ratioScan;
    assert.ok(s.complete);
    const legalRows = [];
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
          if (ratioSlice(s, sign, i, 'legal').some(([lo, hi]) => lo <= j && j <= hi)) legalRows.push(row);
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
    const flags = {
      legal: () => true,
      risk: (r) => r.physical,
      protect: (r) => r.physical && r.covers,
      survive: (r) => r.physical && r.survives,
      both: (r) => r.both,
      failProfit: (r) => r.failProfitable,
      passProfit: (r) => r.passProfitable,
      profit: (r) => r.profitable
    };
    for (const [key, qualifies] of Object.entries(flags)) {
      const members = legalRows.filter(qualifies);
      assert.equal(members.length, s.sets[key].count, variant + '/' + key);
      for (const [index, bin] of [...s.buckets, null].entries()) {
        // Independent exact oracle, with BOTH ends owned by the joint band.
        const compare = (row, edge) => BigInt(row.j)*BigInt(edge.i) - BigInt(edge.j)*BigInt(row.i);
        const rows = members.filter(row => {
          if (!bin || bin.edgeKey === 'all') return true;
          const lo = compare(row,s.sets.both.min), hi = compare(row,s.sets.both.max);
          if (bin.edgeKey === 'below') return lo < 0n;
          if (bin.edgeKey === 'above') return hi > 0n;
          return lo >= 0n && hi <= 0n;
        });
        const range = bin ? bin.ranges[key] : s.sets[key].range;
        if (bin) assert.equal(bin[key], rows.length);
        if (!rows.length) {
          assert.equal(range, null);
          continue;
        }
        assert.equal(range.count, rows.length);
        const fees = (row, path) => {
          const ledgers = row.paths[path];
          const leg = s.ctx.market.hl;
          return dec(ledgers.hl.entryFee)
            .plus(ledgers.hl.exitFee)
            .plus(ledgers.pf.entryFee)
            .plus(ledgers.pf.exitFee)
            .plus(
              dec(row.stress?.priceShock ?? '0')
                .times(dec(row.hl).abs())
                .times(leg.multiplier)
                .times(leg.fx)
                .times(leg.rate)
            );
        };
        const values = {
          failure: (r) => r.fail ?? r.conditionalEndpoints.failure,
          success: (r) => r.successPersonal ?? r.conditionalEndpoints.successPersonal,
          successHype: (r) => r.success ?? r.conditionalEndpoints.successHype,
          pfQty: (r) => dec(r.pf).abs(),
          hlQty: (r) => dec(r.hl).abs(),
          pfValue: (r) => r.pfValue,
          hlValue: (r) => r.hypeValue,
          failureFee: (r) => fees(r, 'fail'),
          successFee: (r) => fees(r, 'pass'),
          gapRate: (r) => r.gapRate,
          consumption: (r) => r.consumption,
          minMargin: (r) => r.initial, maxMargin: (r) => r.initial,
          minBuffer: (r) => r.buffer, maxBuffer: (r) => r.buffer
        };
        for (const [metric, get] of Object.entries(values)) {
          for (const [end, witness] of Object.entries(
            Array.isArray(range.witnesses[metric])
              ? range.witnesses[metric]
              : range.witnesses[metric]
                ? [range.witnesses[metric]]
                : []
          )) {
            const member = rows.find(
              (r) => r.i === witness.i && r.j === witness.j && r.sign === witness.sign
            );
            assert.ok(member, [variant, key, index, metric, 'witness outside subset'].join('/'));
            const extreme = Array.isArray(range[metric]) ? range[metric][end] : range[metric];
            assert.ok(dec(extreme).minus(get(member)).abs().lt('1e-11'));
          }
          const vals = rows
            .map(get)
            .filter((v) => v != null)
            .map(dec)
            .sort((a, b) => a.cmp(b));
          const checks = Array.isArray(range[metric]) ? [
            [range[metric][0],vals[0]], [range[metric][1],vals.at(-1)]
          ] : [[range[metric],metric.startsWith('min') ? vals[0] : vals.at(-1)]];
          for (const [got, want] of checks)
            if (want == null) assert.equal(got, null);
            else
              assert.ok(
                got != null && want.minus(got).abs().lt('1e-11'),
                [variant, key, metric, got, want].join('/')
              );
        }
      }
    }
  }
});
test('实时行情增量重估与冷启动同一组仓位、资金、风险和剪枝证明', () => {
  const f = fixture(),
    cache = new MarketRevaluation();
  const compute = (cached, rule = inputs) =>
    calculateCurrent(rule, f.a, f.m, {}, t, {
      scanRatios: true,
      marketCache: cached
    });
  const first = compute(cache);
  const same = compute(cache);
  assert.ok(cache.hits.ranges > 0 && cache.hits['ranking-size'] > 0);
  assert.deepEqual(same.ratioScan.buckets, first.ratioScan.buckets);
  f.m.pf = { ...f.m.pf, mark: '101', levels: [[['100.95', '10']], [['101.05', '9']]] };
  const next = compute(cache),
    cold = compute(undefined);
  assert.ok(cache.hits['lots-hl'] > 0);
  assert.deepEqual(next.ratioScan.representative, cold.ratioScan.representative);
  assert.deepEqual(next.ratioScan.buckets, cold.ratioScan.buckets);
  assert.deepEqual(next.search.proof, cold.search.proof);
  assert.notDeepEqual(first.ratioScan.buckets, next.ratioScan.buckets);
  const rule = { ...inputs, B: '180', R_success: '40' };
  assert.deepEqual(compute(cache, rule).ratioScan.buckets, compute(undefined, rule).ratioScan.buckets);
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

test('AUTOSEL02/04 自动代表与交集采用同一额外回本缓冲，单端回本仍可独立核对', () => {
  const original = scanFixture(),
    guarded = scanFixture({ recoveryBuffer: '6' }),
    unreachable = scanFixture({ recoveryBuffer: '1000' });
  for (const x of [original, guarded]) {
    const { representative: rep, sets } = x.ratioScan;
    assert.equal(rep.group, 'both');
    assert.notEqual(rep.objective, 'diagnostic');
    assert.ok(rep.row.both && dec(rep.row.failureVsProtection).gte(rep.buffer));
    assert.ok(dec(rep.row.fail).gte(sets.both.range.failure[0]));
  }
  assert.deepEqual(original.ratioScan.sets.protect, guarded.ratioScan.sets.protect);
  assert.ok(original.ratioScan.sets.both.count > guarded.ratioScan.sets.both.count);
  assert.equal(unreachable.ratioScan.sets.both.count, 0);
  assert.equal(unreachable.ratioScan.representative.objective, 'diagnostic');
});
test('AUTOSEL05 500.0018U 仅高出 0.0018U，缓冲率 0.00036%', async () => {
  const { recoveryCushion } = await import('../src/hedge/range-report.js');
  assert.deepEqual(recoveryCushion('500.0018', '500'), { amount: '0.0018', rate: '0.0000036', thin: true });
  assert.equal(recoveryCushion('499.9999', '500').thin, false);
});

test('DYN01 同步标记价格、盘口同比变化：理论界限和 h 可不变，目标数量、费用及保证金实际重算', () => {
  const rules = { pfFee: '0.0001', hlFee: '0.0005' };
  const a = scanFixture(rules);
  const f = fixture();
  for (const venue of ['pf', 'hl'])
    Object.assign(f.m[venue], { mark: '480', levels: [[['480', '30']], [['480', '30']]] });
  const b = scanFixture(rules, f);
  const left = a.ratioScan.representative.row,
    right = b.ratioScan.representative.row;
  assert.deepEqual(a.ratioScan.analysis.theory, b.ratioScan.analysis.theory);
  assert.equal(left.h, right.h);
  for (const key of ['pf', 'hl', 'pfValue', 'hypeValue', 'initial', 'buffer'])
    assert.notEqual(left[key], right[key], key);
  assert.notEqual(left.paths.fail.hl.entryFee, right.paths.fail.hl.entryFee);
  const delta = ratioChanges(a, b);
  assert.ok(!delta.theoryChanged && !delta.hChanged && delta.lotsChanged);
  assert.ok(delta.changes.includes('标记价'));
});

test('DYN02 分别改变点差、单边费率，核对相同实际仓位的双端结算及离散界限', () => {
  const a = scanFixture(),
    f = fixture();
  f.m.hl.levels = [[['98', '30']], [['102', '30']]];
  for (const [b, label] of [
    [scanFixture({}, f), '盘口价格或深度'],
    [scanFixture({ hlFee: '0.007' }), '成交费率']
  ]) {
    const read = (s) => inspectRatio(s.ratioScan.ctx, { sign: -1, i: 10, j: 4 });
    assert.equal(a.funding.lower, b.funding.lower);
    assert.ok(dec(read(b).fail).lt(read(a).fail) && dec(read(b).success).lt(read(a).success));
    assert.ok(dec(b.ratioScan.sets.both.min.h).gt(a.ratioScan.sets.both.min.h));
    assert.ok(dec(b.ratioScan.sets.both.max.h).lt(a.ratioScan.sets.both.max.h));
    assert.ok(ratioChanges(a, b).changes.includes(label));
  }
});

test('DYN03 本金、Hype权益、外部资金、当前 PF 权益、两条触线、成功留存独立驱动上下界', () => {
  const a = scanFixture();
  for (const [patch, side, equity, lo, hi, label] of [
    [{ B: '183' }, null, null, '0.63', '1', '保护本金'],
    [{}, 'hl', '145', '0.15', '1.25', 'Hype 权益'],
    [{ external: '18', externalAt: at }, null, null, '0.22', '1', '外部到账资金'],
    [{}, 'pf', '1020', out(dec('40').div(120)), '1.25', 'PF 权益'],
    [{ challengeFloor: '929' }, null, null, out(dec('40').div(71)), '1', '失败线'],
    [{ challengeTarget: '1150' }, null, null, '0.4', out(dec('100').div(150)), '成功线'],
    [{ R_success: '51' }, null, null, '0.4', '0.69', '成功最低留存']
  ]) {
    const f = fixture();
    if (side) Object.assign(f.a[side], { equity, free: equity });
    const b = scanFixture(patch, f),
      delta = ratioChanges(a, b);
    assert.deepEqual([b.funding.lower, b.funding.upper], [lo, hi], label);
    assert.ok(delta.changes.includes(label) && delta.theoryChanged && delta.intervalChanged, label);
    if (['保护本金', 'Hype 权益'].includes(label)) assert.ok(delta.hChanged);
  }
});

test('DYN04 仅变更参考 FX：quanto 单点、原生路径、实际比例、邻近方案与强平距离完全一致', () => {
  const f = fixture();
  f.m.hl.contract = {
    ...unitContract('BTC', 'USDT', 'USDC'),
    standardCryptoPerp: true,
    settlement: 'quanto-1:1'
  };
  f.rates = { USDC: usdQuote('USDC', '1', '1', at), USDT: usdQuote('USDT', '1', '1', at) };
  const a = scanFixture({}, f);
  f.rates = { ...f.rates, USDT: usdQuote('USDT', '0.98', '0.98', at) };
  const b = scanFixture({}, f);
  assert.notEqual(a.currencies.hypeToVest.mid, b.currencies.hypeToVest.mid);
  assert.ok(b.currencies.warnings.length);
  assert.deepEqual(a.ratioScan.representative.row.paths, b.ratioScan.representative.row.paths);
  assert.deepEqual(a.ratioScan.analysis.neighbors, b.ratioScan.analysis.neighbors);
  assert.deepEqual(ratioChanges(a, b).changes, ['参考汇率']);
});

test('DYN05、DYN06 边界单组的精确见证，按半开区间只计入一个桶，各子集合计一致', () => {
  const f = fixture();
  f.a.hl.qty = '-2';
  f.a.hl.currentMarginCredit = '20';
  const scan = scanFixture({ mode: 'keepHL' }, f).ratioScan;
  const b = scan.analysis.boundary;
  assert.deepEqual([b.count, b.fraction, b.pf, b.hl], [1, '2/5', '5', '-2']);
  assert.equal(ratioBin(scan.buckets, b), b.segment);
  assert.equal(scan.buckets[b.segment].edgeKey,'joint');
  assert.equal(ratioBin(scan.buckets,scan.sets.both.max), b.segment);
  assert.equal(scan.buckets[b.segment].both,scan.sets.both.count);
  assert.ok(scan.buckets.every(bin => bin.edgeKey === 'joint' || bin.both === 0));
  const sums = {};
  for (const key of ['legal', 'risk', 'protect', 'survive', 'both', 'failProfit', 'passProfit', 'profit']) {
    sums[key] = scan.buckets.reduce((acc, x) => acc + x[key], 0);
    assert.equal(sums[key], scan.sets[key].count, key);
  }
  // Exact sensitivity ratios also handle unequal multipliers and recurring percentages.
  const m = structuredClone(scan.ctx.market);
  m.pf.multiplier = '3';
  assert.equal(exactRatio(m, '-5', '2'), '2/15');
});

test('DYN07 相邻目标来自同一方向最近合法数量网格，逐行复核现金、保证金、强平和去重', () => {
  for (const mode of ['auto', 'keepHL']) {
    const f = fixture();
    if (mode === 'keepHL') {
      f.a.hl.qty = '-2';
      f.a.hl.currentMarginCredit = '20';
    }
    const scan = scanFixture({ mode }, f).ratioScan,
      rep = scan.representative.row;
    const rows = scan.analysis.neighbors,
      axis = mode === 'keepHL' ? 'i' : 'j';
    const lots = [];
    for (let i = 1; i <= 10; i++)
      for (let j = 0; j <= 6; j++) {
        if (
          (axis === 'i' ? rep.j !== j : rep.i !== i) ||
          !ratioSlice(scan, rep.sign, i).some(([a, b]) => a <= j && j <= b)
        )
          continue;
        lots.push(axis === 'i' ? i : j);
      }
    const k = lots.indexOf(rep[axis]);
    assert.deepEqual(
      rows.map((r) => r[axis]),
      lots.slice(Math.max(0, k - 2), k + 3)
    );
    assert.equal(rows.filter((r) => r.center).length, 1);
    assert.ok(rows.some((r) => !r.both) && rows.some((r) => r.both));
    for (const row of rows) {
      const check = inspectRatio(scan.ctx, row);
      for (const field of [
        'h',
        'pf',
        'hl',
        'pfValue',
        'hypeValue',
        'fail',
        'success',
        'initial',
        'imRate',
        'buffer',
        'failStop',
        'passStop',
        'both'
      ])
        assert.equal(row[field], check[field], field);
    }
  }
});

test('DYN 数量步长独立变化：理论不变，可行下界及自动代表 h 随实际数量变化', () => {
  const a = scanFixture({ B: '177' }),
    f = fixture();
  f.m.hl.sizeDecimals = 1;
  const b = scanFixture({ B: '177' }, f),
    c = ratioChanges(a, b);
  assert.ok(!c.theoryChanged && c.hChanged && c.intervalChanged && c.changes.includes('数量网格'));
  assert.deepEqual([a.ratioScan.representative.row.h, b.ratioScan.representative.row.h], ['0.6', '0.57']);
});

test('实际仓位分页穷尽所有合法网格，方向、比例与规模分别保留', () => {
  const scan = scanFixture().ratioScan;
  const pages = [];
  let cursor = null;
  do {
    const page = pagePoints(scan, scan.plans.index, cursor, 3);
    assert.ok(page.rows.length && page.rows.length <= 3);
    pages.push(...page.rows);
    cursor = page.next;
  } while (cursor);
  const expected = [];
  for (const sign of [1, -1])
    for (let i = 1; i <= 10; i++)
      for (let j = 0; j <= 6; j++)
        if (ratioSlice(scan, sign, i).some(([lo,hi]) => lo <= j && j <= hi)) expected.push({sign,i,j});
  assert.deepEqual(pages, expected);
  assert.equal(new Set(pages.map(pointKey)).size, scan.sets.legal.count);
  const pair = scan.plans.rows.filter(r => r.labels.includes('同 h 规模对照'));
  assert.equal(pair.length, 2);
  assert.equal(pair[0].fraction, pair[1].fraction);
  assert.notEqual(pair[0].i, pair[1].i);
});

test('三目标从合格交集分别取真仓位，对照逐点账本、额外保护缓冲及 Funded 约束', () => {
  for (const rules of [{}, { recoveryBuffer:'5' }, { recoveryBuffer:'1000' },
    { stage:'funded', ref:'140', fundedTarget:'1100', fundedFloor:'900', g:'50' }]) {
    const scan = scanFixture(rules).ratioScan;
    const eligible = [];
    for (const {sign,i,j} of pagePoints(scan,scan.plans.index,null,1000).rows) {
      const r = inspectRatio(scan.ctx,{sign,i,j});
      if (r.both && dec(r.failureVsProtection).gte(rules.recoveryBuffer ?? 0) &&
          (!rules.ref || dec(r.funded.ifCredited).minus(rules.ref).gte(rules.g))) eligible.push(r);
    }
    assert.equal(eligible.length, scan.plans.eligible);
    for (const [label,field] of [['最大 PF 仓位','pfValue'],['失败回收优先','fail'],['成功留存优先','success']]) {
      const winners = scan.plans.rows.filter(r => r.labels.includes(label));
      assert.equal(winners.length,eligible.length ? 1 : 0);
      if (!eligible.length) continue;
      const pick=winners[0], actual=eligible.find(r=>pointKey(r)===pick.key);
      assert.ok(actual);
      for (const k of ['pfValue','hypeValue','fail','success','initial']) assert.equal(pick[k],actual[k]);
      assert.ok(eligible.every(r=>dec(r[field]).lte(pick[field])));
    }
  }
});

test('每行原生买卖均价及双边费用来自同一个差额仓位，外部现金只计入个人总额', () => {
  const f=fixture();
  f.a.hl.qty='1'; f.a.hl.currentMarginCredit='10';
  f.m.hl.levels=[[['99.8','0.5'],['99.6','30']],[['100.1','0.5'],['100.2','30']]];
  const scan=scanFixture({hlFee:'0.0005',pfFee:'0.0001',external:'15',externalAt:at},f).ratioScan;
  for (const p of [{sign:-1,i:6,j:1},{sign:-1,i:6,j:2},{sign:1,i:6,j:2}]) {
    const r=planRecord(scan,p), actual=inspectRatio(scan.ctx,p);
    assert.equal(r.hlFill.price,actual.paths.fail.hl.entryPrice);
    if(r.j===1) assert.equal(r.hlFill.price,null);
    else assert.ok(p.sign<0 ? dec(r.hlFill.price).gt('100.1') : dec(r.hlFill.price).lt('99.8'));
    assert.ok(dec(r.fail).minus(r.failHype).eq('15'), JSON.stringify([r.fail, r.failHype, scan.ctx.book.external]));
    for(const [key,path] of [['failCost','fail'],['passCost','pass']]) {
      const {pf,hl}=actual.paths[path];
      const total=sumPostings([pf.entryFee,hl.entryFee,pf.exitFee,hl.exitFee]);
      assert.equal(r[key].fees,total);
    }
  }
});

test('断线重载保留四个目标槽及同规模对照的原始记录，资金来源之间隔离', () => {
  const f = fixture(), result = scanFixture({}, f);
  result.calculationMarket = f.m;
  const data = new Map(), storage = {
    getItem: k => data.get(k) ?? null,
    setItem: (k,v) => data.set(k,v)
  };
  displayHistory(storage).record('plan:BTC',createSolutionSnapshot(result));
  const retained = displayHistory(storage).read('plan:BTC').ratioScan;
  assert.deepEqual(retained.plans.rows,result.ratioScan.plans.rows);
  assert.equal(retained.plans.index,undefined);
  assert.equal(displayHistory(storage).read('account:BTC'),null);
  const [[key,raw]]=data.entries(), old=JSON.parse(raw);
  const restored=displayHistory(storage).read('plan:BTC');
  const basicSlots=[0,2,3];
  assert.deepEqual(basicSlots.map(i=>restored.targets[i].key),result.ratioScan.plans.targetKeys);
  assert.equal(restored.targets[1],restored.ratioScan.plans.pressure?.row ?? null);
  for (const i of basicSlots) assert.equal(restored.targets[i],restored.ratioScan.plans.rows.find(p=>p.key===restored.targets[i].key));
  assert.equal(restored.quoteSnapshotId,result.trace.marketId);
  delete old.view.ratioScan.plans.targetKeys;
  delete old.view.trace.accountsId;
  storage.setItem(key,JSON.stringify(old));
  const migrated=displayHistory(storage).read('plan:BTC');
  assert.deepEqual(basicSlots.map(i=>migrated.targets[i].key),result.ratioScan.plans.targetKeys);
  assert.equal(migrated.accountSnapshotId,null);
  delete old.view.ratioScan.plans;
  storage.setItem(key,JSON.stringify(old));
  const legacy=displayHistory(storage).read('plan:BTC').ratioScan;
  assert.equal(legacy.plans.rows[0].fail, legacy.representative.row.fail);
  assert.equal(legacy.plans.rows[0].success, legacy.representative.row.success);
  assert.equal(legacy.plans.legacy,true);
});

test('发布快照引用同一批目标并冻结，修改资金规则后各版本可核对', () => {
  const f = fixture();
  function publish(patch) {
    const result = scanFixture(patch,f);
    result.calculationMarket = f.m;
    result.finishedAt = new Date(t + 100).toISOString();
    const snapshot=createSolutionSnapshot(result);
    assert.deepEqual([snapshot.snapshotId, snapshot.quoteSnapshotId, snapshot.accountSnapshotId,
      snapshot.rulesVersion, snapshot.solverVersion, snapshot.calculatedAt], [result.trace.id,
      result.trace.marketId, result.trace.accountsId, result.trace.rulesId, result.trace.model, result.finishedAt]);
    return snapshot;
  }
  const first=publish({}), next=publish({R_success:'21'});
  assert.notEqual(first.snapshotId,next.snapshotId);
  assert.notEqual(first.rulesVersion,next.rulesVersion);
  assert.equal(first.quoteSnapshotId,next.quoteSnapshotId);
  assert.equal(first.accountSnapshotId,next.accountSnapshotId);
  const plans=first.ratioScan.plans;
  assert.equal(first.targets.length,4);
  assert.equal(first.targets[1],plans.pressure.row ?? null);
  for (const [i,slot] of [0,2,3].entries()) {
    const row=first.targets[slot];
    assert.equal(row,plans.rows.find(r=>r.key===plans.targetKeys[i]));
    assert.throws(()=>{row.fail='0'},TypeError);
  }
  for (const row of first.scale.automatic.rows)
    assert.equal(row,plans.rows.find(r=>r.key===row.key));
  const none=publish({recoveryBuffer:'1000'});
  assert.deepEqual(none.targets,[null,null,null,null]);
  assert.equal(none.ratioScan.plans.eligible,0);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.targets) && Object.isFrozen(first.scale.fixed.rows));
});

test('比例分段的分页、全量交集及三种优先目标与逐仓复算一致', () => {
  for (const buffer of ['0','6','1000']) {
    const scan = scanFixture({recoveryBuffer:buffer}).ratioScan;
    const all = pagePoints(scan,scan.plans.index,null,10000).rows;
    assert.equal(all.length,scan.sets.legal.count);
    const records = all.map(point=>({point, row:inspectRatio(scan.ctx,point)}));
    const floor=dec(scan.ctx.book.B).plus(buffer);
    const qualifies=({row})=>row.physical && !row.failStop && !row.passStop &&
      dec(row.fail).gte(floor) && dec(row.success).gte(scan.ctx.params.R);
    const winners=records.filter(qualifies);
    assert.equal(scan.sets.both.count,winners.length);
    for(const record of records) assert.equal(record.row.both,qualifies(record));
    for(const [n,bin] of scan.buckets.entries()) {
      for(const kind of ['legal','both']) {
        const oracle=(kind==='both'?winners:records).filter(({point})=>ratioBin(scan.buckets,point)===n);
        assert.equal(bin[kind],oracle.length);
        const keys=[];
        for(let p=1;p<=Math.ceil(oracle.length/3);p++) {
          const page=segmentPage(scan,n,kind,p,3);
          assert.equal(page.total,oracle.length);
          keys.push(...page.points.map(pointKey));
        }
        assert.deepEqual(keys,oracle.map(({point})=>pointKey(point)));
        const last=segmentPage(scan,n,kind,1e12,3);
        assert.equal(last.page,last.pages||1);
        if(kind==='both' && oracle.length) {
          assert.ok(dec(bin.ranges.both.failure[0]).gte(floor));
          assert.ok(dec(bin.ranges.both.successHype[0]).gte(scan.ctx.params.R));
        }
      }
    }
  }
});
test('额外保护缓冲在等号处入交集，多一个最小现金单位即排除', () => {
  const f=scanFixture().ratioScan, point=f.sets.both.largest;
  const margin=inspectRatio(f.ctx,point).failureVsProtection;
  for(const [value,expected] of [[margin,true],[out(dec(margin).plus('0.00000001')),false]]) {
    const s=scanFixture({recoveryBuffer:value}).ratioScan;
    assert.equal(inspectRatio(s.ctx,point).both,expected);
    assert.equal(ratioSlice(s,point.sign,point.i,'both').some(([lo,hi])=>lo<=point.j && point.j<=hi),expected);
  }
});

test('交集闭区间的精确边界、紧邻 tick、单点和零下界统一归段', () => {
  // These exact lot pairs produce the two reported rounded percentages.
  const min = {i:11000,j:1670}, max = {i:5700,j:880};
  const partition = (a,b) => [{throughLots:{...a,inclusive:false}},
    {throughLots:{...b,inclusive:true}}, {throughLots:null}];
  assert.equal(dec(String(min.j)).div(min.i).times(100).toFixed(4),'15.1818');
  assert.equal(dec(String(max.j)).div(max.i).times(100).toFixed(4),'15.4386');
  for (const [a,b] of [[min,max],[min,min],[{i:2,j:0},max]]) {
    const bins=partition(a,b);
    for (const [point,expected] of [[a,1],[b,1],[{i:a.i*9,j:a.j*9},1],[{i:b.i*9,j:b.j*9+1},2]])
      assert.equal(ratioBin(bins,point),expected);
    if (a.j) assert.equal(ratioBin(bins,{i:a.i*9,j:a.j*9-1}),0);
  }
  const scan=scanFixture().ratioScan;
  const joint=scan.buckets.findIndex(bin=>bin.edgeKey==='joint'), members=[];
  for (let page=1;page<=Math.ceil(scan.sets.both.count/2);page++)
    members.push(...segmentPage(scan,joint,'both',page,2).points);
  const atEdge=(p,e)=>BigInt(p.i)*BigInt(e.j)===BigInt(p.j)*BigInt(e.i);
  assert.ok(members.length && new Set(members.map(pointKey)).size===scan.sets.both.count);
  assert.equal(members.filter(p=>atEdge(p,scan.sets.both.min)).length,scan.sets.both.minCount);
  assert.equal(members.filter(p=>atEdge(p,scan.sets.both.max)).length,scan.sets.both.maxCount);
});

test('同精确比例的规模边际变化逐项来自独立大小仓核算，未知风险不计作零', () => {
  const scan=scanFixture({hlFee:'0.005',pfFee:'0.001'}).ratioScan;
  const c=scan.plans.comparison;
  assert.ok(c);
  const fetchRow=key=>planRecord(scan,scan.plans.rows.find(r=>r.key===key));
  const small=fetchRow(c.small), large=fetchRow(c.large);
  assert.equal(small.sign,large.sign);
  assert.equal(small.fraction,large.fraction);
  assert.ok(small.i<large.i);
  for (const key of Object.keys(c.delta)) {
    if(small[key]==null || large[key]==null) assert.equal(c.delta[key],null);
    else {
      const value = row => ['pf','hl'].includes(key) ? dec(row[key]).abs() : dec(row[key]);
      assert.ok(dec(c.delta[key]).eq(value(large).minus(value(small))),key);
    }
  }
  const pair=[small,large].map(r=>({...r,labels:['同 h 规模对照']}));
  pair[0].distance=null;
  assert.equal(scaleComparison(pair).delta.distance,null);
  assert.equal(scaleComparison([pair[0],{...pair[1],sign:-pair[1].sign}]),null);
});

test('交集汇总等于同段交集，处于相同比例范围的未达标仓位单独计数', () => {
  const scan=scanFixture({pfFee:'0.0001',hlFee:'0.0005'}).ratioScan;
  const bin=scan.buckets.find(b=>b.edgeKey==='joint');
  assert.ok(bin.legal>bin.both && bin.both>0);
  assert.deepEqual(bin.ranges.both,scan.sets.both.range);
  for (const k of ['legal','protect','survive','both'])
    assert.equal(scan.buckets.reduce((n,b)=>n+b[k],0),scan.sets[k].range.count);
  for (const [kind,check] of [['protect','failure'],['survive','successHype'],['both','failure'],['both','successHype']])
    assert.ok(dec(bin.ranges[kind][check][0]).gte(check==='failure'?scan.ctx.book.B:scan.ctx.params.R));
});

test('真实数量回归：0.01685 与 0.03370 BTC 的全仓保证金分别复算', () => {
  const ctx=structuredClone(scanFixture().ratioScan.ctx);
  const mark='62056.4', price=dec(mark);
  ctx.book.hl='409';
  for (const [venue,step] of [['hl','0.00001'],['pf','0.0001']]) {
    Object.assign(ctx.market[venue],{mark,bids:[[mark,'5']],asks:[[mark,'5']],step,minQty:step,
      capacity:null, rate:'0'});
  }
  Object.assign(ctx.market.hl,{free:'389',hold:'20',otherMaintenance:'3',reserve:'0',utilization:'1',
    tiers:[{from:'0',mmr:'0.0125',deduction:'0',maxLeverage:'40'}],exchangeMaxLeverage:'40'});
  const small={i:1100,j:1685,sign:1}, large={i:2200,j:3370,sign:1};
  const get=p=>planRecord({ctx},p);
  const pair=[get(small),get(large)];
  assert.deepEqual(pair.map(r=>r.leverage),['3','6']);
  assert.equal(pair[0].fraction,pair[1].fraction);
  for (const row of pair) {
    const qty=dec(row.hl).abs(), nominal=qty.times(price), initial=nominal.div(row.leverage);
    assert.ok(dec(row.initial).eq(initial));
    assert.equal(initial.toFixed(2),'348.55');
    assert.ok(dec(row.maintenance).eq(nominal.times('0.0125')));
    assert.ok(dec(row.free).eq(dec('389').minus(initial)));
    assert.ok(dec(row.otherInitial).minus(20).abs().lt('1e-40'));
    const root=dec('409').minus(3).plus(nominal).div(qty.times('1.0125'));
    assert.ok(dec(row.liquidation).minus(root).abs().lt('1e-35'));
    assert.equal(row.stressSurplus,null);
  }
  assert.ok(dec(pair[1].maintenance).eq(dec(pair[0].maintenance).times(2)));
  assert.ok(dec(pair[1].distance).lt(pair[0].distance));
  ctx.book.hl='3000'; ctx.market.hl.free='2980';
  const a=get(small), b=get(large);
  assert.equal(a.leverage,b.leverage);
  assert.ok(dec(b.initial).eq(dec(a.initial).times(2)));
});

test('固定杠杆与自动杠杆对照使用同一对大小仓，并独立核对逐档抵押品', () => {
  for (const account of ['flat','held']) {
    const f=fixture();
    if (account==='held') {
      Object.assign(f.a.hl,{qty:'1',anchor:'95',currentMarginCredit:'20',free:'100'});
      f.a.pf.qty='-2';
    }
    const scan=scanFixture({},f).ratioScan;
    const {fixed,comparison,rows}=scan.plans;
    assert.ok(comparison);
    if (account==='flat') assert.ok(fixed.rows);
    const auto=[comparison.small,comparison.large].map(key=>rows.find(r=>r.key===key));
    const grids=auto.map(row=>inspectRatio(scan.ctx,row,{includeLeverageGrid:true}).leverageGrid);
    for (const [i,row] of auto.entries()) {
      const passing=grids[i].filter(level=>level.status==='pass');
      if (!passing.length) { assert.equal(row.physical,false); continue; }
      assert.equal(Number(row.leverage),Math.min(...passing.map(level=>level.leverage)));
      const level=passing.find(level=>String(level.leverage)===row.leverage);
      assert.equal(row.initial,level.initial);
      assert.equal(row.maintenance,level.maintenance);
      assert.equal(row.free,level.freeAfter);
    }
    const common=grids[0].filter(l=>l.status==='pass' && l.leverage &&
      grids[1].some(other=>other.status==='pass' && other.leverage===l.leverage));
    if (!common.length) {
      assert.match(fixed.reason,/没有.*共同杠杆/);
      assert.equal(fixed.rows,undefined);
      continue;
    }
    assert.equal(Number(fixed.leverage),Math.min(...common.map(l=>l.leverage)));
    const equity=profileInputs(scan.ctx.book,scan.ctx.params,scan.ctx.market).C_hl;
    for (const [index,row] of fixed.rows.entries()) {
      const level=grids[index].find(l=>String(l.leverage)===fixed.leverage);
      assert.equal(row.key,auto[index].key);
      assert.equal(row.initial,level.initial);
      assert.equal(row.free,level.freeAfter);
      const direct=inspectRatio(scan.ctx,{sign:row.sign,i:row.i,j:row.j},{fixedLeverage:Number(fixed.leverage),includeLeverageGrid:true});
      assert.deepEqual(direct.leverageGrid.map(l=>l.leverage),[Number(fixed.leverage)]);
      assert.equal(row.maintenance,direct.maintenance);
      assert.equal(row.liquidation,direct.liquidation);
      assert.equal(row.distance,direct.buffer);
      assert.equal(row.fail,direct.fail);
      assert.equal(row.success,direct.success);
      assert.ok(dec(row.marginRate).eq(dec(row.initial).div(equity)));
      for(const key of ['h','pf','hl','fail','success','liquidation','distance']) assert.equal(row[key],auto[index][key]);
      assert.equal(row.leverage,fixed.leverage);
    }
    const [small,large]=fixed.rows;
    assert.ok(dec(large.initial).times(small.hypeValue).minus(dec(small.initial).times(large.hypeValue)).abs().lt('1e-38'));
  }
});

test('候选各自按有符号 PF 数量反解两条原生触线价，并独立对账两侧成交成本', () => {
  const f=fixture();
  f.m.pf.levels=[[['99.8','2'],['99.6','30']],[['100.3','2'],['100.7','30']]];
  f.m.hl.mark='104';
  f.m.hl.levels=[[['103.7','1'],['103.5','30']],[['104.1','1'],['104.4','30']]];
  const close=(a,b)=>assert.ok(dec(a).minus(b).abs().lt('1e-12'),a+' / '+b);
  const scan=scanFixture({pfFee:'0.0002',hlFee:'0.0006',external:'12',externalAt:at}, f).ratioScan;
  const ctx={...scan.ctx,market:{...scan.ctx.market,pf:{...scan.ctx.market.pf,factor:'2'},
    hl:{...scan.ctx.market.hl,factor:'0.75'}}};
  for (const sign of [1,-1]) for (const i of [6,8]) for (const stressed of [false,true]) {
    const settings={...ctx,checks:{...ctx.checks,stress: stressed ? {jumpBps:'30',basisBps:'0',delayBps:'2',fundingDebit:'0.1'} : undefined}};
    const r=planRecord({ctx:settings},{sign,i,j:2});
    for (const [key,pfTarget,side] of [['fail',900,-1],['pass',1100,1]]) {
      const path=r.paths[key];
      assert.equal(dec(path.pf.exitMark).cmp('100'),sign*side);
      const shift=dec(path.pf.exitMark).minus(100).div(2);
      close(path.hl.exitMark,dec('104').plus(shift.times('0.75')).plus(stressed?dec('104').times('0.003').times(sign):0));
      for (const [venue,qty,fee] of [['pf',r.pf,'0.0002'],['hl',r.hl,'0.0006']]) {
        const leg=path[venue], q=dec(qty), spec=ctx.market[venue];
        const fill=venue==='pf'?r.pfFill:r.hlFill;
        const move=q.times(dec(leg.exitMark).minus(spec.mark));
        close(leg.fees,q.abs().times(dec(fill.price).plus(leg.exitPrice)).times(fee));
        close(leg.executionCost,q.times(dec(fill.price).minus(spec.mark).plus(dec(leg.exitMark).minus(leg.exitPrice))));
        const net=move.minus(leg.executionCost).minus(leg.fees);
        if (venue==='pf') close(net.plus(1000),pfTarget);
        else {
          close(path.hypeNet,net.minus(stressed ? dec('104').times(2).times('0.0002').plus('0.1') : 0));
          close(key==='fail'?r.fail:r.success,dec('120').plus(path.hypeNet).plus(key==='fail'?12:0));
        }
      }
    }
  }
});

test('每个目标从当前净仓及同向剩余挂单计算差额，覆盖加仓、减仓与反手', () => {
  for (const [current, target, pending, remaining] of [
    ['2','6','1','3'], ['8','6','-1','-1'], ['-2','6','3','5'], ['2','6','4','0']
  ]) {
    const f=fixture();
    Object.assign(f.a.pf,{qty:current,orders:[{qty:pending}]});
    Object.assign(f.a.hl,{qty:'-1', orders:[{qty:'-1'}]});
    const scan=scanFixture({},f).ratioScan;
    const p=planRecord(scan,{sign:1,i:Number(target),j:2});
    assert.deepEqual([p.adjustments.pf.current,p.adjustments.pf.pending,p.adjustments.pf.remaining],[current,pending,remaining]);
    assert.equal(p.adjustments.hl.remaining,'0');
  }
});

test('完整路径：成功终点现金与维持保证金都充足，途中基差与异步错位先清算', () => {
  const f = fixture();
  Object.assign(f.a.hl,{qty:'-4',equity:'75',free:'35',currentMarginCredit:'40',leverage:'10'});
  f.m.hl.marginTiers.push({lowerBound:'450',maxLeverage:5});
  const rules = {B:'100',R_success:'10',R_free:'0',minBuffer:'0',adverseBps:'200',
    jumpBps:'25',asyncBps:'1',delayBps:'300',fundingDebit:'0.1'};
  const scan = scanFixture(rules,f).ratioScan;
  const point = {sign:1,i:10,j:4};
  const row = inspectRatio(scan.ctx,point,{includePathAudit:true});
  // Settled Hype short at 112, versus a temporary 115 mark just before PF passes.
  assert.equal(row.conditionalEndpoints.successHype,'26.9');
  assert.equal(row.success,null);
  assert.equal(row.verification.failureFunds,'pass');
  assert.equal(row.verification.successFunds,'pass');
  assert.equal(row.verification.initial,'pass');
  assert.equal(row.verification.liquidation,'fail');
  assert.equal(row.verification.stress,'fail');
  assert.equal(row.pathAudit.pass.base.status,'pass');
  assert.equal(row.pathAudit.fail.dislocation.status,'pass');
  const walk = row.pathAudit.pass.dislocation;
  assert.equal(walk.status,'fail');
  const knot = walk.checkpoints.find(p=>p.mark==='112.5');
  assert.equal(knot.maintenance,'22.5');
  assert.ok(dec(walk.firstBreach.mark).minus(dec('497.4').div('4.4')).abs().lt('1e-38'));
  assert.ok(dec(walk.firstBreach.mark).lt('115'));
  assert.ok(dec(walk.firstBreach.equity).minus(walk.firstBreach.maintenance).abs().lt('1e-36'));
  assert.equal(walk.firstBreach.settlement,null);
  assert.equal(walk.checkpoints.at(-1).mark,'110');
  assert.ok(dec(walk.checkpoints.at(-1).equity).gt(walk.checkpoints.at(-1).maintenance));
  for (const p of walk.checkpoints) {
    assert.ok(dec(p.equity).eq(dec('74.9').minus(dec(p.mark).minus(100).times(4))));
    assert.ok(dec(p.free).eq(dec(row.free).plus(dec(p.equity).minus(75))
      .minus(dec(p.mark).minus(100).times(4).div(row.lev))));
  }
  assert.equal(planRecord(scan,point).success,null);
  assert.equal(row.both,false);
  assert.ok(!ratioSlice(scan,1,10,'both').some(([lo,hi]) => lo <= 4 && hi >= 4));
  assert.ok(!scan.plans.targetKeys.includes('1/10/4'));
});
test('完整路径：三方案保留各自的双向检验；未配置压力只发布基础条件', () => {
  const scan = scanFixture().ratioScan;
  for (const key of scan.plans.targetKeys) {
    const r=scan.plans.rows.find(p=>p.key===key);
    assert.deepEqual(r.verification,{failureFunds:'pass',successFunds:'pass',initial:'pass',maintenance:'pass',path:'pass',liquidation:'pass',stress:'unknown'});
    for (const name of ['fail','pass']) {
      assert.deepEqual(Object.keys(r.pathAudit[name]),['base']);
      const path=r.pathAudit[name].base;
      assert.equal(path.firstBreach,null);
      assert.equal(path.checkpoints[0].mark,scan.ctx.market.hl.mark);
      assert.equal(path.checkpoints.at(-1).mark,r.paths[name].hl.exitMark);
      assert.equal(path.checkpoints[0].free,r.free);
      assert.equal(path.proof.continuous,true);
      for (const seg of path.proof.segments) {
        const start=path.checkpoints.find(x=>x.mark===seg.from), end=path.checkpoints.find(x=>x.mark===seg.to);
        assert.ok(dec(end.surplus).minus(start.surplus).minus(dec(seg.slope).times(dec(seg.to).minus(seg.from))).abs().lt('1e-39'));
        assert.ok(dec(seg.minimum).eq(min(start.surplus,end.surplus)));
      }
    }
  }
});

test('完整路径：PF 空、Hype 多，跌破长仓清算界后反弹也不得结算成功现金', () => {
  const f=fixture();
  Object.assign(f.a.hl,{qty:'4',equity:'75',free:'35',currentMarginCredit:'40',leverage:'10'});
  const scan=scanFixture({B:'100',R_success:'10',R_free:'0',minBuffer:'0',
    adverseBps:'200',jumpBps:'25',asyncBps:'1',delayBps:'300',fundingDebit:'0.1'},f).ratioScan;
  const target={sign:-1,i:10,j:4};
  const row=inspectRatio(scan.ctx,target,{includePathAudit:true});
  assert.equal(row.conditionalEndpoints.successHype,'26.9');
  assert.equal(row.success,null);
  assert.equal(row.pathAudit.fail.dislocation.status,'pass');
  assert.equal(row.pathAudit.pass.base.status,'pass');
  const path=row.pathAudit.pass.dislocation;
  assert.equal(path.status,'fail');
  assert.ok(dec(path.firstBreach.mark).minus(dec('325.1').div('3.8')).abs().lt('1e-38'));
  assert.ok(dec(path.checkpoints.at(-1).surplus).gt(0));
  assert.equal(planRecord(scan,target).success,null);
  assert.ok(!ratioSlice(scan,-1,10,'both').some(([lo,hi])=>lo<=4 && hi>=4));
});

test('全仓六项指标：终点按新名义额重算，抵押缺口与清算线独立', () => {
  const m=demoMarket('unit'), book=createBook({id:'margin',mode:'demo',time:at});
  Object.assign(m.hl,{mark:'100',asks:[['100','20']],bids:[['100','20']],rate:'0',leverage:'3',
    tiers:[{from:'0',mmr:'0.0125',deduction:'0'}],hold:'0',otherMaintenance:'0'});
  book.hl='470.47';
  const run=(openFree)=>validateMargin(book,m,'hl','-10',['0','36.998'],undefined,'0',{openFree}).at(-1);
  const test=run(out(dec(book.hl).minus(dec('1000').div(3))));
  const w=test.worst;
  assert.equal(w.mark,'136.998');
  assert.equal(w.equity,'100.49');
  assert.equal(w.initial,'456.66');
  assert.equal(w.marginUsed,'456.66');
  assert.equal(w.freeCollateral,'0');
  assert.equal(w.initialHeadroom,'-356.17');
  assert.equal(dec(w.maintenance).toFixed(2),'17.12');
  assert.equal(dec(w.surplus).toFixed(2),'83.37');
  assert.equal(test.firstBreach,null);
  // A separate known reservation consumes IM; a directional limit can bind even earlier.
  Object.assign(m.hl,{hold:'12',otherMaintenance:'2'});
  const reserved=run('100').worst;
  assert.equal(reserved.marginUsed,'468.66');
  assert.equal(reserved.maintenance, out(dec(w.maintenance).plus(2)));
  assert.equal(reserved.initialHeadroom,'-368.17');
  assert.ok(dec(reserved.free).lt(reserved.initialHeadroom));
});
test('盘口证据：双向 VWAP、首档零滑点、部分覆盖和缺盘口各自可核对', () => {
  const l={multiplier:'2',fx:'1',bids:[['99','2'],['98','3']],asks:[['101','1'],['103','2']]};
  const top=fillEvidence('-2',l);
  assert.equal(top.vwap,'99'); assert.equal(top.visible,'5'); assert.equal(top.slippage,'0');
  const buy=fillEvidence('3',l,'10');
  assert.equal(buy.covered,'3'); assert.equal(buy.uncovered,'0'); assert.equal(buy.levels,2);
  assert.equal(buy.vwap,out(dec('307').div(3).plus(10)));
  assert.equal(buy.spreadCost,'6'); assert.equal(buy.slippage,'8');
  const sell=fillEvidence('-5',l);
  assert.equal(sell.vwap,'98.4'); assert.equal(sell.slippage,'6');
  const partial=fillEvidence('4',l);
  assert.equal(partial.status,'insufficient'); assert.equal(partial.covered,'3');
  assert.equal(partial.uncovered,'1'); assert.equal(partial.vwap,null); assert.equal(partial.slippage,null);
  assert.equal(fillEvidence('1',{...l,asks:undefined}).status,'unknown');
  assert.equal(fillEvidence('1',{...l,asks:[]}).uncovered,'1');
  assert.equal(fillEvidence('1',{...l,asks:[['NaN','3']]}).slippage,null);
});
test('基差扩大与收敛：双向 PF 路径按各自原生终点重算现金与费用', () => {
  for (const mark of ['98','102']) {
    const f=fixture();
    Object.assign(f.m.hl,{mark,levels:[[[mark,'30']],[[mark,'30']]]});
    const scan=scanFixture({adverseBps:'50',pfFee:'0.0001',hlFee:'0.0005'},f).ratioScan;
    for (const sign of [1,-1]) {
      const row=planRecord(scan,{sign,i:10,j:2});
      for (const end of ['fail','pass']) {
        const {base,basisWiden:w,basisNarrow:n}=row.pathAudit[end];
        assert.ok(dec(w.gapAfter).abs().gt(dec(w.gapBefore).abs()));
        assert.ok(dec(n.gapAfter).abs().lt(dec(n.gapBefore).abs()));
        assert.notEqual(w.adverse,n.adverse);
        for (const p of [w,n]) {
          const z=p.settlement,b=base.settlement;
          assert.equal(z.pfNet,b.pfNet);
          assert.equal(dec(z.pfMark).cmp('100'),end==='pass'?sign:-sign);
          const move=dec(z.hlMark).minus(b.hlMark);
          assert.ok(move.eq(p.offset));
          const change=move.times(row.hl).minus(move.times(dec(row.hl).abs()).times('0.0005'));
          assert.ok(dec(z.hype).minus(b.hype).minus(change).abs().lt('1e-39'));
          assert.equal(z.personal,z.hype);
        }
      }
    }
  }
});
test('解析区间：跨档往返的最差点、抵押品和不可证明的断档',()=>{
  const m=demoMarket('unit'), book=createBook({id:'tiers',mode:'demo',time:at});
  Object.assign(m.hl,{mark:'100',rate:'0',asks:[['100','25']],bids:[['100','25']],leverage:'4',
    tiers:[{from:'0',mmr:'0.05',deduction:'0'},{from:'450',mmr:'0.1',deduction:'22.5'}]});
  book.hl='120';
  const run=()=>validateMargin(book,m,'hl','-4',['0','18','9'],undefined,'0',{openFree:'20'}).at(-1);
  const audit=run();
  assert.equal(audit.proof.intervals,4);
  assert.equal(audit.worst.mark,'118'); assert.equal(audit.worst.legIndex,1);
  for (const seg of audit.proof.segments) {
    for(let i=0;i<=100;i++) {
      const mark=dec(seg.from).plus(dec(seg.to).minus(seg.from).times(i).div(100)),n=mark.times(4);
      const mm=n.lt(450)?n.times('0.05'):n.times('0.1').minus('22.5');
      assert.ok(dec('120').minus(mark.minus(100).times(4)).minus(mm).gte(seg.minimum));
    }
  }
  m.hl.tiers[1].deduction='10';
  assert.equal(run().status,'unknown');
});

test('全仓账户只使用独立抵押池；其他挂单未知时不假设零占用',async()=>{
  const {accountSnapshot}=await import('../src/hedge/current-account.js');
  const user='0x'+'1'.repeat(40);
  const raw={time:t,marginSummary:{accountValue:'900',totalMarginUsed:'67'},
    crossMarginSummary:{accountValue:'120',totalMarginUsed:'17'},withdrawable:'37',assetPositions:[]};
  const input={clearinghouseState:raw,userAbstraction:'standard',frontendOpenOrders:[],
    activeAssetData:{coin:'BTC',user,leverage:{type:'cross',value:10},availableToTrade:['103','102']}};
  const read=()=>accountSnapshot(user,'BTC',async({type})=>input[type],()=>t);
  const account=await read();
  assert.equal(account.equity,'120');
  assert.equal(account.used,'17');
  assert.equal(account.otherHold,'17');
  assert.equal(account.withdrawable,'37');
  input.frontendOpenOrders=[{coin:'ETH',side:'B',oid:'4',sz:'1'}];
  assert.equal((await read()).otherHold,null);
  delete raw.crossMarginSummary;
  assert.equal((await read()).equity,null);
});


test('方向验收：复现 61591.20 的目标，多空各自推导两端，交换账本后拒绝发布', () => {
  const {ctx}=scanFixture().ratioScan;
  Object.assign(ctx.book,{pf:'10000',hl:'409',B:'500',challengeFloor:'9400',challengeTarget:'12000'});
  Object.assign(ctx.params,{R:'100',target:'12000'});
  for (const [side,mark,rate] of [['pf','61591.20','0.0001'],['hl','61580.00','0.0005']]) {
    const l=ctx.market[side];
    Object.assign(l,{mark,rate,step:'0.00001',minQty:'0.00001',minNotional:'0',free:ctx.book[side],
      bids:[[out(dec(mark).minus(1)),'2']],asks:[[out(dec(mark).plus(1)),'2']]});
  }
  const options={includePathAudit:true};
  const rows=[1,-1].map(sign=>inspectRatio(ctx,{sign,i:11220,j:1727},options));
  for (const row of rows) {
    const plan=recordFromInspection(ctx,row);
    for (const [end,threshold] of [['fail','9400'],['pass','12000']]) {
      const {pf,hl}=plan.paths[end];
      assert.equal(dec(pf.exitMark).cmp(pf.mark),row.sign*(end==='pass'?1:-1));
      assert.ok(dec(pf.finalEquity).minus(threshold).abs().lt('1e-36'));
      for (const [side,l] of [['pf',pf],['hl',hl]]) {
        assert.equal(l.target,row[side]);
        assert.ok(dec(l.target).times(l.multiplier).times(l.settlementPerQuote)
          .times(dec(l.exitMark).minus(l.mark)).minus(l.markPnl).abs().lt('1e-36'));
        assert.ok(dec(l.finalEquity).minus(l.startEquity).minus(l.grossPnl)
          .plus(l.entryFee).plus(l.closeFee).plus(l.friction).abs().lt('1e-36'));
      }
    }
  }
  assert.equal(out(dec('0.1122').times(dec('66925.74').minus('61591.20'))),'598.535388');
  const corrupt = structuredClone(rows[0]);
  corrupt.paths.fail.pf.exitMark='66925.74';
  assert.throws(()=>recordFromInspection(ctx,corrupt),/不一致/);
  assert.throws(()=>recordFromInspection(ctx,{...rows[0],paths:rows[1].paths}),/不一致/);
  const fee=structuredClone(rows[0]);
  fee.paths.pass.pf.exitFee='0';
  assert.throws(()=>recordFromInspection(ctx,fee),/不一致/);
});

test('发布验收：三个方向逐个对齐，跨候选价格或起始行情串帧时整帧拒收',()=>{
  const f=fixture(), result=scanFixture({riskPreference:'75',pfFee:'0.0001',hlFee:'0.0005'},f);
  result.calculationMarket=f.m;
  const view=createSolutionSnapshot(result);
  assert.equal(view.targets.filter(Boolean).length,3);
  const focus=view.ratioScan.plans.focus;
  assert.equal(view.ratioScan.representative.row.pf,'-9'); // Preference and maximum are opposite here.
  assert.equal(focus.pf,'10');
  assert.equal(pointKey(focus),view.targets[0].key);
  for (const end of ['fail','pass'])
    assert.equal(focus.paths[end].pf.exitMark,view.targets[0].paths[end].pf.exitMark);
  for (const p of view.targets.filter(Boolean)) for (const end of ['fail','pass']) {
    const path=p.paths[end], ledger=p.pathAudit[end].base.settlement;
    assert.equal(path.pf.exitMark,ledger.pfMark);
    assert.equal(path.hl.finalEquity,ledger.hype);
    assert.ok(dec(path.pf.target).eq(p.pf) && dec(path.hl.target).eq(p.hl));
    assert.equal(dec(path.pf.markPnl).cmp(0),end==='pass'?1:-1);
  }
  const bad=structuredClone(result);
  bad.ratioScan.plans.rows.find(p=>p.key===view.targets[2].key).paths.fail.pf.exitMark='100';
  assert.throws(()=>createSolutionSnapshot(bad),/不一致/);
  const stale=structuredClone(result);
  stale.calculationMarket.pf.mark='101';
  assert.throws(()=>createSolutionSnapshot(stale),/不一致/);
});

test('初保不足时两端没有可回收金额，途中初保缺口独立于维持清算',()=>{
  const {ctx}=scanFixture().ratioScan;
  ctx.market.hl.free='1';
  const row=inspectRatio(ctx,{sign:1,i:10,j:4},{includePathAudit:true});
  assert.equal(row.verification.initial,'fail');
  assert.equal(row.pathAudit.pass.base.firstBreach,null);
  assert.match(row.passStop,/开仓/);
  const plan=recordFromInspection(ctx,row);
  assert.deepEqual([plan.fail,plan.success,plan.paths.fail,plan.paths.pass],[null,null,null,null]);
  assert.equal(plan.pathAudit.fail.base.settlement,undefined);
});

test('途中初保缺口 151.62 U 时保留独立清算证据，断档路径不得出具连续证明',()=>{
  const m=demoMarket('unit'), b=createBook({id:'headroom',mode:'demo',time:at});
  Object.assign(m.hl,{mark:'100',rate:'0',bids:[['100','20']],asks:[['100','20']],leverage:'3',
    tiers:[{from:'0',mmr:'0.0125',deduction:'0'}]});
  b.hl='448.38';
  const run=()=>validateMargin(b,m,'hl','-10',['0','20'],undefined,'0',{openFree:'115'});
  const [initial,path]=run();
  assert.equal(initial.status,'pass');
  assert.equal(path.worst.initialHeadroom,'-151.62');
  assert.equal(path.worst.freeCollateral,'0');
  assert.equal(path.worst.surplus,'233.38');
  assert.equal(path.firstBreach,null);
  assert.equal(path.proof.continuous,true);
  m.hl.tiers.push({from:'1100',mmr:'0.025',deduction:'0'});
  const unproven=run().at(-1);
  assert.equal(unproven.status,'unknown');
  assert.equal(unproven.proof.continuous,false);
});


test('保证金分工：成功途中 357.50 U 追加缺口和 83.26 U 维持余量可同时成立',()=>{
  const m=demoMarket('unit'), book=createBook({id:'im-admission',mode:'demo',time:at});
  Object.assign(m.hl,{mark:'100',rate:'0',leverage:'3',hold:'0',otherMaintenance:'0',
    asks:[['100','20']],bids:[['100','20']],tiers:[{from:'0',mmr:'0.0125',deduction:'0'}]});
  book.hl='474.257';
  const walk=()=>validateMargin(book,m,'hl','-10',['0','37.382'],undefined,'0',{openFree:'140'});
  const [open,path]=walk();
  assert.equal(open.status,'pass');
  const w=path.worst;
  assert.deepEqual([w.equity,w.initial,w.additionalIMShortfall,w.maintenance,w.surplus].map(x=>dec(x).toFixed(2)),
    ['100.44','457.94','357.50','17.17','83.26']);
  assert.equal(w.freeCollateral,'0'); assert.equal(path.firstBreach,null);
  assert.equal(path.status,'pass'); assert.ok(path.proof.continuous);
  m.hl.hold='12'; delete m.hl.otherMaintenance;
  assert.equal(walk().at(-1).status,'unknown');
});

test('保证金分工：保持与减持原全仓不重新交初保，加仓、翻向和改设杠杆单独准入',()=>{
  const f=fixture();
  Object.assign(f.a.hl,{qty:'-4',equity:'100',free:'0',currentMarginCredit:'200',leverage:'2'});
  const {ctx}=scanFixture({B:'100',R_success:'10',R_free:'0',utilization:'1'},f).ratioScan;
  const m={...ctx.market,hl:{...ctx.market.hl,configuredLeverage:'2',leverage:'2'}};
  const admit=(target,lev='2')=>validateMargin(ctx.book,{...m,hl:{...m.hl,leverage:lev}},'hl',target,['0'],undefined,'0',{openFree:'0'});
  for(const q of ['-4','-3']){
    const [entry,hold]=admit(q);
    assert.equal(entry.requiredForTrade,false); assert.equal(entry.status,'pass');
    assert.equal(hold.firstBreach,null);
  }
  for(const [q,l] of [['-5','2'],['4','2'],['-4','1']]){
    assert.equal(admit(q,l)[0].status,'fail');
  }
});

test('原生基差与异步退出：两种 PF 方向、两个终点逐一重算，撤档改变平仓成本与现金',()=>{
  for (const sign of [1,-1]) {
    const f=fixture();
    for(const l of [f.m.pf,f.m.hl])
      l.levels=[[['99.9','12'],['99.4','20']],[['100.1','12'],['100.7','20']]];
    const scan=scanFixture({B:'120',R_success:'10',R_free:'0',adverseBps:'50',jumpBps:'10',delayBps:'10',
      pfFee:'0.0001',hlFee:'0.0005',fundingDebit:'0.01'},f).ratioScan;
    const row=planRecord(scan,{sign,i:10,j:2});
    for(const end of ['fail','pass']) {
      const cases=row.pathAudit[end],base=cases.base.settlement;
      assert.ok(base);
      assert.ok(dec(cases.basisAdverse.settlement.hype).lt(base.hype));
      assert.ok(dec(cases.basisFavorable.settlement.hype).gt(base.hype));
      assert.ok(dec(cases.asyncExit.settlement.hlMark).minus(base.hlMark).times(row.hl).lt(0));
      assert.equal(cases.asyncExit.checkpoints.at(-1).mark,cases.asyncExit.settlement.hlMark);
      assert.notEqual(cases.dislocation.settlement.hlMark,cases.asyncExit.settlement.hlMark);
      const reduced=row.liquidity[end], amount=reduced.settlement;
      for(const side of ['pf','hl']) {
        assert.equal(row.depth[end][side].exit.slippage,'0');
        assert.equal(reduced.depth[side].coverageRatio,'1'); assert.equal(reduced.depth[side].uncovered,'0');
        const lost=dec(row[side]).isPositive()?'0.5':'0.6';
        assert.ok(dec(reduced.extraExitCost[side]).eq(dec(row[side]).abs().times(lost)));
        assert.equal(reduced.depth[side].slippage,'0');
        assert.equal(reduced.withdrawn[side].coverageRatio,'0'); assert.equal(reduced.withdrawn[side].vwap,null);
        assert.equal(reduced.withdrawn[side].uncovered,out(dec(row[side]).abs()));
      }
      assert.ok(reduced.path.proof.continuous);
      assert.ok(dec(amount.pfEquity).minus(end==='fail'?'900':'1100').abs().lt('1e-35'));
      assert.equal(amount.hlPrice,reduced.depth.hl.vwap);
      assert.ok(dec(amount.hype).lt(base.hype));
      assert.equal(amount.hype,amount.personal);
    }
  }
});

test('撤去退出最优档后可见数量不足，按实际覆盖量报告，不给出全量均价、滑点或现金',()=>{
  const f=fixture();
  f.m.hl.levels=[[['100','5'],['99','1']],[['100','5'],['101','1']]];
  const scan=scanFixture({},f).ratioScan, plan=planRecord(scan,{sign:1,i:10,j:2});
  for(const end of ['fail','pass']) {
    const test=plan.liquidity[end], leg=test.depth.hl;
    assert.equal(test.status,'insufficient'); assert.equal(test.settlement,null);
    assert.equal(leg.covered,'1'); assert.equal(leg.coverageRatio,'0.5'); assert.equal(leg.uncovered,'1');
    assert.equal(leg.vwap,null); assert.equal(leg.slippage,null);
    assert.ok(leg.coveredExecution.vwap);
    assert.ok(dec(leg.coveredExecution.fee).gte(0));
    assert.equal(test.withdrawn.hl.slippage,null); assert.equal(test.extraExitCost.hl,null);
  }
  assert.equal(plan.coverage,'conditional');
});

test('发布帧：仅同一盘口深度、账户、规则、版本和完成时间可以发布为当前',()=>{
  const f=fixture(), result=scanFixture({},f);
  result.frameState='ready'; result.calculationMarket=f.m; result.finishedAt=at;
  const snap=createSolutionSnapshot(result);
  const state=(r=result,m=f.m,blocked=false)=>publicationState(r,snap,m,blocked);
  assert.equal(state(),'ready');
  const quote=structuredClone(f.m); quote.hl.levels[0].push(['99','2']);
  assert.equal(state(result,quote),'updating');
  for(const change of [{accountsId:'other'},{rulesId:'other'},{model:'older'},{marketId:'other'}])
    assert.equal(state({...result,trace:{...result.trace,...change}}),'updating');
  assert.equal(state({...result,finishedAt:'late'}),'updating');
  assert.equal(state(result,f.m,true),'paused');
  assert.equal(state({...result,frameState:'recovering'}),'recovering');
  assert.equal(state(),'ready');
});


test('前版已完成快照仅供历史核对，本版拒绝跨候选拼接的现金缓冲和覆盖计数',()=>{
  const f=pressureFixture(), result=scanFixture({B:'157',R_success:'72',R_free:'0'},f);
  result.frameState='ready';result.calculationMarket=f.m;result.finishedAt=at;
  const data=new Map(), storage={setItem:(k,v)=>data.set(k,v),getItem:k=>data.get(k)??null};
  displayHistory(storage).record('plan:BTC',createSolutionSnapshot(result));
  const [[key,json]]=data.entries(), old=JSON.parse(json);
  old.view.trace.model='AUTO-0.21.7';
  data.clear();
  storage.setItem(key.replace('AUTO-0.21.8','AUTO-0.21.7'),JSON.stringify(old));
  const historic=displayHistory(storage).read('plan:BTC');
  assert.equal(historic.solverVersion,'AUTO-0.21.7');
  assert.throws(()=>createSolutionSnapshot({...result,trace:old.view.trace}),/求解器版本已变更/);
  assert.equal(publicationState({...result,trace:old.view.trace},historic,f.m),'updating');
  for (const corrupt of [
    s=>{s.cashBuffers.minimum='5';},
    s=>{s.coverage.unverified=0;},
    s=>{s.minSuccess.id='D';}
  ]) {
    const copy=structuredClone(result), scan=copy.baseScan??copy.ratioScan;
    const plan=scan.plans.rows.find(x=>x.key===scan.plans.targetKeys[0]);
    corrupt(plan.pressureSummary);
    assert.throws(()=>createSolutionSnapshot(copy),/不一致|缺少可对账/);
  }
});

function pressureFixture() {
  const f=fixture();
  f.m.pf.levels=[[['100','20'],['99.9','4'],['99.8','5'],['99.5','2']],
    [['100','20'],['100.1','4'],['100.3','4'],['100.6','3']]];
  f.m.hl.levels=[[['100','10'],['99.9','3'],['99.8','5'],['99.4','2']],
    [['100','10'],['100.1','3'],['100.25','4'],['100.55','4']]];
  return f;
}

test('LIQSEL01 前两档退出成为数量和现金硬约束，压力最大值与逐点独立穷举一致',()=>{
  const initial={B:'157',R_success:'72',R_free:'0',pfFee:'0.0001',hlFee:'0.0005'};
  for (const patch of [{},{adverseBps:'4',jumpBps:'8',delayBps:'2',asyncBps:'1',fundingDebit:'0.1'},
      {R_success:'71',recoveryBuffer:'2',minMaintenanceSurplus:'8'}]) {
    const result=scanFixture({...initial,...patch},pressureFixture());
    const scan=result.ratioScan,pressure=scan.plans.pressure;
    const desktop=result.baseScan ?? scan;
    assert.equal(desktop.plans.pressure,pressure);
    assert.equal(desktop.plans.rows.find(p=>p.key===desktop.plans.targetKeys[0]).i,10);
    const winners=[];
    for (const sign of [1,-1]) for(let i=1;i<=10;i++) for(let j=0;j<=6;j++) {
      if (!ratioSlice(scan,sign,i,'eligible').some(([a,b])=>a<=j && j<=b)) continue;
      const row=planRecord(scan,{sign,i,j});
      if (row.configuredPass) winners.push(row);
    }
    assert.ok(winners.length);
    assert.equal(pressure.row.i,Math.max(...winners.map(row=>row.i)));
    assert.ok(pressure.row.i<=7);
    assert.ok(winners.some(row=>row.key===pressure.key));
    const f=pressureFixture();
    const desk=calculateCurrent({...inputs,...initial,...patch},f.a,f.m,f.rates??{},t,{scanRatios:true,baseObjectives:true}).ratioScan;
    assert.equal(desk.plans.pressure.row.i,pressure.row.i);
    assert.deepEqual(desk.plans.targetKeys,desktop.plans.targetKeys);
    assert.equal(pressure.scope,patch.jumpBps?'configured':'bookOnly');
    assert.equal(pressure.configuredStatus,'pass');
    assert.equal(pressure.status,'conditional');
    assert.equal(pressure.allSpecified.status,'unverified');
    assert.equal(pressure.allSpecified.key,null);
    assert.equal(pressure.liveSafety,'unverified');
    assert.notEqual(result.autoStatus,'AUTO_FEASIBLE');
    const row=pressure.row;
    if (row.pressureSummary.minLiquidationDistance)
      assert.equal(row.pressureSummary.minLiquidationDistance.unit,result.currencies.hl.quoteAsset);
    for(const end of ['fail','pass']) for(const scenario of [row.liquidity[end].full,row.liquidity[end],row.liquidity[end].two]){
      assert.equal(scenario.status,'pass'); assert.equal(scenario.path.firstBreach,null);
      assert.ok(scenario.path.worst && dec(scenario.path.worst.surplus).gt(0));
      assert.ok(dec(scenario.settlement[end==='fail'?'personal':'hype']).gte(end==='fail'?dec(initial.B).plus(patch.recoveryBuffer??'0'):patch.R_success??initial.R_success));
      for(const side of ['hl','pf']){
        const leg=scan.ctx.market[side],fill=scenario.depth[side];
        const fee=dec(fill.vwap).times(dec(row[side]).abs()).times(leg.multiplier).times(leg.fx).times(leg.rate);
        assert.ok(fee.minus(scenario.exitFees[side]).abs().lt('1e-38'));
        assert.ok(dec(fill.covered).eq(fill.target)); assert.equal(fill.uncovered,'0');
      }
    }
    if(patch.jumpBps) assert.ok(row.pathAudit.pass.adverseJump.proof.continuous);
  }
});

test('LIQSEL02 数量尚可开仓但不能全量退出时无压力候选，两账户及资金仍独立',()=>{
  const f=pressureFixture();
  f.m.hl.levels=f.m.hl.levels.map(s=>s.slice(0,2));
  const x=scanFixture({B:'157',R_success:'72',R_free:'0'},f).ratioScan;
  const p=x.plans.rows.find(row=>row.key===x.plans.targetKeys[0]);
  assert.ok(p.both);
  assert.equal(x.plans.pressure.status,'none'); assert.equal(x.plans.pressure.row,undefined);
  assert.equal(x.plans.pressure.configuredStatus,'none');
  assert.equal(x.plans.pressure.allSpecified.status,'none');
  assert.equal(x.plans.pressure.allSpecified.key,null);
  const c=p.liquidity.fail.two;
  assert.equal(c.status,'insufficient'); assert.equal(c.depth.hl.uncovered,c.depth.hl.target);
  assert.equal(c.depth.hl.vwap,null); assert.equal(c.exitFees.hl,null); assert.equal(c.settlement,null);
  assert.equal(p.configuredPass,false); assert.equal(p.coverage,'conditional');
});

test('LIQSEL03 0.1161 对 0.01785 BTC：基础 500.0027，撤一档 499.9634 时淘汰',()=>{
  const {ctx}=scanFixture().ratioScan;
  Object.assign(ctx.book,{pf:'10000',hl:'409',B:'500',challengeFloor:'9400',challengeTarget:'12000'});
  Object.assign(ctx.params,{R:'100',target:'12000',recoveryBuffer:'0'});
  for(const [side,rate] of [['pf','0.0001'],['hl','0.0005']]){
    Object.assign(ctx.market[side],{mark:'60000',rate,step:'0.00001',minQty:'0.00001',minNotional:'0',free:ctx.book[side],
      bids:[['59999.5','1'],['59998.5','1'],['59997','1']],asks:[['60000.5','1'],['60001.7','1'],['60002.5','1']]});
  }
  const point={sign:1,i:11610,j:1785},run=()=>planRecord({ctx},point);
  // The reported historical book is unavailable. Anchor this regression's
  // starting cash so its full-book ledger matches the supplied failure balance.
  ctx.book.hl=out(dec(ctx.book.hl).plus('500.0027').minus(run().liquidity.fail.full.settlement.personal));
  const row=run(), first=row.liquidity.fail;
  assert.equal(dec(first.full.settlement.personal).toFixed(4),'500.0027');
  assert.equal(dec(first.settlement.personal).toFixed(4),'499.9634');
  assert.equal(first.pathStatus,'pass'); assert.equal(first.status,'fail');
  assert.equal(row.configuredPass,false);
  assert.ok(dec(first.two.settlement.personal).lt(first.settlement.personal));
});

test('LIQSEL04 基础最大仓位独立于压力设置，同一发布快照包含重新搜索后的压力结果',()=>{
  const f=pressureFixture(), rule={B:'157',R_free:'0',R_success:'72'};
  const plain=scanFixture(rule,f), stress=scanFixture({...rule,adverseBps:'500',jumpBps:'500',delayBps:'100',fundingDebit:'4'},f);
  assert.equal(stress.ratioScan.plans.pressure.status,'none');
  assert.deepEqual(stress.baseScan.plans.targetKeys,plain.ratioScan.plans.targetKeys);
  for(const r of [plain,stress]){
    r.calculationMarket=f.m;
    const snap=createSolutionSnapshot(r),pressure=snap.ratioScan.plans.pressure;
    assert.equal(snap.snapshotId,r.trace.id);
    assert.equal(pressure.status,r.ratioScan.plans.pressure.status);
    assert.equal(snap.targets[0].i,10);
  }
});


test('LIQSEL05 D 保留真实尾档可成交的部分，余量的均价、总手续费与最终现金未知',()=>{
  const f=pressureFixture();
  const scan=scanFixture({B:'157',R_success:'72',R_free:'0'},f).ratioScan;
  const row=planRecord(scan,{sign:1,i:10,j:5});
  for(const end of ['fail','pass']){
    const test=row.liquidity[end].shortfall;
    assert.equal(test.status,'insufficient');assert.equal(test.settlement,null);
    for(const side of ['pf','hl']){
      const d=test.depth[side];
      assert.ok(dec(d.uncovered).isPositive());assert.ok(dec(d.covered).isPositive());
      assert.ok(dec(d.covered).plus(d.uncovered).eq(d.target));
      assert.equal(d.vwap,null);assert.equal(test.exitFees[side],null);
      assert.ok(d.coveredExecution && !d.coveredExecution.atEndpoint);
      assert.ok(dec(d.coveredExecution.vwap).gt(0));
    }
  }
});

test('LIQSEL06 已配置基差压力缺少参考汇率时暂停发布，不把未完成的压力检验当作无解',()=>{
  const scan=scanFixture({},pressureFixture()).ratioScan;
  const ctx={...scan.ctx,checks:{...scan.ctx.checks,basisBps:'10',basisRate:null}};
  const result=searchLiquidityMaximum(scan,()=>assert.fail('缺少参照时不得核准仓位'),false,ctx);
  assert.equal(result.status,'incomplete');assert.match(result.reason,/参照汇率/);assert.equal(result.key,null);
  assert.equal(result.configuredStatus,'unknown');assert.equal(result.allSpecified.status,'unverified');
});

test('LIQSEL07 现仓差额、手续费与延迟扣款进入撤档求解，最大手数与逐点验算一致',()=>{
  const f=pressureFixture();
  Object.assign(f.a.pf,{qty:'2',free:'980'});
  Object.assign(f.a.hl,{qty:'-1',free:'100'});
  const r={...inputs,B:'157',R_success:'71',R_free:'0',pfFee:'0.0003',hlFee:'0.0009',
    adverseBps:'2',jumpBps:'3',delayBps:'4',fundingDebit:'0.08'};
  const solve=baseObjectives=>calculateCurrent(r,f.a,f.m,f.rates??{},t,{scanRatios:true,baseObjectives}).ratioScan;
  const unchecked=solve(true).plans.pressure;
  assert.equal(unchecked.configuredStatus,'unknown');
  assert.equal(unchecked.key,null);
  Object.assign(f.a.hl,{source:'Hype 主网 API',configuredLeverage:5,currentMarginCredit:'20'});
  const configured=solve(false),worker=solve(true);
  const sizes=[];
  for(const sign of [1,-1]) for(let i=1;i<=10;i++) for(let j=0;j<=6;j++){
    if (!ratioSlice(configured,sign,i,'eligible').some(([lo,hi])=>lo<=j && j<=hi)) continue;
    if (planRecord(configured,{sign,i,j}).configuredPass) sizes.push(i);
  }
  assert.ok(sizes.length);
  assert.equal(worker.plans.pressure.row.i,Math.max(...sizes));
  assert.equal(configured.plans.pressure.row.i,Math.max(...sizes));
});


test('PRESSRANK01 0.1168 BTC 空对 0.01798 BTC 多，撤档跌破 500 U 不得进入压力最大方案',()=>{
  // Reconstruct the supplied cash boundary on a controlled native book. The
  // historical exchange levels are unavailable; this is a regression fixture.
  const {ctx}=scanFixture().ratioScan;
  Object.assign(ctx.book,{pf:'10000',hl:'409',B:'500',challengeFloor:'9400',challengeTarget:'12000'});
  Object.assign(ctx.params,{R:'100',target:'12000',recoveryBuffer:'0'});
  for(const [side,rate] of [['pf','0.0001'],['hl','0.0005']]){
    Object.assign(ctx.market[side],{mark:'60000',rate,step:'0.00001',minQty:'0.00001',minNotional:'0',free:ctx.book[side],
      bids:[['59999.5','1'],['59998.496','1'],['59997','1']],asks:[['60000.5','1'],['60001.7','1'],['60002.5','1']]});
  }
  const check=()=>planRecord({ctx},{sign:-1,i:11680,j:1798});
  ctx.book.hl=out(dec(ctx.book.hl).plus('500.0015').minus(check().liquidity.fail.full.settlement.personal));
  const row=check();
  assert.equal(dec(row.liquidity.fail.full.settlement.personal).toFixed(4),'500.0015');
  assert.equal(dec(row.liquidity.fail.settlement.personal).toFixed(4),'499.9619');
  assert.equal(row.liquidity.fail.status,'fail');
  assert.equal(row.configuredPass,false);
  assert.equal(row.pressureSummary.status,'fail');
});

test('PRESSRANK02 全网格与所有同规模并列项的独立排序一致，收紧不同步或资金费可改变仓位',()=>{
  const fixture=pressureFixture();
  const baseline={B:'157',R_success:'65',R_free:'0',pfFee:'0.0001',hlFee:'0.0005',
    adverseBps:'1',asyncBps:'1',jumpBps:'1',delayBps:'1',fundingDebit:'0.01'};
  let tied=false;
  const outcomes=[];
  for (const patch of [{},{B:'142'},{B:'125',R_success:'35',recoveryBuffer:'11'},
      {asyncBps:'150'},{fundingDebit:'4'},{fundingDebit:'1.95',fundingRatesBps:'70,25'},{asyncBps:'900',fundingDebit:'7'}]) {
    const r={...inputs,...baseline,...patch};
    const configured=scanFixture(r,fixture).ratioScan;
    const desk=calculateCurrent(r,fixture.a,fixture.m,{},t,{scanRatios:true,baseObjectives:true}).ratioScan;
    const valid=[];
    for(const sign of [1,-1]) for(let i=1;i<=10;i++) for(let j=0;j<=6;j++){
      if (!ratioSlice(desk,sign,i,'eligible').some(([lo,hi])=>lo<=j && j<=hi)) continue;
      const row=planRecord(configured,{sign,i,j}),p=row.pressureSummary;
      if (!row.configuredPass || p.status!=='pass') continue;
      const cases=p.cases.filter(c=>c.configured && c.status==='pass');
      const fail=min(...cases.map(c=>dec(c.fail.cash))),success=min(...cases.map(c=>dec(c.success.cash)));
      assert.ok(fail.eq(p.minFailure.value) && success.eq(p.minSuccess.value));
      assert.ok(fail.gte(dec(r.B).plus(r.recoveryBuffer??'0')) && success.gte(r.R_success));
      assert.ok(min(fail.minus(r.B),success.minus(r.R_success)).eq(p.cashBuffers.minimum));
      valid.push({row,headroom:min(fail.minus(r.B),success.minus(r.R_success)),
        margin:dec(p.maxMarginUsed.value),surplus:dec(p.minSurplus.value)});
    }
    valid.sort((a,b)=>b.row.i-a.row.i || b.headroom.cmp(a.headroom) || b.surplus.cmp(a.surplus) ||
      a.margin.cmp(b.margin) || Number(a.row.leverage)-Number(b.row.leverage) ||
      b.row.sign-a.row.sign || a.row.j-b.row.j);
    const best=valid[0]?.row.key??null;
    assert.equal(configured.plans.pressure.key,best);
    assert.equal(desk.plans.pressure.key,best);
    if (patch.recoveryBuffer) {
      // Both candidates meet the extra 11 U admission floor. Subtracting it
      // again from M_fail would incorrectly choose four Hype lots over three.
      assert.equal(best,'1/7/3');
      assert.ok(valid.some(x=>x.row.key==='1/7/4'));
    }
    outcomes.push(best);
    if (valid.length && valid.filter(x=>x.row.i===valid[0].row.i).length>1) tied=true;
  }
  assert.ok(tied);
  assert.ok(new Set(outcomes).size>1);
});


test('PRESSRANK03 延迟增加仓位时单独核验抵押品，先尝试更高合法杠杆再缩仓',()=>{
  const f=pressureFixture();
  Object.assign(f.a.pf,{qty:'-7',free:'930'});
  const r={...inputs,mode:'keepPF',B:'153',R_success:'65',R_free:'19.9',delayBps:'100'};
  const x=calculateCurrent(r,f.a,f.m,{},t,{scanRatios:true});
  const scan=x.ratioScan, point={i:7,j:3,sign:-1};
  const at=lev=>recordFromInspection(scan.ctx,inspectRatio(scan.ctx,point,{includePathAudit:true,fixedLeverage:lev}));
  const basic=at(3),larger=at(4);
  assert.equal(basic.configuredPass,false);
  assert.equal(basic.pressureSummary.retryLeverage,true);
  assert.equal(larger.configuredPass,true);
  const winner=scan.plans.pressure.row;
  assert.equal(winner.key,larger.key);
  assert.equal(winner.leverage,'4');
  assert.equal(winner.pressureSummary.key,winner.key);
});


test('PRESSRANK04 逐期资金费和金额预算属于同一类压力，错误输入阻断，清除后旧快照失效',()=>{
  const f=pressureFixture();
  const r={...inputs,B:'157',R_success:'65',R_free:'0',adverseBps:'1',asyncBps:'1',jumpBps:'1',delayBps:'1',fundingDebit:''};
  const run=p=>calculateCurrent({...r,...p},f.a,f.m,{},t,{scanRatios:true,baseObjectives:true});
  const absent=run({}),entries=run({fundingRatesBps:' 2.5， 1 , 0 '});
  assert.equal(absent.stress.positive.length,4);
  assert.equal(entries.stress.positive.length,5);
  assert.deepEqual(entries.stress.fundingRatesBps,['2.5','1','0']);
  assert.ok(!entries.missingFields.some(g=>g.id==='fundingDebit'));
  const pressure=entries.ratioScan.plans.pressure;
  assert.equal(pressure.status,'conditional');
  assert.equal(pressure.scope,'configured');
  assert.equal(pressure.allSpecified.status,'unverified');
  assert.equal(pressure.allSpecified.key,null);
  assert.match(pressure.allSpecified.reason,/D/);
  assert.notEqual(entries.autoStatus,'AUTO_FEASIBLE');
  const cleared=run({fundingRatesBps:''});
  assert.notEqual(entries.trace.rulesId,cleared.trace.rulesId);
  assert.equal(cleared.trace.rulesId,absent.trace.rulesId);
  assert.deepEqual(cleared.stress.fundingRatesBps,[]);
  assert.equal(cleared.ratioScan.plans.pressure.status,'conditional');
  const zero=run({fundingRatesBps:'0, 0.00'});
  assert.equal(zero.stress.zero.length,1);
  assert.equal(zero.stress.missing.length,0);
  assert.equal(zero.ratioScan.plans.pressure.status,'conditional');
  const budget=run({fundingRatesBps:'0,0',fundingDebit:'0.05'});
  assert.equal(budget.stress.positive.length,5);
  for (const fundingRatesBps of ['3,,4','1,','-1','NaN','1e999','3， -0.1']) {
    const error=run({fundingRatesBps,fundingDebit:'0.05'});
    assert.equal(error.autoStatus,'AUTO_DATA_BLOCKED');
    assert.ok(!error.ratioScan && !error.needsSearch);
    assert.ok(error.missingFields.some(g=>g.id==='fundingRatesBps'));
  }
});


test('PRESSRANK05 较大手数缺少已配置情景证据时不得以较小仓位冒充最大',()=>{
  const scan=scanFixture({B:'157',R_success:'65',R_free:'0'},pressureFixture()).ratioScan;
  const largest=scan.plans.pressure.row.i;
  const observed=new Set();
  const search=searchLiquidityMaximum(scan,point=>{
    const row=planRecord(scan,point);
    observed.add(point.i);
    if(point.i!==largest || !row.configuredPass) return row;
    return {...row,configuredPass:false,pressureSummary:{...row.pressureSummary,status:'unknown'}};
  });
  assert.equal(search.status,'incomplete');
  assert.equal(search.configuredStatus,'unknown');
  assert.equal(search.allSpecified.status,'unverified');
  assert.equal(search.key,null);
  assert.ok(![...observed].some(i=>i<largest));
});

test('PRESSSCOPE 未完成数量网格和待结分成不能产生压力最大仓位',()=>{
  const scan=scanFixture({B:'157',R_success:'65',R_free:'0'},pressureFixture()).ratioScan;
  const inspect=()=>assert.fail('数据未完成时不应取得候选');
  for (const result of [searchLiquidityMaximum({...scan,complete:false},inspect),
    searchLiquidityMaximum(scan,inspect,true)]) {
    assert.equal(result.status,'incomplete');
    assert.equal(result.configuredStatus,'unknown');
    assert.equal(result.allSpecified.status,'unverified');
    assert.equal(result.allSpecified.key,null);
    assert.equal(result.key,null);
    assert.equal(result.liveSafety,'unverified');
  }
});


test('四方案快照核对压力极值的情景来源，并拒收借用其他候选的压力汇总',()=>{
  const f=pressureFixture();
  const result=scanFixture({B:'157',R_free:'0',R_success:'72'},f);
  result.calculationMarket=f.m;
  const frame=createSolutionSnapshot(result),plans=frame.ratioScan.plans;
  assert.deepEqual(frame.targets.map(t=>t?.key),[plans.targetKeys[0],plans.pressure.key,...plans.targetKeys.slice(1)]);
  assert.equal(frame.targets[1],plans.pressure.row);
  for(const change of [p=>{p.pressure.row.pressureSummary.minFailure.value='10000';},
      p=>{p.pressure.row.pressureSummary.leverage='999';},p=>{p.pressure.row.pressureSummary.cases.find(c=>c.id==='B').success.cash='0';}]){
    const damaged=structuredClone(result);
    change(damaged.ratioScan.plans);
    assert.throws(()=>createSolutionSnapshot(damaged),/压力/);
  }
});
