import test from 'node:test';
import assert from 'node:assert/strict';
import { createBook } from '../src/hedge/book.js';
import { demoMarket } from '../src/hedge/solver.js';
import { planRecord } from '../src/hedge/position-plans.js';
import { dec } from '../src/hedge/math.js';

function fixture(overrides={}) {
  const book=createBook({id:'pressure-unit',time:'2026-11-20T00:00:00Z',B:'145',external:'3',
    pf:'1000',hl:'150',baseline:'1000',challengeFloor:'900',challengeTarget:'1100'});
  const market=demoMarket('unit');
  for (const side of ['pf','hl']) Object.assign(market[side],{
    mark:'100',rate:'0.001',step:'1',minQty:'1',free:book[side],hold:'0',otherMaintenance:'0',
    asks:[['100.1','30'],['100.2','30'],['100.4','30']],
    bids:[['99.9','30'],['99.8','30'],['99.6','30']],
    tiers:[{from:'0',mmr:'0.05',deduction:'0',maxLeverage:'10'}],exchangeMaxLeverage:10,leverage:'10'});
  const pressureInputs={basis:'20',async:'10',delay:'5',jump:'30',funding:'0.50',...overrides};
  const checks={currentSnapshot:true,liveLimits:true,fullStress:true,basisRate:'1',pressureInputs,
    basisBps:pressureInputs.basis||null,asyncBps:pressureInputs.async||null,adverseBps:pressureInputs.basis||'0',
    failureTrigger:'net_settlement',passTrigger:'net_settlement',minMaintenanceSurplus:'0',minPriceBuffer:'0',
    stress:{basisBps:pressureInputs.basis||'0',asyncBps:pressureInputs.async||'0',delayBps:pressureInputs.delay||'0',
      jumpBps:pressureInputs.jump||'0',fundingDebit:pressureInputs.funding||'0'}};
  return {book,market,checks,params:{R:'80',k:'0.25',g:'0',mode:'auto',profitBasis:'145'}};
}
const close=(actual,expected)=>assert.ok(dec(actual).minus(expected).abs().lt('1e-37'),actual+' vs '+expected);

test('压力逐项结算：双方向的异步、基差、跳价、延迟、累计资金费及撤档均可独立对账',()=>{
  for (const sign of [1,-1]){
    const ctx=fixture();
    const row=planRecord({ctx},{sign,i:10,j:2}),summary=row.pressureSummary;
    const cases=Object.fromEntries(summary.cases.map(c=>[c.id,c]));
    assert.equal(summary.status,'pass');assert.equal(summary.key,row.key);assert.equal(summary.leverage,row.leverage);
    for(const name of ['fail','success']){
      const normal=cases.A[name], price=dec(normal.hypeMark), q=dec(row.hl);
      // Closing a linear/quanto position changes USDC cash by signed native
      // movement less the change in closing fee base; no FX conversion.
      for(const [id,width] of [['basis','0.20'],['async','0.10'],['jump','0.30']]){
        const delta=dec(width).times(-q.cmp(0)),x=cases[id][name];
        close(x.hypeMark,price.plus(delta));close(x.pfMark,normal.pfMark);
        close(x.cash,dec(normal.cash).plus(delta.times(q.minus(q.abs().times(ctx.market.hl.rate)))));
        assert.ok(dec(x.minSurplus).gt(0));assert.ok(dec(x.maxMarginUsed).gte(row.initial));
      }
      close(cases.funding[name].cash,dec(normal.cash).minus('0.5'));
      close(cases.funding[name].minSurplus,dec(normal.minSurplus).minus('0.5'));
      close(cases.funding[name].hypeMark,price);
      close(cases.delay[name].cash,dec(normal.cash).minus('0.1'));
      const combined=cases.combinedC[name],pure=cases.C[name];
      const shift=dec('0.65').times(-q.cmp(0));
      close(combined.hypeMark,dec(pure.hypeMark).plus(shift));
      close(combined.cash,dec(pure.cash).plus(shift.times(q.minus(q.abs().times(ctx.market.hl.rate)))).minus('0.6'));
      const all=summary.cases.filter(c=>c.configured);
      const worst=all.reduce((a,b)=>dec(a[name].cash).lte(b[name].cash)?a:b);
      const ref=name==='fail'?summary.minFailure:summary.minSuccess;
      assert.equal(ref.id,worst.id);assert.equal(ref.value,worst[name].cash);
    }
    const casesAndEndpoints=summary.cases.filter(c=>c.configured).flatMap(c=>[c.fail,c.success]);
    for(const [key,compare] of [['maxMarginUsed',1],['minSurplus',-1]]){
      const expected=casesAndEndpoints.reduce((a,b)=>dec(b[key]).cmp(a[key])===compare?b:a);
      assert.equal(summary[key].value,expected[key]);
    }
    assert.equal(cases.D.status,'unknown');assert.equal(cases.D.configured,false);assert.equal(cases.D.fail.cash,null);
  }
});

