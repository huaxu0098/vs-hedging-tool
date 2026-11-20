import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openTestBrowser } from './chrome.js';
import { dec } from '../../src/hedge/math.js';

const b=await openTestBrowser({current:true});
const {send,wait,run}=b;
const evidence=[];
try {
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    window.framesById={};window.solverEvents=[];
    const post=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(job,...other){
      if(job.m && !this.watched){
        this.watched=true;
        this.addEventListener('message',({data})=>{
          const r=data.result,s=r?.baseScan??r?.ratioScan;
          if(data.error || !s){solverEvents.push(data.error??r?.autoStatus);return;}
          const plans=s.plans,p=plans.pressure;
          const row=x=>!x?null:{key:x.key,pf:x.pf,hl:x.hl,pfValue:x.pfValue,hypeValue:x.hypeValue,lev:x.leverage,depthStatus:x.depthStatus,
            cases:Object.fromEntries(['fail','pass'].map(end=>{
              const f=x.liquidity[end];
              return [end,[f.full,f,f.two].map(a=>({cash:a.settlement?.[end==='pass'?'hype':'personal'],status:a.status,clearance:a.pathStatus,
                fees:a.exitFees,depth:a.depth,surplus:a.path?.worst?.surplus}))];
            })),audits:Object.keys(x.pathAudit.pass??{})};
          framesById[r.trace.id]={id:r.trace.id,time:r.finishedAt,ms:r.solveMs,model:r.trace.model,
            clocks:JSON.parse(r.trace.inputs).market,account:r.trace.accountsId,rules:r.trace.rulesId,book:r.trace.marketId,
            tested:r.stress.positive,status:p.status,reason:p.reason,B:s.ctx.book.B,R:s.ctx.params.R,
            base:row(plans.rows.find(x=>x.key===plans.targetKeys[0])), pressure:row(p.row),
            fees:Object.fromEntries(['pf','hl'].map(k=>[k,[s.ctx.market[k].rate,s.ctx.market[k].multiplier,s.ctx.market[k].fx]]))};
          solverEvents.push([r.solveMs,r.trace.id,p.status]);
        });
      }
      return post.call(this,job,...other);
    };
  })()`});
  await send('Page.navigate',{url:process.env.CURRENT_URL??'http://127.0.0.1:4181/'});
  for (const full of [false,true]) {
    if(full) await run(`(()=>{
      for(const [key,value] of Object.entries({adverseBps:'0.01',jumpBps:'0.01',delayBps:'0.01',fundingDebit:'0.00001'})){
        const input=document.getElementById(key);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
      }
    })()`);
    const gate="document.querySelector('#scan-desk')?.dataset.state==='ready' && framesById[document.querySelector('#scan-desk').dataset.resultId]?.tested.length==="+(full?4:0);
    await wait(gate,90000);
    const f=await run(`(()=>{
      const q=id=>document.getElementById(id),id=q('scan-desk').dataset.resultId,f=framesById[id];
      return {...f,clocks:Object.fromEntries(['pf','hl'].map(k=>[k,[f.clocks[k].bookSource??f.clocks.source,f.clocks[k].bookAt??f.clocks[k].asOf]])),
        ids:['live-view','positions-view','liquidity-maximum'].map(k=>q(k).dataset.snapshotId),display:q('liquidity-maximum').textContent,
        publishedKey:q('liquidity-maximum').dataset.point,tail:q('liquidity-evidence-body').textContent.includes('D 剩余可见深度不足')};
    })()`);
    assert.ok(f.ids.every(id=>id===f.id));
    for(const [source,stamp] of Object.values(f.clocks)){assert.match(source,/Vest|Hyperliquid/);assert.ok(Number.isFinite(Date.parse(stamp)));}
    assert.ok(f.base && f.book && f.rules && f.account);
    if(f.pressure){
      assert.equal(f.pressure.key,f.publishedKey);
      assert.equal(f.status,full?'feasible':'conditional');
      assert.ok(f.tail);
      for(const [end,tests] of Object.entries(f.pressure.cases)) for(const t of tests) {
        assert.equal(t.status,'pass');assert.equal(t.clearance,'pass');
        assert.ok(dec(t.cash).gte(end==='pass'?f.R:f.B));assert.ok(dec(t.surplus).gt(0));
        for(const side of ['pf','hl']){
          const q=dec(f.pressure[side]).abs(),d=t.depth[side];
          assert.equal(d.uncovered,'0');assert.ok(dec(d.covered).eq(q));
          if(!q.isZero()){
            const fee=f.fees[side].reduce((a,b)=>a.times(b),q.times(d.vwap));
            assert.ok(fee.minus(t.fees[side]).abs().lt('1e-36'));
          }
        }
      }
      if(full) for(const name of ['adverseJump','basisWiden','delayedFill','asyncExit']) assert.ok(f.pressure.audits.includes(name));
    }else assert.equal(f.status,'none');
    evidence.push(f);
    if(process.env.UI_EVIDENCE) await writeFile(process.env.UI_EVIDENCE,JSON.stringify(evidence)+'\n');
    console.log('LIQUIDITY_LIVE',f.id,f.time,f.ms,f.status,f.base.key,f.pressure?.key,f.display);
  }
} catch(e) {
  console.error('BROWSER_DIAGNOSTIC',await run("JSON.stringify([document.getElementById('scan-status')?.textContent,solverEvents.slice(-15)])"));
  throw e;
} finally {await b.close();}
