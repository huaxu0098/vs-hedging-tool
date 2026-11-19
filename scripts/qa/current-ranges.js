import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openTestBrowser } from './chrome.js';
const b = await openTestBrowser({ current: true });
const { run, wait, click, set, send, text } = b;
const evidence = [];
async function ready(condition = 'true') {
  try {
    await wait(
      "!document.querySelector('#scan-results').hidden&&!document.querySelector('#scan-results').inert&&document.querySelector('#scan-rows')?.rows.length>1 && (" +
        condition +
        ')',
      65000
    );
  } catch (e) {
    throw Error(e.message + ' ' + (await text('#scan-status')));
  }
}
async function record(label) {
  const x = await run(
    `(()=>{const t=id=>document.getElementById(id).textContent;return Object.fromEntries(['scan-status','scan-clock','scan-pf-quote','scan-hl-quote','scan-capital','scan-protect','scan-survive','scan-profit','scan-profit-count','scan-intersection','scan-selected','scan-cash','scan-risk','scan-rows','trace-id'].map(k=>[k,t(k)]));})()`
  );
  evidence.push({ label, ...x });
  console.log(
    label,
    JSON.stringify([
      x['scan-protect'],
      x['scan-survive'],
      x['scan-profit'],
      x['scan-intersection'],
      x['scan-selected'],
      x['scan-cash'],
      x['trace-id']
    ])
  );
}
try {
  await send('Page.navigate', { url: (process.env.CURRENT_URL ?? b.url) + '/' });
  await wait("typeof document.querySelector('#scan-config')?.onclick==='function'");
  assert.equal(await run("document.querySelector('#desk-details').open"), false);
  assert.ok(
    await run(
      "['funding-formula','leverage-grid','cash-results','rules','connections','search-coverage'].every(id=>document.getElementById(id).closest('#desk-details'))"
    )
  );
  console.log('RANGE12 极简首页与折叠详情通过');
  await click('#scan-config');
  assert.equal(await run("document.querySelector('#desk-details').open"), true);
  assert.ok(await run("document.querySelector('#plan-cross-flat').getBoundingClientRect().width>0 && !document.querySelector('#desk-details').hidden"));
  await click('#plan-cross-flat');
  await run("document.querySelector('#desk-details').open=false");
  await ready();
  await record('规划 · 未选终点');
  assert.match(await text('#scan-pf-quote'), /\d{2}:\d{2}:\d{2}\.\d{3}/);
  assert.equal(await text('#scan-profit'), '待选择终点');
  await set('#scan-endpoint', 'pass');
  await ready("document.querySelector('#scan-profit').textContent==='无'");
  await record('考核成功 · 到账前');
  assert.match(await text('#scan-intersection'), /没有同时满足/);
  await set('#scan-endpoint', 'fail');
  await ready("document.querySelector('#scan-profit').textContent.includes('%')");
  await record('考核失败 · 条件盈利');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  });
  assert.ok(
    await run('document.documentElement.scrollWidth <= document.documentElement.clientWidth+1'),
    '移动端不应出现整页横向滚动'
  );
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1390,
    height: 1040,
    deviceScaleFactor: 1,
    mobile: false
  });
  if (process.env.RANGE_CAPTURE) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.RANGE_CAPTURE, Buffer.from(shot.data, 'base64'));
  }
  await run("document.querySelector('#scan-rows tr:last-child').click()");
  await set('#scan-slider', '1', 'input');
  await set('#scan-percent', '16');
  await click('#scan-find');
  await ready("document.querySelector('#scan-selected').textContent.includes('16.0000%')");
  await record('直接定位 16%');
  await wait(
    "(()=>{const el=document.querySelector('#scan-detail');if(!el.open&&!document.querySelector('#scan-results').inert)el.querySelector('summary').click();return el.open&&document.querySelector('#scan-audit').textContent.includes('调仓深度滑点')})()",
    30000
  );
  const prior = await text('#trace-id');
  await ready("document.querySelector('#trace-id').textContent!==" + JSON.stringify(prior));
  await record('下一帧主网行情');
  await set('#quoteSecs', '60', 'input');
  await ready();
  // Induce a worker timeout only after successful mainnet scans. Source data and other cases stay live.
  await run(`(()=>{const original=Worker.prototype.postMessage;window.resumeRangeWorker=()=>Worker.prototype.postMessage=original;
 Worker.prototype.postMessage=function(){};
 window.timeoutSeen=false;new MutationObserver(()=>{if(document.getElementById('scan-status').textContent.includes('超过 10 秒'))window.timeoutSeen=true}).observe(document.getElementById('scan-status'),{subtree:true,childList:true,characterData:true});})()`);
  await set('#R_free', '5', 'input');
  await wait(
    "document.getElementById('scan-status').textContent.includes('重算') && document.getElementById('scan-status').textContent.includes('上次完成')",
    1000
  );
  await wait('window.timeoutSeen', 18000);
  console.log('RANGE08 已在浏览器实际触发超时并显示上版和原因');
  await run('window.resumeRangeWorker()');
  await set('#R_free', '0', 'input');
  await ready();
  await set('#funding-view', 'account');
  assert.ok(
    await run(
      "document.querySelector('#scan-results').hidden && document.querySelector('#hl-equity').value===''"
    )
  );
  await record('切换到未接入的真实账户');
  assert.deepEqual(b.faults, []);
  if (process.env.RANGE_EVIDENCE)
    await writeFile(process.env.RANGE_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  console.log('RANGE_BROWSER_OK');
} finally {
  await b.close();
}
