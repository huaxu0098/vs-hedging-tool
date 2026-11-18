import test from 'node:test';
import assert from 'node:assert/strict';
import { liveOrder } from '../src/trade-order.js';
import { lastLiquidation } from '../src/trade-history.js';

function example() {
  const legs = ['vs', 'hype'];
  const asset = { id: 'btc' },
    candidate = { ok: true, limits: {} };
  for (const venue of legs) {
    const vs = venue === 'vs';
    asset[venue] = {
      symbol: vs ? 'BTC-PERP' : 'BTC',
      qtyUnit: 'BTC',
      step: 0.00001,
      multiplier: 1,
      quoteScale: 1,
      type: 'linear',
      quote: vs ? 'USDC' : 'USDT',
      settle: 'USDC',
      marginMode: 'cross',
      leverage: 5
    };
    candidate[venue] = { tradeNotional: 630, tradeQty: vs ? 0.01 : -0.01, targetQty: vs ? 0.11 : -0.01 };
    candidate.limits[venue] = { currentQty: vs ? 0.1 : 0 };
  }
  return {
    display: { asset, config: {}, candidate, expires: Date.now() + 5000 },
    snapshot: {
      mode: 'live',
      endpoint: 'https://api.hyperliquid.xyz/info',
      mappingVerified: true,
      accountAddress: '0x' + '1'.repeat(40),
      vestContract: { symbol: 'BTC-PERP', quote: 'USDC' },
      vs: { symbol: 'BTC-PERP', account: { stage: 'challenge', positions: [], accountContext: 'example' } },
      hype: { symbol: 'BTC', account: {}, settleCurrency: 'USDC', documentedQuote: 'USDT' }
    }
  };
}

test('双边网页委托只使用原生差额数量与实际现仓，过期、反手与乘数不符时拒绝', () => {
  const { display, snapshot } = example();
  const run = () => liveOrder(display, snapshot, true);
  assert.deepEqual(
    run().plan.legs.map((l) => [l.side, l.quantity, l.currentQty]),
    [
      ['buy', '0.01', 0.1],
      ['sell', '0.01', 0]
    ]
  );
  assert.equal(liveOrder(display, snapshot, false).plan, null);
  for (const [key, value] of [
    ['multiplier', 0.1],
    ['quoteScale', 10],
    ['settle', 'USD'],
    ['type', 'inverse']
  ]) {
    const old = display.asset.vs[key];
    display.asset.vs[key] = value;
    assert.equal(run().plan, null);
    display.asset.vs[key] = old;
  }
  snapshot.vestContract.quote = 'EUR';
  assert.equal(run().plan, null);
  snapshot.vestContract.quote = 'USDC';
  display.candidate.vs.targetQty = -0.01;
  assert.equal(run().plan, null);
  display.candidate.vs.targetQty = 0.11;
  snapshot.vs.account.outcome = { status: 'failed' };
  assert.equal(run().plan, null);
});
test('平台强平需有对应品种的清算记录，余额归零和其他品种事件均不构成该证据', () => {
  const now = Date.now();
  const rows = [
    { time: now - 3, delta: { type: 'liquidation', liquidatedPositions: [{ coin: 'BTC', szi: '-.02' }] } },
    { time: now - 2, delta: { type: 'withdraw', accountValue: '0' } },
    { time: now - 1, delta: { type: 'liquidation', liquidatedPositions: [{ coin: 'ETH', szi: '1' }] } }
  ];
  assert.equal(lastLiquidation(rows, 'BTC'), rows[0]);
  assert.equal(lastLiquidation(rows, 'SOL'), null);
  assert.throws(() => lastLiquidation({}, 'BTC'));
});
