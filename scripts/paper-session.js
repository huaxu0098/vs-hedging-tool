import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { collectHype, MAINNET } from '../src/hedge/adapters.js';
import { restoreBook } from '../src/hedge/book.js';
import { maxQuoteAge, paperMarket, samplePaper, startPaper } from '../src/hedge/paper.js';
import { subscribeVestMarket } from '../src/vest-market.js';
import { readVestSpecs } from './vest-contract.js';

export async function runPaper(port) {
  const dir = new URL('../.local/', import.meta.url);
  const file = new URL('paper-funded-btc-' + port + '.json', dir);
  const temp = new URL(file.href + '.tmp');
  await mkdir(dir, { recursive: true });
  const save = async (value) => {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, file);
  };
  let session;
  try {
    session = JSON.parse(await readFile(file, 'utf8'));
    if (session.version !== 1 || session.book?.stage !== 'funded') throw Error('无法恢复本轮模拟账本');
    restoreBook(session.book);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    session = startPaper(new Date().toISOString());
    await save(session);
  }

  let vs, lastGood = 0, timer, stopVest, valuation, quotes;
  let message = '正在连接两边的 BTC 公开行情';
  let vestStatus = '等待 Vest 盘口和标记价';
  const read = () => ({
    startedAt: session.startedAt, initialCash: session.initialCash, principal: session.book.B,
    entry: session.entry, end: session.end, message, valuation, quotes
  });
  if (session.end) return read;
  stopVest = subscribeVestMarket('BTC-PERP', (quote) => { vs = quote; vestStatus = ''; },
    (status) => { vs = null; vestStatus = status; }, { includeDepth: true });
  async function request(body) {
    const r = await fetch(MAINNET, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!r.ok) throw Error('Hype 行情 HTTP ' + r.status);
    return r.json();
  }
  async function poll() {
    try {
      const [spec, hype] = await Promise.all([readVestSpecs('BTC-PERP'), collectHype({ symbol: 'BTC', request })]);
      if (!vs) throw Error(vestStatus || '等待 VS 报价');
      const now = Date.now(), at = new Date(now).toISOString();
      const market = paperMarket(vs, hype, spec, now);
      const result = samplePaper(session, market, at, !!session.entry && now - lastGood > maxQuoteAge);
      for (const leg of [market.pf, market.hl]) {
        if (Date.now() - Date.parse(leg.asOf) > maxQuoteAge) throw Error('盘口已过期，等待下一次采样');
      }
      if (result.session !== session) {
        await save(result.session);
        session = result.session;
      }
      quotes = Object.fromEntries(['pf', 'hl'].map((key) => [key, {
        mark: market[key].mark, asOf: market[key].asOf, bid: market[key].bids[0][0], ask: market[key].asks[0][0]
      }]));
      valuation = result.valuation;
      message = result.message || '';
      lastGood = now;
    } catch (e) {
      message = e.message;
      valuation = null;
    }
    if (session.end) { stopVest(); clearTimeout(timer); }
    else timer = setTimeout(poll, 1500);
  }
  void poll();
  return read;
}