test('异步压力可以单独淘汰 A/B/C 合格仓位；任一路径先清算时不报告终点现金',()=>{
  const ctx=fixture({basis:'',async:'8000',jump:'',delay:'',funding:''});
  const row=planRecord({ctx},{sign:1,i:10,j:2}), all=row.pressureSummary.cases;
  assert.ok(all.filter(x=>['A','B','C'].includes(x.id)).every(x=>x.status==='pass'));
  const lag=all.find(x=>x.id==='async');
  assert.equal(lag.status,'fail');assert.equal(lag.success.cash,null);
  assert.equal(lag.success.pathStatus,'fail');
  assert.equal(row.pressureSummary.status,'fail');assert.equal(row.configuredPass,false);
});

test('缺参数与显式零压力均不作为风险通过；缺少配置所需来源时不能入选',()=>{
  const ctx=fixture({basis:'',async:'0',jump:'',delay:'',funding:''});
  let row=planRecord({ctx},{sign:-1,i:10,j:2});
  const summary=row.pressureSummary;
  assert.equal(summary.fullStress,false);assert.equal(summary.status,'pass');
  const x=id=>summary.cases.find(c=>c.id===id);
  assert.match(x('async').reason,/零/);assert.match(x('basis').reason,/未配置/);
  assert.equal(x('async').fail.cash,null);assert.equal(x('async').status,'unknown');
  ctx.checks.pressureInputs.basis='10';ctx.checks.basisBps='10';ctx.checks.basisRate=null;
  row=planRecord({ctx},{sign:-1,i:10,j:2});
  assert.equal(row.pressureSummary.status,'unknown');assert.equal(row.configuredPass,false);
});

test('延迟到达时的开仓初保可单独淘汰低档杠杆，持仓期维持保证金仍可充足',()=>{
  const ctx=fixture({basis:'',async:'',delay:'100',jump:'',funding:''});
  Object.assign(ctx.book,{B:'105',hl:'101'});
  Object.assign(ctx.market.hl,{free:'101'});
  ctx.params.R='65';
  const p={sign:-1,i:10,j:2};
  const row=planRecord({ctx},p),shock=row.pressureSummary;
  const delay=shock.cases.find(c=>c.id==='delay');
  assert.equal(row.leverage,'2');assert.equal(shock.status,'fail');assert.equal(shock.retryLeverage,true);
  assert.equal(delay.fail.status,'fail');assert.equal(delay.fail.cash,null);assert.ok(dec(delay.fail.admission.maintenanceSurplus).gt(0));
  assert.equal(delay.fail.minSurplus,null); // 拒绝调仓，目标仓从未实际占用保证金。
  assert.match(delay.reason,/初始保证金|可用抵押品/);
});

test('累计资金费按逐期费率和路径名义额计价，固定预算与逐期预算只取较高值并扣一次',()=>{
  const ctx=fixture({funding:'',delay:'',basis:'',async:'',jump:''});
  ctx.checks.fundingRatesBps=['20','30'];
  const probe=j=>planRecord({ctx},{sign:1,i:10,j});
  const small=probe(2),large=probe(4);
  for (const row of [small,large]){
    const c=id=>row.pressureSummary.cases.find(x=>x.id===id);
    assert.equal(c('funding').configured,true);assert.ok(!row.pressureSummary.missing.includes('持仓期累计资金费'));
    for (const [base,stressed] of [['A','funding'],['C','combinedC']]) for(const end of ['fail','success']){
      const normal=c(base)[end],charged=c(stressed)[end],f=charged.funding;
      const peak=dec(normal.hypeMark).gt(ctx.market.hl.mark)?dec(normal.hypeMark):dec(ctx.market.hl.mark);
      close(f.peakMark,peak);close(f.peakNotional,dec(row.hl).abs().times(peak));
      assert.equal(f.periods,2);assert.equal(f.sumBps,'50');
      close(f.charged,peak.times(dec(row.hl).abs()).times('0.005'));
      close(dec(normal.cash).minus(charged.cash),f.charged);
      close(dec(normal.minSurplus).minus(charged.minSurplus),f.charged);
      close(normal.pfMark,charged.pfMark);
    }
  }
  const f=row=>row.pressureSummary.cases.find(c=>c.id==='funding');
  close(f(large).success.funding.charged,dec(f(small).success.funding.charged).times('2'));
  ctx.checks.pressureInputs.funding='8';ctx.checks.stress.fundingDebit='8';
  const fixed=probe(2);
  const a=fixed.pressureSummary.cases.find(c=>c.id==='A');
  for(const end of ['fail','success']){
    const p=f(fixed)[end];
    assert.equal(p.funding.charged,'8');close(dec(a[end].cash).minus(p.cash),'8');
  }
});

