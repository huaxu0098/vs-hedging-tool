import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dec,
  out,
  solveBudgetBounds,
  solveExactBounds,
  exactEndpoint,
  timeoutCash,
  discreteBounds,
  ruleState,
  profitSplit
} from '../src/hedge/math.js';
import {
  createBook,
  applyLedgerEvent as apply,
  balances,
  markEquity,
  advanceClock
} from '../src/hedge/book.js';
const near = (actual, expected, tol = 1e-9) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(Number(actual) - Number(expected)) < tol, `${actual} vs ${expected}`);
};
const base = {
  stage: 'challenge',
  E: '10000',
  C_hl: '409',
  C_external: '0',
  inTransit: '0',
  C_ref: '409',
  B: '500',
  floor: '9400',
  target: '12000',
  baseline: '10000',
  share: '0.8',
  R: '100',
  g: '0',
  k: '0'
};
const funded = {
  ...base,
  stage: 'funded',
  C_hl: '105.666666666666667',
  C_ref: '105.666666666666667',
  floor: '8000',
  target: '10100',
  R: '40',
  g: '20'
};
const fee = { N: '10000', direction: 1, fV: '0.0001', fH: '0.0005', basis: 'flat_before_entry' };
const start = '2026-01-01T00:00:00.000Z',
  end = '2026-01-03T00:00:00.000Z';
const event = (id, type, payload = {}, at = start) => ({
  id,
  type,
  payload,
  occurredAt: at,
  receivedAt: at,
  source: 'demo'
});
const initial = (options = {}) => createBook({ id: 'a1', time: start, ...options });
const held = () => initial({ B: '1000', purchaseFee: '0' });
const fill = (id, venue, qty, price, rate, at = start) =>
  event(
    id,
    'fill',
    { venue, asset: 'unit', qty, price, rate, multiplier: '1', fx: '1', pool: 'standard', currency: 'U' },
    at
  );
test('M01 零费用考核覆盖上下限', () => {
  const r = solveBudgetBounds(base);
  near(r.min, 0.151666666666667);
  near(r.max, 0.1545);
  near(r.selected.fail, 500);
  near(r.selected.before, 105.666666666667);
});
test('M02 压力预算无交集', () => {
  const r = solveBudgetBounds({ ...base, k: '8' });
  near(r.min, 0.165);
  near(r.max, 0.1505);
  assert.equal(r.selected, null);
});
test('M03 到期用实际路径盈亏', () => {
  const h = solveBudgetBounds(base).min;
  near(timeoutCash('409', h, '0', '0'), 409);
  near(timeoutCash('409', h, '-200', '0'), 439.333333333333);
});
test('M04 出金端到账前后', () => {
  const r = solveBudgetBounds(funded);
  near(r.min, 0.197166666666667);
  near(r.max, 0.6);
  near(r.selected.before, 85.95);
  near(r.selected.after, 165.95);
  near(r.selected.gain, 60.283333333333);
});
test('M05 下一轮只用真实到账资金', () =>
  near(solveBudgetBounds({ ...funded, C_hl: '165.95', C_ref: '165.95' }).min, 0.167025));
