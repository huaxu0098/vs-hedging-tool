import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, calculateCurrent } from '../src/hedge/current.js';
import { presetAccount } from '../src/hedge/current-account.js';
import { createSolutionSnapshot } from '../src/hedge/display-history.js';
import { parseTotalLoss, parseDailyLoss, resolveLossBoundary, solveFundedWBounds } from '../src/hedge/loss-limits.js';
import { dec } from '../src/hedge/math.js';
import { unitContract } from '../fixtures/hedge-currency-contracts.js';

const now = Date.parse('2026-11-22T09:00:00Z');
const iso = new Date(now).toISOString();

function liveMarket(mark = '50000') {
  const m = Number(mark);
  const bids = [0.5, 1, 1.5, 2].map((k) => [String(m - k), '5']);
  const asks = [0.5, 1, 1.5, 2].map((k) => [String(m + k), '5']);
  return {
    asset: 'BTC',
    source: 'test-live',
    spec: {
      symbol: 'BTC-PERP', base: 'BTC', quote: 'USDC',
      contract: unitContract('BTC-PERP'),
      sizeDecimals: 4, minQty: '0.0001', minNotional: '0',
      capitalInitMarginRatio: '0.1', fundedInitMarginRatio: '0.1',
      maintMarginRatio: '0.025', maxLeverage: '10', maxQty: '2'
    },
    pf: { symbol: 'BTC-PERP', open: true, mark, bid: bids[0][0], ask: asks[0][0], asOf: iso, bookAt: iso, markAt: iso, levels: [bids, asks] },
    hl: {
      symbol: 'BTC', sizeDecimals: 5, minQty: '0.00001', minNotional: '10',
      maxLeverage: 40, collateralToken: 0, mark, bid: bids[0][0], ask: asks[0][0],
      asOf: iso, bookAt: iso, markAt: iso, funding: '0.00001', oracle: mark,
      contract: unitContract('BTC'), marginTiers: [{ lowerBound: '0', maxLeverage: 40 }],
      levels: [bids, asks]
    }
  };
}

