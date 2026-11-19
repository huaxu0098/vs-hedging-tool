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
          revaluation:r.revaluation, sequence:data.version, protect:s.ctx.book.B, reserve:s.ctx.params.R,
          rep:rep && {pf:rep.pfValue, hl:rep.hypeValue, fail:rep.fail, success:rep.success},
          bins:s.buckets.filter(b=>b.legal).map(b=>{
            const group=['both','protect','survive','risk','legal'].find(k=>b.ranges[k]), v=b.ranges[group];
            return {group,above:b.above,through:b.through,count:v.count,pf:v.pfValue,hl:v.hlValue,qa:v.pfQty,qb:v.hlQty,fail:v.failure,pass:v.successHype,
              consume:v.consumption[1],rawFailure:b.ranges.legal.failure,rawSuccess:b.ranges.legal.successHype,
              failProfit:b.failProfit,passProfit:b.passProfit,profit:b.profit};
          })};
      }});
    }
    if(test.hold) {const handler=this.onmessage.bind(this);test.held.push({job,send:()=>post.call(this,job,...args),handler});return}
    return post.call(this,job,...args);
  };
  let lastId, firstRow, main, root, region, firstCell, previousQuote;
  function frame() {
    const e=id=>document.getElementById(id),desk=e('scan-desk');
    if(lastId) {
      test.elapsedMs=performance.now()-test.started;
      if(document.querySelector('main')!==main || desk!==root || e('scan-results')!==region) test.remounts=(test.remounts||0)+1;
      if (!desk) {test.blanks++;requestAnimationFrame(frame);return}
      const quote=e('scan-pf-quote').textContent+e('scan-hl-quote').textContent;
      if(quote!==previousQuote){test.quoteChanges=(test.quoteChanges||0)+1;previousQuote=quote}
      test.paints++;
      if(desk.dataset.state==='updating') test.pendingPaints++;
      if(desk.dataset.state==='paused') test.pausedPaints++;
      if(e('scan-focus').hidden || e('scan-results').hidden || !e('scan-fail-cash').textContent ||
        !e('scan-pass-cash').textContent || !e('scan-buckets').rows.length || ['protect','survive','both','profit'].some(k=>!e('scan-'+k).textContent || e('scan-'+k).textContent.includes('等待有效数据'))) test.blanks++;
      const rect=region.getBoundingClientRect(), style=getComputedStyle(region);
      if(rect.height===0 || style.visibility==='hidden' || Number(style.opacity)===0) test.blanks++;
      if(region.inert || getComputedStyle(region).userSelect==='none') test.unreadable=true;
      if(e('scan-buckets').rows[0]!==firstRow || e('scan-buckets').rows[0]?.cells[0]!==firstCell) test.replacedFirstRow=true;
    }
    const id=desk?.dataset.resultId;
    if(id && id!==lastId && test.results[id]){
      if(!root){test.started=performance.now();main=document.querySelector('main');root=desk;region=e('scan-results');firstCell=e('scan-buckets').rows[0]?.cells[0]}
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
  await wait(
    'window.scanTest?.commits.length>=4 && window.scanTest.pendingPaints>2 && window.scanTest.elapsedMs>=60000',
    125000
  );
  const frames = await run('window.scanTest.commits');
  for (const f of frames) {
    assert.ok(f.status.includes('结果时间'));
    assert.equal(f.rows.length, f.bins.length);
    assert.deepEqual(f.cash, [cash(f.rep.fail), cash(f.rep.success)]);
    assert.ok(f.prices.every((px) => Number(px) > 0));
    for (const [i, bin] of f.bins.entries()) {
      const cells = f.rows[i];
      for (const [j, values, qty] of [
        [1, bin.pf, bin.qa],
        [2, bin.hl, bin.qb]
      ]) {
        assert.ok(cells[j].includes(qty.join(' – ')), cells[j]);
        for (const v of values) assert.ok(cells[j].includes(dec(v).toFixed(2) + ' U'), cells[j]);
      }
      assert.ok(cells[0].includes(bin.count.toLocaleString('en-US')));
      if (bin.group !== 'legal') {
        assert.equal(cells[3], bin.fail.map(cash).join(' – '));
        assert.equal(cells[4], bin.pass.map(cash).join(' – '));
      }
      if (bin.group === 'both') {
        assert.ok(bin.fail.every((v) => dec(v).gte(f.protect)));
        assert.ok(bin.pass.every((v) => dec(v).gte(f.reserve)));
      }
      assert.ok(cells[5].includes(pct(bin.consume)));
    }
    assert.ok(f.height <= 900, '主要计算区域超出桌面首屏 ' + f.height);
  }
  assert.ok(frames.every((f, i) => !i || f.sequence > frames[i - 1].sequence));
  assert.ok(frames.slice(1).some((f) => f.revaluation.marketOnly));
  evidence.example = frames[0].bins.filter((b) => b.group === 'both').sort((a, b) => b.count - a.count)[0];
  assert.ok(new Set(frames.map((f) => JSON.stringify(f.bins))).size > 1);
  evidence.live = frames.map(({ rows, bins, ...f }) => ({ ...f, bands: bins.length }));
  evidence.observation = await run(
    '(({paints,pendingPaints,blanks,replacedFirstRow=false,remounts=0,unreadable=false,posted,elapsedMs,quoteChanges})=>({paints,pendingPaints,blanks,replacedFirstRow,remounts,unreadable,posted,elapsedMs,quoteChanges}))(window.scanTest)'
  );
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
  assert.ok(evidence.observation.elapsedMs >= 60000 && evidence.observation.quoteChanges > 1);
  assert.equal(evidence.observation.remounts, 0);
  assert.equal(evidence.observation.unreadable, false);
  assert.equal(evidence.observation.blanks, 0);
  assert.equal(evidence.observation.replacedFirstRow, false);
  assert.deepEqual(b.faults, []);
  if (process.env.UI_EVIDENCE)
    await writeFile(process.env.UI_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  console.log('STABLE_BROWSER_OK', JSON.stringify(evidence));
} finally {
  await b.close();
}
