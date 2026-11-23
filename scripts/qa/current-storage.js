// Reproduce a saturated origin in a disposable browser profile on the actual workbench.
import assert from 'node:assert/strict';
import {openTestBrowser} from './chrome.js';
const b=await openTestBrowser({current:true}),url=process.env.CURRENT_URL??'http://127.0.0.1:4181/';
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    const prefix='vs-hype:display-history:AUTO-';
    if(!sessionStorage.testPrepared){
      localStorage.setItem('vs-hype:current-snapshots:v1',JSON.stringify({version:1,asset:'BTC',assets:{},
        rules:{},planRules:{planCapital:'511'},shared:{}}));
      localStorage.setItem(prefix+'0.21.13:test','x'.repeat(600000));
      localStorage.setItem(prefix+'0.21.15:test','newest');
      let low=0,high=5242880;
      while(low<high){
        const size=Math.ceil((low+high)/2);
        try{localStorage.setItem('qa-filler','p'.repeat(size));low=size;}
        catch{high=size-1;}
      }
      sessionStorage.testPrepared='1';
    }`});
  await b.send('Page.navigate',{url});
  await b.wait("document.getElementById('scan-pf-bid')?.textContent>0 && document.getElementById('scan-hl-bid')?.textContent>0",45000);
  await b.wait("!!JSON.parse(localStorage.getItem('vs-hype:current-snapshots:v1')).planRules.examClockVersion");
  const evidence=await b.run(`(async()=>{
    const p='vs-hype:display-history:AUTO-';
    const db=await new Promise((ok,bad)=>{const r=indexedDB.open('vs-hype:display-archive');r.onsuccess=()=>ok(r.result);r.onerror=bad});
    try {
      const saved=await new Promise((ok,bad)=>{const r=db.transaction('snapshots').objectStore('snapshots').get(p+'0.21.13:test');r.onsuccess=()=>ok(r.result);r.onerror=bad});
      return {archived:saved==='x'.repeat(600000),old:localStorage.getItem(p+'0.21.13:test'),latest:localStorage.getItem(p+'0.21.15:test'),
        capital:JSON.parse(localStorage.getItem('vs-hype:current-snapshots:v1')).planRules.planCapital,notice:document.getElementById('storage-note').hidden};
    } finally {db.close();}
  })()`);
  assert.deepEqual(evidence,{archived:true,old:null,latest:'newest',capital:'511',notice:true});
  await b.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    Object.defineProperty(window,'localStorage',{get(){throw new DOMException('storage disabled','SecurityError');}});`});
  await b.send('Page.reload');
  await b.wait("!document.getElementById('storage-note')?.hidden && Number(document.getElementById('scan-pf-bid')?.textContent)>0 && Number(document.getElementById('scan-hl-bid')?.textContent)>0",45000);
  assert.deepEqual(b.faults,[]);
  console.log('QUOTA_AND_DENIED_OK',evidence);
} finally {await b.close();}
