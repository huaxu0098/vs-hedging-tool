import assert from 'node:assert/strict';
import test from 'node:test';
import { readHype, feedIssues, toMarketAsset } from '../src/feeds.js';
import { parseVSText, captureScript } from '../src/vs-parser.js';
import { createTemplates } from '../src/assets.js';

const t = Date.UTC(2026, 10, 18, 17, 0, 0);
const spec = { name: 'BTC', szDecimals: 5, marginTableId: 55, maxLeverage: 40 };
const metadata = {
  universe: [spec],
  collateralToken: 0,
  marginTables: [
    [
      55,
      {
        marginTiers: [
          { lowerBound: '0', maxLeverage: 40 },
          { lowerBound: '150000000', maxLeverage: 20 }
        ]
      }
    ]
  ]
};
const ctx = { markPx: '63181', oraclePx: '63189', funding: '0.0000125' };
function reply(symbol = 'BTC', patch = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      const r = JSON.parse(options.body);
      calls.push(r);
      assert.equal(new URL(url).pathname, '/info');
      const bodies = {
        metaAndAssetCtxs: [{ ...metadata, universe: [{ ...spec, name: symbol, ...patch }] }, [ctx]],
        l2Book: { coin: symbol, time: t, levels: [[{ px: '63180', sz: '2' }], [{ px: '63182', sz: '3' }]] },
        clearinghouseState: {
          marginSummary: { accountValue: '405', totalMarginUsed: '50' },
          withdrawable: '355',
          time: t,
          assetPositions: [
            {
              position: {
                coin: symbol,
                szi: '-0.2',
                entryPx: '63000',
                unrealizedPnl: '5',
                marginUsed: '50',
                leverage: { type: 'isolated', value: 5 },
                liquidationPx: '64500'
              }
            }
          ]
        }
      };
      return Response.json(bodies[r.type]);
    }
  };
}
test('读取精确 HIP-3 universe、市场时间、五档输入、仓位、费率与递推风险档位', async () => {
  const mock = reply('xyz:GOLD');
  const h = await readHype({
    symbol: 'xyz:GOLD',
    dex: 'xyz',
    address: '0x' + '0'.repeat(40),
    fetchImpl: mock.fetchImpl
  });
  assert.equal(h.asOf, new Date(t).toISOString());
  assert.notEqual(h.receivedAt, h.asOf);
  assert.equal(h.bid, 63180);
  assert.equal(h.ask, 63182);
  assert.equal(h.mark, 63181);
  assert.equal(h.fundingRate, 0.0000125);
  assert.equal(h.step, 0.00001);
  assert.equal(h.tick, 1);
  assert.equal(h.tiers[1].deduction, 1875000);
  assert.deepEqual(h.book.asks[0], [63182, 3]);
  assert.equal(h.account.cash, 400);
  assert.equal(h.account.free, 355);
  assert.equal(h.liqQty, -0.2);
  assert.equal(h.liqPrice, 64500);
  assert.equal(h.liqMarginMode, 'isolated');
  assert.equal(mock.calls.find((c) => c.type === 'metaAndAssetCtxs').dex, 'xyz');
  assert.equal(mock.calls.find((c) => c.type === 'l2Book').coin, 'xyz:GOLD');
});
test('未挂牌、缺失维持档位和错误 HIP-3 前缀', async () => {
  await assert.rejects(readHype({ symbol: 'XAU', fetchImpl: reply('PAXG').fetchImpl }), /未挂牌/);
  await assert.rejects(readHype({ symbol: 'xyz:GOLD', dex: 'other', fetchImpl: reply().fetchImpl }), /DEX/);
  const h = await readHype({ symbol: 'BTC', fetchImpl: reply('BTC', { marginTableId: 999 }).fetchImpl });
  assert.equal(h.marginVerified, false);
  assert.equal(h.mmr, null);
});
test('超时、报价陈旧、冻结、非美元汇率及未确认的映射熔断', async () => {
  await assert.rejects(
    readHype({
      symbol: 'BTC',
      fetchImpl: async () => {
        throw new DOMException('timeout', 'TimeoutError');
      }
    }),
    /超时/
  );
  const a = createTemplates(t)[0],
    h = await readHype({ symbol: 'BTC', fetchImpl: reply().fetchImpl });
  const vs = {
    bid: 63180,
    ask: 63182,
    mark: 63181,
    open: true,
    asOf: h.asOf,
    price: 63181,
    spread: 2,
    symbol: 'BTC'
  };
  const snap = {
    assetId: a.id,
    mode: 'live',
    errors: [],
    maxAgeMs: 5000,
    mappingVerified: true,
    hype: h,
    vs,
    addressConfigured: false,
    marginMode: 'cross',
    fx: { hype: { asOf: h.asOf, settleUsd: 1, quoteUsd: 1 } }
  };
  assert.equal(toMarketAsset(a, snap, t).sourceIssues.length, 0);
  assert.match(feedIssues(snap, t + 5001).join(''), /报价过期/);
  assert.match(feedIssues({ ...snap, frozen: true }, t).join(''), /冻结/);
  assert.equal(toMarketAsset(a, { ...snap, mappingVerified: false }, t).verified, false);
  assert.match(toMarketAsset(a, { ...snap, fx: {} }, t).sourceIssues.join(''), /汇率/);
  assert.equal(toMarketAsset(a, { ...snap, mode: 'offline' }, t).vs.mark, 63181);
  assert.equal(toMarketAsset(a, { ...snap, mode: 'offline', vs: null }, t).hype.price, 100000);
});
test('VS 表格、JSON 与选区脚本，仅导出已识别的结构化字段', () => {
  const text =
    'Balance: 10,000\nEquity: 10,012\nUsed Margin: 212\nFree Margin: 9,800\n阶段: 考核中\nSymbol: BTC\nBid: 63,180\nAsk: 63,182\nMark: 63,181\n市场状态: 开市\nSymbol\tSide\tSize\tEntry Price\tUnrealized PnL\tMargin Used\nBTC\tLong\t0.1\t63061\t12\t212';
  const v = parseVSText(text, t);
  assert.deepEqual(v.account, {
    balance: 10000,
    equity: 10012,
    free: 9800,
    used: 212,
    stage: 'challenge',
    positions: [{ symbol: 'BTC', qty: 0.1, entry: 63061, upnl: 12, marginUsed: 212 }]
  });
  assert.deepEqual([v.bid, v.ask, v.mark, v.open, v.timeSource], [63180, 63182, 63181, true, 'capture']);
  const json = parseVSText(JSON.stringify({ ...v, secret: 'unselected' }), t);
  assert.equal(json.timeSource, 'source');
  assert.ok(!Object.hasOwn(json, 'secret'));
  assert.deepEqual(parseVSText('Balance: 10000\nPositions: none', t).account.positions, []);
  const script = captureScript({
    origin: 'https://broker.example',
    token: 'example',
    assetId: 'btc',
    baseURL: 'http://127.0.0.1:4178'
  });
  assert.match(script, /getSelection/);
  assert.doesNotMatch(script, /document\.body|innerHTML/);
  assert.doesNotThrow(() => new Function(script));
});
test('API 抵押币兑美元严格换算账户与风险档，保留合约数量、价格以及旧数据来源', async () => {
  const asset = createTemplates(t)[0],
    h = await readHype({ symbol: 'BTC', address: '0x' + '0'.repeat(40), fetchImpl: reply().fetchImpl });
  const snap = {
    assetId: asset.id,
    mode: 'live',
    hype: h,
    addressConfigured: true,
    vs: { bid: 63180, ask: 63182, mark: 63181, open: true, asOf: h.asOf },
    mappingVerified: true,
    maxAgeMs: 5000,
    marginMode: 'cross',
    quoteCurrency: 'USDT',
    fx: { hype: { asOf: h.asOf, quoteUsd: 1, settleUsd: 1.2 } }
  };
  const live = toMarketAsset(asset, snap, t).hype;
  assert.equal(live.account.cash, 480);
  assert.equal(live.account.equity, 486);
  assert.equal(live.account.free, 426);
  assert.equal(live.account.used, 60);
  assert.equal(live.account.positions[0].marginUsed, 60);
  assert.equal(live.account.positions[0].upnl, 6);
  assert.equal(live.account.positions[0].entry, 63000);
  assert.equal(live.account.positions[0].qty, -0.2);
  assert.equal(live.account.sourceCurrency, 'USDC');
  assert.equal(live.account.currency, 'USD');
  assert.equal(h.account.cash, 400);
  assert.equal(live.tiers[1].lowerBound, 180000000);
  assert.equal(live.tiers[1].deduction, 2250000);
  assert.equal(live.minNotional, 10);
  assert.equal(live.leverage, 5);
  const stale = toMarketAsset(
    asset,
    { ...snap, fx: { hype: { asOf: new Date(t - 5001).toISOString(), quoteUsd: 1, settleUsd: 1 } } },
    t
  );
  assert.equal(stale.hype.account, null);
  assert.ok(stale.sourceIssues.some((i) => i.includes('汇率')));
});
test('VS 独立账户时刻随新报价保留，跨品种只有过期账户时亦熔断', () => {
  const a = createTemplates(t)[0],
    old = new Date(t - 6000).toISOString(),
    fresh = new Date(t).toISOString();
  const v = parseVSText(
    JSON.stringify({
      bid: 99,
      ask: 101,
      mark: 100,
      open: true,
      asOf: fresh,
      account: { equity: 10000, asOf: old }
    }),
    t
  );
  assert.equal(v.asOf, fresh);
  assert.equal(v.account.asOf, old);
  const snap = { assetId: a.id, mode: 'offline', vs: v, maxAgeMs: 5000, mappingVerified: true };
  assert.deepEqual(feedIssues(snap, t), ['VS 账户数据过期或时间未知。']);
  assert.deepEqual(toMarketAsset(a, { ...snap, vs: { account: v.account } }, t).sourceIssues, [
    'VS 账户数据过期或时间未知。'
  ]);
  const switched = { ...snap, assetId: 'eth', vs: v };
  assert.ok(toMarketAsset(a, switched, t).sourceIssues.some((s) => s.includes('品种')));
});
test('手工强平指纹须属于本次钱包与合约映射', async () => {
  const a = createTemplates(t)[0],
    h = await readHype({ symbol: 'BTC', fetchImpl: reply('BTC', { marginTableId: 999 }).fetchImpl });
  Object.assign(a.hype, {
    liqSource: 'manual',
    liqScopeId: 'right',
    liqPrice: 71000,
    liqAsOf: h.asOf,
    liqQty: -0.1,
    liqEntry: 63000,
    liqCollateral: 100,
    liqMarginMode: 'isolated'
  });
  const snap = {
    assetId: a.id,
    scopeId: 'right',
    mode: 'live',
    hype: h,
    vs: { bid: 63180, ask: 63182, mark: 63181, open: true, asOf: h.asOf },
    mappingVerified: true,
    maxAgeMs: 5000,
    marginMode: 'isolated',
    quoteCurrency: 'USDT',
    fx: { hype: { asOf: h.asOf, quoteUsd: 1, settleUsd: 1 } }
  };
  assert.equal(toMarketAsset(a, snap, t).hype.liqPrice, 71000);
  assert.equal(toMarketAsset(a, { ...snap, scopeId: 'another' }, t).hype.liqPrice, null);
  assert.ok(
    toMarketAsset(a, { ...snap, scopeId: 'another' }, t).sourceIssues.some((r) => r.includes('强平参数缺失'))
  );
});

