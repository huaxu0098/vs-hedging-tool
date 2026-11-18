import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkspace, dashboardAccount, WORKSPACE_KEY } from '../src/workspace-state.js';
import { createTemplates } from '../src/assets.js';
import { createSimulation, accountView } from '../src/simulation.js';
const assets = createTemplates(),
  asset = assets[0],
  local = accountView(createSimulation(), assets);
test('旧版合约独立迁移，保留自定义步长和旧报价时间，已有记录保持原样', (t) => {
  const old = structuredClone(assets);
  old[0].vs.step = 0.00021;
  old[0].vs.asOf = '2024-01-05T12:00:00Z';
  const raw = JSON.stringify(old),
    values = new Map([['vs-hype:assets:v1', raw]]);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }
  });
  t.after(() =>
    descriptor
      ? Object.defineProperty(globalThis, 'localStorage', descriptor)
      : delete globalThis.localStorage
  );
  const state = readWorkspace();
  assert.equal(state.assets[0].vs.step, 0.00021);
  assert.equal(state.assets[0].vs.asOf, old[0].vs.asOf);
  assert.equal(state.assets[0].hype.tiersVerified, false);
  assert.equal(values.get('vs-hype:assets:v1'), raw);
  assert.ok(values.has(WORKSPACE_KEY));
});
test('已确认 VS 账户可独立覆盖本地预览；无法解释净值或缺少持仓必须给出原因', () => {
  const quote = {
    mode: 'offline',
    vs: {
      symbol: 'BTC',
      account: {
        stage: 'funded',
        balance: 9800,
        equity: 9800,
        used: 20,
        free: 9780,
        positions: [{ assetId: 'btc', symbol: 'BTC', qty: 0.002, entry: 100000, marginUsed: 20, upnl: 0 }]
      }
    }
  };
  const updated = dashboardAccount(local, null, quote, asset, assets);
  assert.deepEqual(updated.issues, []);
  assert.equal(updated.account.vsBalance, 9800);
  assert.equal(updated.account.hypeCash, 409);
  assert.equal(updated.account.positions[0].margin, 20);
  quote.vs.account.equity = 12005;
  assert.ok(dashboardAccount(local, null, quote, asset, assets).issues.some((s) => s.includes('不一致')));
  delete quote.vs.account.positions;
  assert.ok(dashboardAccount(local, null, quote, asset, assets).issues.some((s) => s.includes('完整持仓')));
});
test('外部账户的抵押余额和旧占用仅合并一次', () => {
  const market = structuredClone(asset);
  market.hype.account = { equity: 301, cash: 301, free: 281, used: 20, positions: [] };
  const snap = { mode: 'live', hype: { symbol: 'BTC', account: market.hype.account } };
  const { account } = dashboardAccount(local, null, snap, market, assets, 13);
  assert.equal(account.hypeUsed, 33);
  assert.equal(account.hypeFree, 268);
  assert.equal(account.hypeCash, 301);
});

test('跨品种切换与重载后保留持仓行情来源，阻止用模板标记实时仓位', async () => {
  const { resolveHeldMarket } = await import('../src/workspace-state.js');
  const held = structuredClone(asset);
  held.feedMode = 'live';
  held.vs.price = 63000;
  held.vs.symbol = 'BTC';
  const actual = resolveHeldMarket(asset, held);
  assert.equal(actual.vs.price, 63000);
  assert.ok(actual.sourceIssues.length);
  const stale = resolveHeldMarket(held, held, Date.now() + held.maxAgeSec * 1000 + 1000);
  assert.match(stale.sourceIssues.join(' '), /过期/);
});

test('品种与规则备份保留自定义品种并完整验证后才更新', async () => {
  const { strategyBackup, loadStrategyBackup } = await import('../src/workspace-state.js');
  const { DEFAULT_CONFIG } = await import('../src/decision.js');
  const source = { assets: structuredClone(assets), config: { ...DEFAULT_CONFIG, targets: [11000] } };
  source.assets[0].vs.step = 0.00063;
  const dest = { assets: structuredClone(assets), config: {} };
  const raw = JSON.stringify(strategyBackup(source));
  loadStrategyBackup(dest, raw);
  assert.equal(dest.assets[0].vs.step, 0.00063);
  assert.equal(dest.config.payoutTarget, 11000);
  const original = structuredClone(dest),
    broken = JSON.parse(raw);
  broken.assets[1].hype.multiplier = 0;
  assert.throws(() => loadStrategyBackup(dest, JSON.stringify(broken)));
  assert.deepEqual(dest, original);
});
