// Exercise the public 4181 page in a disposable browser profile, without touching account state.
import assert from 'node:assert/strict';
import {openTestBrowser} from './chrome.js';

const browser=await openTestBrowser({current:true});
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.reports=new Map();
    const post=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(job,...args){
      if(job.m) {
        const observe=({data})=>{
          if(data.version!==job.version)return;
          this.removeEventListener('message',observe);
          const x=data.result,d=x?.ratioScan?.plans.decision;
          if(!d)return;
          const side=d.directions.find(s=>s.sign===d.adopted),lev=side.levels.find(l=>l.percent===d.percent);
          reports.set(x.trace.id,{id:x.trace.marketId,mode:d.mode,pct:d.percent,sign:d.adopted,qty:lev.requiredPosition.qty,
            required:lev.requiredPosition.notional,cap:side.maxFeasiblePosition,action:d.action?.key??null,
            cash:d.action?.pressureSummary.minFailure.value,trial:d.trial?.R,base:d.capital.R});
          if(reports.size>30) reports.delete(reports.keys().next().value);
        };
        this.addEventListener('message',observe);
      }
      return post.call(this,job,...args);
    };`});
  await browser.send('Page.navigate',{url:'http://127.0.0.1:4181/'});
  async function capture(mode,pct,sign,trial) {
    const expr=`(()=>{const el=id=>document.getElementById(id),desk=el('scan-desk');
      const r=reports.get(desk?.dataset.resultId);if(desk?.dataset.state!=='ready'||!r||
        r.mode!==${JSON.stringify(mode)}||r.pct!==${JSON.stringify(pct)}||r.sign!==${sign}||
        (r.trial??null)!==${JSON.stringify(trial??null)}||r.id!==desk.dataset.quoteSnapshotId)return false;
      window.saved={...r,summary:el('move-summary').innerText,lines:el('move-lines').innerText,trialText:el('trial-result').textContent,
        pf:el('order-pf-qty').innerText,hl:el('order-hl-qty').innerText,point:el('live-ratio').dataset.point,
        copy:['pf','hl'].map(k=>!el('copy-'+k).disabled),bands:el('move-levels').childElementCount,run:desk.dataset.solverRunId};
      return true;})()`;
    await browser.wait(expr,90000);
    const v=await browser.run('saved');
    assert.equal(v.point,v.action??'');assert.equal(v.base,'100');assert.ok(v.run && v.bands>=12);
    assert.match(v.lines,/通过价.*失败价/);
    assert.deepEqual(v.copy,[!!v.action,!!v.action]);
    console.log(JSON.stringify(v));return v;
  }
  const first=await capture('move','5',1);
  await browser.set('#move-percent','10','input');const ten=await capture('move','10',1);
  assert.notEqual(first.qty,ten.qty);assert.notEqual(first.run,ten.run);
  await browser.set('#move-percent','50','input');
  const feasible=await capture('move','50',1);
  assert.ok(feasible.action && feasible.copy.every(Boolean));
  await browser.set('#move-percent','10','input');
  await browser.set('#move-direction','-1','input');await capture('move','10',-1);
  await browser.set('#trial-value','90','input');await browser.click('#trial-apply');await capture('move','10',-1,'90');
  await browser.click('#trial-clear');await browser.set('#move-mode','maximum','input');
  const max=await capture('maximum','10',-1);assert.ok(max.action);
  assert.deepEqual(browser.faults,[]);
} finally {await browser.close();}
