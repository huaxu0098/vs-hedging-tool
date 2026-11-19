import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openTestBrowser } from './chrome.js';

const b = await openTestBrowser({ current: true }),
  origin = process.env.CURRENT_URL ?? b.url;
const info = (body) =>
  fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7000)
  }).then((r) => {
    assert.ok(r.ok);
    return r.json();
  });
// Match an actual L2 event by exchange source time, even when the independent
// REST request is answered one update later than the local WebSocket subscriber.
const books = new Map();
const socket = new WebSocket('wss://api.hyperliquid.xyz/ws');
socket.onopen = () =>
  socket.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin: 'BTC' } }));
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data),
    book = message.data;
  if (message.channel === 'l2Book' && book.coin === 'BTC')
    books.set(new Date(book.time).toISOString(), [book.levels[0][0].px, book.levels[1][0].px]);
};
const readApp = () =>
  b.run(`(()=>{const rows=document.body.innerText.split('\\n');
  const value=name=>Number((rows[rows.indexOf(name)+1]??'').replaceAll(',',''));
  return {time:new Date().toISOString(), url:location.href, mark:value('Mark'), oracle:value('Oracle')};})()`);
try {
  await b.send('Page.navigate', { url: 'https://app.hyperliquid.xyz/trade/BTC' });
  await b.wait(
    "document.body?.innerText?.includes('Oracle') && /Mark\\n[0-9]/.test(document.body.innerText)",
    55000
  );
  const samples = [];
  for (let i = 0; i < 16; i++) {
    const before = await readApp();
    const [meta, book, m] = await Promise.all([
      info({ type: 'metaAndAssetCtxs' }),
      info({ type: 'l2Book', coin: 'BTC' }),
      fetch(origin + '/api/current-market?asset=BTC').then((r) => r.json())
    ]);
    const after = await readApp();
    const k = meta[0].universe.findIndex((x) => x.name === 'BTC'),
      ctx = meta[1][k];
    if (!m.hl?.oracle || !m.pf) continue;
    const sample = {
      before,
      after,
      official: {
        mark: ctx.markPx,
        oracle: ctx.oraclePx,
        bid: book.levels[0][0].px,
        ask: book.levels[1][0].px,
        bookAt: new Date(book.time).toISOString()
      },
      local: {
        mark: m.hl.mark,
        oracle: m.hl.oracle,
        bid: m.hl.levels[0][0][0],
        ask: m.hl.levels[1][0][0],
        bookAt: m.hl.asOf,
        source: m.hl.bookSource
      }
    };
    books.set(sample.official.bookAt, [sample.official.bid, sample.official.ask]);
    const event = books.get(sample.local.bookAt);
    if (event) {
      assert.equal(+sample.local.bid, +event[0]);
      assert.equal(+sample.local.ask, +event[1]);
      sample.matchedL2At = sample.local.bookAt;
    }
    samples.push(sample);
    assert.equal(m.hl.contract.productType, 'perpetual');
    assert.equal(m.hl.assetId, k);
    assert.equal(m.hl.contract.quoteAsset, 'USDT');
    assert.equal(m.hl.contract.settleAsset, 'USDC');
    if (
      [before, after].some((x) => x.mark === +ctx.markPx && x.oracle === +ctx.oraclePx) &&
      +m.hl.mark === +ctx.markPx &&
      +m.hl.oracle === +ctx.oraclePx &&
      samples.some((x) => x.matchedL2At)
    )
      break;
  }
  assert.ok(samples.length);
  const mark = samples.some((s) => [s.before, s.after].some((x) => x.mark === +s.official.mark));
  const oracle = samples.some((s) => [s.before, s.after].some((x) => x.oracle === +s.official.oracle));
  assert.ok(mark && oracle, '独立采样窗口内未逐字段读到相同的 Mark 和 Oracle');
  const local = samples.some(
    (s) => +s.local.mark === +s.official.mark && +s.local.oracle === +s.official.oracle
  );
  assert.ok(local, '本地 Mark/Oracle 未与原始 perp 接口对上同一组数值');
  assert.ok(
    samples.some((s) => s.matchedL2At),
    '未取得相同源时间的公开 BTC L2 事件'
  );
  for (const s of samples) assert.ok(+s.local.bid <= +s.local.ask && +s.official.bid <= +s.official.ask);
  if (process.env.PRODUCT_EVIDENCE)
    await writeFile(process.env.PRODUCT_EVIDENCE, JSON.stringify(samples, null, 2) + '\n');
  console.log('PERP_APP_OK', samples.length, JSON.stringify(samples.at(-1)));
} finally {
  socket.close();
  await b.close();
}
