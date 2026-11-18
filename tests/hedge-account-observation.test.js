import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizePages, assessObservation, validateObservation } from '../src/hedge/account-observation.js';

const at = '2026-01-01T08:00:00.000Z';
const primary = {
  at,
  symbol: 'BTC-PERP',
  accountLabel: '主账户',
  rows: ['可用保证金：', ' ', '$0.00', '未找到持仓', '交易额度', '$0.00', '账户价值', '$0.00']
};
const disconnected = { at, symbol: 'BTC', rows: ['Connect', '可用', '0.00 USDC', '投资组合价值', '$0.00'] };
test('账户读数把未连接的钱包与实测零保证金分开', () => {
  const s = validateObservation(summarizePages(primary, disconnected));
  const r = assessObservation(s);
  assert.deepEqual([s.vs.equity, s.vs.free, s.hl.equity, s.hl.free], ['0.00', '0.00', null, null]);
  assert.equal(r.flatAndBlocked, true);
  assert.equal(r.tickets, '$0.00');
  assert.match(r.scenario, /不适用/);
  assert.equal(r.incremental, '$0.00');
  assert.ok(r.missing.length >= 2);
  assert.throws(() => validateObservation({ ...s, hl: { ...s.hl, free: '0' } }));
});
test('已有余额或持仓不能套用主账户零仓结论', () => {
  const s = summarizePages(
    {
      ...primary,
      accountLabel: '',
      rows: ['可用保证金', ' ', '$12.01', '交易额度', '$96.08', '账户价值', '$1,201.99']
    },
    { at, symbol: 'BTC', rows: ['投资组合价值', '$510.00', '可用', '110.25 USDC'] }
  );
  const r = assessObservation(s);
  assert.equal(s.vs.equity, '1201.99');
  assert.equal(s.hl.free, '110.25');
  assert.equal(r.stop, false);
  assert.equal(r.tickets, '待核算');
});
test('冲突或未显示的数值保留未知', () => {
  const s = summarizePages(
    {
      ...primary,
      accountLabel: '',
      rows: ['可用保证金', '$12.00', '可用保证金', '$13.00', '交易额度', '—', '1100', '未找到持仓']
    },
    disconnected
  );
  assert.equal(s.vs.free, null);
  assert.equal(s.vs.capacity, null);
  assert.equal(assessObservation(s).flatAndBlocked, false);
});
