// Open the running service with a fresh browser profile. The first assertions
// precede every input event, including the optional presentation filter.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openTestBrowser} from './chrome.js';
const b=await openTestBrowser({current:true});
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.inputEvents=0;window.copies=[];
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async s=>copies.push(s)}});
    for(const type of ['click','change','input']) addEventListener(type,()=>inputEvents++,true);
    window.frames=new Map();
    const post=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(job,...rest){
      if(job.m){
        const receive=({data})=>{
          if(job.version!==data.version)return;
          this.removeEventListener('message',receive);
          const x=data.result,d=x?.ratioScan?.plans.collection;
          if(d) {
            const rows=d.groups.flatMap(g=>g.rows);
            frames.set(x.trace.id,{count:rows.length,rules:x.trace.rulesId,accounts:x.trace.accountsId,
              market:x.trace.marketId,ms:x.solveMs,reserve:x.ratioScan.plans.decision.capital.R,checks:rows.filter(r=>r.sign===1 && r.tags.includes('10%') &&
                r.targets.some(v=>[1000,5000,10000].includes(v))).map(r=>[r.targets,r.pfValue,r.hypeValue,r.fail,r.pass,r.status])});
            if(frames.size>10)frames.delete(frames.keys().next().value);
          }
        };
        this.addEventListener('message',receive);
      }
      return post.call(this,job,...rest);
    };`});
  if(process.env.COLLECTION_FIXTURE==='1') {
    // Only in this isolated page replace both books with a known common mark.
    // Keep the original venue clocks, contract metadata, health gates and UI.
    await b.send('Page.addScriptToEvaluateOnNewDocument',{source:`
      const realFetch=window.fetch;
      window.fetch=async(...args)=>{
        const response=await realFetch(...args);
        if(!String(args[0]).includes('/api/current-market'))return response;
        const market=await response.json();
        for(const side of ['pf','hl']) if(market[side]?.levels) {
          const leg=market[side];leg.mark='50000';leg.bid=49999.9;leg.ask=50000.1;
          leg.levels=[-1,1].map(s=>Array.from({length:5},(_,i)=>[String(50000+s*(i+1)/10),'1']));
        }
        return Response.json(market);
      };`});
  }
  await b.send('Page.navigate',{url:'http://127.0.0.1:4181/'});
  const capture=`(()=>{const el=id=>document.getElementById(id),desk=el('scan-desk'),f=frames.get(desk?.dataset.resultId);
    if(!f||desk.dataset.state!=='ready')return false;
    const rows=[...el('candidate-tables').querySelectorAll('tbody tr[data-key]')],moves=[...el('move-overview-rows').rows];
    window.sample={...f,run:desk.dataset.solverRunId,snapshot:desk.dataset.quoteSnapshotId,inputEvents,
      countDOM:rows.length,keys:new Set(rows.map(r=>r.dataset.key)).size,groups:el('candidate-tables').querySelectorAll('section').length,
      cards:el('candidate-cards').querySelectorAll('article').length,amounts:moves.map(r=>r.cells[0].textContent),
      visibleBenchmarks:rows.filter(r=>r.dataset.key.startsWith('1/') && r.dataset.tags.split(',').includes('10%') &&
        ['1000','5000','10000'].some(x=>r.dataset.targets.split(',').includes(x))).map(r=>[r.cells[1].textContent,r.cells[2].textContent]),
      passed:rows.filter(r=>r.dataset.status==='pass').length,failed:rows.filter(r=>r.dataset.status==='fail').length,
      bothVisible:rows.every(r=>[1,2].every(i=>r.cells[i].checkVisibility() && r.cells[i].innerText.includes('BTC'))),
      inverseVisible:moves.every(r=>r.checkVisibility() && r.cells[1].innerText.includes('允许') && r.cells[2].innerText.includes('允许')),
      at10k:rows.filter(r=>r.dataset.key.startsWith('1/') && r.dataset.targets.split(',').includes('10000'))
        .map(r=>[r.dataset.tags,r.cells[3].innerText,r.dataset.status,r.cells[7].textContent]),
      protectedRules:localStorage.getItem('vs-hype:current-snapshots:v1')};return true;})()`;
  await b.wait(capture,120000);const first=await b.run('sample');
  assert.equal(first.inputEvents,0);assert.equal(first.countDOM,first.count);assert.equal(first.keys,first.count);
  assert.equal(first.market,first.snapshot);assert.equal(first.groups,2);assert.ok(first.cards>=2 && first.bothVisible && first.inverseVisible);
  assert.deepEqual(first.amounts,['1%','2%','3%','5%','10%','20%']);
  assert.equal(first.checks.length,3);assert.ok(first.passed>0 && first.failed>0);
  for(const [n,[,pf,hl]] of first.checks.entries()) {
    assert.ok(first.visibleBenchmarks[n][0].includes(Number(pf).toFixed(2)+' U'));
    assert.ok(first.visibleBenchmarks[n][1].includes(Number(hl).toFixed(2)+' U'));
  }
  if(process.env.COLLECTION_FIXTURE==='1') assert.deepEqual(first.checks.map(r=>r.slice(1,3)),
    [['1000','100'],['5000','500'],['10000','1000']]);
  for(const pct of ['5%','10%','15%','20%']) assert.ok(first.at10k.some(r=>r[0].split(',').includes(pct)));
  assert.ok(first.at10k.some(r=>r[2]==='fail' && r[3]));
  if(process.env.COLLECTION_SCREENSHOT) {
    const shot=await b.send('Page.captureScreenshot',{format:'png',fromSurface:true});
    await writeFile(process.env.COLLECTION_SCREENSHOT,Buffer.from(shot.data,'base64'));
  }
  await b.set('#collection-filter','fail','change');
  await b.wait("document.querySelectorAll('#candidate-tables tr[data-status=pass]').length===0");
  await b.wait(`(()=>{const desk=document.getElementById('scan-desk'),f=frames.get(desk.dataset.resultId);
    return desk.dataset.state==='ready' && f && desk.dataset.solverRunId!==${JSON.stringify(first.run)} &&
      f.market!==${JSON.stringify(first.market)} && f.rules===${JSON.stringify(first.rules)} &&
      f.accounts===${JSON.stringify(first.accounts)} && !document.querySelector('#candidate-tables tr[data-status=pass]');})()`,90000);
  await b.set('#collection-filter','all','change');
  await b.send('Page.reload');await b.wait(capture,120000);const second=await b.run('sample');
  assert.equal(first.protectedRules,second.protectedRules);assert.equal(first.accounts,second.accounts);assert.equal(first.rules,second.rules);
  await b.wait(`(()=>{const desk=document.getElementById('scan-desk'),btn=document.querySelector('#candidate-tables button[data-copy]');
    if(!btn || desk.dataset.state!=='ready')return false;
    const id=desk.dataset.resultId;btn.click();return copies.some(s=>s.includes(id)&&s.includes('待下单'));})()`,90000);
  // An ordinary financial input event must replace the whole collection.
  await b.set('#R_success','101','input');
  await b.wait(`(()=>{const desk=document.getElementById('scan-desk'),f=frames.get(desk.dataset.resultId);
    return desk.dataset.state==='ready' && f?.reserve==='101' && f.rules!==${JSON.stringify(first.rules)} &&
      f.accounts===${JSON.stringify(first.accounts)} && document.querySelectorAll('#candidate-tables tr[data-key]').length===f.count &&
      document.getElementById('candidate-grid').dataset.snapshotId===desk.dataset.resultId;})()`,90000);
  await b.set('#R_success','100','input');
  await b.wait(`(()=>{const desk=document.getElementById('scan-desk');return desk.dataset.state==='ready' &&
    frames.get(desk.dataset.resultId)?.reserve==='100' && frames.get(desk.dataset.resultId)?.accounts===${JSON.stringify(first.accounts)};})()`,90000);
  await b.send('Fetch.enable',{patterns:[{urlPattern:'*api/current-market*'}]});
  await b.wait("document.querySelector('#current').dataset.historical==='true' && document.querySelector('#scan-desk').dataset.state!=='ready'",20000);
  assert.ok(await b.run(`(()=>{const before=copies.length,btn=document.querySelector('#candidate-tables button[data-copy]');btn?.click();return copies.length===before;})()`));
  assert.deepEqual(b.faults,[]);
  const {protectedRules,...publicResult}=first;console.log(JSON.stringify({...publicResult,reloadUnchanged:true,ruleInputRecomputed:true,historyCopyBlocked:true}));
} finally {await b.close();}
