// Mainnet observation first. Faults below modify only the response delivered
// to this disposable browser profile; the server and user's storage stay live.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openTestBrowser } from './chrome.js';
const b = await openTestBrowser({ current: true });
const { run, wait, send, click, set } = b;
const url = process.env.CURRENT_URL || b.url;
const ready =
  "document.querySelector('#scan-desk')?.dataset.state==='ready' && document.querySelector('#scan-buckets').rows.length>0";
const paused = "document.querySelector('#scan-desk')?.dataset.state==='paused'";
const read = () =>
  run(`(()=>{const e=k=>document.getElementById(k),t=k=>e(k).textContent;
 return {id:e('scan-desk').dataset.resultId,status:t('scan-status'),pf:t('scan-pf-price'),hl:t('scan-hl-price'),
 rows:e('scan-buckets').rows.length,cash:[t('scan-fail-cash'),t('scan-pass-cash')],
 ranges:['protect','survive','both','profit'].map(k=>t('scan-'+k)), units:[t('scan-pf-unit'),t('scan-hl-unit'),t('scan-hl-settle')]}})()`);
const metaFault = async (value) =>
  run('sessionStorage.setItem("qa-vest-fault",' + JSON.stringify(value) + ')');
const reports = {};
try {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
    const fetchLive=window.fetch.bind(window);
    window.fetch=async(...args)=>{
      if (String(args[0]).includes('/api/usd-rates') && window.holdFx) {
        window.fxHeld=true;
        await new Promise(resolve=>window.releaseFx=resolve);
      }
      const r=await fetchLive(...args);
      if(!String(args[0]).includes('/api/current-market') || !r.ok) return r;
      const mode=sessionStorage.getItem('qa-vest-fault');
      if(!mode)return r;
      const x=await r.json();
      if(mode==='offline') throw Error('受控本地连接中断');
      if(mode==='missing' && x.spec){ x.spec.quote=null; delete x.spec.quoteAsset;
        x.spec.contract.quoteAsset=null; x.spec.contract.settlement=null; }
      if(mode==='outage'){ x.spec=null; x.specStatus='unavailable'; x.errors.spec='受控 Vest 规格接口不可用'; }
      if(mode==='conflict' && x.spec){x.spec.quote='USDT';x.spec.contract.quoteAsset='USDT';}
      return Response.json(x);
    };
  })()`
  });
  await send('Page.navigate', { url });
  await wait(ready, 55000);
  reports.live = await read();
  assert.deepEqual(reports.live.units, ['USDC/BTC', 'USDT/BTC', 'USDC 抵押/结算']);
  assert.ok(
    await run(
      "document.querySelectorAll('main > details').length===1 && !document.querySelector('#desk-details').open && [...document.querySelectorAll('.desk-group')].every(x=>!x.open)"
    )
  );
  const liveSpec = await run("fetch('/api/current-market?asset=BTC').then(r=>r.json()).then(x=>x.spec)");
  await run('window.holdFx=true');
  await wait('window.fxHeld===true', 15000);
  const priceStamp =
    "document.querySelector('#scan-pf-quote').textContent.match(/\\d{2}:\\d{2}:\\d{2}/)?.[0]";
  const startStamp = await run(priceStamp);
  assert.ok(startStamp);
  await wait(priceStamp + ' !== ' + JSON.stringify(startStamp), 12000);
  reports.independentQuotes = { before: startStamp, after: await run(priceStamp) };
  await run('window.holdFx=false; window.releaseFx()');
  await metaFault('missing');
  await wait(
    paused + " && document.querySelector('#scan-basis').textContent==='QUOTE_CURRENCY_UNVERIFIED'",
    30000
  );
  reports.missing = await read();
  assert.ok(Number(reports.missing.pf) > 0 && Number(reports.missing.hl) > 0);
  assert.ok(reports.missing.rows > 0 && reports.missing.status.includes('历史结果'));
  await metaFault('offline');
  await send('Page.reload', { ignoreCache: true });
  await wait(paused + " && document.querySelector('#scan-status').textContent.includes('连接失败')", 30000);
  reports.reloaded = await read();
  assert.equal(reports.reloaded.id, reports.missing.id);
  assert.deepEqual(reports.reloaded.cash, reports.missing.cash);
  assert.deepEqual(reports.reloaded.ranges, reports.missing.ranges);
  assert.ok(await run("document.querySelector('#scan-hl-quote').textContent.includes('历史 Mark')"));
  await metaFault('missing');
  await wait(
    "document.querySelector('#scan-basis').textContent==='QUOTE_CURRENCY_UNVERIFIED' && !document.querySelector('#scan-hl-quote').textContent.includes('历史 Mark')",
    30000
  );
  await click('#scan-config');
  assert.ok(await run("[...document.querySelectorAll('.desk-group')].every(x=>!x.open)"));
  await click('#vest-spec-details > summary');
  await set('#vest-spec-form [name="quoteAsset"]', 'USDC', 'input');
  await click('#vest-spec-form button[type=submit]');
  await wait(
    ready + " && document.querySelector('#vest-spec-source').textContent.includes('本机手工确认')",
    45000
  );
  reports.confirmed = await read();
  assert.notEqual(reports.confirmed.id, reports.missing.id);
  await send('Page.reload', { ignoreCache: true });
  await wait(ready, 45000);
  await metaFault('outage');
  await wait(
    paused + " && document.querySelector('#scan-status').textContent.includes('sizeDecimals')",
    30000
  );
  reports.missingRules = await read();
  await click('#scan-config');
  await click('#vest-spec-details > summary');
  await click('#vest-spec-form details > summary');
  for (const [k, v] of ['sizeDecimals', 'capitalInitMarginRatio', 'maintMarginRatio'].map((k) => [
    k,
    String(liveSpec[k])
  ]))
    await set('#vest-spec-form [name="' + k + '"]', v, 'input');
  await click('#vest-spec-form button[type=submit]');
  await wait(ready, 45000);
  reports.manual = await read();
  await metaFault('conflict');
  await wait(paused + " && document.querySelector('#scan-status').textContent.includes('冲突')", 30000);
  reports.conflict = await read();
  await metaFault('');
  await click('#vest-spec-clear');
  await wait(ready + " && document.querySelector('#scan-pf-unit').textContent==='USDC/BTC'", 45000);
  reports.recovered = await read();
  // A first-use browser with no complete calculation must explain the missing
  // field and still show both native prices, without manufacturing past cash.
  await metaFault('missing');
  await run('localStorage.clear()');
  await send('Page.reload', { ignoreCache: true });
  await wait(
    paused + " && document.querySelector('#scan-basis').textContent==='QUOTE_CURRENCY_UNVERIFIED'",
    30000
  );
  reports.firstUse = await read();
  assert.ok(Number(reports.firstUse.pf) > 0 && Number(reports.firstUse.hl) > 0);
  assert.equal(reports.firstUse.rows, 0);
  assert.equal(reports.firstUse.id, '');
  assert.ok(reports.firstUse.ranges.every((x) => x === '待核实 Vest 规格'));
  assert.ok(reports.firstUse.status.includes('高级详情'));
  assert.deepEqual(b.faults, []);
  if (process.env.VEST_EVIDENCE)
    await writeFile(process.env.VEST_EVIDENCE, JSON.stringify(reports, null, 2) + '\n');
  console.log('VEST_INTAKE_BROWSER_OK', JSON.stringify(reports));
} finally {
  await b.close();
}
