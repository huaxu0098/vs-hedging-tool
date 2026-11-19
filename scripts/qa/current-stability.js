// Observe actual Chromium paints and Worker traffic. Price/position/cash evidence
// comes from unmodified public quotes, before any controlled delivery fault.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dec } from '../../src/hedge/math.js';
import { openTestBrowser } from './chrome.js';

const b = await openTestBrowser({ current: true });
const { run, send, wait, set } = b;
const url = process.env.CURRENT_URL || b.url;
const evidence = {};
const ready =
  "document.querySelector('#scan-desk')?.dataset.state==='ready' && !document.querySelector('#scan-focus').hidden";
const install = `(() => {
  const test = window.scanTest = {posted:0, pendingPaints:0, pausedPaints:0, blanks:0, late:false, paints:0, commits:[], results:{}, held:[]};
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage=function(job,...args) {
    if (!job.m) return post.call(this,job,...args);
    test.posted++;
    if (!this.observed) {
      this.observed=true;
      this.addEventListener('message',({data})=>{if(data.result?.ratioScan) {
        const r=data.result, s=r.ratioScan, rep=s.representative?.row;
        const key=r.trace.id;
        test.results[key]={id:key, started:r.startedAt,finished:r.finishedAt,ms:r.solveMs,
          pfMark:s.ctx.market.pf.mark,hlMark:s.ctx.market.hl.mark, count:s.sets.legal.count,
          rep:rep && {pf:rep.pfValue, hl:rep.hypeValue, fail:rep.fail, success:rep.successPersonal},
          bins:s.buckets.filter(b=>b.range).map(b=>({pf:b.range.pfValue,hl:b.range.hlValue,qa:b.range.pfQty,qb:b.range.hlQty,fail:b.range.failure,pass:b.range.success,im:b.range.maxMarginRate}))};
      }});
    }
    if(test.hold) {const handler=this.onmessage.bind(this);test.held.push({job,send:()=>post.call(this,job,...args),handler});return}
    return post.call(this,job,...args);
  };
  let lastId, firstRow;
  function frame() {
    const e=id=>document.getElementById(id),desk=e('scan-desk');
    if(desk && lastId){
      test.paints++;
      if(desk.dataset.state==='updating') test.pendingPaints++;
      if(desk.dataset.state==='paused') test.pausedPaints++;
      if(e('scan-focus').hidden || e('scan-results').hidden || !e('scan-fail-cash').textContent ||
        !e('scan-pass-cash').textContent || !e('scan-buckets').rows.length || /等待有效数据/.test(e('scan-protect').textContent)) test.blanks++;
      if(e('scan-buckets').rows[0]!==firstRow) test.replacedFirstRow=true;
    }
    const id=desk?.dataset.resultId;
    if(id && id!==lastId && desk.dataset.state==='ready' && test.results[id]){
      firstRow??=e('scan-buckets').rows[0];lastId=id;
      test.commits.push({ ...test.results[id], prices:[e('scan-pf-price').textContent,e('scan-hl-price').textContent],
        cash:[e('scan-fail-cash').textContent,e('scan-pass-cash').textContent], position:e('scan-position').textContent,
        rows:[...e('scan-buckets').rows].map(tr=>[...tr.cells].map(td=>td.innerText)),
        height:e('scan-results').getBoundingClientRect().bottom, status:e('scan-status').textContent});
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})()`;
const cash = (v) => dec(v).toFixed(4) + ' U';
const pct = (v) => dec(v).times(100).toFixed(2) + '%';
try {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: install });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  await send('Page.navigate', { url });
  await wait('window.scanTest?.commits.length>=4 && window.scanTest.pendingPaints>2', 65000);
  const frames = await run('window.scanTest.commits.slice(0,4)');
  for (const f of frames) {
    assert.ok(f.status.includes(f.id));
    assert.equal(f.rows.length, f.bins.length);
    assert.deepEqual(f.cash, [cash(f.rep.fail), cash(f.rep.success)]);
    assert.deepEqual(f.prices, [dec(String(f.pfMark)).toFixed(2), dec(String(f.hlMark)).toFixed(2)]);
    for (const [i, bin] of f.bins.entries()) {
      const cells = f.rows[i];
      for (const [j, values, qty] of [
        [1, bin.pf, bin.qa],
        [2, bin.hl, bin.qb]
      ]) {
        assert.ok(cells[j].includes(qty.join(' – ')), cells[j]);
        for (const v of values) assert.ok(cells[j].includes(dec(v).toFixed(2) + ' U'), cells[j]);
      }
      assert.equal(cells[3], bin.fail.map(cash).join(' – '));
      assert.equal(cells[4], bin.pass.map(cash).join(' – '));
      assert.ok(cells[5].includes(pct(bin.im)));
    }
    assert.ok(f.height <= 900, '主要计算区域超出桌面首屏 ' + f.height);
  }
  assert.ok(new Set(frames.map((f) => JSON.stringify(f.bins))).size > 1);
  evidence.live = frames.map(({ rows, bins, ...f }) => ({ ...f, bands: bins.length }));
  // Hold one legitimate request, supersede it with a new rule, then deliver
  // the old response after dispatch. It must never become visible.
  await run('window.scanTest.hold=true');
  await set('#R_success', '98', 'input');
  await wait('window.scanTest.held.length===1');
  await set('#R_success', '97', 'input');
  await wait('window.scanTest.held.length>=2');
  const stableId = await run("document.getElementById('scan-desk').dataset.resultId");
  assert.ok(
    await run(
      "document.getElementById('scan-desk').dataset.state==='updating' && !document.getElementById('scan-results').hidden"
    )
  );
  await run(
    "(()=>{const t=window.scanTest; t.held[0].handler({data:{version:t.held[0].job.version,error:'INVALID_LATE_TEST'}}); t.hold=false; t.held.at(-1).send()})()"
  );
  await wait(
    ready + " && document.getElementById('scan-desk').dataset.resultId!==" + JSON.stringify(stableId)
  );
  assert.ok(
    await run(
      "!document.body.textContent.includes('INVALID_LATE_TEST') && document.getElementById('scan-pass-summary').textContent.includes('97.00 U')"
    )
  );
  evidence.observation = await run(
    '(({paints,pendingPaints,blanks,replacedFirstRow=false,posted})=>({paints,pendingPaints,blanks,replacedFirstRow,posted}))(window.scanTest)'
  );
  assert.equal(evidence.observation.blanks, 0);
  assert.equal(evidence.observation.replacedFirstRow, false);
  assert.deepEqual(b.faults, []);
  if (process.env.UI_EVIDENCE)
    await writeFile(process.env.UI_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  console.log('STABLE_BROWSER_OK', JSON.stringify(evidence));
} finally {
  await b.close();
}