test('已有反向原仓由延迟前路径单独承受，延迟成本按跨零的真实差额，接受后再核验新仓',()=>{
  const ctx=fixture({basis:'',async:'',delay:'100',jump:'',funding:''});
  Object.assign(ctx.book,{B:'120',hl:'150'});
  Object.assign(ctx.market.hl,{configuredLeverage:'10',free:'110',currentMarginCredit:'40'});
  ctx.book.positions.old={venue:'hl',asset:ctx.market.id,pool:ctx.market.hl.pool,qty:'4',entry:'100',
    mark:'100',multiplier:'1',fx:'1'};
  const row=planRecord({ctx},{sign:1,i:10,j:2});
  const c=id=>row.pressureSummary.cases.find(item=>item.id===id);
  // +4 -> -2 trades 6 units; a one-unit shift prices the full adjustment.
  for(const name of ['fail','success']){
    assert.equal(c('delay')[name].debit,'6');
    close(c('delay')[name].cash,dec(c('A')[name].cash).minus('6'));
  }
  const oldLow=dec('150').minus('4').minus(dec('396').times('0.05'));
  assert.ok(dec(c('delay').fail.minSurplus).lte(oldLow));

  // The original long hits its exchange-reported liquidation level before
  // the short can be opened, even though the two enabled target exits fit.
  ctx.market.hl.currentLiquidation='99.5';
  const blocked=planRecord({ctx},{sign:1,i:10,j:2});
  const lag=blocked.pressureSummary.cases.find(item=>item.id==='delay');
  assert.equal(lag.status,'fail');assert.equal(lag.fail.cash,null);assert.equal(lag.success.cash,null);
  assert.equal(blocked.configuredPass,false);
  delete ctx.market.hl.currentLiquidation;delete ctx.market.hl.configuredLeverage;
  const incomplete=planRecord({ctx},{sign:1,i:10,j:2});
  assert.equal(incomplete.pressureSummary.cases.find(x=>x.id==='delay').status,'unknown');
  assert.equal(incomplete.configuredPass,false);
});

const noAssumptions={basis:'',async:'',delay:'',jump:'',funding:''};

test('A–C 可报价与全情景认证分别计数，D 缺退出价，零幅度和缺值均保留未知',()=>{
  const {pressureSummary:p}=planRecord({ctx:fixture({...noAssumptions,delay:'0'})},{sign:1,i:10,j:2});
  assert.deepEqual([p.coverage.total,p.coverage.verified,p.coverage.unverified,p.coverage.passed,p.coverage.failed],[9,3,6,3,0]);
  assert.deepEqual(p.coverage.verifiedLabels,p.cases.slice(0,3).map(c=>c.label));
  assert.equal(p.fullStress,false);
  assert.equal(p.coverage.allSpecifiedPassed,false);
  const d=p.cases.find(c=>c.id==='D');
  assert.equal(d.verified,false);assert.equal(d.fail.cash,null);assert.equal(d.success.cash,null);
  const all=planRecord({ctx:fixture()},{sign:1,i:10,j:2});
  assert.deepEqual(all.pressureSummary.coverage.unverifiedLabels,[d.label]);
  assert.equal(all.coverage,'conditional');assert.equal(all.pressureSummary.fullStress,false);
  assert.notEqual(all.verification.stress,'pass');
});