test('实时与冻结冷启动不借用模板价格，返回离线后恢复模板标记与时刻', async () => {
  const a = createTemplates(t)[0];
  const snap = { assetId: a.id, mode: 'live', maxAgeMs: 5000, vs: null, hype: null, errors: [] };
  const waiting = toMarketAsset(a, snap, t);
  assert.equal(waiting.referencePrice, null);
  assert.equal(waiting.vs.price, null);
  assert.equal(waiting.hype.price, null);
  assert.ok(waiting.sourceIssues.some((issue) => issue.includes('缺少买一')));
  const h = await readHype({ symbol: 'BTC', fetchImpl: reply().fetchImpl });
  const frozen = toMarketAsset(a, { ...snap, mode: 'frozen', frozen: true, hype: h }, t);
  assert.equal(frozen.referencePrice, null);
  assert.equal(frozen.hype.mark, h.mark);
  assert.ok(frozen.sourceIssues.some((issue) => issue.includes('冻结')));
  const offline = toMarketAsset(a, { ...snap, mode: 'offline', hype: h }, t);
  assert.equal(offline.referencePrice, a.referencePrice);
  assert.equal(offline.hype.price, a.hype.price);
  assert.notEqual(offline.hype.sourceKind, 'live');
});

function observedRate(currency, rate, source = 'Bitstamp', time = t) {
  return {
    currency,
    quote: 'USD',
    bid: rate - 0.0001,
    ask: rate + 0.0001,
    rate,
    asOf: new Date(time).toISOString(),
    source
  };
}

