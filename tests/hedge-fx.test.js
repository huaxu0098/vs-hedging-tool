import test from 'node:test';
import assert from 'node:assert/strict';
import { scanKeys, refreshDelay } from '../src/hedge/scan-refresh.js';
import { dec, normalizeExposure } from '../src/hedge/math.js';
import { rules, calculateCurrent } from '../src/hedge/current.js';
import { currencyMapping, conversionBook } from '../src/hedge/quote-currencies.js';
import { vestContract, hypeContract } from '../src/hedge/contract-currencies.js';
import { usdQuote, unitContract } from '../fixtures/hedge-currency-contracts.js';
import { inspectRatio } from '../src/hedge/ratio-scan.js';
import { executionDetail } from '../src/hedge/solver.js';
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
      ...rules,challengeStart:at,twoDayUpPct:'10000',twoDayDownPct:'100',
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
  assert.equal(run(m, {}).priceComparison, undefined);
  assert.ok(a.spots.USDC.error);
  assert.equal(mapping(m).hypeToVest.mid, '1');
});
test('FX02 Vest USD 使用 USD_per_USDC；不依赖 USDT 数据', () => {
  const m = market('USD'),
    a = mapping(m, { USDC: quotes.USDC });
  assert.equal(a.hypeToVest.name, 'USD_per_USDC');
  assert.equal(a.hypeToVest.mid, '0.97');

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
  assert.notEqual(x.currencies.hypeToVest.mid, y.currencies.hypeToVest.mid);
  for (const key of ['vsNotional', 'actualRatio', 'requiredInitialMargin'])
    assert.notEqual(x.candidate[key], y.candidate[key], key);
  assert.notDeepEqual(x.candidate.lines, y.candidate.lines);
  assert.notDeepEqual(x.costs, y.costs);
  for (const key of ['fail', 'success', 'buffer'])
    assert.notEqual(x.ratioScan.representative.row[key], y.ratioScan.representative.row[key], key);
  assert.notDeepEqual(x.ratioScan.sets.both, y.ratioScan.sets.both);
});
test('BOOK01 两种对冲方向按数量吃盘口，终点保留原生深度和各自费用基数', () => {
  const m = market('USDC');
  m.hl.contract = hypeContract({ name: 'BTC' }, '', 0);
  m.pf.levels = [[['99', '0.4'], ['97', '12']], [['102', '0.4'], ['104', '12']]];
  m.hl.levels = [[['100', '0.2'], ['98', '12']], [['105', '0.2'], ['107', '12']]];
  const scan = run(m, {}).ratioScan;
  for (const sign of [1, -1]) {
    const row = inspectRatio(scan.ctx, { sign, i: 20, j: 10 });
    for (const venue of ['pf','hl']) {
      const buy = venue === 'pf' ? sign === 1 : sign === -1;
      const [bidVWAP, askVWAP, qty] = venue === 'pf' ? ['97.4','103.6','2'] : ['98.4','106.6','1'];
      for (const path of ['fail','pass']) {
        const l = row.paths[path][venue];
        const shift = dec(l.exitMark).minus(l.mark);
        assert.equal(l.entryPrice, buy ? askVWAP : bidVWAP);
        assert.equal(l.exitPrice, shift.plus(buy ? bidVWAP : askVWAP).toString());
        assert.ok(dec(l.entrySlippage).gt(0) && dec(l.exitSlippage).gt(0));
        for (const side of ['entry','exit']) assert.equal(l[side+'Fee'], dec(l[side+'Price']).times(qty).times(l.rate).toString());
        const net = dec(l.exitPrice).minus(l.entryPrice).times(l.target).plus(l.start).minus(l.entryFee).minus(l.exitFee).minus(l.friction);
        assert.ok(net.minus(l.settled).abs().lt('1e-18'));
      }
    }
  }
  assert.throws(() => executionDetail(scan.ctx.market.hl, '13'), /INSUFFICIENT_DEPTH/);
});
test('BOOK02 同 Mark 与 BBO 下减少顶档数量，逐仓重算而保留线性资金理论界限', () => {
  const m = market('USDC');
  m.hl.contract = hypeContract({ name: 'BTC' }, '', 0);
  m.hl.levels[1].push(['113', '12']);
  const full = run(m);
  m.hl.levels[1][0][1] = '0.1';
  const thin = run(m);
  assert.deepEqual([full.funding.lower, full.funding.upper], [thin.funding.lower, thin.funding.upper]);
  const target = { sign: -1, i: 20, j: 10 };
  const before = inspectRatio(full.ratioScan.ctx, target), after = inspectRatio(thin.ratioScan.ctx, target);
  assert.equal(before.h, after.h);
  assert.equal(before.paths.fail.hl.entryPrice, '102');
  assert.equal(after.paths.fail.hl.entryPrice, '111.9');
  assert.ok(dec(after.fail).lt(before.fail) && dec(after.success).lt(before.success));
  assert.notEqual(after.paths.fail.hl.entryFee, before.paths.fail.hl.entryFee);
  assert.notDeepEqual(full.ratioScan.sets.both, thin.ratioScan.sets.both);
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
test('FX10 同币种与跨币种均保留原生盘口；过期参考 FX 不影响 quanto 网格和结算', () => {
  const m = market('USDC');
  m.hl.contract = hypeContract({ name: 'BTC' }, '', 0);
  const x = run(m), old = { ...quotes, USDT: { ...quotes.USDT, asOf: '2001-01-01T00:00:00Z' } };
  for (const fx of [{}, old]) {
    const y = run(m, fx);
    assert.equal(y.priceComparison, undefined);
    assert.equal(y.currencies.hypeToVest, undefined);
    assert.match(y.currencies.referenceError, /FX_STALE|FX_UNVERIFIED/);
    assert.deepEqual(y.ratioScan.representative, x.ratioScan.representative);
    assert.deepEqual(y.ratioScan.sets, x.ratioScan.sets);
    assert.deepEqual(scanKeys({}, {}, m, fx, 'plan'), scanKeys({}, {}, m, quotes, 'plan'));
  }
  assert.equal(recoveryCushion('500.0001', '500').thin, true);
});

test('PRODUCT01/04、HL05—HL08：标准 BTC perp 的两端账本、分段现金和清算不随参考 FX 缩放', () => {
  const m = market('USDC');
  m.hl.contract = hypeContract({ name: 'BTC' }, '', 0);
  const x = run(m),
    y = run(m, { ...quotes, USDC: usdQuote('USDC', '0.8', '0.82', at) });
  assert.notEqual(x.currencies.hypeToVest.mid, y.currencies.hypeToVest.mid);
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
test('UI12 同价格不同盘口源时间废弃旧结果；盘口数量或规则变化触发有界节流', () => {
  const m = market('USDC');
  const key = (n, fx = quotes, r = {}) => scanKeys(r, {}, n, fx, 'plan');
  const next = structuredClone(m);
  next.pf.asOf = next.hl.asOf = '2026-11-19T12:00:02Z';
  const fx = { USDT: { ...quotes.USDT, asOf: next.hl.asOf }, USDC: quotes.USDC };
  assert.notEqual(key(m).key, key(next, fx).key);
  assert.equal(key(m).context, key(next, fx).context);
  next.hl.levels[1][0][1] = '49';
  assert.notEqual(key(next, fx).key, key(m).key);
  assert.equal(key(next, fx).context, key(m).context);
  assert.notEqual(key(next, fx, { B: '501' }).context, key(m).context);
  assert.equal(refreshDelay(m, m, 100), 900);
  assert.equal(refreshDelay(m, next, 100), 0);
  assert.equal(refreshDelay(m, next, 1800), 0);
  next.hl.levels[1][0][0] = '103';
  assert.equal(refreshDelay(m, next, 100), 0);
  next.hl.mark = '120';
  assert.equal(refreshDelay(m, next, 100), 0);
});

test('同一源时刻的双边 Bid、Ask、Mark、深度及适用 FX 各自改变重算键',()=>{
  const original=market('USDT');
  const key=(m=original,r={},fx=quotes,a={})=>scanKeys(r,a,m,fx,'BTC').key;
  for(const side of ['pf','hl']) {
    for(const update of [
      q=>q.levels[0][0][0]='98.8',q=>q.levels[1][0][0]='103.2',
      q=>q.mark='99.8',q=>q.levels[1][0][1]='249',q=>q.levels[0].push(['98','8'])
    ]) {
      const m=structuredClone(original);
      update(m[side]);assert.notEqual(key(m),key());
    }
  }
  for (const patch of [{pfFee:'0.003'},{hlFee:'0.007'},{R_free:'7'}])
    assert.notEqual(key(original,patch),key());
  assert.notEqual(key(original,{},quotes,{hl:{leverage:'3'}}),key());
  assert.notEqual(key(original,{},{...quotes,USDT:{...quotes.USDT,bid:'0.98'}}),key());
});
