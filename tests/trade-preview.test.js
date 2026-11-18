import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemplates } from '../src/assets.js';
import { analyzeCandidate } from '../src/decision.js';
import { buildTradePreview } from '../src/trade-preview.js';

const now = Date.parse('2026-11-19T01:00:00Z');
const setup = (stage = 'challenge') => ({
  asset: createTemplates(now)[0],
  account: {
    stage,
    vsBalance: 10000,
    hypeCash: 409,
    positions: [],
    initialCapital: 500,
    registrationPaid: 91,
    received: 0
  },
  order: { vsUsd: 18000, hypeUsd: 3000, vsLong: true }
});
function preview({ asset, account, order }, config = {}) {
  const candidate = analyzeCandidate(asset, account, config, order, now);
  return { candidate, ...buildTradePreview(asset, account, config, candidate) };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + ' vs ' + b);

test('考核模型分别给出新增现金利润与全周期利润；已扣报名费、占用保证金及交易费只入账一次', () => {
  const inputs = setup();
  inputs.account.externalUnrecovered = 0.25;
  const result = preview(inputs);
  const { pass, fail, liq } = result.scenarios;
  assert.equal(result.candidate.ok, true);
  assert.equal(result.registrationPaid, 91);
  assert.equal(pass.status, 'conditional');
  assert.equal(fail.status, 'conditional');
  near(fail.cash, 504.773377);
  near(fail.cashChange, 95.773377);
  near(fail.profit, 95.773377);
  near(fail.totalProfit, 4.523377);
  near(pass.cash, 71.0716345);
  near(pass.profit, -337.9283655);
  assert.equal(pass.pendingPayout, 0);
  near(pass.cashAfterPayout, pass.cash);
  near(fail.price, result.candidate.fail);
  assert.equal(liq.status, 'preempted');
  assert.equal(liq.cash, null);
  assert.ok(result.candidate.hype.margin > 200);
});

test('未到账的 VS 分成不抬高出金号达标时的现金或利润，到账后单列；以前到账不重复加回', () => {
  const inputs = setup('funded');
  inputs.account.received = 70;
  const {
    scenarios: { pass, fail }
  } = preview(inputs);
  near(pass.cash, 237.8829985);
  near(pass.profit, -171.1170015);
  near(pass.totalProfit, -262.1170015);
  near(pass.pendingPayout, 800.0112220628);
  near(pass.cashAfterPayout, 1037.8942205628);
  near(pass.profitAfterPayout, 628.8942205628);
  near(pass.totalProfitAfterPayout, 537.8942205628);
  assert.equal(fail.pendingPayout, 0);
});

test('有原仓时按起始标记净值计算此刻向前的现金盈亏，单列现金账面变化', () => {
  const inputs = setup();
  inputs.account.positions = [{ assetId: 'btc', venue: 'hype', qty: -0.02, entry: 101000, margin: 200 }];
  Object.assign(inputs.account, { hypeUsed: 200, hypeEquity: 429, hypeFree: 229 });
  const result = preview(inputs),
    row = result.scenarios.fail;
  assert.equal(result.startingEquity, 429);
  assert.equal(row.status, 'conditional');
  near(row.profit, row.cash - 429);
  near(row.cashChange - row.profit, 20);
  near(row.totalProfit, row.cash - 500);
});

test('Hype 强平先于通过时，只给强平触发价与已核实的另一方向情景', () => {
  const inputs = setup();
  inputs.asset.hype.leverage = 20;
  inputs.order.hypeUsd = 3800;
  const {
    scenarios: { fail, pass, liq },
    candidate
  } = preview(inputs);
  assert.equal(candidate.checks.capital, true);
  assert.equal(pass.status, 'preempted');
  assert.equal(pass.profit, null);
  assert.equal(liq.status, 'conditional');
  near(liq.price, candidate.liq);
  near(liq.localPrice, candidate.liqMark);
  assert.equal(liq.cash, null);
  assert.equal(liq.totalProfit, null);
  assert.equal(liq.pendingPayout, null);
  assert.ok(liq.reason.includes('清算'));
  assert.equal(fail.status, 'conditional');
});

test('反方向路径、同时触线、资金不足、已失效与无交易方案均不虚构可达款项', () => {
  const inputs = setup();
  inputs.order.vsLong = false;
  const output = preview(inputs),
    candidate = output.candidate;
  assert.equal(output.scenarios.pass.status, 'conditional');
  assert.equal(output.scenarios.liq.status, 'preempted');
  const tied = buildTradePreview(
    inputs.asset,
    inputs.account,
    {},
    { ...candidate, liq: candidate.pass, liqMark: candidate.pass }
  );
  assert.equal(tied.scenarios.liq.status, 'simultaneous');
  assert.equal(tied.scenarios.pass.status, 'simultaneous');
  assert.equal(tied.scenarios.pass.cash, null);
  for (const c of [
    undefined,
    { ...candidate, noTrade: true },
    { ...candidate, liq: null },
    { ...candidate, checks: { capital: false } }
  ]) {
    const res = buildTradePreview(inputs.asset, inputs.account, {}, c);
    for (const row of Object.values(res.scenarios)) {
      assert.equal(row.status, 'unverified');
      assert.equal(row.cash, null);
    }
  }
  const stale = buildTradePreview(
    { ...inputs.asset, sourceIssues: ['报价过期'] },
    inputs.account,
    {},
    candidate
  );
  assert.equal(stale.scenarios.pass.reason, '报价过期');
});
