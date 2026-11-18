import test from 'node:test';
import assert from 'node:assert/strict';
import { vestMarketSymbol, vestQuoteReader, vestPageURL } from '../src/vest-market.js';

const symbol = 'BTC-PERP',
  now = 200000;
const ticker = (tsMs) => ({
  channel: symbol + '@ticker',
  tsMs,
  data: { symbol, markPrice: '101', capitalStatus: 'TRADING', status: 'TRADING' }
});
const depth = (tsMs) => ({
  channel: symbol + '@depth',
  tsMs,
  data: {
    bids: [
      ['99', '1'],
      ['100', '2']
    ],
    asks: [
      ['102', '1'],
      ['101', '2']
    ]
  }
});

test('Vest 交易地址绑定精确 HTTPS 来源和合约', () => {
  assert.equal(vestMarketSymbol(vestPageURL(symbol) + '?x=1'), symbol);
  for (const url of [
    'https://next.vestmarkets.com.evil.test/trade/BTC-PERP',
    'http://next.vestmarkets.com/trade/BTC-PERP',
    'https://next.vestmarkets.com/market/BTC',
    'https://x@next.vestmarkets.com/trade/BTC',
    'https://next.vestmarkets.com/trade/BTC%2FUSD'
  ])
    assert.throws(() => vestMarketSymbol(url));
});
test('Vest 公共行情只采用同合约的标记和盘口，使用两者中较早的源时间', () => {
  const read = vestQuoteReader(symbol);
  assert.equal(read(ticker(now - 20), now), null);
  assert.equal(read({ ...depth(now), channel: 'ETH-PERP@depth' }, now), null);
  assert.deepEqual(read(depth(now - 10), now), {
    symbol,
    bid: 100,
    ask: 101,
    mark: 101,
    open: true,
    timeSource: 'source',
    asOf: new Date(now - 20).toISOString()
  });
  assert.equal(read(depth(now), now).asOf, new Date(now - 20).toISOString());
  assert.equal(read(depth(now - 50), now), null);
  const m = ticker(now);
  m.data.capitalStatus = 'HALTED';
  assert.equal(read(m, now).open, false);
});
test('Vest 报价缺来源、时间在未来、盘口倒挂或标记串品种时不采信', () => {
  for (const m of [
    { ...ticker(now), tsMs: null },
    depth(now + 5000),
    { ...depth(now), data: { bids: [[102, 1]], asks: [[100, 1]] } },
    { ...ticker(now), data: { symbol: 'ETH-PERP', markPrice: 1 } }
  ])
    assert.throws(() => vestQuoteReader(symbol)(m, now));
});
