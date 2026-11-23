// Run against the actual service in an isolated Chrome profile. Inject only
// the subscription flag, leaving REST prices, WS clocks and transport intact.
import assert from 'node:assert/strict';
import { openTestBrowser } from './chrome.js';

const browser=await openTestBrowser({current:true});
const {run,wait,send}=browser;
const ready="document.querySelector('#scan-desk').dataset.state==='ready' && document.querySelector('#home-cash').dataset.point";
try {
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    const realFetch=window.fetch;
    window.fetch=async (...args)=>{
      const response=await realFetch(...args);
      if(!window.staleSubscription || !String(args[0]).includes('/api/current-market')) return response;
      const market=await response.json();
      const side=window.staleSubscription;
      if(market.health?.[side]) market.health[side]={...market.health[side],connected:true,subscription:'stale'};
      return Response.json(market);
    };`});
  await send('Page.navigate',{url:process.env.CURRENT_URL??'http://127.0.0.1:4181/'});
  await wait("!!document.getElementById('dailyUpPct')",15000);
  for(const [key,value] of Object.entries({dailyUpPct:'600',dailyDownPct:'100',twoDayUpPct:'600',twoDayDownPct:'100'}))
    await browser.set('#'+key,value,'input');
  await wait(ready,90000);
  await run(`(()=>{
    const el=id=>document.getElementById(id), desk=el('scan-desk');
    const nodes=['live-ratio','live-targets'].map(el);
    const observed=window.observed={paints:0,empty:0,replaced:0,mixed:0,frames:[],started:performance.now()};
    function paint(){
      observed.paints++;
      if(nodes.some(node=>!node.checkVisibility() || !node.dataset.point)) observed.empty++;
      if(nodes.some(node=>el(node.id)!==node)) observed.replaced++;
      const id=desk.dataset.resultId;
      const cols=[...el('plan-columns').rows[0].cells].slice(1);
      if(cols.length!==5 || [...nodes,...cols].some(node=>node.dataset.snapshotId!==id) ||
        nodes[0].dataset.point!==cols[4].dataset.point || nodes[1].dataset.point!==cols[4].dataset.point) observed.mixed++;
      if(observed.frames.at(-1)!==id) observed.frames.push(id);
      if(!observed.finished) requestAnimationFrame(paint);
    }
    paint();
  })()`);
  assert.equal(await run("document.querySelector('#comparison-detail').open"),false);
  const outages=[];
  for(const side of ['pf','hl']) {
    await run('window.staleSubscription='+JSON.stringify(side));
    await wait("document.querySelector('#scan-desk').dataset.state==='paused' && document.getElementById('scan-"+side+"-connection').textContent.includes('stale')",15000);
    const paused=await run("document.querySelector('#scan-desk').dataset.resultId");
    assert.equal(await run("document.querySelector('#current').dataset.historical"),'true');
    await new Promise(resolve=>setTimeout(resolve,3200));
    assert.equal(await run("document.querySelector('#scan-desk').dataset.resultId"),paused);
    await run('window.staleSubscription=false');
    await wait(ready+" && document.querySelector('#scan-desk').dataset.resultId!=="+JSON.stringify(paused),90000);
    const recovered=await run("document.querySelector('#scan-desk').dataset.resultId");
    outages.push({side,paused,recovered});
  }
  await wait('performance.now()-observed.started>=60000',65000);
  const result=await run('({...observed,finished:observed.finished=true})');
  assert.deepEqual([result.empty,result.replaced,result.mixed],[0,0,0]);
  assert.ok(result.paints>10 && result.frames.length>=2);
  assert.deepEqual(browser.faults,[]);
  console.log(JSON.stringify({outages,frames:result.frames.length,paints:result.paints,
    empty:result.empty,replaced:result.replaced,mixed:result.mixed}));
} finally { await browser.close(); }
