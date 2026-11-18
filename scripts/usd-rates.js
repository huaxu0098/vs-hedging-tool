// Fixed public spot markets. No URL, account or credentials come from the browser.
const markets = {
  USDC: [
    ['Bitstamp', 'https://www.bitstamp.net/api/v2/order_book/usdcusd/'],
    ['Kraken', 'https://api.kraken.com/0/public/Depth?pair=USDCUSD&count=1&assetVersion=1']
  ],
  USDT: [
    ['Bitstamp', 'https://www.bitstamp.net/api/v2/order_book/usdtusd/'],
    ['Coinbase Exchange', 'https://api.exchange.coinbase.com/products/USDT-USD/book?level=1']
  ]
};
const freshTargetMs = 5000;
const cacheMs = 600;

function positive(value) {
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
  return numeric && Number.isFinite(Number(value)) && Number(value) > 0;
}

function parseBook(currency, source, payload, now) {
  let book = payload;
  let time;
  if (source === 'Bitstamp') {
    const micros = Number(book?.microtimestamp);
    if (!positive(book?.microtimestamp) || !Number.isSafeInteger(micros)) throw Error('交易所微秒时间无效');
    time = Math.floor(micros / 1000);
  } else if (source === 'Kraken') {
    if (!Array.isArray(payload?.error) || payload.error.length) throw Error('交易所未返回有效盘口');
    book = payload.result?.[currency + '/USD'];
    const times = [book?.bids?.[0]?.[2], book?.asks?.[0]?.[2]];
    if (!times.every((value) => Number.isSafeInteger(value) && value > 0)) throw Error('盘口档位时间无效');
    // Either side can be stationary. Its age must survive even if the opposite side changed.
    if (times.some((value) => value * 1000 > now)) throw Error('交易所档位时间在未来');
    time = Math.min(...times) * 1000;
  } else {
    if (book?.auction_mode) throw Error('交易对正在集合竞价');
    if (typeof book?.time !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(book.time))
      throw Error('盘口源时间缺失');
    time = Date.parse(book.time);
  }
  const bestBid = book?.bids?.[0],
    bestAsk = book?.asks?.[0];
  if (
    ![bestBid, bestAsk].every((level) => Array.isArray(level) && positive(level[0]) && positive(level[1]))
  ) {
    throw Error('买一、卖一或挂单数量无效');
  }
  const bid = Number(bestBid[0]),
    ask = Number(bestAsk[0]);
  if (ask < bid) throw Error('盘口交叉');
  if (!Number.isSafeInteger(time) || time <= 0 || time > now) throw Error('交易所源时间无效或在未来');
  return {
    currency,
    quote: 'USD',
    rate: bid + (ask - bid) / 2,
    bid,
    ask,
    asOf: new Date(time).toISOString(),
    source
  };
}

export function createUsdRatesReader({ fetchImpl = fetch, now = Date.now } = {}) {
  const latestTime = new Map();
  let inFlight,
    cache,
    cachedAt = -Infinity;

  async function readCurrency(currency) {
    const failures = [];
    let newest = null;
    for (const [source, url] of markets[currency]) {
      try {
        const r = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(1800)
        });
        if (!r.ok) throw Error('HTTP ' + r.status);
        const quote = parseBook(currency, source, await r.json(), now());
        const stamp = Date.parse(quote.asOf);
        if (stamp < (latestTime.get(currency) ?? -Infinity)) throw Error('源时间早于上一份汇率');
        if (!newest || stamp > Date.parse(newest.asOf)) newest = quote;
        if (now() - stamp <= freshTargetMs) break;
      } catch (err) {
        failures.push(source + ' ' + (err.name === 'TimeoutError' ? '请求超时' : err.message));
      }
    }
    if (!newest) throw Error(failures.join('；'));
    latestTime.set(currency, Date.parse(newest.asOf));
    return newest;
  }

  // Concurrent tabs share a refresh. The transport cache never changes a venue's asOf.
  return async function readUsdRates() {
    if (cache && now() >= cachedAt && now() - cachedAt < cacheMs) return cache;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const currencies = Object.keys(markets);
      const results = await Promise.allSettled(currencies.map(readCurrency));
      const rates = {},
        errors = {};
      results.forEach((result, index) => {
        const currency = currencies[index];
        if (result.status === 'fulfilled') rates[currency] = result.value;
        else errors[currency] = result.reason.message || '无法获取美元现货盘口';
      });
      cache = { rates, errors };
      cachedAt = now();
      return cache;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
