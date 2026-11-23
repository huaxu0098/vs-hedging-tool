import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, calculateCurrent } from '../src/hedge/current.js';
import { presetAccount } from '../src/hedge/current-account.js';
import { createSolutionSnapshot } from '../src/hedge/display-history.js';
import { dec, profitSplit } from '../src/hedge/math.js';
import { unitContract } from '../fixtures/hedge-currency-contracts.js';

const now = Date.parse('2026-11-22T06:00:00Z');
const iso = new Date(now).toISOString();

function liveMarket(mark = '60000') {
  const m = Number(mark);
  const bids = [1, 2, 3, 4].map((k) => [String(m - k), '5']);
  const asks = [1, 2, 3, 4].map((k) => [String(m + k), '5']);
  return {
    asset: 'BTC',
    source: 'test-live',
    spec: {
      symbol: 'BTC-PERP',
      base: 'BTC',
      quote: 'USDC',
      contract: unitContract('BTC-PERP'),
      sizeDecimals: 4,
      minQty: '0.0001',
      minNotional: '0',
      capitalInitMarginRatio: '0.1',
      fundedInitMarginRatio: '0.1',
      maintMarginRatio: '0.025',
      maxLeverage: '10',
      maxQty: '2'
    },
    pf: {
      symbol: 'BTC-PERP',
      open: true,
      mark,
      bid: bids[0][0],
      ask: asks[0][0],
      asOf: iso,
      bookAt: iso,
      markAt: iso,
      levels: [bids, asks]
    },
    hl: {
      symbol: 'BTC',
      sizeDecimals: 5,
      minQty: '0.00001',
      minNotional: '10',
      maxLeverage: 40,
      collateralToken: 0,
      mark,
      bid: bids[0][0],
      ask: asks[0][0],
      asOf: iso,
      bookAt: iso,
      markAt: iso,
      funding: '0.0000125',
      oracle: mark,
      contract: unitContract('BTC'),
      marginTiers: [{ lowerBound: '0', maxLeverage: 40 }],
      levels: [bids, asks]
    }
  };
}

function runCalc(ruleOverrides = {}, market = liveMarket()) {
  const r = {
    ...rules,
    planCrossFlat: true,
    planCapital: '500',
    registration: '91',
    planPF: '10000',
    fundedFloor: '8000',
    fundedTarget: '10800',
    challengeStart: iso,
    deadline: new Date(now + 48 * 3600000).toISOString(),
    examClockVersion: 1,
    ...ruleOverrides
  };
  const a = { pf: presetAccount(r, 'pf'), hl: presetAccount(r, 'hl') };
  const res = calculateCurrent(r, a, market, {}, now, {
    scanRatios: true,
    baseObjectives: true,
    openingCapacity: true
  });
  if (res.ratioScan) {
    res.calculationMarket = market;
    res.finishedAt = iso;
  }
  return { r, a, res };
}

test('R6-1 考核口径不重扣报名费、多规模多比例联合求解、A/B/C 三节点严格分离', () => {
  const { a, res } = runCalc();
  assert.equal(a.hl.equity, '409'); // 500 - 91 = 409
  const snap = createSolutionSnapshot(res);
  const col = snap.ratioScan.plans.collection;
  assert.equal(col.stage, 'challenge');
  assert.equal(col.principal, '500');
  assert.equal(col.registration, '91');
  const rows = col.groups.flatMap((g) => g.rows);
  assert.ok(rows.length >= 6);
  // Deduplicated by (sign, i, j)
  assert.equal(rows.length, new Set(rows.map((r) => r.key)).size);
  // Multiple distinct PF scales and multiple distinct hedge ratios discovered dynamically
  const distinctPF = new Set(rows.map((r) => r.pfValue));
  const distinctRatios = new Set(rows.map((r) => dec(r.h).toFixed(4)));
  assert.ok(distinctPF.size >= 4);
  assert.ok(distinctRatios.size >= 4);
  // Failure recovery uses 500U principal (not 591U)
  const failRepaid = rows.filter((r) => r.repayment.fail.recovered);
  assert.ok(failRepaid.length > 0);
  for (const row of failRepaid) {
    assert.ok(dec(row.fail).gte('500'));
    assert.equal(row.verdicts.canOpen.ok, true);
    assert.equal(row.verdicts.failRecovered.ok, true);
    // Node B must NOT count Evaluation 2000U profit or future Funded payout as recovered
    assert.equal(row.repayment.pass.recovered, false);
    assert.equal(row.verdicts.passRecovered.ok, false);
    assert.equal(row.funded.conditional, true);
    // When carryover Hype (< 142.86U for 10800 target) cannot protect Funded fail, Node C reports insufficient support & shortfall
    assert.equal(row.funded.supported, false);
    assert.ok(dec(row.funded.shortfall).gt(0));
    assert.equal(row.verdicts.fundedRecovered.supported, false);
  }
});

