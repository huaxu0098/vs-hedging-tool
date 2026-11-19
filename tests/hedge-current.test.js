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
const r = { ...rules, fx: '1', fxAt: at };
const calc = (profile = r, a = accounts, m = market, time = t) => calculateCurrent(profile, a, m, {}, time);
test('当前权益独立给出区间，仓位留空与显式零有不同语义', () => {
  const x = calc(r, { pf: { equity: '10000' }, hl: { equity: '409' } }, {});
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
  const p = { ...r, stage: 'funded', R: '40' };
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
