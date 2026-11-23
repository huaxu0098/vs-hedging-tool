// Exercise the recommendation and reference scans on the service's public books.
// Capture the Clipboard API payload inside the isolated tab without writing the desktop clipboard.
import assert from 'node:assert/strict';
import {openTestBrowser} from './chrome.js';

const b=await openTestBrowser({current:true});
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.copies=[];
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>copies.push(text)}});
  `});
  await b.send('Page.navigate',{url:'http://127.0.0.1:4181/'});
  await b.wait("!!document.getElementById('move-mode')");
  await b.run("document.querySelector('.single-inspection').open=true;document.querySelector('#size-report details').open=true");
  await b.set('#move-mode','maximum','input');
  const read=async mode=>{
    await b.wait(`(()=>{
      const el=id=>document.getElementById(id), desk=el('scan-desk');
      if(desk?.dataset.state!=='ready' || el('size-mode').value!==${JSON.stringify(mode)} ||
        el('size-rows').rows.length!==10 || !el('live-targets').dataset.point)return false;
      window.view={id:desk.dataset.quoteSnapshotId,run:desk.dataset.solverRunId,
        at:el('cash-calculated-at').textContent,targets:el('live-targets').textContent,
        legs:['pf','hl'].map(k=>['direction','qty','value'].map(f=>el('order-'+k+'-'+f).textContent)),
        first:desk.firstElementChild.id,ratio:el('live-ratio').textContent,cash:el('scan-cash').innerText,
        buffer:el('buffer-alternative').textContent,hiddenMoves:!el('required-moves').checkVisibility(),
        rows:Array.from(el('size-rows').rows,r=>Array.from(r.cells,c=>c.textContent))};
      return true;
    })()`,90000);
    return b.run('view');
  };
  const first=await read('auto');
  assert.equal(first.first,'candidate-overview');assert.ok(first.hiddenMoves);
  for(const [dir,qty,value] of first.legs) {
    assert.match(dir,/做多|做空/);assert.match(qty,/BTC$/);assert.match(value,/ U$/);
  }
  assert.match(first.cash,/考核失败.*个人回收[\s\S]*考核通过.*Hype 剩余/);
  assert.match(first.buffer,/失败回收.*通过留存.*保证金.*维持余量.*M_eval/);
  for(const k of ['pf','hl']) {
    const prefix=k==='pf'?'PF':'Hype';
    await b.wait(`(()=>{const btn=document.getElementById('copy-${k}');if(btn.disabled)return false;
      btn.click();return copies.some(s=>s.startsWith('${prefix}'));})()`,90000);
    const copied=await b.run(`copies.find(s=>s.startsWith('${prefix}'))`);
    assert.match(copied,/目标仓位.*BTC[\s\S]*目标名义金额.*U[\s\S]*调整方向.*下单数量.*BTC[\s\S]*行情快照/);
  }
  const fixed={};
  for(const p of ['10','15']){
    await b.set('#size-mode',p,'change');fixed[p]=await read(p);
    assert.deepEqual(fixed[p].rows.map(r=>Number(r[0])),[500,1000,2000,3000,5000,8000,10000,15000,20000,30000]);
    for(const r of fixed[p].rows) {
      assert.ok(Math.abs(Number.parseFloat(r[3])-Number(p))<0.2);
      assert.ok(r[10] && r[11]);
    }
  }
  await b.set('#challengeStart','','input');
  await b.wait("document.querySelector('#current').dataset.historical==='true' && ['pf','hl'].every(k=>document.querySelector('#copy-'+k).disabled)");
  assert.deepEqual(b.faults,[]);
  console.log(JSON.stringify({first,fixed,copyChecked:true,historyCopyBlocked:true}));
} finally {await b.close();}
