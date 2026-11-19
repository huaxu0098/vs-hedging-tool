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
          bins:s.buckets.flatMap((b,index)=>{
            if(!b.legal)return [];
            const groups=[b.risk?'risk':'legal'];
            if(b.both && b.both<b.risk)groups.push('both');
            return groups.map(group=>{
              const v=b.ranges[group];
              return {group,index,both:b.both,risk:b.risk,count:v.count,pf:v.pfValue,hl:v.hlValue,qa:v.pfQty,qb:v.hlQty,
                fail:v.failure,pass:v.successHype,protect:b.protect,survive:b.survive,profit:b.profit,above:b.above,through:b.through};
            });
          })};
      }});
    }
    if(test.hold) {const handler=this.onmessage.bind(this);test.held.push({job,send:()=>post.call(this,job,...args),handler});return}
    return post.call(this,job,...args);
  };
  let lastId, firstRow, main, root, region, firstCell, previousQuote, neighborBody, neighborCell;
  function frame() {
    const e=id=>document.getElementById(id),desk=e('scan-desk');
    if(lastId) {
      test.elapsedMs=performance.now()-test.started;
      if(document.querySelector('main')!==main || desk!==root || e('scan-results')!==region) test.remounts=(test.remounts||0)+1;
      if (!desk) {test.blanks++;requestAnimationFrame(frame);return}
      const quote=['pf','hl'].flatMap(k=>['bid','ask'].map(side=>e('scan-'+k+'-'+side).textContent)).join('|');
      if(quote!==previousQuote){test.quoteChanges=(test.quoteChanges||0)+1;previousQuote=quote}
      test.paints++;
      if(desk.dataset.state==='updating') test.pendingPaints++;
      if(desk.dataset.state==='paused') test.pausedPaints++;
      if(e('scan-focus').hidden || e('scan-results').hidden || !e('scan-fail-cash').textContent ||
        !e('scan-pass-cash').textContent || ['scan-pass-cash','scan-fail-cash'].some(k=>e(k).textContent==='—') || !e('scan-buckets').rows.length || ['protect','survive','both','profit'].some(k=>!e('scan-'+k).textContent || e('scan-'+k).textContent.includes('等待有效数据'))) test.blanks++;
      if(e('ratio-analysis').hidden || !e('ratio-neighbors').rows.length ||
        !e('ratio-neighbors').querySelector('.representative-range') || !e('ratio-counts').textContent) test.neighborBlanks=(test.neighborBlanks||0)+1;
      if(neighborBody!==e('ratio-neighbors') || neighborCell!==e('ratio-neighbors').rows[0]?.cells[0]) test.neighborRemounts=(test.neighborRemounts||0)+1;
      const rect=region.getBoundingClientRect(), style=getComputedStyle(region);
      if(rect.height===0 || style.visibility==='hidden' || Number(style.opacity)===0) test.blanks++;
      if(region.inert || getComputedStyle(region).userSelect==='none') test.unreadable=true;
      if(e('scan-buckets').rows[0]!==firstRow || e('scan-buckets').rows[0]?.cells[0]!==firstCell) test.replacedFirstRow=true;
    }
    const id=desk?.dataset.resultId;
    if(id && id!==lastId && test.results[id]){
      if(!root){test.started=performance.now();main=document.querySelector('main');root=desk;region=e('scan-results');neighborBody=e('ratio-neighbors');neighborCell=neighborBody.rows[0]?.cells[0];firstCell=e('scan-buckets').rows[0]?.cells[0]}
      firstRow??=e('scan-buckets').rows[0];lastId=id;
      test.commits.push({ ...test.results[id], prices:[e('scan-pf-price').textContent,e('scan-hl-price').textContent],
        cash:[e('scan-fail-cash').textContent,e('scan-pass-cash').textContent], position:e('scan-position').textContent,
        rows:[...e('scan-buckets').rows].map(tr=>({index:Number(tr.dataset.band),group:tr.dataset.subset,cells:[...tr.cells].map(td=>td.innerText)})),
        height:e('scan-results').getBoundingClientRect().bottom, status:e('scan-status').textContent});
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})()`;
const cash = (v) => dec(v).toFixed(4) + ' U';
try {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: install });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false
  });
  await send('Page.navigate', { url });
  await wait(
    'window.scanTest?.commits.length>=4 && window.scanTest.pendingPaints>2 && window.scanTest.elapsedMs>=60000',
    125000
  );
  assert.ok(await run(`!document.getElementById('desk-details').open && !document.getElementById('scan-basis') &&
    document.querySelectorAll('#scan-desk > section').length===4 &&
    !/USDC_per_USDT|参考价差|相邻仓位|[0-9,]+ 组|AUTO_|杠杆档位|费用流水/.test(document.body.innerText) &&
    ['pf','hl'].every(k=>['bid','ask','price'].every(s=>Number(document.getElementById('scan-'+k+'-'+s).textContent)>0))`));
  const frames = await run('window.scanTest.commits');
  for (const f of frames) {
    assert.ok(f.status.includes('结果时间'));
    assert.equal(f.rows.length, f.bins.length);
    assert.deepEqual(f.cash, [cash(f.rep.fail), cash(f.rep.success)]);
    assert.ok(f.prices.every((px) => Number(px) > 0));
    const range = (values, digits) => {
      const parts = values.map(x => digits == null ? x : dec(x).toFixed(digits));
      return dec(values[0]).eq(values[1]) ? parts[0] : parts.join(' – ');
    };
    for (const bin of f.bins) {
      const matches = f.rows.filter(row => row.index === bin.index && row.group === bin.group);
      assert.equal(matches.length,1);
      const cells = matches[0].cells;
      assert.equal(cells.length,6);
      for (const [j, values, qty] of [[1,bin.pf,bin.qa],[2,bin.hl,bin.qb]])
        assert.equal(cells[j],range(values,2)+'\n'+range(qty)+' BTC');
      assert.equal(cells[3],bin.group==='legal'?'未验证':range(bin.fail,4));
      assert.equal(cells[4],bin.group==='legal'?'未验证':range(bin.pass,4));
      if(bin.group==='both' || (bin.group==='risk' && bin.risk===bin.both)) {
        assert.ok(bin.fail.every(v=>dec(v).gte(f.protect)) && bin.pass.every(v=>dec(v).gte(f.reserve)));
        assert.ok(cells[5].includes('失败回本 · 成功留存'));
      } else if(bin.group==='legal') assert.ok(cells[5].includes('未通过'));
      else {
        if(bin.protect<bin.risk) assert.match(cells[5],/未回本|无法回本/);
        if(bin.survive<bin.risk) assert.match(cells[5],/留存不足/);
      }
    }
    assert.ok(f.height<=720,'主要计算区域超出桌面首屏 '+f.height);
  }
  assert.ok(frames.every((f, i) => !i || f.sequence > frames[i - 1].sequence));
  assert.ok(frames.slice(1).some((f) => f.revaluation.marketOnly));
  evidence.example = frames[0].bins.filter((b) => b.group === 'both').sort((a, b) => b.count - a.count)[0];
  assert.ok(new Set(frames.map((f) => JSON.stringify(f.bins))).size > 1);
  evidence.live = frames.map(({ rows, bins, ...f }) => ({ ...f, bands: bins.length }));
  evidence.observation = await run(
    '(({paints,pendingPaints,blanks,neighborBlanks=0,neighborRemounts=0,replacedFirstRow=false,remounts=0,unreadable=false,posted,elapsedMs,quoteChanges})=>({paints,pendingPaints,blanks,neighborBlanks,neighborRemounts,replacedFirstRow,remounts,unreadable,posted,elapsedMs,quoteChanges}))(window.scanTest)'
  );
  evidence.viewports = [];
  for (const [width,height] of [[1280,720],[390,844],[1440,900]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});
    const layout = await run(`(() => {
      const at = selector => Math.ceil(document.querySelector(selector).getBoundingClientRect().bottom);
      return {width:innerWidth, height:innerHeight, contentWidth:document.documentElement.scrollWidth,
        quotes:at('.book-table'), cash:at('#scan-cash'), ranges:at('.scan-sets'),
        secondBand:at('#scan-buckets tr:nth-child(2)'), table:at('#scan-results')};
    })()`);
    assert.ok(layout.contentWidth <= width && layout.secondBand <= height, JSON.stringify(layout));
    if (width>=1000) assert.ok(layout.table <= height, JSON.stringify(layout));
    evidence.viewports.push(layout);
  }
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
  assert.equal(evidence.observation.neighborBlanks, 0);
  assert.equal(evidence.observation.neighborRemounts, 0);
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
