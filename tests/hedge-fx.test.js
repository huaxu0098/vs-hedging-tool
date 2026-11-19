import test from 'node:test';
import assert from 'node:assert/strict';
import { scanKeys, refreshDelay } from '../src/hedge/scan-refresh.js';
import { dec, normalizeExposure } from '../src/hedge/math.js';
import { rules, calculateCurrent } from '../src/hedge/current.js';
import { currencyMapping, comparePriceBooks, conversionBook } from '../src/hedge/quote-currencies.js';
import { vestContract, hypeContract } from '../src/hedge/contract-currencies.js';
import { usdQuote, unitContract } from '../fixtures/hedge-currency-contracts.js';
import { recoveryCushion } from '../src/hedge/range-report.js';

const at = '2026-11-19T12:00:00.000Z',
  t = Date.parse(at);
const quotes = {
  USDC: usdQuote('USDC', '0.96', '0.98', at),
  USDT: usdQuote('USDT', '0.99', '1.01', at)
};
function market(pfQuote, hlQuote = 'USDC') {
  const levels = [[['99', '250']], [['101', '250']]];
  return {
    asset: 'BTC',
    spec: {
      symbol: 'BTC-PERP',
      contract: vestContract({
        symbol: 'BTC-PERP',
        base: 'BTC',
        asset: 'crypto',
        quote: pfQuote,
        settleAsset: pfQuote
      }),
      sizeDecimals: 1,
      capitalInitMarginRatio: '0.1',
      maintMarginRatio: '0.025',
      maxQty: '10'
    },
    pf: { symbol: 'BTC-PERP', mark: '100', levels, asOf: at, open: true },
    hl: {
      symbol: 'BTC',
      mark: '101',
      levels: [[['100', '250']], [['102', '250']]],
      asOf: at,
      contract: unitContract('BTC', hlQuote),
      sizeDecimals: 1,
      marginTiers: [{ lowerBound: '0', maxLeverage: 10 }],
      maxLeverage: 10,
      maxQty: '8'
    }
  };
}
const mapping = (m, fx = quotes) => currencyMapping(m, fx, t, 5000);
const run = (m, fx = quotes, overrides = {}) => {
  const fields = { sourceKind: 'plan', qty: '0', orders: [], otherHold: '0', marginMode: 'cross' };
  return calculateCurrent(
    {
      ...rules,
      B: '160',
      investedCapital: '160',
      R_success: '20',
      challengeFloor: '900',
      challengeTarget: '1100',
      ...overrides
    },
    { pf: { ...fields, equity: '1000', free: '1000' }, hl: { ...fields, equity: '120', free: '120' } },
    m,
    fx,
    t,
    { scanRatios: true }
  );
};
test('FX01 同为 BTC-USDC 直接比较；外部美元现货失效不更改 USDC 本币对价', () => {
  const m = market('USDC'),
    a = mapping(m, {});
  assert.equal(a.ok, true);
  assert.deepEqual([a.hypeToVest.mid, a.hypeToVest.bid, a.hypeToVest.ask], ['1', '1', '1']);
  assert.equal(comparePriceBooks(m.pf, m.hl, a).raw, '1');
  assert.ok(a.spots.USDC.error);
  assert.equal(mapping(m).hypeToVest.mid, '1');
});
test('FX02 Vest USD 使用 USD_per_USDC；不依赖 USDT 数据', () => {
  const m = market('USD'),
    a = mapping(m, { USDC: quotes.USDC });
  assert.equal(a.hypeToVest.name, 'USD_per_USDC');
  assert.equal(a.hypeToVest.mid, '0.97');
  const price = comparePriceBooks(m.pf, m.hl, a);
  assert.equal(price.normalized, '97.97');
  assert.equal(price.raw, null);
});
test('FX03 Vest USDT 使用两份美元盘口的有向交叉盘', () => {
  const a = mapping(market('USDT'), { ...quotes, USDT: usdQuote('USDT', '0.91', '0.93', at) });
  assert.equal(a.hypeToVest.name, 'USDT_per_USDC');
  assert.equal(a.hypeToVest.mid, dec('0.97').div('0.92').toString());
  assert.equal(a.hypeToVest.bid, dec('0.96').div('0.93').toString());
  assert.equal(a.hypeToVest.ask, dec('0.98').div('0.91').toString());
});
test('FX04 反向盘口须交换 bid/ask 并取倒数；拒绝方向标签颠倒的供应商输入', () => {
  const q = conversionBook('USD', 'USDC', quotes, t, 5000);
  assert.equal(q.bid, dec('1').div('0.98').toString());
  assert.equal(q.ask, dec('1').div('0.96').toString());
  assert.throws(
    () =>
      conversionBook('USDC', 'USD', { USDC: { ...quotes.USDC, currency: 'USD', quote: 'USDC' } }, t, 5000),
    /FX_UNVERIFIED/
  );
});
test('FX05 缺报价币或结算币阻断完整求解，历史手工系数不能恢复旧仓位', () => {
  for (const field of ['quoteAsset', 'settleAsset'])
    for (const side of ['spec', 'hl']) {
      const m = market('USDC');
      delete m[side].contract[field];
      const r = run(m, quotes, { fx: '1', fxAt: at });
      assert.match(r.dataState, /QUOTE_CURRENCY_UNVERIFIED/);
      assert.equal(r.autoStatus, 'AUTO_DATA_BLOCKED');
      assert.equal(r.ratioScan, undefined);
      assert.equal(r.priceComparison, undefined);
    }
});
test('FX06 稳定币脱锚按真实盘口估值并独立告警；过期任一必要汇率立即撤回计算', () => {
  const m = market('USDT'),
    a = run(m);
  assert.equal(a.currencies.spots.USDC.deviationBps, '-300');
  assert.ok(a.currencies.warnings.some((s) => s.includes('USDC 脱锚')));
  assert.equal(a.currencies.hypeToVest.mid, '0.97');
  const old = { ...quotes, USDC: { ...quotes.USDC, asOf: new Date(t - 5001).toISOString() } };
  const b = run(m, old);
  assert.match(b.dataState, /FX_STALE/);
  assert.equal(b.autoStatus, 'AUTO_DATA_BLOCKED');
  assert.equal(b.priceComparison, undefined);
  assert.equal(b.candidate, undefined);
});
test('FX07 同一时刻仅改变 FX 会重建市场、比例网格、成交费、现金和保证金', () => {
  const m = market('USD');
  const x = run(m, { USDC: usdQuote('USDC', '1', '1', at) }),
    y = run(m, { USDC: usdQuote('USDC', '0.8', '0.8', at) });
  assert.notEqual(y.trace.marketId, x.trace.marketId);
  assert.notEqual(x.priceComparison.diff, y.priceComparison.diff);
  for (const key of ['vsNotional', 'actualRatio', 'requiredInitialMargin'])
    assert.notEqual(x.candidate[key], y.candidate[key], key);
  assert.notDeepEqual(x.candidate.lines, y.candidate.lines);
  assert.notDeepEqual(x.costs, y.costs);
  for (const key of ['fail', 'success', 'buffer'])
    assert.notEqual(x.ratioScan.representative.row[key], y.ratioScan.representative.row[key], key);
  assert.notDeepEqual(x.ratioScan.sets.both, y.ratioScan.sets.both);
});
test('FX08 双边成交价差按 Hype bid × FX bid − Vest ask 及 Hype ask × FX ask − Vest bid', () => {
  const m = market('USD'),
    p = comparePriceBooks(m.pf, m.hl, mapping(m));
  assert.equal(p.sellHypeBuyVest, '-5');
  assert.equal(p.buyHypeSellVest, '0.96');
  assert.notEqual(p.diff, p.sellHypeBuyVest);
});
test('FX09 元数据、不同乘数和 quanto：合约名称、保证金币均不能单独证明报价币', () => {
  const v = vestContract({ asset: 'crypto', symbol: 'BTC-PERP', base: 'BTC', quote: 'USDC' });
  const h = hypeContract({ name: 'BTC' }, '', 0);
  assert.deepEqual(
    [v.baseAsset, v.quoteAsset, v.settleAsset, v.contractMultiplier],
    ['BTC', 'USDC', 'USDC', '1']
  );
  assert.deepEqual(
    [h.baseAsset, h.quoteAsset, h.settleAsset, h.contractMultiplier, h.settlement],
    ['BTC', 'USDT', 'USDC', '1', 'quanto-1:1']
  );
  assert.equal(hypeContract({ name: 'BTC', quoteAsset: 'USDC' }, '', 0).quoteAsset, 'USDC');
  assert.equal(hypeContract({ name: 'BTC', quote: 'USDC' }, '', 0).quoteAsset, 'USDC');
  assert.equal(hypeContract({ name: 'BTC', quoteAsset: null }, '', 0).quoteAsset, null);
  assert.equal(hypeContract({ name: 'BTC' }, 'other', 0).quoteAsset, null);
  const m = market('USDC');
  m.spec.contract = v;
  m.hl.contract = { ...h, contractMultiplier: '2', quantityUnit: 'contract' };
  const x = run(m),
    l = x.ratioScan.ctx.market.hl;
  assert.equal(l.multiplier, '2');
  assert.equal(l.fx, '1');
  assert.equal(l.factor, '1');
  const row = x.ratioScan.representative.row;
  assert.equal(row.hypeValue, dec(row.hl).abs().times('202').toString());
  m.hl.contract.baseAsset = 'WBTC';
  assert.equal(run(m).candidate, undefined);
  m.hl.contract = h;
  m.hl.contract.quantityUnit = 'unidentified';
  assert.equal(run(m).candidate, undefined);
});
test('FX10 截图 62839 − 62870.70 = −31.70；明确 USD_per_USDC=1.000841 时只允许乘法', () => {
  const m = market('USDC');
  m.hl.mark = '62839.00';
  m.pf.mark = '62870.70';
  const rates = { USDC: usdQuote('USDC', '1.000841', '1.000841', at) };
  assert.equal(comparePriceBooks(m.pf, m.hl, mapping(m, rates)).diff, '-31.7');
  m.spec.contract = unitContract('BTC-PERP', 'USD');
  assert.equal(comparePriceBooks(m.pf, m.hl, mapping(m, rates)).diff, '21.147599');
  assert.equal(recoveryCushion('500.0001', '500').thin, true);
});

