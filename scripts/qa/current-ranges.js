import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { calculateCurrent } from '../../src/hedge/current.js';
import { dec } from '../../src/hedge/math.js';
import { openTestBrowser } from './chrome.js';
const b = await openTestBrowser({ current: true });
const { run, wait, click, set, send, text } = b;
const evidence = [];
async function ready(condition = 'true') {
  try {
    await wait(
      "!document.querySelector('#scan-results').hidden&&document.querySelector('#scan-desk').dataset.state==='ready'&&document.querySelector('#scan-rows')?.rows.length>1 && (" +
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
    `(()=>{const t=id=>document.getElementById(id).textContent;return Object.fromEntries(['scan-status','scan-clock','scan-pf-quote','scan-hl-quote','scan-capital','scan-protect','scan-survive','scan-both','scan-both-count','scan-funded','scan-deadline','scan-profit','scan-profit-count','scan-intersection','scan-representative','scan-position','scan-cash','scan-fail-cash','scan-pass-cash','scan-pass-net','scan-risk','scan-buckets','scan-rows','trace-id'].map(k=>[k,t(k)]));})()`
  );
  evidence.push({ label, ...x });
  console.log(
    label,
    JSON.stringify([
      x['scan-protect'],
      x['scan-survive'],
      x['scan-profit'],
      x['scan-intersection'],
      x['scan-position'],
      x['scan-cash'],
      x['trace-id']
    ])
  );
}
try {
  await send('Page.navigate', { url: (process.env.CURRENT_URL ?? b.url) + '/' });
  await wait("!!document.querySelector('#desk-details > summary#scan-config')");
  assert.equal(await run("document.querySelector('#desk-details').open"), false);
  assert.ok(
    await run(
      "['funding-formula','leverage-grid','cash-results','rules','connections','search-coverage'].every(id=>document.getElementById(id).closest('#desk-details'))"
    )
  );
  console.log('RANGE12 极简首页与折叠详情通过');
  await ready("document.getElementById('scan-representative').textContent.includes('自动计算代表方案')");
  assert.ok(
    await run(`['scan-percent','scan-find','scan-reset','scan-slider','scan-smaller','scan-larger','scan-scale','scan-filter','scan-endpoint'].every(x=>!document.getElementById(x)) &&
    !document.getElementById('desk-details').open && !document.getElementById('scan-desk').innerText.includes('已选') &&
    !document.querySelector('#scan-desk input,#scan-desk select,#scan-rows [tabindex]')`)
  );
  assert.match(await text('#scan-capital'), /预设资金规划/);
  assert.equal(await text('#scan-profit'), '当前资金规则及已配置条件下，没有双路径净盈利比例。');
  assert.ok(await run("document.getElementById('profit-panel').classList.contains('no-profit')"));
  assert.ok(
    await run(
      "document.querySelectorAll('#scan-buckets .representative-range').length===1 && document.querySelector('#scan-buckets .representative-range th').title.includes('含代表方案')"
    )
  );
  assert.match(await text('#scan-funded'), /当前阶段不适用/);
  assert.match(await text('#scan-deadline'), /到期结果未知/);
  assert.match(
    await text('#scan-pass-net'),
    /假设 PF 自身净结算达到 12000.00 U.*满足 100.00 U 最低留存.*尚差/
  );
  assert.match(await text('#scan-intersection'), /500.00 U.*100.00 U/);
  await run("document.getElementById('desk-details').open=true");
  await ready("document.getElementById('trace-id').textContent.includes('AUTO-0.21')");
  await record('AUTOSEL01—AUTOSEL07 · 首次打开即自动展示两端与四个区间');
  await run("document.getElementById('subset-detail').parentElement.open=true");
  await click('#subset-detail > summary');
  await ready("document.getElementById('scan-subsets').rows.length>=7");
  const captured =
    await run(`(()=>{const el=id=>document.getElementById(id), doc=el('trace-inputs').parentElement;doc.open=true;doc.ontoggle();
    return {input:JSON.parse(el('trace-inputs').textContent), time:el('trace-sources').textContent.match(/计算于 (\\S+)/)[1],id:el('trace-id').textContent,
      rows:[...el('scan-rows').rows].map(tr=>[...tr.cells].map(td=>td.textContent)),
      subsets:[...el('scan-subsets').rows].map(tr=>[...tr.cells].map(td=>td.textContent)),
      rep:el('scan-representative').textContent,fail:el('scan-fail-cash').textContent,success:el('scan-pass-cash').textContent,
      cushion:el('scan-fail-net').textContent,thin:el('scan-fail-net').classList.contains('thin-buffer')};})()`);
  const { rules, accounts, market, rates, options } = captured.input;
  const x = calculateCurrent(rules, accounts, market, rates, Date.parse(captured.time), options);
  assert.ok(captured.id.endsWith(x.trace.id));
  const { sets, representative, buckets } = x.ratioScan;
  const keys = ['legal','protect','survive','both','failProfit','passProfit','profit'];
  const visible = buckets.filter(bin => bin.legal);
  assert.equal(captured.subsets.length, keys.length * visible.length);
  for (const [i, bin] of visible.entries()) for (const [j, key] of keys.entries()) {
    const row = captured.subsets[i * keys.length + j], values = bin.ranges[key];
    if (!values) { assert.equal(row[1], '0 组'); continue; }
    assert.ok(row[0].endsWith(values.count.toLocaleString('en-US') + ' 组'));
    assert.ok(row[1].includes(values.pfQty.join(' – ')));
    assert.ok(row[2].includes(values.hlQty.join(' – ')));
    if (key === 'both') {
      assert.ok(dec(values.failure[0]).gte(x.funding.B));
      assert.ok(dec(values.successHype[0]).gte(x.funding.R_success));
      assert.ok(row[3].includes(dec(values.failure[0]).toFixed(4) + ' U'));
      assert.ok(row[3].includes(dec(values.successHype[0]).toFixed(4) + ' U'));
    }
  }
  await click('#subset-detail > summary');
  assert.equal(representative.group, 'both');
  assert.equal(representative.objective, 'max_pf');
  assert.ok(captured.rep.includes(dec(representative.row.h).times(100).toFixed(4) + '%'));
  assert.equal(captured.fail, dec(representative.row.fail).toFixed(4) + ' U');
  assert.equal(captured.success, dec(representative.row.success).toFixed(4) + ' U');
  assert.equal(captured.thin, representative.row.cushion.thin);
  assert.ok(captured.cushion.includes('未设额外安全缓冲'));
  if (captured.thin) assert.match(captured.cushion, /极薄缓冲.*压力未验证/);
  for (const [n, k] of ['protect', 'survive', 'both', 'profit'].entries()) {
    assert.equal(
      buckets.reduce((acc, bin) => acc + bin[k], 0),
      sets[k].count
    );
    const range = sets[k].range;
    if (!range) {
      assert.match(captured.rows[n][1], /没有双路径净盈利比例|无符合条件的仓位/);
      continue;
    }
    assert.equal(range.count, sets[k].count);
    assert.ok(captured.rows[n][0].includes(range.count.toLocaleString('en-US')));
    assert.ok(captured.rows[n][1].includes(range.pfQty.join(' – ')));
    assert.ok(captured.rows[n][2].includes(range.hlQty.join(' – ')));
    assert.ok(captured.rows[n][3].includes(dec(range.failure[1]).toFixed(4) + ' U'));
    assert.ok(captured.rows[n][4].includes(dec(range.successFee[1]).toFixed(4) + ' U'));
  }
  evidence.push({
    label: 'AUTOSEL08 · 同帧资金快照与全部范围复算',
    trace: captured.id,
    representative: {
      h: representative.row.h,
      pf: representative.row.pf,
      hl: representative.row.hl,
      pfValue: representative.row.pfValue,
      hypeValue: representative.row.hypeValue,
      failure: representative.row.fail,
      success: representative.row.successPersonal,
      cushion: representative.row.cushion
    },
    sets: Object.fromEntries(['protect', 'survive', 'both', 'profit'].map((k) => [k, sets[k]])),
    buckets
  });
  await run("document.getElementById('desk-details').open=false");
  await click('#scan-config');
  assert.ok(await run("document.getElementById('desk-details').open"));
  await run(
    "document.getElementById('scan-detail').open=true;document.getElementById('scan-detail').ontoggle()"
  );
  assert.match(await text('#scan-audit'), /调仓深度滑点/);
  await run("document.getElementById('desk-details').open=false");
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
  await run("document.getElementById('desk-details').open=true");
  const prior = await text('#trace-id');
  await ready("document.querySelector('#trace-id').textContent!==" + JSON.stringify(prior));
  await record('PATH06 · 下一帧主网行情');
  await set('#recoveryBuffer', '1', 'input');
  await ready("document.getElementById('scan-fail-net').textContent.includes('额外缓冲要求 1.00 U')");
  const phr = await text('#scan-position');
  if (!phr.includes('仅作路径对照')) assert.ok(parseFloat(await text('#scan-fail-cash')) >= 501);
  await record('安全缓冲改为 1 U 后重新求解');
  await set('#recoveryBuffer', '', 'input');
  await ready();
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
    "document.getElementById('scan-status').textContent.includes('更新中') && document.getElementById('scan-status').textContent.includes('上次完成')",
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
