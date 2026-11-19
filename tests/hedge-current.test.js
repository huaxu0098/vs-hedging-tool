import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, calculateCurrent, remainingOrder } from '../src/hedge/current.js';
import { dec } from '../src/hedge/math.js';
const at = '2026-11-19T12:00:00Z',
  t = Date.parse(at),
  confirmed = { at, equity: '10000', qty: '0.08', anchor: '63000', orders: [] };
const accounts = { pf: confirmed, hl: { ...confirmed, equity: '409', qty: '-0.005' } };
const depth = [[['62999', '2']], [['63001', '2']]];
const q = { mark: '63000', asOf: at, levels: depth };
const market = {
  asset: 'BTC',
  pf: { ...q, symbol: 'BTC-PERP', open: true },
  hl: { ...q, symbol: 'BTC', sizeDecimals: 5, collateralToken: 0 },
  spec: {
    symbol: 'BTC-PERP',
    base: 'BTC',
    quote: 'USDC',
    sizeDecimals: 4,
    capitalInitMarginRatio: '0.04',
    fundedInitMarginRatio: '0.04',
    maintMarginRatio: '0.01'
  }
};
const r = { ...rules, mode: 'keepPF', fx: '1', fxAt: at };
const calc = (profile = r, a = accounts, m = market, time = t) => calculateCurrent(profile, a, m, {}, time);
test('当前权益独立给出区间，仓位留空与显式零有不同语义', () => {
  const x = calc(r, { pf: { at, equity: '10000' }, hl: { at, equity: '409' } }, {});
  assert.ok(dec(x.range.min).times(100).toFixed(3) === '15.167');
  assert.equal(x.qty.pf, null);
  assert.equal(x.candidate, undefined);
  const hold = calc(r, { ...accounts, pf: { ...confirmed, qty: '0' } });
  assert.match(hold.issues.join(' '), /空仓/);
  assert.equal(hold.currentH, undefined);
});
test('固定已有 PF 精确保留数量和方向，挂单不改变已成交 h', () => {
  for (const sign of [1, -1]) {
    const a = structuredClone(accounts);
    a.pf.qty = String(sign * 0.08);
    a.hl.qty = String(-sign * 0.005);
    a.hl.orders = [{ qty: String(-sign * 0.001) }];
    const x = calc(r, a);
    assert.equal(x.currentH, '0.0625');
    assert.equal(x.candidate.vsTargetQuantity, a.pf.qty);
    assert.equal(x.candidate.vsDeltaQuantity, '0');
    assert.equal(x.candidate.code, 'MARGIN_UNVERIFIED');
    assert.equal(
      x.adjust.hl.remaining,
      dec(x.candidate.hlDeltaQuantity).minus(a.hl.orders[0].qty).toString()
    );
  }
});
test('未知 C_ref 保留 Funded 目标与前向现金，补录基准后只额外评估整轮收益', () => {
  const a = { ...accounts, hl: { ...accounts.hl, equity: '101.50' } };
  const p = { ...r, stage: 'funded', R_success: '40' };
  const x = calc(p, a);
  assert.equal(x.range.profitMax, null);
  assert.equal(x.round, null);
  assert.ok(dec(x.forward).gt(0));
  assert.ok(x.candidate);
  const known = calc({ ...p, ref: '100' }, a);
  assert.ok(known.range.profitMax);
  assert.ok(known.round);
  const stressed = calc({ ...p, k: '4' }, a);
  assert.ok(dec(stressed.range.min).gt(x.range.min));
});
test('断线仍保留读数和资金区间，停止输出调整量；手工改仓不产生交易', () => {
  const copy = structuredClone(accounts);
  const x = calc(r, accounts, market, t + 6000);
  assert.equal(x.qty.pf, '0.08');
  assert.ok(x.range);
  assert.equal(x.candidate, undefined);
  assert.deepEqual(copy, accounts);
  assert.equal(remainingOrder('-0.02', '0.05', [{ qty: '-0.02' }]).remaining, '0');
  assert.equal(remainingOrder('-0.02', '0.05', [{ qty: '0.01' }]).remaining, null);
  assert.equal(remainingOrder('-0.02', '0.05', null).remaining, null);
});
test('观测截止及待到账事件不会预支分成、重置权益或清除仓位', () => {
  const a = structuredClone(accounts);
  const x = calc({ ...r, deadline: at, receivable: '80' }, a);
  assert.match(x.notices.join(' '), /已到期/);
  assert.equal(x.candidate, undefined);
  assert.equal(x.cash.hl, '409');
  assert.deepEqual(a, accounts);
});
test('两边同向时 h 为敏感度绝对比，明确标记同向敞口', () => {
  const x = calc(r, { ...accounts, hl: { ...accounts.hl, qty: '0.005' } });
  assert.equal(x.currentH, '0.0625');
  assert.equal(x.sameDirection, true);
});