test('PRODUCT01/04、HL05—HL08：标准 BTC perp 的两端账本、分段现金和清算不随参考 FX 缩放', () => {
  const m = market('USDC');
  m.hl.contract = hypeContract({ name: 'BTC' }, '', 0);
  const x = run(m),
    y = run(m, { ...quotes, USDC: usdQuote('USDC', '0.8', '0.82', at) });
  assert.notEqual(x.priceComparison.diff, y.priceComparison.diff);
  assert.notDeepEqual(x.currencies.spots, y.currencies.spots);
  const candidate = x.ratioScan.representative.row;
  for (const side of ['pf', 'hl']) {
    const leg = x.ratioScan.ctx.market[side];
    assert.equal(normalizeExposure('0.07', leg), '0.07');
    for (const path of ['fail', 'pass']) {
      const posting = candidate.paths[path][side];
      assert.equal(
        posting.entries.move,
        dec(posting.target).times(dec(posting.exitMark).minus(posting.mark)).toString()
      );
    }
  }
  assert.deepEqual(x.ratioScan.buckets, y.ratioScan.buckets);
  assert.deepEqual(x.ratioScan.representative, y.ratioScan.representative);
  m.hl.mark = '104';
  const z = run(m);
  assert.notDeepEqual(z.ratioScan.buckets, x.ratioScan.buckets);
});
test('PRODUCT02/03 按已确认的永续范围拒绝现货或规格冲突', () => {
  const m = market('USDC');
  m.hl.contract = { ...hypeContract({ name: 'BTC' }, '', 0), productType: 'spot' };
  assert.equal(run(m).ratioScan, undefined);
  m.hl.contract = hypeContract({ name: 'BTC', quoteAsset: 'USDC' }, '', 0);
  assert.match(run(m).dataState, /CONTRACT_METADATA_UNVERIFIED/);
});
test('UI12 同内容不同源时间仅更新观测；盘口数量或规则变化触发有界节流', () => {
  const m = market('USDC');
  const key = (n, fx = quotes, r = {}) => scanKeys(r, {}, n, fx, 'plan');
  const next = structuredClone(m);
  next.pf.asOf = next.hl.asOf = '2026-11-19T12:00:02Z';
  const fx = { USDT: { ...quotes.USDT, asOf: next.hl.asOf }, USDC: quotes.USDC };
  assert.deepEqual(key(m), key(next, fx));
  next.hl.levels[1][0][1] = '49';
  assert.notEqual(key(next, fx).key, key(m).key);
  assert.equal(key(next, fx).context, key(m).context);
  assert.notEqual(key(next, fx, { B: '501' }).context, key(m).context);
  assert.equal(refreshDelay(m, next, 100), 1700);
  assert.equal(refreshDelay(m, next, 1800), 0);
  assert.equal(refreshDelay(m, next, 100, '0', '0.00002'), 300);
  next.hl.mark = '120';
  assert.equal(refreshDelay(m, next, 100), 300);
});
