import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  dec,
  normalizeExposure,
  estimateFill,
  solveBudgetBounds,
  discreteBounds
} from '../src/hedge/math.js';
import {
  createBook,
  applyLedgerEvent as apply,
  balances,
  advanceClock,
  restoreBook
} from '../src/hedge/book.js';
import {
  demoMarket,
  evaluateCandidate,
  projectSettlementEquity,
  solveBoundaryPrices,
  solve,
  profileInputs,
  validateMargin
} from '../src/hedge/solver.js';
import { replayFixture, seekReplay, applyTargets, scenarioNames, atPrice } from '../src/hedge/replay.js';
import {
  accountMode,
  reconcileAnchor,
  normalizeFlows,
  freshness,
  manualVs,
  versionGate,
  collectHype,
  decodeWS,
  poolKey
} from '../src/hedge/adapters.js';
import { workspace, restore, eventCSV } from '../src/hedge/workspace.js';
const at = '2026-01-01T00:00:00.000Z',
  due = '2026-01-03T00:00:00.000Z';
const book = (opts = {}) => createBook({ id: 'a', time: at, ...opts }),
  m = demoMarket(),
  s = book();
const config = { target: '10100', R: '0', g: '0', k: '0', pfSize: '10000', mode: 'fixedPF', directions: [1] };
const pp = profileInputs(s, config, m),
  event = (id, type, payload) => ({ id, type, payload, source: 'demo', occurredAt: at, receivedAt: at });