async function fxSnapshot(wallet = false) {
  const a = createTemplates(t)[0];
  const h = await readHype({
    symbol: 'BTC',
    address: wallet ? '0x' + '0'.repeat(40) : '',
    fetchImpl: reply().fetchImpl
  });
  const v = (h.mark * 0.98) / 1.02;
  return {
    a,
    s: {
      assetId: 'btc',
      mode: 'live',
      mappingVerified: true,
      maxAgeMs: 5000,
      fxMode: 'auto',
      marginMode: 'cross',
      quoteCurrency: 'USDT',
      addressConfigured: wallet,
      vestContract: { symbol: 'BTC-PERP', quote: 'USDC' },
      hype: h,
      vs: {
        symbol: 'BTC-PERP',
        source: 'Vest 公开行情',
        open: true,
        bid: v - 0.5,
        ask: v + 0.5,
        price: v,
        mark: v,
        asOf: h.asOf
      },
      usdRates: { USDC: observedRate('USDC', 1.02), USDT: observedRate('USDT', 0.98, 'Kraken', t - 60) }
    }
  };
}

const nearFX = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, a + ' vs ' + b);

test('非平价 USDT/USDC 稳定映射到原生美元轴；乘数、结算币和账户权益各按自己的单位换算', async () => {
  const { analyzeCandidate } = await import('../src/decision.js');
  const { a, s } = await fxSnapshot(true);
  s.vs.account = {
    asOf: s.vs.asOf,
    currency: 'USDT',
    balance: 10000,
    equity: 10015,
    used: 20,
    free: 9995,
    positions: [{ symbol: 'BTC-PERP', qty: 0.02, entry: 60000, liqPrice: 52000, upnl: 15, marginUsed: 20 }]
  };
  const live = toMarketAsset(a, s, t);
  assert.deepEqual(live.sourceIssues, []);
  assert.equal(a.vs.quote, 'USD');
  assert.equal(live.vs.quote, 'USDC');
  assert.equal(live.vs.settle, 'USD');
  nearFX(live.referencePrice, s.vs.mark * 1.02);
  nearFX(live.referencePrice, s.hype.mark * 0.98);
  nearFX(live.vs.ratio, 1 / 1.02);
  nearFX(live.hype.ratio, 1 / 0.98);
  assert.equal(live.hype.fxDetails.quote.source, 'Kraken');
  assert.equal(live.hype.fxAsOf, s.usdRates.USDT.asOf);
  nearFX(live.hype.account.cash, 400 * 1.02);
  nearFX(live.hype.account.positions[0].upnl, 5 * 1.02);
  assert.equal(live.hype.account.positions[0].liqPrice, 64500);
  nearFX(live.hype.tiers[1].lowerBound, 150000000 * 1.02);
  nearFX(live.vs.account.balance, 9800);
  nearFX(live.vs.account.positions[0].marginUsed, 19.6);
  assert.equal(live.vs.account.positions[0].entry, 60000);
  assert.equal(live.vs.account.positions[0].liqPrice, 52000);
  assert.equal(live.vs.account.sourceCurrency, 'USDT');
  assert.equal(s.vs.account.balance, 10000);
  const rec = analyzeCandidate(
    live,
    { stage: 'challenge', vsBalance: 10000, hypeCash: 409, positions: [] },
    {},
    { vsUsd: 18000, hypeUsd: 3000, vsLong: true },
    t
  );
  assert.ok(Number.isFinite(rec.liq), rec.reasons.join(' '));
  nearFX(rec.vs.delta, rec.vs.qty / 1.02);
  nearFX(rec.hype.delta, (-rec.hype.qty * 1.02) / 0.98);
  nearFX(rec.liq, live.referencePrice + (rec.liqMark - s.hype.mark) * 0.98);
});