test('C 最差失败回收500.0040与成功留存100.0171分别追溯，额外保本缓冲独立准入',()=>{
  const ctx=fixture(noAssumptions);
  const point={sign:1,i:10,j:2};
  const run=()=>planRecord({ctx},point).pressureSummary;
  // Adjust two input equities/rules on a real quantity grid. Hype's starting
  // balance shifts both exits equally; the PF success target only moves success.
  const base=run();
  const newHL=dec(ctx.book.hl).plus(dec('500.0040').minus(base.minFailure.value));
  ctx.book.hl=newHL.toString();ctx.market.hl.free=newHL.toString();
  ctx.book.B='500';
  const successNow=dec(run().minSuccess.value);
  const pf=ctx.market.pf,hl=ctx.market.hl;
  const pfSlope=dec('10').times(dec('1').minus(pf.rate));
  const hypeSlope=dec('-2').minus(dec('2').times(hl.rate));
  ctx.book.challengeTarget=dec(ctx.book.challengeTarget).plus(dec('100.0171').minus(successNow).times(pfSlope).div(hypeSlope)).toString();
  ctx.params.R='100';
  let p=run();
  assert.equal(p.minFailure.id,'C');assert.equal(p.minSuccess.id,'C');
  close(p.minFailure.value,'500.004');close(p.minSuccess.value,'100.0171');
  close(p.cashBuffers.fail,'0.004');close(p.cashBuffers.success,'0.0171');close(p.cashBuffers.minimum,'0.004');
  assert.equal(p.status,'pass');
  ctx.params.recoveryBuffer='0.005'; p=run();
  assert.equal(p.status,'fail');
  close(p.cashBuffers.minimum,'0.004'); // B 未变；只收紧准入标准。
  assert.ok(p.coverage.failed>=1);
  assert.equal(p.cases.find(c=>c.id==='C').verified,true);
});

test('路径峰值计入同池占用，实际可用最低为零，签名抵押缺口不归入清算损失',()=>{
  const ctx=fixture(noAssumptions);
  ctx.book.challengeTarget='1420';
  Object.assign(ctx.market.hl,{hold:'8',otherMaintenance:'1.2',free:'142'});
  ctx.params.R='40';
  const row=planRecord({ctx},{sign:1,i:10,j:2}),p=row.pressureSummary;
  assert.equal(row.leverage,'2');
  const path=row.liquidity.pass.two.path;
  const worst=path.checkpoints.at(-1);
  assert.ok(dec(worst.surplus).gt(0));assert.ok(dec(worst.free).lt(0));
  const reached=['pass','fail'].flatMap(end=>[row.liquidity[end].full,row.liquidity[end],row.liquidity[end].two])
    .flatMap(e=>e.path.checkpoints);
  const extrema=(field,order)=>reached.reduce((a,b)=>dec(b[field]).cmp(a[field])===order?b:a);
  close(p.openingInitial,dec(row.hl).abs().times(ctx.market.hl.mark).div(row.leverage));
  close(p.openingFree.value,row.free);
  close(p.maxMarginUsed.value,extrema('marginUsed',1).marginUsed);
  assert.ok(dec(p.maxMarginUsed.value).gt(p.openingInitial));
  close(p.maxCollateralDeficit.value,dec(extrema('free',-1).free).neg());close(p.minFreeCollateral.value,'0');
  close(p.minSurplus.value,extrema('surplus',-1).surplus);
  assert.ok(p.minLiquidationDistance.value);assert.equal(p.minLiquidationDistance.source,'cross-model');
  close(p.minLiquidationDistance.value,dec(p.minLiquidationDistance.liquidationMark).minus(extrema('mark',1).mark));
  assert.ok(p.cases.find(c=>c.id==='C').success.cash);
});

test('提前清算在首次触线截断；不足量拒绝全量结算且不产生已核验现金',()=>{
  const ctx=fixture({...noAssumptions,async:'8000'});
  const row=planRecord({ctx},{sign:1,i:10,j:2}),p=row.pressureSummary;
  const lag=p.cases.find(c=>c.id==='async');
  assert.equal(lag.verified,true);assert.equal(lag.success.cash,null);assert.equal(lag.success.status,'fail');
  close(p.minLiquidationDistance.value,'0');close(p.minSurplus.value,'0');
  // A reached liquidation before an oversized jump ends. The margin and the
  // implied deficit stop at liquidation, not at the counterfactual jump end.
  const root=dec(p.minLiquidationDistance.liquidationMark);
  close(lag.success.maxMarginUsed,root.times(dec(row.hl).abs()).div(row.leverage));
  ctx.market.hl.asks=ctx.market.hl.asks.slice(0,2);
  const c=planRecord({ctx},{sign:1,i:10,j:2}).pressureSummary.cases.find(c=>c.id==='C');
  assert.equal(c.status,'fail');assert.equal(c.verified,false);assert.equal(c.fail.cash,null);
});
