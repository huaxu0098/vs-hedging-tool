import test from 'node:test';
import assert from 'node:assert/strict';
import { paperMarket, samplePaper, startPaper } from '../src/hedge/paper.js';
import { atPrice } from '../src/hedge/replay.js';
import { dec, out } from '../src/hedge/math.js';

const at = '2026-11-19T09:00:00.000Z', now = Date.parse(at);
const levels = [[['63750', '1']], [['63751', '1']]];
const vs = { symbol: 'BTC-PERP', mark: '63750', asOf: at, open: true, levels };
const hl = { symbol: 'BTC', dex: '', mark: '63750', maxLeverage: 40, sizeDecimals: 5,
  quote: { symbol: 'BTC', occurredAt: at, levels } };
const spec = { symbol: 'BTC-PERP', quote: 'USDC', base: 'BTC', sizeDecimals: 4,
  fundedInitMarginRatio: '0.04', capitalTradingStatus: 'TRADING' };
const market = paperMarket(vs, hl, spec, now);
const seed = startPaper(at);
const held = samplePaper(seed, market, at).session;

test('实盘模拟承接通过后精确余额，按两边深度成交，刷新估值不重复开仓', () => {
  assert.equal(dec(seed.initialCash).toFixed(2), '101.50');
  assert.equal(seed.book.ref, seed.initialCash);
  assert.equal(seed.book.pf, '10000');
  assert.equal(held.entry.legs.length, 2);
  for (const { qty, entry, notional, venue } of held.entry.legs) {
    assert.equal(entry, dec(qty).gt(0) ? '63751' : '63750');
    assert.equal(notional, out(dec(qty).abs().times(entry)));
    assert.ok(dec(qty).mod(market[venue].step).isZero());
  }
  const marked = samplePaper(held, market, at);
  assert.equal(marked.session, held);
  assert.ok(dec(marked.valuation.cash).lt(seed.initialCash));
});

test('任一实盘盘口超时、串合约、休市或深度异常时阻断模拟', () => {
  assert.throws(() => paperMarket(vs, hl, spec, now + 5001), /过期/);
  assert.throws(() => paperMarket({...vs, asOf: null}, hl, spec, now), /过期/);
  assert.throws(() => paperMarket(vs, {...hl, quote: {...hl.quote, symbol: 'ETH'}}, spec, now), /BTC/);
  assert.throws(() => paperMarket({...vs, open: false}, hl, spec, now), /休市/);
  assert.throws(() => paperMarket({...vs, levels: [[], []]}, hl, spec, now), /盘口/);
});

test('出金户分别模拟爆号和毛利润分成到账，结算只发生一次', () => {
  const sign = dec(held.entry.targets.pf).gt(0) ? 1 : -1;
  const pass = samplePaper(held, atPrice(market, String(sign * 1600)), at).session;
  assert.equal(pass.end.type, 'pass');
  assert.ok(dec(pass.end.received).gt(0));
  assert.equal(pass.end.cash, out(dec(pass.book.hl).plus(pass.book.external)));
  assert.equal(samplePaper(pass, market, at).session, pass);
  const fail = samplePaper(held, atPrice(market, String(-sign * 27000)), at).session;
  assert.equal(fail.end.type, 'failure');
  assert.equal(fail.book.status, 'FUNDED_FAILED');
  assert.equal(fail.end.cash, fail.book.hl);
  const uncertain = samplePaper(held, atPrice(market, String(sign * 1600)), at, true).session;
  assert.equal(uncertain.end.type, 'uncertain');
  assert.equal(uncertain.book, held.book);
});

test('独立 Hype 标记先强平时停止，同次观测双触线保留未决结果', () => {
  const sign = dec(held.entry.targets.pf).gt(0) ? 1 : -1;
  const hlAlone = atPrice(market, '0', String(sign * 9000));
  const hit = samplePaper(held, hlAlone, at).session;
  assert.equal(hit.end.type, 'liquidation');
  assert.equal(hit.end.cash, null);
  const conflict = samplePaper(held, atPrice(market, String(sign * 1800), String(sign * 9000)), at).session;
  assert.equal(conflict.end.type, 'uncertain');
  assert.deepEqual(conflict.end.events, ['pass', 'liquidation']);
});