test('自动汇率必须有同一币/USD、实盘来源、新鲜时刻及双边价格；无效数据不会退回模板或手工 1', async () => {
  const { a, s } = await fxSnapshot(true);
  s.fx = { hype: { quoteUsd: 1, settleUsd: 1, asOf: s.hype.asOf } };
  for (const mutate of [
    (r) => {
      delete r.USDC;
    },
    (r) => {
      r.USDC.rate = 0;
    },
    (r) => {
      r.USDC.source = '  ';
    },
    (r) => {
      r.USDC.currency = 'USDT';
    },
    (r) => {
      r.USDC.quote = 'USDT';
    },
    (r) => {
      r.USDC.bid = r.USDC.ask + 1;
    },
    (r) => {
      r.USDC.rate = r.USDC.ask + 0.1;
    },
    (r) => {
      r.USDC.asOf = t + 1;
    },
    (r) => {
      r.USDC.asOf = t - 5001;
    }
  ]) {
    const copy = structuredClone(s);
    mutate(copy.usdRates);
    const result = toMarketAsset(a, copy, t);
    assert.equal(result.hype.settleUsd, null);
    assert.equal(result.hype.account, null);
    assert.equal(result.referencePrice, null);
    assert.equal(result.verified, false);
    assert.ok(result.sourceIssues.some((i) => i.includes('USDC') && i.includes('汇率')));
  }
});

