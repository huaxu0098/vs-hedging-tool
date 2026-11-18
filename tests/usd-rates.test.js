import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsdRatesReader } from '../scripts/usd-rates.js';

const t = Date.UTC(2026, 10, 18, 18, 39, 5);
const levels = { bids: [['0.9970', '432']], asks: [['0.9974', '89']] };
const stamp = (at, payload = {}) =>
  Response.json({ ...levels, microtimestamp: String(at * 1000 + 321), ...payload });
const coinbase = (at, payload = {}) =>
  Response.json({ ...levels, time: new Date(at).toISOString(), auction_mode: false, ...payload });
const kraken = (bidAt, askAt, pair = 'USDC/USD') =>
  Response.json({
    error: [],
    result: { [pair]: { bids: [['0.9970', '432', bidAt / 1000]], asks: [['0.9974', '89', askAt / 1000]] } }
  });

test('USDC、USDT 的真美元盘口分别取双边中价；并发及短缓存沿用微秒源时刻', async () => {
  let now = t,
    calls = 0;
  const read = createUsdRatesReader({
    now: () => now,
    fetchImpl: async (url, options) => {
      calls++;
      assert.match(url, /^https:\/\/www\.bitstamp\.net\/api\/v2\/order_book\/usd[ct]usd\/$/);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      return stamp(t - (url.includes('usdc') ? 230 : 650));
    }
  });
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(calls, 2);
  assert.deepEqual(a, b);
  assert.deepEqual(a.errors, {});
  assert.equal(a.rates.USDC.currency, 'USDC');
  assert.equal(a.rates.USDT.quote, 'USD');
  assert.equal(a.rates.USDC.source, 'Bitstamp');
  assert.deepEqual([a.rates.USDC.bid, a.rates.USDC.ask], [0.997, 0.9974]);
  assert.ok(Math.abs(a.rates.USDC.rate - 0.9972) < 1e-12);
  assert.equal(Date.parse(a.rates.USDC.asOf), t - 230);
  assert.equal(Date.parse(a.rates.USDT.asOf), t - 650);
  now += 450;
  assert.deepEqual(await read(), a);
  assert.equal(calls, 2);
});

test('主站超时或超龄时逐币选择对应 USD 现货备源；Kraken 取两侧较早时刻', async () => {
  const read = createUsdRatesReader({
    now: () => t,
    fetchImpl: async (url) => {
      if (url.includes('bitstamp.net') && url.includes('usdc'))
        throw new DOMException('timeout', 'TimeoutError');
      if (url.includes('bitstamp.net')) return stamp(t - 15000);
      if (url.includes('kraken.com')) return kraken(t - 3000, t - 1000);
      if (url.includes('coinbase.com')) return coinbase(t - 200);
      assert.fail('请求了非白名单来源');
    }
  });
  const { rates, errors } = await read();
  assert.deepEqual(errors, {});
  assert.equal(rates.USDC.source, 'Kraken');
  assert.equal(Date.parse(rates.USDC.asOf), t - 3000);
  assert.equal(rates.USDT.source, 'Coinbase Exchange');
  assert.equal(Date.parse(rates.USDT.asOf), t - 200);
});

test('上游回退时间、异常盘口、错误货币对只阻断该币，不把上次成功缓存当新报价', async () => {
  let now = t;
  const read = createUsdRatesReader({
    now: () => now,
    fetchImpl: async (url) => {
      if (now === t) return stamp(t - 100);
      if (url.includes('bitstamp.net') && url.includes('usdc')) return stamp(t - 1200);
      if (url.includes('kraken.com')) return kraken(t, t, 'USDC/EUR');
      if (url.includes('bitstamp.net')) return stamp(now - 50, { asks: [['0.1', '42']] });
      return coinbase(now - 40);
    }
  });
  assert.ok((await read()).rates.USDC);
  now += 1000;
  const { rates, errors } = await read();
  assert.equal(rates.USDC, undefined);
  assert.match(errors.USDC, /早于上一份汇率/);
  assert.equal(rates.USDT.source, 'Coinbase Exchange');
  assert.equal(errors.USDT, undefined);
});

test('缺源时刻、未来时刻、无量及集合竞价不可用；仍保留真实的旧盘口时间供用户阈值判定', async () => {
  const read = createUsdRatesReader({
    now: () => t,
    fetchImpl: async (url) => {
      if (url.includes('bitstamp.net') && url.includes('usdc')) return stamp(t - 9000);
      if (url.includes('kraken.com')) return kraken(t - 11000, t - 6000);
      if (url.includes('bitstamp.net'))
        return stamp(t + 2000, { microtimestamp: null, bids: [['0.99', '0']] });
      return coinbase(t + 1500, { auction_mode: true });
    }
  });
  const result = await read();
  assert.deepEqual(Object.keys(result.rates), ['USDC']);
  assert.equal(Date.parse(result.rates.USDC.asOf), t - 9000);
  assert.match(result.errors.USDT, /交易所微秒时间无效/);
  assert.match(result.errors.USDT, /集合竞价/);
  const bad = await createUsdRatesReader({
    now: () => t,
    fetchImpl: async (url) =>
      url.includes('bitstamp.net')
        ? stamp(t - 1, { asks: [['1', '0']] })
        : url.includes('kraken.com')
          ? kraken(t + 1000, t - 1000)
          : coinbase(t + 1)
  })();
  assert.deepEqual(bad.rates, {});
  assert.match(bad.errors.USDC, /未来/);
  assert.match(bad.errors.USDT, /未来/);
});
