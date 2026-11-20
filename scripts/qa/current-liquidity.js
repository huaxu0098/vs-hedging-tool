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
          const row=x=>!x?null:{key:x.key,pf:x.pf,hl:x.hl,pfValue:x.pfValue,hypeValue:x.hypeValue,lev:x.leverage,depthStatus:x.depthStatus,summary:x.pressureSummary,
            cases:Object.fromEntries(['fail','pass'].map(end=>{
              const f=x.liquidity[end];
              return [end,[f.full,f,f.two].map(a=>({cash:a.settlement?.[end==='pass'?'hype':'personal'],status:a.status,clearance:a.pathStatus,
                fees:a.exitFees,depth:a.depth,surplus:a.path?.worst?.surplus}))];
            })),audits:Object.keys(x.pathAudit.pass??{})};
          framesById[r.trace.id]={id:r.trace.id,time:r.finishedAt,ms:r.solveMs,model:r.trace.model,
            clocks:JSON.parse(r.trace.inputs).market,account:r.trace.accountsId,rules:r.trace.rulesId,book:r.trace.marketId,
            tested:r.stress.positive,funding:JSON.parse(r.trace.inputs).rules.fundingDebit,scope:p.scope,allSpecified:p.allSpecified,liveSafety:p.liveSafety,status:p.status,reason:p.reason,B:s.ctx.book.B,R:s.ctx.params.R,
            columns:[plans.targetKeys[0],null,...plans.targetKeys.slice(1)].map((key,i)=>row(i===1?p.row:plans.rows.find(r=>r.key===key))),
            base:row(plans.rows.find(x=>x.key===plans.targetKeys[0])), pressure:row(p.row),
            keys:[plans.targetKeys[0],p.key,...plans.targetKeys.slice(1)],
            fees:Object.fromEntries(['pf','hl'].map(k=>[k,[s.ctx.market[k].rate,s.ctx.market[k].multiplier,s.ctx.market[k].fx]]))};
          solverEvents.push([r.solveMs,r.trace.id,p.status]);
        });
      }
      return post.call(this,job,...other);
    };
  })()`});
  await send('Page.navigate',{url:process.env.CURRENT_URL??'http://127.0.0.1:4181/'});
  for (const budget of ['', '0.00001', '500']) {
    const full=Boolean(budget);
    if(full) await run(`(()=>{
      for(const [key,value] of Object.entries({adverseBps:'0.01',asyncBps:'0.02',jumpBps:'0.03',delayBps:'0.01',fundingRatesBps:'0.01,0.02',fundingDebit:${JSON.stringify(budget)}})){
        const input=document.getElementById(key);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
      }
    })()`);
    const gate="document.querySelector('#scan-desk')?.dataset.state==='ready' && framesById[document.querySelector('#scan-desk').dataset.resultId]?.funding==="+JSON.stringify(budget);
    await wait(gate+" && "+`(window.acceptedFrame=(()=>{
      const q=id=>document.getElementById(id),id=q('scan-desk').dataset.resultId,f=framesById[id];
      return {...f,clocks:Object.fromEntries(['pf','hl'].map(k=>[k,[f.clocks[k].bookSource??f.clocks.source,f.clocks[k].bookAt??f.clocks[k].asOf]])),
        ids:['live-view','positions-view','liquidity-maximum'].map(k=>q(k).dataset.snapshotId),display:q('liquidity-maximum').textContent,
        publishedKey:q('liquidity-maximum').dataset.point,publishedKeys:[...q('plan-columns').rows[0].cells].slice(1).map(th=>th.dataset.point||null),
        allStatus:q('pressure-all-specified').dataset.status,liveSafetyLabel:q('pressure-live-safety').textContent,
        cashDisplay:[...q('plan-rows').querySelector('[data-metric="cashBuffer"]').cells].slice(1).map(td=>td.textContent),
        coverageDisplay:[...q('plan-rows').querySelector('[data-metric="coverage"]').cells].slice(1).map(td=>td.textContent),
        detail:[...q('liquidity-evidence-body').rows].map(tr=>[tr.dataset.case,[...tr.cells].map(td=>td.textContent)]),
        headline:[q('scan-fail-cash').textContent,q('scan-pass-cash').textContent]};
    })())`,90000);
    const f=await run('window.acceptedFrame');
    assert.deepEqual(f.publishedKeys,f.keys);
    assert.ok(f.ids.every(id=>id===f.id));
    for(const [source,stamp] of Object.values(f.clocks)){assert.match(source,/Vest|Hyperliquid/);assert.ok(Number.isFinite(Date.parse(stamp)));}
    assert.ok(f.base && f.book && f.rules && f.account);
    assert.equal(f.liveSafety,'unverified');
    assert.equal(f.allStatus,f.allSpecified.status);
    assert.match(f.liveSafetyLabel,/未验证/);
    for (const [i,plan] of f.columns.entries()) {
      if (!plan) continue;
      const summary=plan.summary, known=summary.cases.filter(c=>c.verified);
      assert.equal(summary.key,f.keys[i]);
      assert.equal(f.coverageDisplay[i],known.length+' / '+(summary.cases.length-known.length));
      assert.equal(summary.coverage.passed,known.filter(c=>c.status==='pass').length);
      // Reconcile signed headroom with independently priced failure and success ledgers.
      const endpoints=summary.cases.filter(c=>c.configured);
      const minimum=(name)=>endpoints.map(c=>c[name].cash).filter(v=>v!=null).map(dec)
        .reduce((a,b)=>a.lte(b)?a:b);
      const fail=minimum('fail').minus(f.B),success=minimum('success').minus(f.R);
      const worst=fail.lte(success)?fail:success;
      assert.ok(dec(summary.cashBuffers.fail).eq(fail) && dec(summary.cashBuffers.success).eq(success));
      assert.ok(dec(summary.cashBuffers.minimum).eq(worst));
      const shown=f.cashDisplay[i].match(/[+-]?[0-9]+(?:\.[0-9]+)?/);
      assert.ok(shown && dec(shown[0]).eq(worst.toDecimalPlaces(4)),f.cashDisplay[i]);
      for (const [field,maximize] of [['maxMarginUsed',true],['minSurplus',false],
        ['minFreeCollateral',false],['maxCollateralDeficit',true],['minLiquidationDistance',false]]) {
        const values=endpoints.flatMap(c=>[c.fail[field],c.success[field]]).filter(x=>x!=null).map(dec);
        if (!values.length) {assert.equal(summary[field],null);continue;}
        const expected=values.reduce((a,b)=>(maximize?a.gt(b):a.lt(b))?a:b);
        assert.ok(expected.eq(summary[field].value),field);
        const witness=endpoints.find(c=>c.id===summary[field].id);
        assert.ok(expected.eq(witness[summary[field].endpoint][field]));
      }
    }
    if(f.pressure){
      assert.equal(f.pressure.key,f.publishedKey);
      assert.equal(f.status,'conditional');
      assert.equal(f.scope,full?'configured':'bookOnly');
      assert.equal(f.allSpecified.status,'unverified');assert.equal(f.allSpecified.key,null);
      assert.equal(f.pressure.summary.coverage.unverified,full?1:6);
      const summary=f.pressure.summary;
      assert.equal(summary.key,f.pressure.key);
      assert.equal(summary.status,'pass');
      const active=summary.cases.filter(c=>c.configured);
      for(const c of active) {
        assert.equal(c.status,'pass',c.label);
        for(const end of ['fail','success']){
          assert.ok(dec(c[end].cash).gte(end==='fail'?f.B:f.R));
          assert.ok(c[end].initialMargin!=null && c[end].maxMarginUsed!=null && dec(c[end].minSurplus).gt(0));
        }
      }
      for(const [field,end] of [['minFailure','fail'],['minSuccess','success']]){
        const amounts=active.map(c=>dec(c[end].cash));
        assert.ok(amounts.every(v=>v.gte(summary[field].value)));
        assert.equal(summary.cases.find(c=>c.id===summary[field].id)[end].cash,summary[field].value);
      }
      assert.deepEqual(f.headline,[summary.minFailure,summary.minSuccess].map(x=>dec(x.value).toFixed(4)+' U'));
      const endpoints=active.flatMap(c=>[c.fail,c.success]);
      for(const item of endpoints){
        assert.ok(dec(item.maxMarginUsed).lte(summary.maxMarginUsed.value));
        assert.ok(dec(item.minSurplus).gte(summary.minSurplus.value));
      }
      const d=summary.cases.find(c=>c.id==='D');
      assert.equal(d.status,'unknown');assert.equal(d.success.cash,null);assert.equal(d.fail.cash,null);
      for(const c of summary.cases) assert.ok(f.detail.some(([id,cells])=>id===c.id && cells[0]===c.label));
      for(const id of ['basis','async','delay','jump','funding']){
        const c=summary.cases.find(c=>c.id===id);
        assert.equal(c.status,full?'pass':'unknown');
        assert.equal(c.configured,full);
      }
      if(full){
        const initial=summary.cases.find(s=>s.id==='A'),charges=summary.cases.find(s=>s.id==='funding');
        for(const end of ['fail','success']){
          const accrual=charges[end].funding;
          assert.equal(accrual.periods,2);
          assert.ok(dec(accrual.sumBps).eq('0.03'));
          const byRate=dec(accrual.peakNotional).times('0.03').div(10000);
          assert.ok(byRate.minus(accrual.rateDebit).abs().lt('1e-36'));
          assert.ok(dec(initial[end].cash).minus(charges[end].cash).minus(accrual.charged).abs().lt('1e-36'));
        }
      }
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
    if (budget==='500') assert.equal(f.pressure,null,'过量资金费应保留基础目标并排除所有压力目标');
    evidence.push(f);
    if(process.env.UI_EVIDENCE) await writeFile(process.env.UI_EVIDENCE,JSON.stringify(evidence)+'\n');
    console.log('LIQUIDITY_LIVE',f.id,f.time,f.ms,f.status,f.base.key,f.pressure?.key,f.display);
  }
} catch(e) {
  console.error('BROWSER_DIAGNOSTIC',await run("JSON.stringify([document.getElementById('scan-status')?.textContent,solverEvents.slice(-15)])"));
  throw e;
} finally {await b.close();}
