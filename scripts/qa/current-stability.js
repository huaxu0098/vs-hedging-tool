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
          plans:['最大 PF 仓位','失败回收优先','成功留存优先'].map(label=>s.plans.rows.find(row=>row.labels.includes(label))).filter(Boolean),
          fixed:s.plans.fixed, comparison:s.plans.comparison, comparisonRows:s.plans.rows.filter(row=>row.labels.includes('同 h 规模对照')),
          joint:{count:s.sets.both.count,min:s.sets.both.min,max:s.sets.both.max,minCount:s.sets.both.minCount,maxCount:s.sets.both.maxCount,
            counts:s.buckets.map(bin=>[bin.edgeKey,bin.both])}, rep:rep && {pf:rep.pfValue, hl:rep.hypeValue, fail:rep.fail, success:rep.success},
          bins:s.buckets.flatMap((b,index)=>{
            if(!b.legal)return [];
            return ['legal','protect','survive','both'].map(group=>{
              const v=b.ranges[group];
              return {group,index,count:b[group], pf:v?.pfValue,hl:v?.hlValue,qa:v?.pfQty,qb:v?.hlQty,
                fail:v?.failure,pass:v?.successHype,fee:v?.failureFee,exitFee:v?.successFee,
                margin:[v?.minMargin,v?.maxMargin],distance:[v?.minBuffer,v?.maxBuffer]};
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
      if(desk.dataset.state==='updating') {
        test.pendingPaints++;
        if(!/重算/.test(e('scan-status').textContent) || e('scan-status').textContent.includes('当前数据有效')) test.conflict=true;
      }
      if(desk.dataset.state==='ready' && !e('scan-status').textContent.includes('当前数据有效 · 条件估算')) test.conflict=true;
      if(desk.dataset.state==='paused') test.pausedPaints++;
      if(e('scan-focus').hidden || e('scan-results').hidden || !e('scan-fail-cash').textContent ||
        !e('scan-pass-cash').textContent || ['scan-pass-cash','scan-fail-cash'].some(k=>e(k).textContent==='—') || e('plan-comparison').hidden || !e('plan-rows').rows[0]?.cells[1]?.textContent || !e('plan-columns').rows[0].cells[1]?.dataset.point || ['protect','survive','both','profit'].some(k=>!e('scan-'+k).textContent || e('scan-'+k).textContent.includes('等待有效数据'))) test.blanks++;
      if(e('ratio-analysis').hidden || !e('ratio-neighbors').rows.length ||
        !e('ratio-neighbors').querySelector('.representative-range') || !e('ratio-counts').textContent) test.neighborBlanks=(test.neighborBlanks||0)+1;
      if(neighborBody!==e('ratio-neighbors') || neighborCell!==e('ratio-neighbors').rows[0]?.cells[0]) test.neighborRemounts=(test.neighborRemounts||0)+1;
      const rect=region.getBoundingClientRect(), style=getComputedStyle(region);
      if(rect.height===0 || style.visibility==='hidden' || Number(style.opacity)===0) test.blanks++;
      if(region.inert || getComputedStyle(region).userSelect==='none') test.unreadable=true;
      if(e('plan-rows').rows[0]!==firstRow || e('plan-rows').rows[0]?.cells[1]!==firstCell) test.replacedFirstRow=true;
    }
    const id=desk?.dataset.resultId;
    if(id && id!==lastId && test.results[id]){
      if(!root){test.started=performance.now();main=document.querySelector('main');root=desk;region=e('scan-results');neighborBody=e('ratio-neighbors');neighborCell=neighborBody.rows[0]?.cells[0];firstCell=e('plan-rows').rows[0]?.cells[1]}
      firstRow??=e('plan-rows').rows[0];lastId=id;
      test.commits.push({ ...test.results[id], prices:[e('scan-pf-price').textContent,e('scan-hl-price').textContent],
        cash:[e('scan-fail-cash').textContent,e('scan-pass-cash').textContent], position:e('scan-position').textContent,
        shown:[...e('plan-columns').rows[0].cells].slice(1).map((th,i)=>({
          key:th.dataset.point, scenario:th.lastElementChild.textContent,
          cells:Object.fromEntries([...e('plan-rows').rows].map(tr=>[tr.dataset.metric,tr.cells[i+1].textContent]))
        })), warning:e('max-risk').innerText,
        rows:[...e('scan-buckets').rows].map(tr=>({index:Number(tr.dataset.band),group:tr.dataset.subset,cells:[...tr.cells].map(td=>[...td.childNodes].map(n=>n.nodeName==='BR'?'\\n':(n.nodeName==='SMALL'?'\\n':'')+n.textContent).join(''))})),
        height:e('scan-results').getBoundingClientRect().bottom, status:e('scan-status').textContent});
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})()`;
function cash(v) {
  const amount = dec(v);
  return (!amount.isZero() && amount.abs().lt('0.0001')
    ? amount.toSignificantDigits(4).toString()
    : amount.toFixed(4)) + ' U';
}
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
  assert.equal(await run('Boolean(window.scanTest.conflict)'),false);
  assert.ok(await run("document.getElementById('plan-stress').textContent.includes('压力未配置')"));
  const frames = await run('window.scanTest.commits');
  for (const f of frames) {
    assert.ok(f.status.includes('最近成功计算'));
    assert.equal(f.rows.length, f.bins.length);
    assert.deepEqual(f.cash, [cash(f.rep.fail), cash(f.rep.success)]);
    assert.equal(f.shown.length, f.plans.length);
    assert.ok(f.plans.some(r=>r.labels.includes('最大 PF 仓位')));
    const two=(values,fmt)=>values.map(fmt).join(' – ');
    const money=x=>dec(x).toFixed(dec(x).abs().lt(1)&&!dec(x).isZero()?4:2)+' U';
    const pct=(x,digits)=>dec(x).times(100).toFixed(digits)+'%';
    const quantity=x=>(dec(x).isZero()?'空仓 ':dec(x).gt(0)?'多 ':'空 ')+dec(x).abs()+' BTC';
    const delta=x=>(dec(x).gt(0)?'+':'')+cash(x);
    for (const [i, plan] of f.plans.entries()) {
      const {key,scenario,cells}=f.shown[i];
      assert.equal(key,plan.key);
      assert.equal(scenario,'基础情景');
      assert.ok(dec(cells.h.slice(0,-1)).eq(dec(plan.h).times(100).toDecimalPlaces(cells.h.split('.')[1].length-1)));
      const distance = plan.distance == null ? '无已验证交点' : dec(plan.distance).toFixed(2)+' USDT';
      for(const [field,expected] of Object.entries({
        pf:quantity(plan.pf),hl:quantity(plan.hl),pfValue:money(plan.pfValue),hypeValue:money(plan.hypeValue),
        fail:cash(plan.fail),failDelta:delta(plan.failDelta),success:cash(plan.success),successDelta:delta(plan.successDelta),
        leverage:plan.leverage+'×',initial:money(plan.initial),marginRate:pct(plan.marginRate,2),free:money(plan.free),distance
      })) assert.equal(cells[field],expected,field+' / '+key);
      if(i===0) {
        assert.match(f.warning,dec(plan.failDelta).lte('0.01') ? /基础情景可行，但缓冲极薄，压力风险未验证/ : /最大基础情景可行仓位，压力安全性未验证/);
        for(const field of ['marginRate','free','distance']) assert.ok(f.warning.includes(cells[field]));
      }
      if(plan.both) assert.ok(dec(plan.fail).gte(f.protect) && dec(plan.success).gte(f.reserve));
    }
    assert.ok(f.prices.every((px) => Number(px) > 0));
    for (const bin of f.bins) {
      const found=f.rows.filter(row=>row.index===bin.index && row.group===bin.group);
      assert.equal(found.length,1);
      const cells=found[0].cells;
      assert.match(cells[0],{legal:/全部合法候选/,protect:/失败端本金回收/,survive:/成功端最低留存/,both:/双路径交集合格/}[bin.group]);
      if (!bin.count) {assert.equal(cells[1],'0 组');continue;}
      assert.ok(cells[0].includes(bin.count.toLocaleString()+' 组'));
      assert.equal(cells.length,7);
      for(const [i,q,value] of [[1,bin.qa,bin.pf],[2,bin.qb,bin.hl]])
        assert.equal(cells[i],two(q,String)+'\n'+two(value,money));
      assert.equal(cells[3],two(bin.fail,cash)+'\n'+two(bin.pass,cash));
      assert.equal(cells[4],two(bin.fee,cash)+'\n'+two(bin.exitFee,cash));
      assert.ok(cells[6].includes(two(bin.margin,money)));
      if(bin.distance.every(v=>v!=null)) assert.ok(cells[6].includes(two(bin.distance,v=>dec(v).toFixed(4))));
      if(bin.group==='both') {
        assert.equal(bin.count,f.joint.count);
        assert.ok(dec(bin.fail[0]).gte(f.protect) && dec(bin.pass[0]).gte(f.reserve));
      }
    }
    assert.ok(f.height<=720,'主要计算区域超出桌面首屏 '+f.height);
  }
  assert.ok(frames.every((f, i) => !i || f.sequence > frames[i - 1].sequence));
  assert.ok(frames.slice(1).some((f) => f.revaluation.marketOnly));
  evidence.example = frames[0].bins.filter((b) => b.group === 'both').sort((a, b) => b.count - a.count)[0];
  assert.ok(new Set(frames.map(f => JSON.stringify(f.bins))).size > 1);
  assert.ok(new Set(frames.map(f => JSON.stringify(f.shown))).size > 1);
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
        secondBand:at('#plan-rows tr:nth-child(2)'), table:at('#scan-results')};
    })()`);
    assert.ok(layout.contentWidth <= width && layout.secondBand <= height, JSON.stringify(layout));
    if (width>=1000) assert.ok(layout.table <= height, JSON.stringify(layout));
    evidence.viewports.push(layout);
  }
  assert.ok(await run("!document.getElementById('positions-view').open && !document.querySelector('#desk-details').open && document.getElementById('plan-columns').rows[0].cells.length===4 && !document.body.innerText.includes('全部目标仓位')"));
  for (const f of frames) {
    assert.equal(f.joint.counts.find(([key]) => key === 'joint')[1],f.joint.count);
    assert.ok(f.joint.counts.every(([key,n]) => key==='joint' || n===0));
    assert.ok(f.joint.minCount>0 && f.joint.maxCount>0);
  }
  await b.click('#scale-link');
  assert.ok(await run("document.getElementById('positions-view').open && !document.getElementById('desk-details').open && !document.getElementById('live-view').open"));
  const comparison = await run(`(() => {
    const e=id=>document.getElementById(id), id=e('scan-desk').dataset.resultId;
    const result=window.scanTest.results[id], read=id=>[...e(id).rows].map(tr=>[...tr.cells].map(td=>td.textContent));
    return {id, auto:result.comparison, autoPlans:result.comparisonRows, autoCells:read('scale-rows'),
      fixed:result.fixed,fixedCells:read('fixed-scale-rows'), source:e('scan-source').textContent,
      targets:[...e('position-list-rows').rows].map(r=>r.dataset.point), winners:result.plans.map(r=>r.key)};
  })()`);
  assert.deepEqual(comparison.targets,comparison.winners);
  for (const [pair,plans,cells] of [[comparison.auto,comparison.autoPlans,comparison.autoCells],
    [comparison.fixed?.comparison,comparison.fixed?.rows,comparison.fixedCells]]) {
    if(!pair) {assert.equal(cells.length,0);continue;}
    const small=plans.find(p=>p.key===pair.small), large=plans.find(p=>p.key===pair.large);
    assert.equal(cells.length,12);
    for (const [index,key] of ['pf','pfValue','hl','hypeValue','initial','marginRate','failDelta','success','distance','leverage','free','fail'].entries()) {
      const val=row=>['pf','hl'].includes(key)?dec(row[key]).abs():dec(row[key]);
      if (small[key]==null || large[key]==null) { assert.equal(cells[index][3],'未验证'); continue; }
      const delta=val(large).minus(val(small));
      assert.ok(delta.eq(pair.delta[key]),key);
      for(const [col,p] of [small,large].entries()) {
        assert.ok(dec(p.initial).eq(dec(p.hypeValue).div(p.leverage)));
        const printed=dec(cells[index][col+1].split(' ')[0].replace('%',''));
        const expected=key==='marginRate'?val(p).times(100):val(p);
        assert.ok(printed.minus(expected).abs().lte('0.005'),key+' printed '+printed+' / '+expected);
      }
      const displayed=dec(cells[index][3].replace('−','-').split(' ')[0]);
      const expected=key==='marginRate'?delta.times(100):delta;
      assert.ok(displayed.minus(expected).abs().lte('0.005'),key);
    }
  }
  if (comparison.fixed?.rows) assert.equal(comparison.fixed.rows[0].leverage,comparison.fixed.rows[1].leverage);
  assert.match(comparison.source,/预设资金规划.*规划空仓/);
  evidence.scaleComparison=comparison;
  await b.click('#desk-views button[aria-controls="live-view"]');
  assert.ok(await run("document.getElementById('live-view').open && !document.getElementById('plan-next')"));
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
  const changed = await run(`(() => {
    const result=window.scanTest.results[document.getElementById('scan-desk').dataset.resultId];
    return {reserve:result.reserve, plans:result.plans, shown:[...document.querySelectorAll('#plan-columns th[data-point]')].map(th=>th.dataset.point)};
  })()`);
  assert.equal(changed.reserve, '97');
  assert.deepEqual(changed.shown, changed.plans.map(p=>p.key));
  assert.ok(changed.plans.every(p=>dec(p.success).gte(changed.reserve)));
  evidence.fundingChange = {reserve:changed.reserve, targets:changed.shown};
  // Tighten only the allowed skew across real market observations. Hold the
  // first recovered job to observe the gap between feed recovery and publication.
  await run("window.scanTest.held=[];window.scanTest.hold=true");
  await set('#quoteSkewMs','0','input');
  await wait("document.getElementById('scan-status').textContent.includes('行情熔断')",20000);
  const readState=()=>run(`(()=>{const e=id=>document.getElementById(id);return {id:e('scan-desk').dataset.resultId,
    historical:e('current').dataset.historical,note:e('snapshot-note').innerText,status:e('scan-status').textContent,
    targets:[...e('plan-columns').rows[0].cells].slice(1).map(c=>c.dataset.point),state:e('scan-desk').dataset.state,
    promotion:getComputedStyle(e('max-risk')).display}})()`);
  const blocked=await readState();
  assert.equal(blocked.historical,'true'); assert.equal(blocked.state,'paused');
  assert.match(blocked.note,/历史快照.*新目标建议已暂停/); assert.doesNotMatch(blocked.status,/当前数据有效/);
  assert.equal(blocked.promotion,'none');
  await set('#quoteSkewMs','3000','input');
  await wait("document.getElementById('scan-desk').dataset.state==='recovering' && window.scanTest.held.length>0",20000);
  const recovering=await readState();
  assert.equal(recovering.historical,'true');assert.equal(recovering.id,blocked.id);
  assert.deepEqual(recovering.targets,blocked.targets);assert.doesNotMatch(recovering.status,/当前数据有效/);
  await run("window.scanTest.hold=false;window.scanTest.held.at(-1).send()");
  await wait(ready+" && document.getElementById('scan-desk').dataset.resultId!=="+JSON.stringify(blocked.id),45000);
  const restored=await readState();
  assert.equal(restored.historical,'false');assert.equal(restored.note,'');assert.match(restored.status,/当前数据有效/);
  evidence.breaker={blocked,recovering,restored};
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