test('M06 回撤后使用冻结 C_ref', () => {
  const r = solveBudgetBounds({ ...funded, E: '9000', C_hl: '302.833333333333' });
  near(r.min, 0.197166666666667);
  near(r.max, 0.233787878787879);
});
test('M07 低于起点不分利润', () => {
  for (const E of ['9000', '9800']) assert.equal(profitSplit(E, '10000', '0.8').user, '0');
  assert.equal(solveBudgetBounds({ ...funded, target: '9800' }).code, 'NO_PAYOUT_TARGET');
});
const payoutBook = () => initial({ stage: 'funded', pf: '10100', hl: '85.95', ref: '105.666666666666667' });
const claim = event('claim1', 'distribution', { payoutId: 'p1' });
const receipt = (id = 'receipt', destination = 'hl') => event(id, 'receipt', { payoutId: 'p1', destination });
test('M08 全额扣毛利润并建立应收', () => {
  const s = apply(payoutBook(), claim);
  assert.equal(s.pf, '10000');
  assert.equal(s.payouts.p1.platform, '20');
  assert.equal(balances(s).receivable, '80');
  assert.equal(s.hl, '85.95');
});
test('M09 重复到账只记一笔', () => {
  const s = apply(apply(payoutBook(), claim), receipt());
  assert.deepEqual(apply(s, receipt('another-envelope')), s);
  near(s.hl, 165.95);
});
test('M10 负现金上限保留', () => {
  const r = solveBudgetBounds({ ...funded, C_hl: '40', C_ref: '40', R: '50', g: '0' });
  near(r.min, 0.23);
  near(r.cashMax, -0.1);
  assert.equal(r.selected, null);
});
test('M11 h=0 合法未对冲候选', () => {
  const r = solveBudgetBounds({ ...funded, C_hl: '600', C_ref: '600' });
  assert.equal(r.selected.h, '0');
});
test('M12 端点先于除法判定', () => {
  for (const [E, code] of [
    ['9400', 'CHALLENGE_FAILED'],
    ['12000', 'CHALLENGE_PASS_PENDING_SETTLEMENT']
  ])
    assert.equal(solveBudgetBounds({ ...base, E }).code, code);
});
for (const [id, d, gross, nominal, pfFee, endCash] of [
  ['F01', 1, 2002.200220022002, 12002.200220022002, 2.200220022002, 597.359735973597],
  ['F02', -1, 2001.799820017998, 7998.200179982002, 1.799820017998, 597.840215978402]
])
  test(id + ' 新开线性双边交易费用', () => {
    const r = exactEndpoint({ ...fee, direction: d, y: '2000', h: '0.2', cash: '1000' });
    near(r.gross, gross);
    near(r.exitNotional, nominal);
    near(r.pfFees, pfFee);
    near(r.hlFees, pfFee);
    near(r.cash, endCash);
  });
