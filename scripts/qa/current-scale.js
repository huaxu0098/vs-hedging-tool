// Read the actual 4181 publication and replay its precise inputs with a bounded 48-hour scenario.
import assert from 'node:assert/strict';
import {openTestBrowser} from './chrome.js';
import {dec} from '../../src/hedge/math.js';
import {calculateCurrent} from '../../src/hedge/current.js';

const browser=await openTestBrowser({current:true});
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.samples=new Map();
    const post=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(job,...rest){
      if(job.m){
        const observe=({data})=>{
          if(data.version!==job.version)return;
          this.removeEventListener('message',observe);
          if(!data.result?.ratioScan)return;
          samples.set(data.result.trace.id,{job,options:JSON.parse(data.result.trace.inputs).options,elapsed:data.result.solveMs});
          if(samples.size>10)samples.delete(samples.keys().next().value);
        };
        this.addEventListener('message',observe);
      }
      return post.call(this,job,...rest);
    };
  `});
  await browser.send('Page.navigate',{url:'http://127.0.0.1:4181/'});
  await browser.wait("!!document.getElementById('move-mode')");
  await browser.set('#move-mode','maximum','input');
  await browser.wait(`(()=>{
    const el=id=>document.getElementById(id),desk=el('scan-desk');
    if(desk?.dataset.state!=='ready' || !samples.has(desk.dataset.resultId) || el('size-rows').rows.length!==10)return false;
    window.probe={...samples.get(desk.dataset.resultId),id:desk.dataset.quoteSnapshotId,resultId:desk.dataset.resultId,
      run:desk.dataset.solverRunId,ratio:el('live-ratio').textContent,targets:el('live-targets').textContent,
      margin:el('live-margin').textContent,cash:el('scan-cash').innerText,moves:el('required-moves').textContent,
      branches:el('branch-summary').textContent,expiry:el('unhit-expiry').textContent,buffer:el('buffer-alternative').textContent,rows:Array.from(el('size-rows').rows,r=>Array.from(r.cells,c=>c.textContent))};
    return true;
  })()`,90000);
  const {job,options,...live}=await browser.run('window.probe');
  const {r,a,m,rates,t}=job;
  const solve=rules=>calculateCurrent(rules,a,m,rates,t,options);
  const baseline=solve(r), p=baseline.ratioScan.plans;
  assert.equal(baseline.trace.marketId,live.id);
  assert.equal(baseline.trace.id,live.resultId);
  assert.deepEqual(live.rows.map(r=>Number(r[0])),p.checkpoints.map(r=>r.target));
  assert.ok(live.rows.every(r=>r.length===15 && r[12] && r[13] && r[14]));
  assert.ok(live.rows.every(r=>!r.includes('条件可行')));
  assert.match(live.expiry,/到期未触线退出/);
  if(p.decision.action) {
    assert.match(live.branches,/已填写的资金条件通过.*通过线.*失败线/);
    assert.equal(live.ratio,dec(p.decision.action.notionalRatio).times(100).toFixed(6)+'%');
    assert.ok(Number(p.pressure.row.pfValue)>=Number(p.cashPriority.row.pfValue));
    assert.ok(Number(p.pressure.row.pressureSummary.M_eval)<=Number(p.cashPriority.row.pressureSummary.M_eval));
  }
  const window=solve({...r,dailyUpPct:'5',dailyDownPct:'5',twoDayUpPct:'10',twoDayDownPct:'10'});
  assert.equal(window.trace.marketId,live.id);
  assert.equal(!!window.ratioScan.plans.pressure.row,!!window.ratioScan.plans.cashPriority.row);
  for(const row of window.ratioScan.plans.checkpoints.filter(r=>r.status==='pass')) {
    assert.ok(Math.abs(Number(row.failMove))<=10 && Math.abs(Number(row.passMove))<=10);
  }
  console.log(JSON.stringify({...live,at:new Date(t).toISOString(),windowMax:window.ratioScan.plans.pressure.row?.pfValue??null,
    windowStatus:window.ratioScan.plans.pressure.status,window30k:window.ratioScan.plans.checkpoints.at(-1).reason}));
  assert.deepEqual(browser.faults,[]);
} finally {await browser.close();}
