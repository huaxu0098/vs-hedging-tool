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
    `(()=>{const t=id=>document.getElementById(id).textContent;return Object.fromEntries(['scan-status','scan-clock','scan-pf-quote','scan-hl-quote','scan-capital','scan-protect','scan-survive','scan-both','scan-both-count','scan-funded','scan-deadline','scan-profit','scan-profit-count','scan-intersection','scan-selected','scan-cash','scan-fail-cash','scan-pass-cash','scan-pass-net','scan-risk','scan-buckets','scan-rows','trace-id'].map(k=>[k,t(k)]));})()`
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
  assert.ok(
    await run(
      "document.querySelector('#plan-cross-flat').getBoundingClientRect().width>0 && !document.querySelector('#desk-details').hidden"
    )
  );
  await click('#plan-cross-flat');
  await run("document.querySelector('#desk-details').open=false");
  await ready();
  assert.equal(
    await run(
      "document.querySelector('#scan-endpoint')===null && !document.body.innerText.includes('选择条件路径')"
    ),
    true
  );
  assert.match(await text('#scan-pf-quote'), /\d{2}:\d{2}:\d{2}\.\d{3}/);
  await ready("document.querySelector('#scan-both').textContent.includes('%')");
  assert.match(await text('#scan-funded'), /不适用/);
  assert.match(await text('#scan-deadline'), /到期结果未知/);
  assert.match(await text('#scan-profit'), /当前已定义路径下无净盈利比例/);
  await record('PATH01/02/05/07 · 规划资金和主网双边实时行情，默认并行结算');
  await set('#scan-percent', '15.3739');
  await click('#scan-find');
  await ready("document.querySelector('#scan-rows tr[aria-selected=true]')?.dataset.both==='true'");
  const point = await run(
    "(()=>{const t=id=>document.getElementById(id).textContent;return [t('scan-selected'),parseFloat(t('scan-fail-cash')),parseFloat(t('scan-pass-cash')),t('scan-pass-net')]})()"
  );
  assert.ok(point[1] >= 500 && point[2] >= 100 && point[3].includes('相对总投入 -'));

  assert.ok(await run("document.querySelector('#scan-buckets').rows.length>=2"));
  assert.match(point[0], /15\.3739%/);
  assert.match(await text('#scan-fail-net'), /在此路径下，收回保护本金/);
  assert.match(point[3], /未收回保护本金.*达到最低留存/);
  await record('PATH03/04/08 · 定位请求 15.3739%，本次报价最近的双路径保护仓位');
  await set('#scan-filter', 'both');
  await ready();
  assert.ok(
    await run("[...document.querySelector('#scan-rows').rows].every(row=>row.dataset.both==='true')")
  );
  await set('#scan-filter', 'protect');
  await ready();
  const upper = await run(`(()=>{const rows=[...document.querySelector('#scan-rows').rows];
    const hi=Number(document.getElementById('scan-survive').textContent.split('–').at(-1).replace('%','').trim());
    const row=rows.find(r=>parseFloat(r.cells[0].textContent)>hi && r.dataset.both==='false');
    if(row)row.click();return row?.cells[0].textContent})()`);
  assert.match(upper, /仅失败回本/);
  await record('PATH04 · 成功留存上限之外的失败回本仓位');
  await set('#scan-filter', 'profit');
  await wait(
    "document.querySelector('#scan-rows').rows.length===0 && document.querySelector('#scan-focus').hidden"
  );
  await set('#scan-filter', 'legal');
  await ready();
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
  const scale = await run(`(()=>{const el=id=>document.getElementById(id);
    el('scan-side').value='1';el('scan-size').value='0.05';el('scan-scale').click();
    const selected=()=>el('scan-rows').querySelector('[aria-selected=true]')?.dataset.point;
    const before=selected();el('scan-larger').click();return [before,selected()]})()`);
  assert.ok(scale[0] && scale[1]);
  const [[side, i, j], [nextSide, ii, jj]] = scale.map((key) => key.split('/').map(Number));
  assert.ok(nextSide === side && ii > i && j * ii === jj * i, '同向仓位增加且精确数量比不变');
  await record('PATH08 · 同方向同一精确比例的另一个仓位规模');
  await wait(
    "(()=>{const el=document.querySelector('#scan-detail');if(!el.open&&!document.querySelector('#scan-results').inert)el.querySelector('summary').click();return el.open&&document.querySelector('#scan-audit').textContent.includes('调仓深度滑点')})()",
    30000
  );
  const prior = await text('#trace-id');
  await ready("document.querySelector('#trace-id').textContent!==" + JSON.stringify(prior));
  await record('PATH06 · 下一帧主网行情');
  await set('#R_success', '106', 'input');
  await ready("document.querySelector('#scan-capital').textContent.includes('106.00 U')");
  await record('PATH06 · 最低留存改为 106 U');
  await set('#R_success', '100', 'input');
  await ready("document.querySelector('#scan-capital').textContent.includes('最低留存 100.00 U')");
  await set('#quoteSecs', '60', 'input');
  await ready();
  // Hold this actual source frame and its original timestamps steady during the 10-second fault.
  await run(`(()=>{const el=id=>document.getElementById(id), box=el('trace-inputs').parentElement;
    box.open=true;box.ontoggle();el('manual-quote').value=JSON.stringify(JSON.parse(el('trace-inputs').textContent).market);
    el('confirm-quote').click()})()`);
  await ready("document.querySelector('#scan-clock').textContent.includes('手工确认盘口')");
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
  await set('#quote-source', 'api');
  await set('#R_free', '0', 'input');
  await ready();
  await set('#stage', 'funded', 'input');
  await ready("document.querySelector('#scan-funded').textContent.includes('目标可分 80.00 U')");
  assert.match(await text('#scan-funded'), /已确认到账 未知/);
  assert.match(await text('#scan-deadline'), /当前阶段不适用/);
  await record('Funded · 两端平仓现金、80 U 分成与实际到账状态');
  await set('#stage', 'challenge', 'input');
  await ready();
  const cutoff = await run(
    '(()=>{const d=new Date(Date.now()+86400000);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16)})()'
  );
  await set('#deadline', cutoff, 'input');
  await ready("document.querySelector('#scan-deadline').textContent==='到期结果未知'");
  const mark = await text('#scan-pf-price');
  await set('#deadlineMark', mark, 'input');
  await ready("document.querySelector('#scan-deadline-note').textContent.includes('按指定截止价')");
  await record('PATH07 · 配置截止时间与明确压力终点后的条件结算');
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