function verifiedMarket() {
  const m = structuredClone(market);
  m.hl.marginTiers = [{ lowerBound: '0', maxLeverage: '40' }];
  return m;
}
function verifiedAccounts() {
  const a = structuredClone(accounts);
  Object.assign(a.pf, { marginMode: 'cross', otherHold: '0', free: '9700' });
  Object.assign(a.hl, { marginMode: 'cross', otherHold: '0', free: '375', leverage: '10' });
  return a;
}
test('固定已成交 Hype 数量，两种方向均可反解 VS，固定侧调仓费为零', () => {
  for (const dir of [1, -1]) {
    const a = verifiedAccounts();
    a.hl.qty = String(-dir * 0.01225);
    a.pf.qty = String(dir * 0.09);
    const x = calc({ ...r, mode: 'keepHL' }, a, verifiedMarket());
    assert.equal(x.candidate?.code, 'FEASIBLE', x.issues.join(' '));
    assert.equal(x.candidate.hlTargetQuantity, a.hl.qty);
    assert.equal(x.candidate.hlDeltaQuantity, '0');
    assert.equal(x.costs.hl.entry.fee, '0');
    assert.ok(dec(x.candidate.vsDeltaQuantity).abs().gt(0));
    assert.ok(dec(x.verified.min).lte(x.candidate.actualRatio));
    assert.ok(dec(x.verified.max).gte(x.candidate.actualRatio));
  }
});
test('联合搜索默认从两边空仓求解，当前资金、已有仓位和盘口决定比例', () => {
  const a = verifiedAccounts(),
    m = verifiedMarket();
  a.pf.qty = a.hl.qty = '0';
  const x = calc({ ...r, mode: 'joint' }, a, m);
  assert.equal(x.candidate?.code, 'FEASIBLE', x.issues.join(' '));
  assert.ok(dec(x.candidate.vsTargetQuantity).times(x.candidate.hlTargetQuantity).lt(0));
});
test('历史成本口径、盘口冲击、价格缓冲与单独过期的标记价', () => {
  const a = verifiedAccounts(),
    m = verifiedMarket();
  m.hl.levels = [
    [
      ['62999', '0.001'],
      ['62980', '2']
    ],
    [
      ['63001', '0.001'],
      ['63030', '2']
    ]
  ];
  const x = calc(r, a, m);
  assert.equal(x.candidate?.code, 'FEASIBLE', x.issues.join(' '));
  assert.ok(dec(x.costs.hl.entry.impact).gt(0));
  assert.ok(dec(x.candidate.priceBuffer).gt(0));
  assert.equal(x.costs.pf.entry.fee, '0');
  const same = calc({ ...r, registration: '80' }, a, m);
  assert.equal(x.candidate.failureCash, same.candidate.failureCash);
  const cost = calc({ ...r, outsideCosts: '12' }, a, m);
  assert.ok(dec(cost.range.min).gt(x.range.min));
  const no = calc({ ...r, minBuffer: '1000000' }, a, m);
  assert.equal(no.candidate, undefined);
  m.hl.markAt = new Date(t - 10000).toISOString();
  assert.match(calc(r, a, m).issues.join(' '), /Hype 行情缺失或过期/);
});

test('无可调组合仍展示现仓真实数量的条件现金，已知提前强平的终点留空', () => {
  const a = verifiedAccounts();
  a.hl.qty = '-0.01225';
  const m = verifiedMarket();
  const no = calc({ ...r, outsideCosts: '500' }, a, m);
  assert.equal(no.candidate, undefined);
  assert.ok(dec(no.heldCash.failureCash).gt(a.hl.equity));
  a.hl.liquidation = '69000';
  const blocked = calc({ ...r, mode: 'keepHL' }, a, m);
  assert.equal(blocked.candidate, undefined);
  assert.ok(blocked.heldCash.failureCash);
  assert.equal(blocked.heldCash.pressureCashAfter, undefined);
  assert.match(blocked.notices.join(' '), /成功线之前触及强平/);
});

test('跨品种读取共享权益时，金额、来源及时间必须来自同一快照', async () => {
  const { manualAccount } = await import('../src/hedge/current-account.js');
  const st = {
    shared: { hl: { asset: 'ETH', equity: '400', at: '2020-01-01', source: 'ETH账户快照' } },
    assets: {
      BTC: {
        hl: { equity: '409', equityAt: at, qty: '0', qtyAt: at, anchor: '63000', origins: { free: { at } } }
      },
      ETH: { hl: { equity: '400', equityAt: '2020-01-01' } }
    }
  };
  let a = manualAccount(st, 'BTC', 'hl');
  assert.equal(a.equity, '400');
  assert.equal(a.equityAt, '2020-01-01');
  assert.equal(a.source, 'ETH账户快照');
  assert.equal(a.anchor, null);
  assert.equal(calc(r, { pf: accounts.pf, hl: a }).protect, null);
  st.shared.hl.equity = '';
  a = manualAccount(st, 'BTC', 'hl');
  assert.equal(a.equity, '');
});