test('R6-2 Funded 规则：8000 失败线独立、9000→9800 无分成、10100 提取 80/20、进入 Funded 后继续联合求解', () => {
  // 9000 -> 9800 has 0 splittable profit above 10000 baseline
  const below = profitSplit('9800', '10000', '0.8', { platformShare: '0.2' });
  assert.equal(below.qualified, '0');
  assert.equal(below.user, '0');
  // 10100 yields 80U user / 20U platform
  const sample = profitSplit('10100', '10000', '0.8', { platformShare: '0.2' });
  assert.equal(sample.user, '80');
  assert.equal(sample.platform, '20');

  // Funded stage full joint solver with carryover Hype = 200U, PF = 10000, floor = 8000, target = 10800
  const { res } = runCalc({
    stage: 'funded',
    planPF: '10000',
    planFundedCash: '200',
    fundedFloor: '8000',
    fundedTarget: '10800'
  });
  const snap = createSolutionSnapshot(res);
  const col = snap.ratioScan.plans.collection;
  assert.equal(col.stage, 'funded');
  assert.equal(col.capital.floor, '8000');
  assert.equal(col.capital.target, '10800');
  const rows = col.groups.flatMap((g) => g.rows);
  assert.ok(rows.length >= 6);
  // Both failure-recovery and post-first-payout recovery are verified with pre-payout real support
  const dual = rows.filter((r) => r.repayment.fail.recovered && r.funded.repayment.recovered && r.funded.supported);
  assert.ok(dual.length > 0);
  for (const row of dual) {
    assert.equal(row.funded.conditional, false);
    assert.equal(row.funded.payout, '640');
    assert.equal(row.funded.platformPayout, '160');
    assert.ok(dec(row.pass).gt(0)); // Hype survives before payout arrives
    assert.ok(dec(row.funded.totalCash).eq(dec(row.pass).plus('640')));
    assert.ok(dec(row.funded.repayment.net).gt(0));
  }
});

test('R6-3 无法回本时如实报告无解与缺口，保留可开仓位但不误标为回本；行情变动重新求解整组候选', () => {
  // High exam fee leaving only 50U in Hype with low 2x leverage -> cannot recover 500U on failure
  const tightMarket = liveMarket('60000');
  tightMarket.hl.maxLeverage = 2;
  tightMarket.hl.marginTiers = [{ lowerBound: '0', maxLeverage: 2 }];
  const { res: tight } = runCalc({ planCapital: '500', registration: '450' }, tightMarket);
  const colTight = tight.ratioScan.plans.collection;
  assert.equal(colTight.summary.failRecovered, 0);
  assert.ok(dec(colTight.summary.bestFailShortfall).gt(0));
  for (const row of colTight.groups.flatMap((g) => g.rows)) {
    assert.equal(row.repayment.fail.recovered, false);
    assert.equal(row.verdicts.failRecovered.ok, false);
  }

  // Re-solve when market price changes significantly
  const { res: m1 } = runCalc({}, liveMarket('60000'));
  const { res: m2 } = runCalc({}, liveMarket('80000'));
  const keys1 = m1.ratioScan.plans.collection.rankedKeys;
  const keys2 = m2.ratioScan.plans.collection.rankedKeys;
  assert.notDeepEqual(keys1, keys2);
});
