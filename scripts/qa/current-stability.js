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
        const key=r.trace.id, market=JSON.parse(r.trace.inputs).market;
        test.results[key]={id:key, traceVersions:[r.trace.marketId,r.trace.accountsId,r.trace.rulesId,r.trace.model,r.finishedAt], started:r.startedAt,finished:r.finishedAt,ms:r.solveMs,
          bookTimes:['pf','hl'].map(k=>market[k].bookAt??market[k].asOf),
          books:Object.fromEntries(['pf','hl'].map(k=>[k,{levels:market[k].levels,
            multiplier:s.ctx.market[k].multiplier,fx:s.ctx.market[k].fx}])),
          pfMark:s.ctx.market.pf.mark,hlMark:s.ctx.market.hl.mark, count:s.sets.legal.count,
          revaluation:r.revaluation, sequence:data.version, protect:s.ctx.book.B, reserve:s.ctx.params.R,
          plans:[s.plans.targetKeys[0],null,...s.plans.targetKeys.slice(1)].map((k,i)=>i===1?s.plans.pressure.row??null:s.plans.rows.find(row=>row.key===k)),
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
  test.readPanels=()=>{
    const e=id=>document.getElementById(id), desk=e('scan-desk');
    const fields=['snapshotId','quoteSnapshotId','accountSnapshotId','rulesVersion','solverVersion','calculatedAt'];
    const panels=['live-view','positions-view','scale-details','desk-details','scan-results','scan-cash','ratio-intervals','desk-state'];
    const ids=panels.map(k=>e(k).dataset.snapshotId);
    if (panels.some(k=>e(k).dataset.calculatedAt!==desk.dataset.calculatedAt)) test.conflict=true;
    const version=Object.fromEntries(fields.map(k=>[k,k==='snapshotId'?desk.dataset.resultId:desk.dataset[k]]));
    const matrix=Object.fromEntries([...e('plan-rows').rows].map(row=>[row.dataset.metric,[...row.cells].slice(1).map(c=>c.textContent)]));
    const cols=[...e('plan-columns').rows[0].cells].slice(1);
    const live=cols.flatMap((th,i)=>th.dataset.point ? [[th.dataset.point,th.firstChild.textContent,
      matrix.pf[i]+' / '+matrix.pfValue[i],matrix.hl[i]+' / '+matrix.hypeValue[i],matrix.fail[i],matrix.success[i]]] : []);
    const positions=[...e('position-list-rows').rows].map(row=>[row.dataset.point,...[...row.cells].map(c=>c.firstChild?.textContent ?? '')]);
    return {version,ids,live,positions,empty:e('positions-empty').textContent,visible:!e('position-list').hidden,
      emptyVisible:!e('positions-empty').hidden,liveVisible:!e('plan-comparison').hidden};
  };
  let lastClocks, lastClockId, lastId, firstRow, main, root, region, firstCell, previousQuote, neighborBody, neighborCell;
  function frame() {
    const e=id=>document.getElementById(id),desk=e('scan-desk');
    if(lastId) {
      test.elapsedMs=performance.now()-test.started;
      if(document.querySelector('main')!==main || desk!==root || e('scan-results')!==region) test.remounts=(test.remounts||0)+1;
      if (!desk) {test.blanks++;requestAnimationFrame(frame);return}
      const quote=['pf','hl'].flatMap(k=>['bid','ask'].map(side=>e('scan-'+k+'-'+side).textContent)).join('|');
      if(quote!==previousQuote){test.quoteChanges=(test.quoteChanges||0)+1;previousQuote=quote}
      test.paints++;
      const panels=test.readPanels();
      if (!panels.ids.every(id=>id===panels.version.snapshotId) ||
          JSON.stringify(panels.live)!==JSON.stringify(panels.positions) ||
          panels.visible!==!!panels.live.length || panels.liveVisible!==panels.visible ||
          panels.emptyVisible===panels.visible || (panels.visible && panels.empty)) test.panelMismatches=(test.panelMismatches||0)+1;
      const clockPair=['pf','hl'].map(k=>e('scan-'+k+'-book-time').dateTime).join('|');
      if(desk.dataset.state==='updating' && lastClockId===panels.version.snapshotId && lastClocks!==clockPair)
        test.historyTicks=(test.historyTicks||0)+1;
      lastClocks=clockPair;lastClockId=panels.version.snapshotId;
      const historic=e('current').dataset.historical==='true';
      if ([...document.querySelectorAll('.history-label')].some(el=>el.textContent!==(historic?'历史快照':'')) ||
          historic===e('scan-status').textContent.includes('当前数据有效') || historic===(desk.dataset.state==='ready'))
        test.conflict=true;
      if(desk.dataset.state==='updating') {
        test.pendingPaints++;
        if(e('current').dataset.historical!=='true' || !e('scan-status').textContent.includes('历史快照') ||
          e('cash-calculated-at').dateTime!==panels.version.calculatedAt) test.conflict=true;
        if(!/重算/.test(e('scan-status').textContent) || e('scan-status').textContent.includes('当前数据有效')) test.conflict=true;
      }
      if(desk.dataset.state==='ready' && (!e('scan-status').textContent.includes('当前数据有效 · 条件估算') ||
           test.results[panels.version.snapshotId]?.bookTimes.join('|') !== clockPair)) test.conflict=true;
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
      test.commits.push({ ...test.results[id], panels:test.readPanels(), prices:[e('scan-pf-price').textContent,e('scan-hl-price').textContent],
        cash:[e('scan-fail-cash').textContent,e('scan-pass-cash').textContent], position:e('scan-position').textContent,
        clocks:['pf','hl'].map(k=>e('scan-'+k+'-book-time').dateTime),
        shownPaths:[...e('position-list-rows').rows].map(row=>[row.cells[3].textContent,row.cells[4].textContent]),
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
    const featured=f.plans[1]?.pressureSummary;
    assert.deepEqual(f.cash, [cash(featured?.minFailure.value ?? f.plans[0].fail), cash(featured?.minSuccess.value ?? f.plans[0].success)]);
    assert.equal(f.shown.length, f.plans.length);
    if(f.status.includes('当前数据有效')) assert.deepEqual(f.bookTimes,f.clocks);
    assert.ok(f.plans.some(r=>r?.labels?.includes('最大 PF 仓位')));
    const two=(values,fmt)=>values.map(fmt).join(' – ');
    const money=x=>dec(x).toFixed(dec(x).abs().lt(1)&&!dec(x).isZero()?4:2)+' U';
    const pct=(x,digits)=>dec(x).times(100).toFixed(digits)+'%';
    const quantity=x=>(dec(x).isZero()?'空仓 ':dec(x).gt(0)?'多 ':'空 ')+dec(x).abs()+' BTC';
    const delta=x=>(dec(x).gt(0)?'+':'')+cash(x);
    for (const [i, plan] of f.plans.entries()) {
      const {key,scenario,cells}=f.shown[i];
      if (!plan) {assert.equal(key,'');continue;}
      assert.ok(f.clocks.every(stamp=>Number.isFinite(Date.parse(stamp))));
      for (const [column,end] of ['fail','pass'].entries()) {
        const path=plan.paths[end], shown=f.shownPaths[f.plans.slice(0,i).filter(Boolean).length][column];
        const expectedSign=end==='fail'?-plan.sign:plan.sign;
        assert.equal(dec(path.pf.exitMark).cmp(f.pfMark),expectedSign);
        assert.equal(dec(path.hl.exitMark).cmp(f.hlMark),expectedSign);
        for(const [venue,symbol] of [['pf','PF'],['hl','Hype']])
          assert.ok(shown.includes(symbol+(expectedSign>0?' ↑ ':' ↓ ')+dec(path[venue].exitMark).toFixed(2)));
        for (const [venue,label] of [['pf','PF'],['hl','Hype']]) {
          const l=path[venue], spec=f.books[venue], start=venue==='pf'?f.pfMark:f.hlMark;
          assert.equal(l.mark,start);
          assert.equal(l.target,plan[venue]);
          const move=dec(plan[venue]).times(spec.multiplier).times(spec.fx).times(dec(l.exitMark).minus(start));
          assert.ok(move.minus(l.markPnl).abs().lt('1e-36'));
          const final=dec(l.startEquity).plus(move).plus(l.fillPnl).minus(l.entryFee).minus(l.closeFee).minus(l.friction);
          assert.ok(final.minus(l.finalEquity).abs().lt('1e-36'));
          assert.ok(shown.includes(label+' '+quantity(plan[venue])+' × 乘数 '+l.multiplier+
            ' · 标记价格盈亏 '+delta(l.markPnl)));
        }
        assert.ok(shown.includes('Hype 净盈亏 '+delta(path.hypeNet)));
        assert.ok(shown.includes('手续费 PF '+cash(path.pf.fees)+' / Hype '+cash(path.hl.fees)));
      }
      assert.equal(key,plan.key);
      assert.ok(scenario);
      if(i===1) assert.equal(plan.pressureSummary.status,'pass');
      for (const pathName of ['pass','fail']) {
        const test = plan.pathAudit[pathName].base;
        const liquidity=plan.liquidity[pathName];
        for (const side of ['pf','hl']) {
          const fill=liquidity.depth[side], gone=liquidity.withdrawn[side];
          const levels=f.books[side].levels[fill.side==='ask'?1:0];
          assert.ok(dec(liquidity.removed[side]).eq(levels[0][1]));
          assert.ok(dec(fill.visible).eq(levels.slice(1).reduce((sum,q)=>sum.plus(q[1]),dec('0'))));
          assert.ok(dec(fill.covered).plus(fill.uncovered).eq(fill.target));
          assert.ok(dec(fill.coverageRatio).eq(dec(fill.covered).div(fill.target)));
          assert.equal(gone.uncovered,fill.target);
          assert.equal(gone.vwap,null); assert.equal(gone.slippage,null);
          if(dec(fill.uncovered).gt(0)) {
            assert.equal(fill.vwap,null); assert.equal(fill.slippage,null); assert.equal(liquidity.settlement,null);
          }
        }
        assert.equal(test.firstBreach,null);
        assert.equal(test.status,'pass');
        assert.ok(test.proof.continuous && test.proof.intervals===test.proof.segments.length && test.proof.intervals>0);
        assert.ok(test.checkpoints.every(p=>dec(p.marginUsed).eq(dec(p.initial).plus(p.otherUsed)) &&
          dec(p.freeCollateral).gte(0) && dec(p.surplus).eq(dec(p.equity).minus(p.maintenance))));
        for (const side of ['pf','hl']) for (const fill of Object.values(plan.depth[pathName][side])) {
          assert.equal(fill.status,'covered');
          assert.ok(dec(fill.covered).eq(fill.target) && dec(fill.uncovered).isZero());
          const book=f.books[side], levels=book.levels[fill.side==='ask'?1:0];
          const best=dec(String(levels[0][0])), unit=dec(book.multiplier).times(book.fx);
          let remaining=dec(fill.target), visible=dec('0'), impact=dec('0'), used=0;
          for (const [px,size] of levels) {
            visible=visible.plus(size);
            if(remaining.isZero()) continue;
            const take=remaining.lt(size)?remaining:dec(String(size));
            impact=impact.plus(dec(String(px)).minus(best).abs().times(take).times(unit));
            remaining=remaining.minus(take);
            used++;
          }
          assert.equal(fill.levels,used);
          assert.ok(remaining.isZero() && visible.eq(fill.visible) && impact.eq(fill.slippage));
          const signedImpact=impact.times(fill.side==='ask'?1:-1);
          assert.ok(dec(fill.best).plus(signedImpact.div(unit).div(fill.target)).minus(fill.vwap).abs().lt('1e-36'));
          if (impact.isZero()) assert.ok(dec(fill.vwap).eq(fill.best));
        }
        assert.ok(test.checkpoints.every(p => dec(p.equity).gt(p.maintenance) && p.free != null));
      }
      assert.ok(dec(cells.h.slice(0,-1)).eq(dec(plan.h).times(100).toDecimalPlaces(cells.h.split('.')[1].length-1)));
      const summary=plan.pressureSummary;
      const full=end=>plan.liquidity[end].full.settlement;
      for(const [field,expected] of Object.entries({
        pf:quantity(plan.pf),hl:quantity(plan.hl),pfValue:money(plan.pfValue),hypeValue:money(plan.hypeValue),
        fail:cash(full('fail').personal),success:cash(full('pass').hype),
        leverage:plan.leverage+'×',initial:money(plan.initial)
      })) assert.equal(cells[field],expected,field+' / '+key);
      for(const field of ['minFailure','minSuccess','maxMarginUsed','minSurplus']) {
        const extremum=summary[field];
        if(extremum) {
          const printed=cells[field].match(/-?[0-9]+(?:\.[0-9]+)?/);
          assert.ok(printed && dec(printed[0]).minus(extremum.value).abs().lte('0.005'),field+' / '+cells[field]);
        }
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
  assert.ok(frames.slice(1).some((f) => f.revaluation.marketOnly),'连续发布中没有行情重估，序号 '+frames.map(f=>f.sequence).join(','));
  evidence.example = frames[0].bins.filter((b) => b.group === 'both').sort((a, b) => b.count - a.count)[0];
  assert.ok(new Set(frames.map(f => JSON.stringify(f.bins))).size > 1);
  assert.ok(new Set(frames.map(f => JSON.stringify(f.shown))).size > 1);
  evidence.live = frames.map(({ rows, bins, ...f }) => ({ ...f, bands: bins.length }));
  evidence.observation = await run(
    '(({paints,pendingPaints,blanks,neighborBlanks=0,neighborRemounts=0,replacedFirstRow=false,remounts=0,unreadable=false,posted,elapsedMs,quoteChanges,panelMismatches=0,historyTicks=0})=>({historyTicks,panelMismatches,paints,pendingPaints,blanks,neighborBlanks,neighborRemounts,replacedFirstRow,remounts,unreadable,posted,elapsedMs,quoteChanges}))(window.scanTest)'
  );
  if (process.env.UI_EVIDENCE) await writeFile(process.env.UI_EVIDENCE,JSON.stringify(evidence)+'\n');
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
  assert.ok(await run("!document.getElementById('positions-view').open && !document.querySelector('#desk-details').open && document.getElementById('plan-columns').rows[0].cells.length===5 && !document.body.innerText.includes('全部目标仓位')"));
  for (const f of frames) {
    assert.deepEqual(Object.values(f.panels.version),[f.id,...f.traceVersions]);
    assert.deepEqual(f.panels.positions,f.panels.live);
    assert.equal(f.panels.live.length,f.plans.filter(Boolean).length);
    assert.equal(f.joint.counts.find(([key]) => key === 'joint')[1],f.joint.count);
    assert.ok(f.joint.counts.every(([key,n]) => key==='joint' || n===0));
    assert.ok(f.joint.minCount>0 && f.joint.maxCount>0);
  }
  await b.click('[aria-controls="desk-details"]');
  await run(`(() => {
    document.getElementById('audit-details').open=true;
    document.getElementById('scan-detail').open=true;
  })()`);
  await wait(`(() => {
    const desk=document.getElementById('scan-desk'), frame=window.scanTest.results[desk.dataset.resultId];
    if (!frame?.plans[0]) return false;
    const text=document.getElementById('scan-audit').textContent;
    const p=frame.plans[0];
    return text.includes('PF 有符号目标 '+p.pf+' / Hype '+p.hl+' · 源快照 '+frame.id)
      && ['fail','pass'].every(end=>text.includes(Number(p.paths[end].pf.exitMark).toFixed(5)));
  })()`,15000);
  evidence.advancedFocusVerified=true;
  await b.click('[aria-controls="live-view"]');
  await b.click('#scale-link');
  assert.ok(await run("document.getElementById('positions-view').open && !document.getElementById('desk-details').open && !document.getElementById('live-view').open"));
  const comparison = await run(`(() => {
    const e=id=>document.getElementById(id), id=e('scan-desk').dataset.resultId;
    const result=window.scanTest.results[id], read=id=>[...e(id).rows].map(tr=>[...tr.cells].map(td=>td.textContent));
    return {id, auto:result.comparison, autoPlans:result.comparisonRows, autoCells:read('scale-rows'),
      fixed:result.fixed,fixedCells:read('fixed-scale-rows'), source:e('scan-source').textContent,
      targets:[...e('position-list-rows').rows].map(r=>r.dataset.point), winners:result.plans.filter(Boolean).map(r=>r.key)};
  })()`);
  assert.deepEqual(comparison.targets,comparison.winners);
  for (const [pair,plans,cells] of [[comparison.auto,comparison.autoPlans,comparison.autoCells],
    [comparison.fixed?.comparison,comparison.fixed?.rows,comparison.fixedCells]]) {
    if(!pair) {assert.equal(cells.length,0);continue;}
    const small=plans.find(p=>p.key===pair.small), large=plans.find(p=>p.key===pair.large);
    assert.equal(cells.length,14);
    for (const [index,key] of ['pf','pfValue','hl','hypeValue','initial','marginRate','failDelta','success','distance','leverage','free','fail','maintenance','liquidation'].entries()) {
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
  const groups=await run("[...document.querySelectorAll('#desk-details > details')].map(d=>[d.firstElementChild.textContent.trim(),d.open])");
  assert.deepEqual(groups,['账户与持仓','资金规则','压力假设','合约规格与行情连接'].map(label=>[label,false]));
  // Hold a real repricing job until another source book arrives, without
  // changing any account or rule. Its late callback must leave no visible trace.
  await run("window.scanTest.hold=true");
  await wait("window.scanTest.held.length===1",45000);
  const lastValid=await run("document.getElementById('scan-desk').dataset.resultId");
  await wait(`(() => {const m=window.scanTest.held[0].job.m;return ['pf','hl'].some(k=>
    document.getElementById('scan-'+k+'-book-time').dateTime!==(m[k].bookAt??m[k].asOf))})()`,12000);
  await run("(()=>{const h=window.scanTest.held[0];h.handler({data:{version:h.job.version,error:'STALE_BOOK_TEST'}})})()");
  assert.equal(await run("document.getElementById('scan-desk').dataset.resultId"),lastValid);
  assert.ok(await run("!document.getElementById('scan-status').textContent.includes('STALE_BOOK_TEST') && document.getElementById('current').dataset.historical==='true'"));
  await wait("window.scanTest.held.length>=2",45000);
  await run("window.scanTest.hold=false;window.scanTest.held.at(-1).send();window.scanTest.held=[]");
  await wait(ready+" && document.getElementById('scan-desk').dataset.resultId!=="+JSON.stringify(lastValid),45000);
  evidence.supersededBookDiscarded=true;
  // Hold one legitimate request, supersede it with a new rule, then deliver
  // the old response after dispatch. It must never become visible.
  await run('window.scanTest.hold=true');
  await set('#R_success', '98', 'input');
  await wait('window.scanTest.held.length===1',45000);
  const previousPanels=await run('window.scanTest.readPanels()');
  await set('#R_success', '97', 'input');
  await wait('window.scanTest.held.length>=2',45000);
  await b.click('#desk-views button[aria-controls="positions-view"]');
  assert.deepEqual(await run('window.scanTest.readPanels()'),previousPanels);
  assert.ok(await run("document.getElementById('position-list').checkVisibility() && !document.getElementById('positions-empty').checkVisibility()"));
  await b.click('#desk-views button[aria-controls="live-view"]');
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
    ready + " && document.getElementById('scan-desk').dataset.resultId!==" + JSON.stringify(stableId),60000
  );
  assert.ok(
    await run(
      "!document.body.textContent.includes('INVALID_LATE_TEST') && document.getElementById('reserve-threshold').textContent.includes('97')"
    )
  );
  const changed = await run(`(() => {
    const result=window.scanTest.results[document.getElementById('scan-desk').dataset.resultId];
    return {reserve:result.reserve, plans:result.plans, shown:[...document.querySelectorAll('#plan-columns th[data-point]')].map(th=>th.dataset.point)};
  })()`);
  assert.equal(changed.reserve, '97');
  assert.deepEqual(changed.shown, changed.plans.map(p=>p?.key??''));
  assert.ok(changed.plans.filter(Boolean).every(p=>dec(p.success).gte(changed.reserve)));
  evidence.fundingChange = {reserve:changed.reserve, targets:changed.shown};
  // Tighten only the allowed skew across real market observations. Hold the
  // first recovered job to observe the gap between feed recovery and publication.
  await run("window.scanTest.held=[];window.scanTest.hold=true");
  await set('#quoteSkewMs','0','input');
  await wait("document.getElementById('scan-status').textContent.includes('行情熔断')",20000);
  const readState=()=>run(`(()=>{const e=id=>document.getElementById(id);return {id:e('scan-desk').dataset.resultId,
    historical:e('current').dataset.historical,note:e('snapshot-note').innerText,status:e('scan-status').textContent,
    targets:[...e('plan-columns').rows[0].cells].slice(1).map(c=>c.dataset.point),state:e('scan-desk').dataset.state,
    pressure:[...e('plan-rows').rows].filter(row=>['cashBuffer','coverage','minFailure','minSuccess'].includes(row.dataset.metric))
      .map(row=>[...row.cells].slice(1).map(td=>td.textContent)),calculatedAt:e('scan-desk').dataset.calculatedAt,
    promotion:getComputedStyle(e('max-risk')).display}})()`);
  const blocked=await readState();
  assert.equal(blocked.historical,'true'); assert.equal(blocked.state,'paused');
  assert.match(blocked.note,/历史快照.*新目标建议已暂停/); assert.doesNotMatch(blocked.status,/当前数据有效/);
  assert.equal(blocked.promotion,'none');
  await set('#quoteSkewMs','3000','input');
  await wait("document.getElementById('scan-desk').dataset.state==='recovering' && window.scanTest.held.length>0",20000);
  const recovering=await readState();
  assert.equal(recovering.historical,'true');assert.equal(recovering.id,blocked.id);
  assert.deepEqual(recovering.targets,blocked.targets);assert.deepEqual(recovering.pressure,blocked.pressure);
  assert.equal(recovering.calculatedAt,blocked.calculatedAt);assert.doesNotMatch(recovering.status,/当前数据有效/);
  await run("window.scanTest.hold=false;window.scanTest.held.at(-1).send()");
  await wait(ready+" && document.getElementById('scan-desk').dataset.resultId!=="+JSON.stringify(blocked.id),45000);
  const restored=await readState();
  assert.equal(restored.historical,'false');assert.equal(restored.note,'');assert.match(restored.status,/当前数据有效/);
  evidence.breaker={blocked,recovering,restored};
  // Reload with a real accepted cache and withhold fresh worker jobs until the historical tables have been inspected.
  const saved = await run("JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('vs-hype:display-history:')))).view");
  await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.scanTest.hold=true'});
  await send('Page.reload',{ignoreCache:true});
  await wait("window.scanTest?.held.length && document.getElementById('scan-desk').dataset.resultId",35000);
  await b.click('#desk-views button[aria-controls="positions-view"]');
  const cached=await run('window.scanTest.readPanels()');
  assert.deepEqual(cached.ids,Array(8).fill(cached.version.snapshotId));
  assert.deepEqual(cached.live,cached.positions);
  assert.equal(cached.live.length,3+Number(!!saved.ratioScan.plans.pressure.row));
  assert.equal(cached.empty,'');
  assert.ok(await run("document.getElementById('current').dataset.historical==='true' && document.getElementById('position-list').checkVisibility()"));
  assert.equal(cached.version.rulesVersion,saved.rulesVersion);
  assert.equal(cached.version.accountSnapshotId,saved.accountSnapshotId);
  await run('window.scanTest.hold=false;window.scanTest.held.at(-1).send()');
  await wait(ready+" && document.getElementById('scan-desk').dataset.resultId!=="+JSON.stringify(cached.version.snapshotId),50000);
  const renewed=await run('window.scanTest.readPanels()');
  assert.deepEqual(renewed.ids,Array(8).fill(renewed.version.snapshotId));
  assert.deepEqual(renewed.positions,renewed.live);
  evidence.reload={historical:cached.version.snapshotId,renewed:renewed.version.snapshotId,targets:renewed.live.length};
  assert.ok(evidence.observation.historyTicks>0);
  assert.equal(evidence.observation.panelMismatches,0);
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
