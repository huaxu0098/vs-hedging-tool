// The first target uses both public books. Controlled cases replay those prices
// in this isolated browser, while the service and other workbench tabs stay live.
import assert from 'node:assert/strict';
import {openTestBrowser} from './chrome.js';
const browser=await openTestBrowser({current:true});
const {send,run,wait}=browser;
try {
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.results={};window.phase='live';
    const post=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(job,...args){
      if(job.m && !this.watched){this.watched=true;this.addEventListener('message',({data})=>{
        const x=data.result,s=x?.ratioScan?.plans?.pressure;
        if(!s)return;
        const row=x.ratioScan.plans.decision?.action;
        const market=JSON.parse(x.trace.inputs).market;
        window.results[x.trace.id]={id:x.trace.id,phase:market.qaPhase??'live',key:row?.key,h:row?.notionalRatio,
          pf:row?.pf,hl:row?.hl,pfValue:row?.pfValue,hypeValue:row?.hypeValue,M:row?.pressureSummary.M_verified,local:s.localEvaluations,
          marks:[market.pf.mark,market.hl.mark],time:x.solveMs};
      });}
      return post.call(this,job,...args);
    };
    const read=window.fetch;
    window.fetch=async (...args)=>{
      const res=await read(...args);
      if(!String(args[0]).includes('/api/current-market'))return res;
      const m=await res.json();
      if(m.pf && m.hl && m.health.pf.ready && m.health.hl.ready){
        if(phase==='live') window.books=structuredClone([m.pf,m.hl]);
        else if(window.books){
          for(const [i,k] of ['pf','hl'].entries()){
            m[k].mark=books[i].mark;m[k].levels=structuredClone(books[i].levels);
          }
          if(phase==='vestBid')m.pf.levels[0][0][0]=String(Number(m.pf.levels[0][0][0])-0.1);
          if(phase==='hypeAsk')m.hl.levels[1][0][0]=String(Number(m.hl.levels[1][0][0])+0.1);
          if(phase==='hypeDepth')m.hl.levels[1][0][1]=String(Number(m.hl.levels[1][0][1])*1.1);
          if(phase==='bid')m.hl.levels[0][0][0]=String(Number(m.hl.levels[0][0][0])-0.1);
          if(phase==='ask')m.pf.levels[1][0][0]=String(Number(m.pf.levels[1][0][0])+0.1);
          if(phase==='depth')for(const level of m.pf.levels[window.cutSide].slice(2))level[1]='0.005';
          for(const k of ['pf','hl']){m[k].bid=Number(m[k].levels[0][0][0]);m[k].ask=Number(m[k].levels[1][0][0]);}
          m.qaPhase=phase;
        }
      }
      return Response.json(m);
    };`});
  await send('Page.navigate',{url:'http://127.0.0.1:4181/'});
  await browser.wait("!!document.getElementById('move-mode')");
  await browser.set('#move-mode','maximum','input');
  await wait("!!document.getElementById('dailyUpPct')");
  for(const [k,v] of Object.entries({dailyUpPct:'600',dailyDownPct:'100',twoDayUpPct:'600',twoDayDownPct:'100'}))
    await browser.set('#'+k,v,'input');
  await run("document.getElementById('solve-details').open=true");
  const rows=[];
  for(const phase of ['live','base','bid','beforeAsk','ask','beforeDepth','depth','vestBid','hypeAsk','hypeDepth','fees']){
    if(phase==='fees')await browser.set('#pfFee','0.00011','input');
    await run('window.phase='+JSON.stringify(phase));
    await wait(`(()=>{const el=id=>document.getElementById(id),desk=el('scan-desk'),r=results[desk.dataset.resultId];
      if(desk.dataset.state!=='ready'||!r || r.phase!==${JSON.stringify(phase)} || !r.key)return false;
      const logs=el('solve-log').textContent.split('\\n').filter(Boolean).map(JSON.parse);
      const rec=logs.find(log=>log.solverRunId===desk.dataset.solverRunId);
      if(!rec || rec.status!=='本帧最优'||!rec.executionCost||rec.quoteSnapshotId!==desk.dataset.quoteSnapshotId)return false;
      window.sample={...r,run:rec.solverRunId,leverage:rec.leverage,cost:rec.executionCost,margin:rec.margin,ratio:el('live-ratio').textContent,change:el('solve-change').textContent,theory:el('theory-only').textContent};
      return el('live-ratio').dataset.point===r.key && el('size-rows').rows.length===10;
    })()`,90000);
    const sample=await run('window.sample');rows.push(sample);console.log(JSON.stringify(sample));
    if(phase==='base')await run('window.cutSide='+String(Number(sample.pf)>0?0:1));
  }
  const [,base,bid,,ask,,depth]=rows;
  for(const row of [bid,ask,depth]){
    assert.deepEqual(row.marks,base.marks);
    assert.match(row.change,/上次.*PF .* U）.*Hype .* U）.*本次.*PF .* U）.*Hype .* U）.*bp.*缓冲/);
  }
  assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);
  assert.equal(new Set(rows.map(row=>row.run)).size,rows.length);
  assert.notDeepEqual(rows.at(-1).cost,base.cost);
  assert.notEqual(depth.key,base.key);
  for (const row of rows) assert.ok(Math.abs(Number(row.h)-Number(row.hypeValue)/Number(row.pfValue))<1e-12);
  await browser.set('#hardDepthD','required','input');
  await wait("document.getElementById('scan-desk').dataset.state==='ready' && document.getElementById('live-ratio').textContent==='无可行方案' && !document.getElementById('live-targets').dataset.point",90000);
  assert.equal(await browser.text('#live-targets'),'—');
  console.log('NO_SOLUTION_OK');
  await browser.set('#hardDepthD','','input');
  const storageKey='vs-hype:current-snapshots:v1';
  const saved=await run('JSON.parse(localStorage.getItem('+JSON.stringify(storageKey)+')).planRules');
  const epoch=Date.parse(saved.challengeStart);
  await run(`(()=>{const key=${JSON.stringify(storageKey)},state=JSON.parse(localStorage.getItem(key));
    state.planRules.challengeStart=${epoch/1000};state.planRules.deadline=${Date.parse(saved.deadline)};
    localStorage.setItem(key,JSON.stringify(state));})()`);
  await send('Emulation.setTimezoneOverride',{timezoneId:'UTC'});
  await send('Page.reload');
  await wait("document.getElementById('scan-desk')?.dataset.state==='ready' && !!window.results[document.getElementById('scan-desk').dataset.resultId]",90000);
  const restored=await run('JSON.parse(localStorage.getItem('+JSON.stringify(storageKey)+')).planRules');
  assert.equal(restored.challengeStart,saved.challengeStart);assert.equal(restored.deadline,saved.deadline);
  await browser.set('#challengeStart','','input');
  await wait("document.getElementById('exam-status').textContent.includes('开始时间无效') && document.getElementById('current').dataset.historical==='true'");
  const last=await run("document.getElementById('scan-desk').dataset.resultId");
  await new Promise(resolve=>setTimeout(resolve,3200));
  assert.equal(await run("document.getElementById('scan-desk').dataset.resultId"),last);
  await browser.set('#challengeStart',saved.challengeStart.slice(0,16),'input');
  await wait("document.getElementById('scan-desk').dataset.state==='ready' && document.getElementById('scan-desk').dataset.resultId!=="+JSON.stringify(last),90000);
  console.log('CLOCK_OK',restored.challengeStart,restored.deadline,'UTC reload; invalid start blocks publication; corrected input resumes');
  assert.deepEqual(browser.faults,[]);
} finally {await browser.close();}