const end = (kind) => seekReplay(replayFixture(kind), 10);
test('A01 只按 PF 自身平仓费用判定', () => {
  const a = book({ pf: '12005' }),
    market = demoMarket();
  market.pf.rate = '0';
  const opened = applyTargets(a, market, { pf: '10', hl: '0' }, at, 'enter');
  market.pf.rate = '0.0006';
  assert.equal(projectSettlementEquity(opened, market, 'pf', '10').toString(), '11999');
  assert.notEqual(solve(opened, market, config).code, 'CHALLENGE_PASS_PENDING_SETTLEMENT');
  market.hl.rate = '0.9';
  assert.equal(projectSettlementEquity(opened, market, 'pf', '10').toString(), '11999');
});
test('A02 足额与不足额的真实失败缺口', () => {
  for (const [q, pass] of [
    ['-2', true],
    ['-0.5', false]
  ]) {
    const r = evaluateCandidate(s, m, pp, '10', q);
    const c = r.constraints.find((x) => x.code === 'FAILURE_RECOVERY');
    assert.equal(c.status === 'pass', pass);
    assert.equal(c.required, '500');
    assert.equal(dec(c.shortfall).gt(0), !pass);
  }
});
test('A03 强平先行时淘汰并中断原策略', () => {
  const r = evaluateCandidate(s, m, pp, '10', '-3');
  assert.equal(r.code, 'REJECTED');
  assert.ok(r.constraints.some((c) => c.code === 'hl_MAINTENANCE_PATH' && c.status === 'fail'));
  const t = end('liquidation');
  assert.equal(t.event, 'HYPE_LIQUIDATION');
  assert.equal(t.cash, null);
  assert.equal(Object.keys(t.state.positions).length, 2);
});
test('A04 通过结算仅重置 PF', () => {
  const f = replayFixture('pass'),
    r = seekReplay(f, 1);
  assert.equal(r.state.pf, '10000');
  assert.equal(r.state.status, 'FUNDED_ACTIVE');
  assert.equal(r.state.ref, r.state.hl);
  assert.ok(dec(r.state.hl).lt(f.initial.hl));
  assert.ok(r.state.events.length > f.initial.events.length);
  assert.equal(r.state.fees.registration, '91');
});
test('A05 全额分配、恢复收益不可分', () => {
  const r = apply(book({ stage: 'funded', pf: '10100' }), event('c', 'distribution', { payoutId: 'p' }));
  assert.equal(r.pf, '10000');
  assert.equal(r.payouts.p.user, '80');
  assert.equal(r.payouts.p.platform, '20');
  assert.throws(() =>
    apply(book({ stage: 'funded', pf: '9800' }), event('c', 'distribution', { payoutId: 'p' }))
  );
});
test('A06 固定 PF 改 Hype 不移动触线价', () => {
  const a = evaluateCandidate(s, m, pp, '10', '-1'),
    b = evaluateCandidate(s, m, pp, '10', '-2');
  assert.deepEqual(a.lines, b.lines);
  assert.notEqual(a.failureCash, b.failureCash);
});
test('A07 重启与切品种冻结期限，到期禁止新仓', () => {
  const r = restoreBook(JSON.stringify(s));
  for (const id of ['btc', 'xau'])
    assert.equal(solve(r, demoMarket(id), config, { now: due }).code, 'EXIT_REQUIRED');
  assert.equal(r.challengeDeadlineAt, due);
  assert.throws(() => applyTargets(r, m, { pf: '1', hl: '0' }, due, 'late'), /EXIT_REQUIRED/);
});
test('A08 到期无报价不出最终现金，恢复后仅退出', () => {
  const f = replayFixture('timeout'),
    a = advanceClock(f.initial, due, {}, 'replay');
  assert.equal(a.exitStatus, 'pending_quote');
  assert.equal(a.exitCash, undefined);
  const b = advanceClock(a, due, { unit: { bid: '1000', ask: '1000', asOf: due } }, 'replay');
  assert.equal(b.exitCash, '407');
  assert.deepEqual(advanceClock(b, due, {}, 'replay'), b);
});
test('A09 原仓加减、平仓及反手按差额计费', () => {
  let r = applyTargets(book({ B: '1000', purchaseFee: '0' }), m, { pf: '10', hl: '-2' }, at, '1');
  r = applyTargets(r, atPrice(m, '100'), { pf: '10', hl: '-1' }, at, '2');
  assert.equal(r.events.at(-1).payload.fee, '0.55');
  r = applyTargets(r, m, { pf: '10', hl: '1' }, at, '3');
  assert.equal(r.events.at(-1).payload.qty, '2');
  assert.equal(r.events.at(-1).payload.fee, '1');
});
test('A10 实际 bid/ask 与已含附加费不重复扣，保证金可释放', () => {
  const l = { asks: [['1001', '4']], bids: [['999', '4']] };
  assert.equal(estimateFill('2', l).price, '1001');
  assert.equal(estimateFill('-2', l).price, '999');
  const [f] = normalizeFlows(
    [
      {
        tid: 1,
        coin: 'X',
        time: 1,
        fee: '1.5',
        builderFee: '0.4',
        feeToken: 'USDC',
        closedPnl: '5',
        side: 'B',
        sz: '1'
      }
    ],
    'fill',
    { user: 'x', dex: '' }
  );
  assert.equal(f.amount, '3.5');
  const o = applyTargets(s, m, { pf: '1', hl: '-1' }, at, 'fill');
  assert.equal(o.hl, '408.5');
});
test('A11 缺保证金参数标记未验证', () => {
  const a = demoMarket();
  a.hl.tiers = null;
  const r = solve(s, a, config);
  assert.equal(r.code, 'MARGIN_UNVERIFIED');
  assert.equal(r.selected, null);
});
test('A12 同池跨品种共享保证金，不混用 DEX 资金', () => {
  const gold = demoMarket('xau'),
    held = applyTargets(s, gold, { pf: '0', hl: '-1' }, at, 'hold');
  const a = validateMargin(s, m, 'hl', '-1', ['0']);
  const b = validateMargin(held, m, 'hl', '-1', ['0'], { unit: m, xau: gold });
  assert.ok(dec(b[0].required).gt(a[0].required));
  assert.notEqual(poolKey('a', '', 'USDC'), poolKey('a', 'xyz', 'USDC'));
  assert.notEqual(poolKey('a', '', 'USDC'), poolKey('a', '', 'USDT'));
});
test('A13 币、盎司及指数的模拟合约乘数', () => {
  for (const [id, factor] of [
    ['btc', '1'],
    ['xau', '100'],
    ['us100', '5']
  ]) {
    const m = demoMarket(id);
    assert.equal(normalizeExposure('1', m.pf), factor);
    assert.equal(normalizeExposure('-1', m.hl), '-1');
  }
  assert.throws(() => normalizeExposure('1', { ...m.pf, type: 'inverse' }), /UNSUPPORTED/);
});
test('A14 连续区间与合法数量网格分别验证', () => {
  const r = discreteBounds({ selected: {}, min: '0.151666666666667', max: '0.1545' }, '1', '1', '0.01');
  assert.equal(r.code, 'NO_DISCRETE_MATCH');
  assert.deepEqual(r.neighbors, ['0.15', '0.16']);
  const fine = discreteBounds({ selected: {}, min: '0.151666666666667', max: '0.1545' }, '1', '1', '0.001');
  assert.equal(fine.first, '0.152');
  const coarse = demoMarket();
  for (const l of [coarse.pf, coarse.hl]) {
    l.mark = '10000';
    l.bids = [['10000', '50']];
    l.asks = [['10000', '50']];
    l.step = l.minQty = '0.01';
    l.rate = '0';
  }
  assert.equal(solve(s, coarse, { ...config, R: '100' }).code, 'NO_DISCRETE_MATCH');
});
test('A15 同柱歧义分支与最坏现金，原账本不变', () => {
  const f = replayFixture('ambiguous'),
    r = seekReplay(f, 1);
  assert.equal(r.event, 'AMBIGUOUS_EVENT_ORDER');
  assert.equal(r.state, f.initial);
  assert.equal(r.alternatives.length, 2);
  assert.equal(Number(r.worst), Math.min(...r.alternatives.map((a) => Number(a.cash))));
});
test('A16 粘贴千位分隔、负数、歧义、确认前隔离', () => {
  const raw = 'Balance: 10,000.25 USD\nEquity: 9,980 USD\nPositions: none\nBid: 999\nAsk: 1001';
  const vs = manualVs(raw, 'USD', at);
  assert.equal(vs.fields.balance, '10000.25');
  assert.equal(vs.evidence, raw);
  assert.equal(vs.occurredAt, null);
  assert.throws(() => manualVs('Equity: 10,000 DOGE', 'USD', at));
  assert.equal(vs.verification, 'unconfirmed');
  assert.throws(() => manualVs('Balance: 1,02 EUR', 'USD', at));
  const p = manualVs('Balance: 10,000 USD\nBTC-PERP short 2 1000 -45', 'USD', at);
  assert.equal(p.positions[0].upnl, -45);
  assert.equal(s.pf, '10000');
});
test('A17 各自报价与账户新鲜度、断线', () => {
  const t = Date.parse(at),
    good = { occurredAt: at },
    old = { occurredAt: new Date(t - 60000).toISOString() };
  assert.deepEqual(freshness({ vs: old, hl: good, account: old, now: t, connected: false }), [
    'API_DISCONNECTED',
    'VS_QUOTE_STALE',
    'ACCOUNT_STALE'
  ]);
});
test('A18 重复费用与资金费流水可重建且只记一次', () => {
  const anchor = { pool: 'p', currency: 'USDC', stream: 'ledger', balance: '100', cursor: 5 };
  const f = { id: 'f', amount: '-1', pool: 'p', currency: 'USDC', stream: 'ledger', cursor: 6 },
    g = { ...f, id: 'g', amount: '2', cursor: 7 };
  const r = reconcileAnchor(anchor, [g, f, g, f]);
  assert.equal(r.balance, '101');
  assert.equal(r.auditIds.length, 2);
});
test('A19 只读端点加白名单，纯试算不产生模拟成交', async () => {
  const before = JSON.stringify(s);
  solve(s, m, config);
  assert.equal(JSON.stringify(s), before);
  const { infoTypes } = await import('../src/hedge/adapters.js');
  for (const k of ['order', 'exchange', 'sign', 'cancel', 'withdraw', 'transfer'])
    assert.ok(!infoTypes.has(k));
});
test('A20 无网络的全部内置路径可重放与回退', () => {
  for (const k of Object.keys(scenarioNames)) {
    const f = replayFixture(k),
      r = seekReplay(f, 10);
    assert.ok(r.event);
    assert.deepEqual(seekReplay(f, 0).state, f.initial);
  }
});
test('A21 Unified/Portfolio 不使用 Standard 假设', () => {
  for (const x of ['portfolioMargin', 'unifiedAccount', 'dexAbstraction', 'unknown', 'default'])
    assert.equal(accountMode(x), 'UNSUPPORTED_MARGIN_MODE');
  assert.equal(accountMode('disabled'), 'standard');
});
test('A22 冻结基准事件跨标记、快照、重载和重算', () => {
  const o = applyTargets(s, m, { pf: '1', hl: '-1' }, at, 'enter');
  let u = apply(o, event('mark', 'mark', { prices: { unit: '1100' } }));
  u = apply(u, event('override', 'snapshot_edit', { hl: '470' }));
  solve(restoreBook(JSON.stringify(u)), m, config);
  assert.equal(u.refEvent, s.refEvent);
  assert.equal(u.ref, '409');
});
test('A23 异步陈旧请求版本无效', () => {
  const g = versionGate(),
    first = g.next(),
    second = g.next();
  assert.equal(g.current(first), false);
  assert.equal(g.current(second), true);
});
test('A24 JSON 与 CSV 保留十进制原值和截止、事件、应收', () => {
  const w = workspace(at);
  w.branches.demo = apply(
    book({ stage: 'funded', pf: '10100.000000000000000001' }),
    event('dis', 'distribution', { payoutId: 'p' })
  );
  assert.deepEqual(restore(JSON.stringify(w)), w);
  assert.ok(eventCSV(w.branches.demo).includes('10100.000000000000000001'));
});
test('A25 Mock 接口与独立 Live 探测分开', async () => {
  const req = async (r) =>
    r.type === 'metaAndAssetCtxs'
      ? [
          { universe: [{ name: 'X', szDecimals: 2, maxLeverage: 10 }] },
          [{ markPx: '11', oraclePx: '10.9', funding: '0' }]
        ]
      : { coin: 'X', time: Date.parse(at), levels: [[{ px: '10', sz: '1' }], [{ px: '12', sz: '1' }]] };
  const r = await collectHype({ symbol: 'X', request: req });
  assert.equal(r.mark, '11');
  assert.ok(r.unresolved.includes('CANDIDATE_MARGIN'));
  assert.equal(r.account, undefined);
  const ws = {
    user: 'x',
    dex: '',
    clearinghouseState: {
      time: Date.parse(at),
      assetPositions: [],
      marginSummary: { accountValue: '100', totalMarginUsed: '0' },
      withdrawable: '90'
    }
  };
  assert.equal(decodeWS({ channel: 'clearinghouseState', data: ws }, { user: 'x', dex: '' }).equity, '100');
  assert.throws(() =>
    decodeWS({ channel: 'clearinghouseState', data: ws.clearinghouseState }, { user: 'x', dex: '' })
  );
});
test('A26 实时触线只观察，截止不代替成交', () => {
  const l = book({ mode: 'live_readonly' });
  const timeout = advanceClock(l, due, {}, 'live_readonly');
  assert.equal(timeout.exitStatus, 'required');
  assert.equal(timeout.exitCash, undefined);
  assert.equal(timeout.hl, l.hl);
  assert.equal(timeout.pf, l.pf);
  for (const [stage, pf] of [
    ['challenge', '12000'],
    ['funded', '10100']
  ]) {
    const observed = book({ stage, pf, mode: 'live_readonly' });
    const before = JSON.stringify(observed);
    solve(observed, m, config);
    assert.equal(JSON.stringify(observed), before);
    assert.deepEqual(observed.payouts, {});
  }
  assert.throws(() => apply(l, event('fake', 'challenge_reset', {})), /SOURCE_NOT_CONFIRMED/);
});
test('A27 含 fill 的余额锚点不重扣；覆盖未知需对账', () => {
  const a = { balance: '499', coveredIds: ['filled'], currency: 'USDC', pool: 'p', ref: '500' };
  const e = { id: 'filled', amount: '-1', currency: 'USDC', pool: 'p' };
  const r = reconcileAnchor(a, [e, e, { ...e, id: 'unknown' }]);
  assert.equal(r.balance, '499');
  assert.equal(r.ref, '500');
  assert.deepEqual(r.unresolved, ['unknown']);
});
test('A28 外部、在途、Hype 三处守恒，应收不作抵押', () => {
  let b = apply(
    book({ stage: 'funded', pf: '10100', hl: '85.95' }),
    event('d', 'distribution', { payoutId: 'p' })
  );
  b = apply(b, event('r', 'receipt', { payoutId: 'p', destination: 'external' }));
  b = apply(
    b,
    event('out', 'transfer_out', { transferId: 't', payoutId: 'p', from: 'external', to: 'hl', amount: '80' })
  );
  assert.equal(balances(b).total, '165.95');
  assert.equal(balances(b).protect, '85.95');
  assert.equal(balances(b).inTransit, '80');
  b = apply(b, event('in', 'transfer_in', { transferId: 't' }));
  assert.equal(b.hl, '165.95');
  assert.equal(balances(b).total, '165.95');
});
test('A29 单参考点与显式有限集合各自携带毛分成', () => {
  const a = book({ stage: 'funded', hl: '500' });
  const r = solve(a, m, { ...config, targets: ['10100', '10200'] });
  assert.deepEqual(r.targets, ['10100', '10200']);
  assert.ok(r.candidates.some((x) => x.targetEquity === '10200'));
  for (const x of r.candidates)
    assert.ok(Math.abs(Number(x.expectedUserPayout) - (Number(x.targetEquity) - 10000) * 0.8) < 1e-6);
  assert.deepEqual(solve(a, m, config).targets, ['10100']);
});
