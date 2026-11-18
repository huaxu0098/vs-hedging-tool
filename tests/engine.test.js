import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/engine.js';
import { createTemplates } from '../src/assets.js';

const now = Date.parse('2026-10-05T02:00:00Z');
const order = { vsUsd: 2000, hypeUsd: 2000, vsLong: true };
const product = id => createTemplates(now).find(asset => asset.id === id);
const calc = (asset, overrides = {}, available = 500) => evaluate(asset, { ...order, ...overrides }, available, now);
function near(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${actual} to equal ${expected}`);
}

for (const [id, vsQty, hypeQty, pass, fail, liq, buffer] of [
  ['btc', 0.01999, 0.020, 103044.5, 97040, 109452.18905472638, 6407.689054726376],
  ['xau', 0.0079, 0.8, 2577.4, 2425.5, 2736.2636815920396, 158.86368159203994],
  ['us100', 0.0199, 0.1, 20612.25, 19406, 21890.328358208957, 1278.078358208957]
]) {
  test(id + ' 模板使用整步的实际数量、名义金额与原生单位缓冲', () => {
    const asset = product(id);
    const r = calc(asset);
    assert.deepEqual(r.reasons, []);
    assert.equal(r.ok, true);
    near(r.vs.qty, vsQty);
    near(r.hype.qty, hypeQty);
    near(r.pass, pass);
    near(r.fail, fail);
    near(r.liq, liq);
    near(r.buffer, buffer);
    near(r.bufferPct, buffer / asset.referencePrice * 100);
    assert.ok(r.vs.notional <= order.vsUsd && r.hype.notional <= order.hypeUsd);
    near(r.reserve, r.hype.margin + r.hype.fees);
    assert.ok(r.reserve > r.hype.margin);
  });
}

test('黄金两边报价与名称相似时仍然分别使用每手的美元盈亏', () => {
  const asset = product('xau');
  const r = calc(asset);
  assert.equal(asset.vs.multiplier, 100);
  assert.equal(asset.hype.multiplier, 1);
  near(r.vs.delta, 0.79);
  near(r.hype.delta, -0.8);
  near(r.netDelta, -0.01);
  near(r.matchPct, 98.75);
});

test('黄金按实际最小手数取整后，原本足够的强平缓冲跌破门槛并拒绝候选', () => {
  const asset = product('xau');
  asset.minBuffer = 159.3;
  const r = calc(asset);
  const fine = structuredClone(asset);
  fine.vs.step = 0.0000001;
  const fineResult = calc(fine);
  assert.equal(fineResult.ok, true);
  near(fineResult.buffer, 159.76368159203957);
  const idealDelta = r.vs.idealQty * asset.vs.multiplier;
  const idealExit = (asset.vsProfit / idealDelta + (1 + asset.vs.feeRate) * r.vs.entryPrice) /
    (1 - asset.vs.feeRate);
  const idealPass = asset.referencePrice + Math.ceil(idealExit / asset.vs.tick) * asset.vs.tick - r.vs.exitPrice;
  assert.ok(r.liq - idealPass > asset.minBuffer);
  assert.deepEqual(r.reasons, ['取整后强平缓冲不足']);
  assert.equal(r.ok, false);
  near(r.buffer, 158.86368159203994);
});

test('VS 空与 Hype 多使用下行通过线和下行强平缓冲', () => {
  const asset = product('us100');
  const r = calc(asset, { vsLong: false });
  assert.equal(r.ok, true);
  assert.ok(r.vs.delta < 0 && r.hype.delta > 0);
  assert.ok(r.liq < r.pass && r.pass < asset.referencePrice && r.fail > asset.referencePrice);
  near(r.buffer, r.pass - r.liq);
  near(r.bufferPct, r.buffer / asset.referencePrice * 100);
});

test('VS 按绝对平仓报价档反推通过和严格失败边界，即使中间价不对齐 tick', () => {
  for (const vsLong of [true, false]) {
    const a = product('xau');
    a.vs.price += 0.05; // Half-tick mark, full-tick book prices.
    a.vs.spread = 0.23;
    const r = calc(a, { vsLong });
    const sign = vsLong ? 1 : -1;
    const pnl = ref => {
      const mark = a.vs.price + (ref - a.referencePrice) * a.vs.ratio;
      const rawTicks = (mark - sign * a.vs.spread / 2) / a.vs.tick;
      const ticks = sign > 0 ? Math.floor(rawTicks + 1e-9) : Math.ceil(rawTicks - 1e-9);
      const exit = ticks * a.vs.tick;
      return r.vs.pointValue * (sign * (exit - r.vs.entryPrice) - a.vs.feeRate * (r.vs.entryPrice + exit));
    };
    const epsilon = a.vs.tick / 1000;
    assert.ok(pnl(r.pass) >= a.vsProfit);
    assert.ok(pnl(r.pass - sign * epsilon) < a.vsProfit);
    assert.ok(pnl(r.fail - sign * epsilon) <= -a.vsLoss);
    assert.ok(pnl(r.fail) > -a.vsLoss);
    assert.equal(r.failRelation, vsLong ? '<' : '>');
  }
});

test('Hype 以连续标记价判定逐仓强平，成交 tick 不得推迟触发', () => {
  for (const vsLong of [true, false]) {
    const a = product('btc');
    a.hype.price += a.hype.tick / 2;
    const r = calc(a, { vsLong });
    const sign = vsLong ? -1 : 1;
    const excess = ref => {
      const mark = a.hype.price + (ref - a.referencePrice) * a.hype.ratio;
      return r.hype.margin + sign * r.hype.pointValue * (mark - r.hype.entryPrice) -
        a.hype.mmr * r.hype.pointValue * mark;
    };
    near(excess(r.liq), 0, 1e-10);
    assert.ok(excess(r.liq + sign * a.hype.tick / 1000) > 0);
    assert.ok(excess(r.liq - sign * a.hype.tick / 1000) < 0);
  }
});

test('报价及结算币均不同的线性合约换算到同一原生价格轴', () => {
  const a = product('btc');
  // Express Hype prices in EUR, and the fixed payoff per EUR point in GBP.
  Object.assign(a.hype, { quote: 'EUR', quoteUsd: 1.25, price: 80000, ratio: 0.8, settle: 'GBP',
    settleUsd: 1.5625, multiplier: 0.8, spread: 0, tick: 0.1 });
  const r = calc(a);
  assert.equal(r.ok, true);
  near(r.hype.qty, 0.02);
  near(r.hype.delta, -0.02);
  near(r.hype.notional, 2000);
  near(r.basisPct, 0);
});

test('每克与每金衡盎司的黄金合约按可验证的独立单位标尺匹配', () => {
  const a = product('xau');
  const ouncesPerGram = 1 / 31.1034768;
  Object.assign(a.hype, {
    qtyUnit: '克', price: a.referencePrice * ouncesPerGram,
    quoteScale: ouncesPerGram, ratio: ouncesPerGram, tick: 0.001,
    spread: 0.002, multiplier: 1, step: 0.01, minQty: 0.01
  });
  const r = calc(a);
  assert.deepEqual(r.reasons, []);
  near(r.basisPct, 0);
  near(r.hype.delta, -r.hype.qty / 31.1034768);
  near(r.hype.qty, 24.88);
  assert.ok(r.buffer > a.minBuffer);
  // A small absolute difference is still too large relative to this gram scale.
  a.hype.quoteScale += 0.00005;
  assert.match(calc(a).reasons.join(' '), /无法验证参考价格尺度/);
});

test('买卖点差落在半个 tick 时，向买入更贵、卖出更便宜的方向取价', () => {
  const asset = product('btc');
  Object.assign(asset.vs, { tick: 1, spread: 1 });
  const r = calc(asset);
  assert.equal(r.vs.entryPrice, 100001);
  assert.equal(r.vs.exitPrice, 99999);
});

test('decimal 步长恰好整除时不会损失一个可下单单位', () => {
  const a = product('sol');
  a.referencePrice = a.hype.price = 0.2;
  Object.assign(a.vs, { price: 0.2, ratio: 1, tick: 0.01, spread: 0,
    multiplier: 1, step: 0.1, minQty: 0.1 });
  const r = calc(a, { vsUsd: 0.06 });
  near(r.vs.qty, 0.3);
});

test('拒绝占用超过共享余额的保证金及手续费', () => {
  const r = calc(product('btc'), {}, 200);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /本金不足/);
});

for (const [name, patch, expected] of [
  ['未验证', a => { a.verified = false; }, /尚未验证/],
  ['同名但不同基准', a => { a.hype.symbol = a.vs.symbol; a.hype.benchmark = 'another-index'; }, /跟踪基准/],
  ['未知计价币汇率', a => { a.vs.quoteUsd = undefined; }, /无法换算/],
  ['价格看似对齐但外币乘数错误', a => { a.hype.quote = 'EUR'; a.hype.quoteUsd = 1.25; }, /报价映射与美元汇率不一致/],
  ['VS 逐仓维持早于考核失败线', a => { a.vs.leverage = 40; }, /VS 逐仓维持保证金线先于考核失败/],
  ['冲突的汇率', a => { a.hype.quoteUsd = 2; }, /汇率不一致/],
  ['逆向合约', a => { a.hype.type = 'inverse'; }, /不支持该合约类型/],
  ['未知类型', a => { a.vs.type = 'option'; }, /不支持该合约类型/],
  ['休市', a => { a.hype.open = false; }, /休市/],
  ['报价过期', a => { a.vs.asOf = new Date(now - 901000).toISOString(); }, /报价过期/],
  ['未来报价', a => { a.vs.asOf = new Date(now + 60000).toISOString(); }, /晚于/],
  ['无效映射倍数', a => { a.hype.ratio = 0; }, /映射系数/],
  ['报价偏离', a => { a.hype.price *= 1.1; }, /价格关系无法验证/],
  ['低于最小手数', a => { a.vs.minQty = 1; }, /低于最小下单量/],
  ['敏感度不符', a => { a.minMatchPct = 100; }, /匹配率低于/],
  ['无效维持率', a => { a.hype.mmr = 1 / a.hype.leverage; }, /维持保证金/]
]) {
  test(name + '时阻断匹配', () => {
    const a = product('btc');
    patch(a);
    const r = calc(a);
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(' '), expected);
  });
}