test('手工确认按币种绑定；错误 Vest 合约元数据不覆盖原规格，其他来源不能借用 Vest 报价币', async () => {
  const { a, s } = await fxSnapshot();
  s.fxMode = 'manual';
  s.fx = {
    vs: { quoteCurrency: 'USDC', quoteUsd: 1.02, asOf: s.vs.asOf },
    hype: {
      quoteCurrency: 'USDT',
      settleCurrency: 'USDC',
      quoteUsd: 0.98,
      settleUsd: 1.02,
      asOf: s.hype.asOf
    }
  };
  assert.deepEqual(toMarketAsset(a, s, t).sourceIssues, []);
  s.fx.hype.quoteCurrency = 'USDC';
  assert.equal(toMarketAsset(a, s, t).hype.quoteUsd, null);
  assert.match(toMarketAsset(a, { ...s, assetId: 'eth' }, t).sourceIssues.join(' '), /精确代码/);
  s.vestContract.symbol = 'ETH-PERP';
  assert.match(toMarketAsset(a, s, t).sourceIssues.join(' '), /精确代码/);
  s.vs.source = '手工确认';
  s.vs.quote = 'EUR';
  s.vs.settle = 'EUR';
  const manual = toMarketAsset(a, s, t);
  assert.equal(manual.vs.quote, 'USD');
  assert.equal(manual.vs.settle, 'USD');
  s.vs.account = { balance: 10000, asOf: s.vs.asOf };
  assert.equal(toMarketAsset(a, s, t).vs.account.balance, 10000);
});

test('识别的每克价格标尺随汇率浮动；原映射不一致必须拒绝', async () => {
  const { a, s } = await fxSnapshot();
  Object.assign(a.vs, { quoteScale: 1 / 31.1034768, ratio: 1 / 31.1034768 });
  for (const key of ['bid', 'ask', 'mark', 'price']) s.vs[key] /= 31.1034768;
  const live = toMarketAsset(a, s, t);
  assert.deepEqual(live.sourceIssues, []);
  nearFX(live.vs.ratio, 1 / 31.1034768 / 1.02);
  nearFX(live.referencePrice, s.hype.mark * 0.98);
  a.vs.ratio = 1;
  const wrong = toMarketAsset(a, s, t);
  assert.equal(wrong.vs.ratio, null);
  assert.ok(wrong.sourceIssues.some((i) => i.includes('报价比例')));
});