function runCalc(ruleOverrides = {}, market = liveMarket()) {
  const r = {
    ...rules,
    planCrossFlat: true,
    planCapital: '1100',
    registration: '100',
    planPF: '10000',
    challengeFloor: '9500',
    challengeDailyMode: 'none',
    challengeDailyFloor: '',
    challengeTarget: '11000',
    fundedFloor: '9000',
    fundedDailyMode: 'none',
    fundedDailyFloor: '',
    fundedTarget: '',
    pfFee: '0.0001',
    hlFee: '0.00045',
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

test('R11-1 总止损必有、日止损可有可无（A–G 七种边界状态严格区分，0 不等于无日限或空值）', () => {
  // Numeric 0 is valid, never missing or none
  assert.deepEqual(parseTotalLoss('0'), { state: 'provided', floor: '0' });
  assert.deepEqual(parseTotalLoss(''), { state: 'missing', floor: null });
  assert.deepEqual(parseDailyLoss('provided', '0'), { state: 'provided', floor: '0' });
  assert.deepEqual(parseDailyLoss('none', '9700'), { state: 'none', floor: null });
  assert.equal(parseDailyLoss('missing', '').state, 'missing');
  assert.equal(parseDailyLoss('provided', '').state, 'missing');

  // Case A: Total 9400, no daily limit -> effective 9400, space 400
  const caseA = resolveLossBoundary('challenge', '9800', parseTotalLoss('9400'), parseDailyLoss('none', ''));
  assert.equal(caseA.caseCode, 'A');
  assert.equal(caseA.effectiveFloor, '9400');
  assert.equal(caseA.effectiveSpace, '400');
  assert.equal(caseA.failureComplete, true);

  // Case B: Daily 9700 earlier than Total 9400 -> effective 9700, space 100
  const caseB1 = resolveLossBoundary('challenge', '9800', parseTotalLoss('9400'), parseDailyLoss('provided', '9700'));
  assert.equal(caseB1.caseCode, 'B');
  assert.equal(caseB1.bindingSource, 'daily');
  assert.equal(caseB1.effectiveFloor, '9700');
  assert.equal(caseB1.effectiveSpace, '100');

  // Case B (reverse): Daily 9200 lower than Total 9400 -> total triggers first!
  const caseB2 = resolveLossBoundary('challenge', '9800', parseTotalLoss('9400'), parseDailyLoss('provided', '9200'));
  assert.equal(caseB2.bindingSource, 'total');
  assert.equal(caseB2.effectiveFloor, '9400');

  // Case C: Total 9400, Daily missing -> incomplete!
  const caseC = resolveLossBoundary('challenge', '9800', parseTotalLoss('9400'), parseDailyLoss('missing', ''));
  assert.equal(caseC.caseCode, 'C');
  assert.equal(caseC.failureDefined, true);
  assert.equal(caseC.failureComplete, false);

  // Case D: Total missing, Daily 9700 -> incomplete!
  const caseD = resolveLossBoundary('challenge', '9800', parseTotalLoss(''), parseDailyLoss('provided', '9700'));
  assert.equal(caseD.caseCode, 'D');
  assert.equal(caseD.effectiveFloor, '9700');
  assert.equal(caseD.failureComplete, false);

  // Case E: Total missing, no daily -> failure undefined
  const caseE = resolveLossBoundary('challenge', '9800', parseTotalLoss(''), parseDailyLoss('none', ''));
  assert.equal(caseE.caseCode, 'E');
  assert.equal(caseE.effectiveFloor, null);
  assert.equal(caseE.failureDefined, false);

  // Case F: D_effective == 0
  const caseF = resolveLossBoundary('challenge', '9400', parseTotalLoss('9400'), parseDailyLoss('none', ''));
  assert.equal(caseF.caseCode, 'F');
  assert.equal(caseF.zeroSpace, true);
  assert.equal(caseF.failureDefined, false);

  // Case G: D_effective < 0
  const caseG = resolveLossBoundary('challenge', '9300', parseTotalLoss('9400'), parseDailyLoss('none', ''));
  assert.equal(caseG.caseCode, 'G');
  assert.equal(caseG.breached, true);
});

test('R11-2 缺少总止损数据时不整页报错、保留通过/容量结果并明确标缺总止损；日限未填不标完整回本', () => {
  // Case E: challengeFloor blank, no daily limit
  const { res: resE } = runCalc({ challengeFloor: '', challengeDailyMode: 'none' });
  assert.ok(resE.ratioScan);
  const colE = resE.ratioScan.plans.collection;
  assert.equal(colE.lossBoundary.caseCode, 'E');
  const rowsE = colE.groups.flatMap((g) => g.rows);
  assert.ok(rowsE.length > 0);
  for (const row of rowsE) {
    assert.equal(row.fail, null);
    assert.equal(row.lines.fail, undefined);
    assert.equal(row.repayment.fail, null);
    assert.equal(row.verdicts.failRecovered.label, '缺少总止损数据');
    assert.ok(row.pass != null && row.passCost != null); // Pass branch still calculated!
  }
  assert.equal(colE.summary.failRecovered, 0);

  // Case C: challengeFloor 9500, daily mode unconfirmed ('missing') -> failureComplete false
  const { res: resC } = runCalc({ challengeFloor: '9500', challengeDailyMode: 'missing' });
  const colC = resC.ratioScan.plans.collection;
  assert.equal(colC.lossBoundary.caseCode, 'C');
  assert.equal(colC.summary.failRecovered, 0); // Must NOT claim complete recovery!
  assert.ok(colC.groups.flatMap((g) => g.rows).every((r) => r.verdicts.failRecovered.incomplete === true));

  // Case F: D_effective = 0 blocks new-entry failure plans cleanly
  const { res: resF } = runCalc({ planPF: '9500', challengeFloor: '9500' });
  assert.equal(resF.lossBoundary.caseCode, 'F');
  assert.ok(resF.issues.some((s) => s.includes('无新增亏损空间')));
});

test('R11-3 第15节含费算术基准：考核含费回本、通关成本延续、Funded 自动求 W 并筛选双端严格大于 0', () => {
  // Evaluation with R11 Section 15 inputs: F=100, H0=1000 (total 1100), D_E=500, G=1000, D_F=1000, a=80%, auto W
  const { res: evalRes } = runCalc();
  const evalSnap = createSolutionSnapshot(evalRes);
  const evalCol = evalSnap.ratioScan.plans.collection;
  assert.equal(evalCol.lossBoundary.caseCode, 'A');
  const dualEvalRows = evalCol.groups.flatMap((g) => g.rows).filter((r) => r.repayment.fail?.recovered && r.funded?.dualPositive);
  assert.ok(dualEvalRows.length > 0, 'Section 15 setup should discover conditional Funded dual-positive (>0) solutions with auto-solved W');
  for (const row of dualEvalRows) {
    // Fee-included failure recovery ratio must exceed the zero-fee 20% floor
    assert.ok(dec(row.h).gt('0.20'));
    assert.ok(dec(row.passCost).gt('300')); // Around 313.80+ with fees
    assert.equal(row.funded.conditional, true);
    assert.equal(row.funded.dualPositive, true);
    assert.ok(dec(row.funded.failRepayment.net).gt(0));
    assert.ok(dec(row.funded.repayment.net).gt(0));
    assert.ok(dec(row.funded.w).gt('645')); // Must exceed W_min ≈ 645.41 U
  }

  // Funded stage directly with H1 = 786.20, C_pass = 313.80 (total basis 1100), D_F = 1000, auto W (blank fundedTarget)
  const { res: fundRes } = runCalc({
    stage: 'funded',
    planPF: '10000',
    planFundedCash: '786.20',
    fundedFloor: '9000',
    fundedDailyMode: 'none',
    fundedTarget: ''
  });
  const fundSnap = createSolutionSnapshot(fundRes);
  const fundCol = fundSnap.ratioScan.plans.collection;
  assert.equal(fundCol.autoFundedTarget, true);
  assert.ok(fundCol.summary.dualPositive > 0);
  const best = fundCol.groups.flatMap((g) => g.rows).find((r) => r.funded.dualPositive);
  assert.ok(dec(best.repayment.fail.net).gt(0));
  assert.ok(dec(best.funded.repayment.net).gt(0));

  // R11 Section 9.3: D_F = 300 with C = 300, a = 0.8 => a*D_F = 240 <= 300 => mathematical impossibility!
  const impossible = solveFundedWBounds('300', '300', '700', '0.8');
  assert.equal(impossible.feasible, false);
  assert.equal(impossible.code, 'LOSS_SPACE_TOO_SMALL');
});
