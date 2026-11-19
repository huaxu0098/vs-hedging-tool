import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dec } from '../../src/hedge/math.js';
import { calculateCurrent } from '../../src/hedge/current.js';
import { inspectRatio } from '../../src/hedge/ratio-scan.js';
import { openTestBrowser } from './chrome.js';

const browser = await openTestBrowser({ current: true });
const { send, run, wait, set } = browser;
const ready = "document.querySelector('#scan-desk')?.dataset.state==='ready'";
const reports = [];

// Independently accumulate native book levels. The conditional exit translates
// the captured book by the venue's own mark move, retaining its quantities.
function verifyFill(book, ledger, field) {
  const quantity = field === 'entry' ? dec(ledger.adjustment) : dec(ledger.target).neg();
  assert.ok(!quantity.isZero());
  const side = quantity.gt(0) ? 1 : 0;
  const move = field === 'entry' ? dec('0') : dec(ledger.exitMark).minus(ledger.mark);
  let left = quantity.abs(), total = dec('0'), levels = 0;
  for (const [px, size] of book.levels[side]) {
    const take = left.lt(size) ? left : dec(size);
    total = total.plus(take.times(dec(px).plus(move)));
    levels++;
    left = left.minus(take);
    if (left.isZero()) break;
  }
  assert.ok(left.isZero());
  const price = total.div(quantity.abs());
  assert.ok(price.minus(ledger[field + 'Price']).abs().lt('1e-18'));
  const fee = total.times(ledger.multiplier).times(ledger.fx).times(ledger.rate);
  assert.ok(fee.minus(ledger[field + 'Fee']).abs().lt('1e-18'));
  return { side: side ? 'Ask' : 'Bid', levels, price: price.toString(), fee: fee.toString() };
}

async function capture(asset) {
  const captureDOM = `(()=>{
    const e=id=>document.getElementById(id), t=id=>e(id).textContent;
    if (e('scan-desk')?.dataset.state!=='ready' || t('scan-hl-unit')!=='USDT/${asset}') return null;
    const box=e('trace-inputs').parentElement; box.open=true; box.ontoggle();
    const input=JSON.parse(t('trace-inputs')), native=['pf','hl'].map(k=>
      ['bid','ask','price'].map(s=>Number(t('scan-'+k+'-'+s))));
    if(input.market.asset!=='${asset}' || !window.readBooks.some(x=>x.asset==='${asset}' && JSON.stringify(x.prices)===JSON.stringify(native))) return null;
    const trace=t('trace-id').split(' / ')[1];
    if(trace!==e('scan-desk').dataset.resultId) return null;
    return {input,native,trace,at:t('trace-sources').split(' · ')[0].replace('计算于 ', ''),source:t('scan-source'),cash:[t('scan-fail-cash'),t('scan-pass-cash')],h:t('scan-representative'),profit:t('scan-profit'),position:t('scan-position')};
  })()`;
  await wait('!!(window.bookEvidence=' + captureDOM + ')', 65000);
  const { input, ...shown } = await run('window.bookEvidence');
  const m = input.market;
  assert.deepEqual([m.spec.contract.quoteAsset, m.hl.contract.quoteAsset, m.hl.contract.settleAsset], ['USDC','USDT','USDC']);
  assert.equal(m.hl.contract.settlement, 'quanto-1:1');
  const result = calculateCurrent(input.rules, input.accounts, m, input.rates, Date.parse(shown.at), input.options);
  const scan = result.ratioScan;
  assert.ok(scan?.representative, JSON.stringify(result.issues));
  assert.equal(shown.trace, result.trace.id);
  const original = scan.representative.row, fills = [];
  assert.deepEqual(shown.cash, [original.fail, original.success].map(v => dec(v).toFixed(4) + ' U'));
  for (const sign of [1,-1]) {
    const candidate = inspectRatio(scan.ctx, { sign, i: original.i, j: original.j });
    for (const path of ['fail','pass'])
      for (const venue of ['pf','hl']) {
        const l = candidate.paths[path][venue];
        fills.push({ sign, path, venue, entry:verifyFill(m[venue], l, 'entry'), exit:verifyFill(m[venue], l, 'exit') });
      }
  }
  reports.push({ ...shown, asset, fills, bookTimes: [m.pf.bookAt ?? m.pf.asOf,m.hl.bookAt ?? m.hl.asOf] });
}

try {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
    const read=window.fetch;window.readBooks=[];
    window.fetch=async(...args)=>{
      const r=await read(...args),url=String(args[0]);
      if(!r.ok)return r;
      if(url.includes('/api/current-market')) {
        const x=await r.clone().json();
        if(x.pf?.levels && x.hl?.levels){
          window.readBooks.push({asset:x.asset,prices:['pf','hl'].map(k=>[+x[k].levels[0][0][0],+x[k].levels[1][0][0],+x[k].mark])});
          if(window.readBooks.length>20)window.readBooks.shift();
        }
        if(window.bookFault==='missing' && x.hl?.contract){x.hl.contract.quoteAsset=null;return Response.json(x)}
      }
      if(window.bookFault==='fx' && url.includes('/api/usd-rates')){
        const x=await r.json();if(x.rates.USDT)x.rates.USDT.asOf='2000-01-01T00:00:00Z';return Response.json(x);
      }
      return r;
    }
  })()` });
  await send('Page.navigate', { url: process.env.CURRENT_URL ?? browser.url });
  await wait(ready, 65000);
  assert.ok(await run("!document.querySelector('#desk-details').open && !/USDC_per_USDT|参考价差/.test(document.body.innerText)"));
  await run("document.querySelector('#desk-details').open=true");
  await capture('BTC');
  await set('#asset', 'ETH');
  await capture('ETH');
  await set('#asset', 'BTC');
  await capture('BTC');
  await run("window.bookFault='fx'");
  await wait(ready+" && document.querySelector('#fx-source').textContent.includes('FX_STALE')", 35000);
  reports.push({ controlledFault:'expired optional FX', scan:'ready' });
  await run("window.bookFault='missing'");
  await wait("document.querySelector('#scan-desk').dataset.state==='paused' && document.querySelector('#scan-status').textContent.includes('QUOTE_CURRENCY_UNVERIFIED') && !document.querySelector('#scan-results').hidden",35000);
  reports.push({ controlledFault:'missing settlement metadata', scan:'paused', retained:true });
  await run("window.bookFault=null");
  await capture('BTC');
  assert.deepEqual(browser.faults, []);
  if (process.env.FX_EVIDENCE) await writeFile(process.env.FX_EVIDENCE, JSON.stringify(reports,null,2)+'\n');
  console.log('NATIVE_BOOK_OK', reports.map(x=>[x.asset ?? x.controlledFault,x.trace ?? x.scan,x.cash]));
} finally {
  await browser.close();
}