test('账户部分字段按原币独立换算；已有 USD 手工输入、缺失金额和跨品种原价格保持原义', async () => {
  const { dashboardAccount } = await import('../src/workspace-state.js');
  const { a, s } = await fxSnapshot();
  s.vs.account = {
    currency: 'USDC',
    asOf: s.vs.asOf,
    equity: 100,
    positions: [{ assetId: 'eth', symbol: 'ETH-PERP', qty: 3, entry: 500, upnl: 7 }]
  };
  const live = toMarketAsset(a, s, t),
    usd = live.vs.account;
  nearFX(usd.equity, 102);
  nearFX(usd.positions[0].upnl, 7.14);
  assert.equal(usd.positions[0].entry, 500);
  assert.ok(!Object.hasOwn(usd, 'free'));
  const acc = {
    stage: 'challenge',
    vsBalance: 10000,
    hypeCash: 409,
    vsEquity: 10000,
    hypeEquity: 409,
    vsFree: 10000,
    hypeFree: 409,
    vsUsed: 0,
    hypeUsed: 0,
    positions: []
  };
  const board = dashboardAccount(acc, null, s, live, [live, ...createTemplates(t).slice(1)]);
  nearFX(board.account.vsEquity, 102);
  assert.ok(board.issues.some((i) => i.includes('vsFree')));
  const accountOnly = { ...s, mode: 'offline', vs: { account: s.vs.account } };
  const mixed = toMarketAsset(a, accountOnly, t);
  nearFX(mixed.vs.account.equity, 102);
  assert.equal(mixed.vs.quote, 'USD');
  assert.equal(mixed.referencePrice, a.referencePrice);
  delete s.usdRates.USDC;
  const invalid = toMarketAsset(a, s, t);
  assert.equal(invalid.vs.account, null);
  assert.ok(dashboardAccount(acc, null, s, invalid, [invalid]).issues.some((i) => i.includes('美元估值')));
  s.vs.account.currency = 'USD';
  nearFX(toMarketAsset(a, s, t).vs.account.equity, 100);
});

test('换汇时刻独立过期，阻断异品种持仓估值和平仓；有效新汇率不改变原合约身份', async () => {
  const { resolveHeldMarket } = await import('../src/workspace-state.js');
  const { verifyQuotes } = await import('../src/simulation.js');
  const { a, s } = await fxSnapshot();
  const first = toMarketAsset(a, s, t);
  const fresh = structuredClone(s);
  fresh.usdRates.USDC = observedRate('USDC', 1.021);
  const next = toMarketAsset(a, fresh, t);
  assert.deepEqual(resolveHeldMarket(next, first, t).sourceIssues, []);
  const now = t + 4960;
  const late = resolveHeldMarket(first, first, now);
  assert.ok(late.sourceIssues.some((i) => i.includes('汇率过期')));
  assert.throws(() => verifyQuotes(first, now), /汇率过期/);
  const modified = structuredClone(next);
  modified.vs.multiplier *= 2;
  assert.ok(resolveHeldMarket(modified, first, t).sourceIssues.some((i) => i.includes('规格')));
});

test('跨市场持仓可用各自显式金额币，缺少其汇率时只保留已知金额，严禁使用离线规格重估', async () => {
  const { dashboardAccount } = await import('../src/workspace-state.js');
  const { analyzeCandidate } = await import('../src/decision.js');
  const { a, s } = await fxSnapshot();
  s.vs.account = {
    asOf: s.vs.asOf,
    currency: 'USD',
    balance: 10000,
    equity: 10007,
    free: 500,
    used: 0,
    positions: [
      { assetId: 'eth', symbol: 'ETH-PERP', qty: 2, entry: 500, currency: 'EUR', upnl: 7, margin: 10 }
    ]
  };
  s.usdRates.EUR = observedRate('EUR', 1.08, '美元直盘', t - 4700);
  const live = toMarketAsset(a, s, t),
    row = live.vs.account.positions[0];
  nearFX(row.upnl, 7.56);
  nearFX(row.margin, 10.8);
  assert.equal(row.entry, 500);
  assert.equal(row.currency, 'USD');
  assert.equal(live.vs.account.equity, 10007);
  const account = { stage: 'challenge', vsBalance: 10000, hypeCash: 409, positions: [] };
  const otherTemplate = createTemplates(t)[1];
  const board = dashboardAccount(account, null, s, live, [live, otherTemplate]);
  assert.equal(board.account.positions[0].asset, undefined);
  const otherLive = { ...otherTemplate, feedMode: 'live', vs: { ...otherTemplate.vs, symbol: 'ETH-PERP' } };
  const attached = dashboardAccount(account, null, s, live, [live, otherLive]);
  assert.equal(attached.account.positions[0].asset.id, 'eth');
  const late = analyzeCandidate(live, account, {}, { vsUsd: 18000, hypeUsd: 3000, vsLong: true }, t + 301);
  assert.ok(late.reasons.some((r) => r.includes('汇率已过期')));
  delete s.usdRates.EUR;
  const incomplete = toMarketAsset(a, s, t);
  assert.equal(incomplete.vs.account.equity, 10007);
  assert.equal(incomplete.vs.account.positions[0].upnl, null);
  assert.equal(incomplete.verified, false);
});
