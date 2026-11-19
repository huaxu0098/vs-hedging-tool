import test from 'node:test';
import assert from 'node:assert/strict';
import { dec, out, fundingInterval } from '../src/hedge/math.js';
import { fundingProof, demoMarket, evaluateCandidate, profileInputs } from '../src/hedge/solver.js';
import { solveAuto } from '../src/hedge/auto.js';
import { createBook } from '../src/hedge/book.js';

const profile = {
  stage: 'challenge',
  E: '10000',
  floor: '9400',
  target: '12000',
  C_hl: '409',
  C_external: '0',
  B: '500',
  R: '100',
  k: '0',
  baseline: '10000'
};
const interval = (changes) => fundingInterval({ ...profile, ...changes });
const close = (a, b) => assert.ok(dec(a).minus(b).abs().lt('1e-35'), String(a) + ' / ' + String(b));
function grid(changes = {}) {
  const book = createBook({ id: 'formula', mode: 'demo', time: '2026-11-19T12:00:00Z' });
  Object.assign(
    book,
    { pf: '1000', hl: '120', B: '160', challengeFloor: '900', challengeTarget: '1100', positions: {} },
    changes.book
  );
  const m = demoMarket('unit');
  for (const side of ['pf', 'hl'])
    Object.assign(
      m[side],
      {
        free: book[side],
        mark: '100',
        step: '1',
        minQty: '1',
        maxQty: side === 'pf' ? '10' : '8',
        leverage: '10',
        rate: '0.0005',
        bids: [
          ['99.9', '2'],
          ['99.8', '28']
        ],
        asks: [
          ['100.1', '2'],
          ['100.2', '28']
        ]
      },
      changes[side]
    );
  m.hl.exchangeMaxLeverage = changes.cap ?? 10;
  m.hl.tiers = [{ from: '0', mmr: '0.05', deduction: '0', maxLeverage: String(m.hl.exchangeMaxLeverage) }];
  const params = { R: '20', g: '0', k: '0', objective: 'size', ...changes.params };
  const checks = { currentSnapshot: true, liveLimits: true, ...changes.checks };
  const res = solveAuto(book, m, params, checks);
  return { ...res, book, m, p: profileInputs(book, params, m), checks };
}