test('F03 含费覆盖比例', () => {
  const r = solveExactBounds({ ...base, R: '0' }, fee);
  near(r.failureUnit, 588.358835883588);
  near(r.successUnit, 2013.201320132013);
  near(r.min, 0.15466751657317695);
  near(r.selected.fail, 500);
  near(r.selected.before, 97.62315145334013);
});
test('F04 已有仓位只收未来平仓费', () => {
  for (const [y, gross, cash] of [
    ['1001', 1002.200220022002, 597.359735973597],
    ['-1599', -1598.059805980598, 1117.671767176718]
  ]) {
    const r = exactEndpoint({ ...fee, N: '11000', basis: 'open_mark_snapshot', y, h: '0.2', cash: '799' });
    near(r.gross, gross);
    near(r.cash, cash);
  }
});
test('F05 动态减仓逐笔入账', () => {
  let s = held();
  for (const e of [
    fill('v', 'pf', '10', '1000', fee.fV),
    fill('h', 'hl', '-2', '1000', fee.fH),
    fill('trim', 'hl', '1', '1100', fee.fH)
  ])
    s = apply(s, e);
  near(s.hl, 898.45);
  near(markEquity(s, 'hl', { unit: '1100' }), 798.45);
  for (const e of [fill('vc', 'pf', '-10', '1200', fee.fV), fill('hc', 'hl', '1', '1200', fee.fH)])
    s = apply(s, e);
  near(s.fees.pf, 2.2);
  near(s.fees.hl, 2.15);
  near(s.pf, 11997.8);
  near(s.hl, 697.85);
  near(s.ref, 1000);
});
test('F06 远参考点现金不足', () => {
  const r = solveBudgetBounds({ ...funded, target: '11000', R: '0', g: '0' });
  near(r.cashMax, 0.10566666666666667);
  near(r.profitMax, 0.8);
  near(r.atMinimum.before, -91.5);
  assert.equal(r.code, 'CASH_BEFORE_PAYOUT');
  assert.equal(r.selected, null);
});
test('F07 应收、实际到账、新轮次三个独立事件', () => {
  let s = apply(payoutBook(), claim);
  near(s.ref, 105.66666666666667);
  assert.throws(() => apply(s, event('early', 'round_start')));
  s = apply(s, receipt());
  near(s.ref, 105.66666666666667);
  s = apply(s, event('r2', 'round_start'));
  near(s.ref, 165.95);
  assert.equal(s.refEvent, 'r2');
  assert.deepEqual(apply(s, receipt('dupe')), s);
});
test('F08 连续实际到账路径，比例逐轮重算', () => {
  let cash = solveExactBounds({ ...base, R: '0' }, fee).selected.before;
  let ledger = initial({ stage: 'funded', hl: cash, ref: cash });
  const expected = [
    154.95531541530432, 215.51727775431128, 279.4909886504252, 347.0686484182885, 418.4532849468301,
    493.8593636689479, 573.5134318937371, 653.5134318937371
  ];
  for (const [i, expectedCash] of expected.entries()) {
    const r = solveExactBounds({ ...funded, C_hl: cash, C_ref: cash, R: '0', g: '0' }, fee);
    near(r.failureUnit, 1989.198919891989);
    near(r.successUnit, 112.061206120612);
    if (!i) {
      near(r.min, 0.20228085010648829);
      near(r.selected.before, 74.95531541530432);
    }
    if (i === 6) near(r.min, 0.003086989576379579);
    near(r.selected.fail, i === 7 ? 573.5134318937371 : 500);
    const payoutId = 'f08/' + i,
      position = out(dec(r.min).times('-10'));
    const end = exactEndpoint({ ...fee, y: '100', cash, h: r.min }),
      px = out(dec(end.exitNotional).div(10));
    ledger = apply(ledger, fill(payoutId + '/pf-open', 'pf', '10', '1000', fee.fV));
    if (position !== '0') ledger = apply(ledger, fill(payoutId + '/hl-open', 'hl', position, '1000', fee.fH));
    ledger = apply(ledger, fill(payoutId + '/pf-exit', 'pf', '-10', px, fee.fV));
    if (position !== '0')
      ledger = apply(ledger, fill(payoutId + '/hl-exit', 'hl', out(dec(position).neg()), px, fee.fH));
    ledger = apply(ledger, event(payoutId + '/distribution', 'distribution', { payoutId }));
    near(ledger.hl, r.selected.before);
    near(balances(ledger).receivable, 80);
    ledger = apply(ledger, event(payoutId + '/receipt', 'receipt', { payoutId, destination: 'hl' }));
    ledger = apply(ledger, event(payoutId + '/next', 'round_start'));
    cash = ledger.hl;
    near(ledger.ref, cash);
    near(cash, r.selected.after);
    near(cash, expectedCash);
  }
});
test('F09 负利润上限不得截零', () => {
  const r = solveBudgetBounds({ ...funded, C_hl: '600', C_ref: '600', R: '0', g: '100' });
  near(r.profitMax, -0.2);
  assert.equal(r.code, 'PROFIT_TARGET_UNATTAINABLE');
  assert.equal(r.selected, null);
});
test('F10 两日平价按实际退出费结算', () => {
  let s = initial();
  for (const e of [fill('v', 'pf', '10', '1000', fee.fV), fill('h', 'hl', '-2', '1000', fee.fH)])
    s = apply(s, e);
  s = advanceClock(s, end, { unit: { bid: '1000', ask: '1000', asOf: end } }, 'demo');
  near(s.fees.pf, 2);
  near(s.pf, 9998);
  near(s.fees.hl, 2);
  near(s.hl, 407);
  assert.equal(s.exitStatus, 'settled');
  assert.deepEqual(s.positions, {});
  assert.deepEqual(advanceClock(s, end, {}, 'demo'), s);
});
test('F11 无效价格与负失败回收系数', () => {
  assert.equal(
    exactEndpoint({ ...fee, N: '1000', direction: -1, y: '2000', h: '0.2', cash: '409' }).code,
    'INVALID_PRICE_ENDPOINT'
  );
  const r = solveExactBounds(base, { ...fee, N: '600000' });
  near(r.failureUnit, -119.71197119711971);
  assert.equal(r.selected, null);
});
test('F12 连续可行但数量步长无解', () => {
  const r = discreteBounds(solveBudgetBounds(base), '1', '1', '0.01');
  assert.equal(r.code, 'NO_DISCRETE_MATCH');
  assert.deepEqual(r.neighbors, ['0.15', '0.16']);
});