test('FORM01 本金与另需收回成本改变保护下限及候选', () => {
  close(interval({}).lower, dec('91').div(600));
  close(interval({ B: '530' }).lower, dec('121').div(600));
  const a = grid(),
    b = grid({ book: { B: '200' } });
  assert.notEqual(a.funding.lower, b.funding.lower);
  assert.ok(a.selected);
  assert.notDeepEqual(
    a.candidates.map((x) => [x.vsTargetQuantity, x.hlTargetQuantity]),
    b.candidates.map((x) => [x.vsTargetQuantity, x.hlTargetQuantity])
  );
});
test('FORM02 Hype权益改变现金上限和保证金约束', () => {
  assert.equal(interval({ C_hl: '389' }).upper, '0.1445');
  const a = grid(),
    b = grid({ book: { hl: '24' }, hl: { free: '21' } });
  assert.ok(a.selected);
  assert.ok(!b.selected || dec(b.selected.hlNotional).lt(a.selected.hlNotional));
});
test('FORM03 外部资金仅降低保护缺口', () => {
  const x = interval({ C_external: '40' });
  close(x.lower, dec('51').div(600));
  assert.equal(x.upper, '0.1545');
  const a = grid(),
    b = grid({ book: { external: '40' } });
  assert.equal(a.m.hl.free, b.m.hl.free);
  assert.equal(a.book.hl, b.book.hl);
  const bad = grid({ book: { external: '5000' }, hl: { free: '0' }, params: { R: '20' } });
  assert.ok(!bad.selected || bad.selected.hlTargetQuantity === '0');
});
test('FORM04 PF权益和失败线分别重算损失空间', () => {
  assert.equal(interval({ E: '9900' }).loss, '500');
  close(interval({ floor: '9300' }).lower, dec('91').div(700));
  assert.equal(interval({ E: '9400' }).code, 'CHALLENGE_FAILED');
});
test('FORM05 通过线与Funded参考点决定成功空间，分成不进到账前现金', () => {
  assert.equal(interval({ target: '11000' }).upper, '0.309');
  const x = interval({ stage: 'funded', floor: '8000', target: '10100' });
  assert.equal(x.gain, '100');
  assert.equal(x.upper, '3.09');
  assert.equal(interval({ target: '10000' }).code, 'CHALLENGE_PASS_PENDING_SETTLEMENT');
});
test('FORM06 提高成功端留存收紧上限及合法仓位', () => {
  assert.equal(interval({ R: '110' }).upper, '0.1495');
  const x = grid({ params: { R: '113' } });
  assert.equal(x.selected, null);
});
test('FORM07 每个候选按实际盘口和差额重算双端成本，桥接与引擎相符', () => {
  const x = grid();
  assert.ok(x.candidates.length > 1);
  const costs = new Set();
  for (const c of x.candidates) {
    const f = c.funding;
    assert.equal(f.valid, true);
    costs.add(f.failCost);
    close(f.failureCash, c.failureCash);
    close(f.successHypeCash, c.hlBeforePayout);
    close(f.paths.fail.hl.settled, c.failureHypeCash);
    close(f.paths.pass.pf.settled, x.p.target);
    assert.ok(dec(f.h).gte(f.lower) && dec(f.h).lte(f.upper));
  }
  assert.ok(costs.size > 1);
  const c = x.selected;
  const y = grid({
    hl: {
      rate: '0.003',
      bids: [
        ['99', '1'],
        ['98', '29']
      ],
      asks: [
        ['101', '1'],
        ['102', '29']
      ]
    }
  });
  const changed = evaluateCandidate(y.book, y.m, y.p, c.vsTargetQuantity, c.hlTargetQuantity, y.checks);
  const proof = fundingProof(y.p, y.m, changed);
  assert.ok(proof.valid);
  assert.notEqual(proof.failCost, c.funding.failCost);
  assert.ok(dec(proof.paths.fail.hl.exitSlippage).gt(0));
});
test('FORM08 两边乘数、结算币汇率及共同价格转换决定实际h', () => {
  const x = grid({ pf: { multiplier: '2' }, hl: { fx: '0.8', factor: '1.25' } });
  const c = x.selected,
    f = c.funding;
  close(f.Kpf, dec(c.vsTargetQuantity).times(2));
  close(f.Kh, c.hlTargetQuantity);
  assert.notEqual(f.h, out(dec(c.hlNotional).div(c.vsNotional)));
  assert.ok(f.valid);
});
test('FORM09 固定同一对数量，仅调整档位，现金和h保持，初始保证金变化', () => {
  const c = grid().selected,
    rows = c.leverageGrid.filter((x) => x.leverage);
  assert.ok(rows.length > 1);
  assert.notEqual(rows[0].initial, rows.at(-1).initial);
  assert.equal(rows[0].liquidation, rows.at(-1).liquidation);
  const x = grid({ cap: 5 }),
    y = evaluateCandidate(x.book, x.m, x.p, c.vsTargetQuantity, c.hlTargetQuantity, x.checks);
  assert.equal(y.actualRatio, c.actualRatio);
  assert.equal(y.hlBeforePayout, c.hlBeforePayout);
});
test('FORM10 相同市场与数量网格，资金输入变化重新生成计算结果', () => {
  const a = grid().selected,
    b = grid({ book: { hl: '140' } }).selected;
  assert.ok(a && b);
  assert.notEqual(a.funding.C_H, b.funding.C_H);
  assert.notEqual(a.funding.upper, b.funding.upper);
});
test('FORM11 无交集披露两端缺口，负上限保留，到线不除零', () => {
  const x = interval({ R: '150' });
  assert.equal(x.code, 'NO_CASH_INTERSECTION');
  assert.ok(dec(x.successShortfallAtLower).gt(0));
  assert.ok(dec(x.failureShortfallAtUpper).gt(0));
  const negative = interval({ R: '420' });
  assert.ok(dec(negative.upper).lt(0));
  assert.equal(negative.reserveShortfallAtZero, '11');
  assert.equal(grid({ params: { R: '200' } }).selected, null);
});
test('FORM12 仅输入资金规则、合约和行情，联合输出规模、h与最小可行杠杆', () => {
  const x = grid(),
    c = x.selected;
  assert.ok(c.funding.valid);
  assert.ok(dec(c.funding.h).gt(0));
  assert.equal(c.candidateLeverage, c.leverageGrid.find((r) => r.status === 'pass').leverage);
  assert.equal(x.code, 'AUTO_PARTIAL');
  assert.equal(x.searchComplete, true);
});
