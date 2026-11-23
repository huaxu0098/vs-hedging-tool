import {venueCases,basisObservation} from './venue-scenarios.js';
// Per-candidate stress evidence. Monetary extrema always retain the scenario
// and endpoint that produced them. Only certified exits can contribute cash.
import { dec, out, min, max, projectedSplit, canClaimOnSuccess } from './math.js';
import { exitLiquidity, exitDepthLabel, pressureExitOffset } from './exit-liquidity.js';
import { validateMargin, preservesCrossExposure, liquidationMark } from './solver.js';

const labels={examReachability:'考核期限内价格可达性',...Object.fromEntries(Object.entries(venueCases).map(([id,[label]])=>[id,label])),A:'A 完整盘口', B:'B 撤退出最优档', C:'C 撤退出前两档', D:'D 可见退出深度不足',
  basis:'不利基差扩大', async:'双边价格不同步', delay:'单边延迟', jump:'不利跳价', funding:'持仓期累计资金费',
  basisWiden:'基差扩大路径',basisNarrow:'基差收敛路径',basisFavorable:'基差有利路径',dislocation:'不同步往返路径',
  asyncExit:'不同步退出路径',delayedFill:'延迟调仓后退出路径',
  combinedA:'联合压力 · A 完整盘口',combinedB:'联合压力 · B 撤一档',combinedC:'联合压力 · C 撤两档'};

function inputs(checks) {
  if (checks.pressureInputs) return checks.pressureInputs;
  const s=checks.stress;
  return {basis:checks.basisBps, async:checks.asyncBps, delay:s?.delayBps,
    jump:s?.jumpBps, funding:s?.fundingDebit};
}

function extreme(items,field,comparison) {
  let best=null;
  for (const item of items) if(item[field]!=null && (!best || dec(item[field]).cmp(best[field])===comparison)) best=item;
  return best;
}

// IM is checked when an adjustment increases exposure. The interim IM at a
// later terminal mark is reported as margin used, never booked as a loss.
function delayedAdmission(ctx,row,delayBps,debit) {
  const leg=ctx.market.hl, adjustment=row.paths?.fail?.hl?.adjustment;
  if (adjustment==null || dec(adjustment).isZero() || !dec(delayBps).gt(0)) return null;
  const target=dec(row.hl),old=target.minus(adjustment);
  const lev=String(row.lev??leg.leverage);
  const native=dec(leg.mark).times(delayBps).div(10000).times(dec(adjustment).cmp(0));
  const arrival=dec(leg.mark).plus(native);
  if(arrival.lte(0)) return {status:'fail',reason:'延迟成交价越界'};
  const model={...ctx.market,hl:{...leg,leverage:lev}};
  const report=validateMargin(ctx.book,model,'hl',row.hl,[out(native.div(leg.factor))],
    ctx.checks.catalog,debit,{openFree:row.free}).at(-1);
  const point=report.checkpoints?.at(-1);
  if (!point || point.free==null) return {status:'unknown',reason:'延迟调仓时的实际抵押品未验证'};
  const reducing=preservesCrossExposure(old,target,leg.configuredLeverage,lev);
  const usesCap=dec(leg.utilization??'1').lt(1) || !reducing;
  const withinIM=!usesCap || dec(point.equity).times(leg.utilization??'1').gte(point.marginUsed);
  const free=reducing && dec(point.free).lt(0)?dec('0'):dec(point.free);
  const tier=leg.tiers.findLast(t=>target.abs().times(leg.multiplier).times(leg.fx).times(arrival).gte(t.from));
  const tierOK=target.isZero() || tier?.maxLeverage!=null && dec(lev).lte(String(tier.maxLeverage));
  const ok=report.status==='pass' && withinIM && free.gte(leg.reserve??'0') && tierOK;
  return {status:ok?'pass':'fail',retryLeverage:!ok && tierOK && report.status==='pass', reason:ok?null:'延迟调仓时的杠杆档位、初始保证金或可用抵押品不足',point};
}

// The cross pool has a fixed native liquidation boundary on each exposure
// and debit regime. Use the earlier of the model and applicable account mark.
function liquidationBoundary(ctx) {
  const leg=ctx.market.hl;
  const current=Object.values(ctx.book.positions).find(p=>p.venue==='hl' && p.asset===ctx.market.id && p.pool===leg.pool);
  const cache=new Map();
  return (qty,debit)=>{
    const key=qty+'/'+debit;
    if (cache.has(key)) return cache.get(key);
    let mark=liquidationMark(ctx.book,ctx.market,qty,ctx.checks.catalog,debit);
    let source='cross-model';
    const reference=current && dec(qty).eq(current.qty) ? leg.currentLiquidation : null;
    if (reference!=null && (mark==null || dec(reference).minus(mark).times(qty).gte(0))) {
      mark=reference; source='account-reference';
    }
    const result=mark==null?null:{mark,source};
    cache.set(key,result);
    return result;
  };
}

// Include the first crossing, never the unreachable endpoint beyond it.
// Inside a tier, IM and both components of signed free collateral are affine.
function reachedPoints(path) {
  if (!path?.proof?.continuous || !path.checkpoints?.length) return [];
  const hit=path.firstBreach;
  if (!hit) return path.checkpoints;
  const chunk=path.checkpoints.slice(0,hit.segment);
  const edge=path.checkpoints[hit.segment], prev=chunk.at(-1);
  let t=dec('1');
  if (prev && !dec(edge.mark).eq(prev.mark)) t=dec(hit.mark).minus(prev.mark).div(dec(edge.mark).minus(prev.mark));
  function at(field) {
    if (edge[field]==null || (prev && prev[field]==null)) return null;
    return prev?out(dec(prev[field]).plus(dec(edge[field]).minus(prev[field]).times(t))):edge[field];
  }
  return [...chunk,{mark:hit.mark,marginUsed:at('marginUsed'),free:at('free'),maintenance:hit.maintenance,
    surplus:out(dec(hit.equity).minus(hit.maintenance))}];
}

function metrics(test,admission,row,boundary) {
  const points=[];
  const old=out(dec(row.hl).minus(row.paths?.fail?.hl?.adjustment??'0'));
  function append(path,qty,debit) {
    const reached=reachedPoints(path);
    if (!reached.length) return;
    const root=dec(qty).isZero()?null:boundary(qty,debit);
    const sign=dec(qty).cmp(0);
    for (const p of reached) {
      const distance=root?out(max(0,dec(p.mark).minus(root.mark).times(sign))):null;
      points.push({...p,liquidationDistance:distance,liquidationMark:root?.mark??null,source:root?.source??null});
    }
  }
  append(test?.before,old,'0');
  // Without a common stopping time for a PF breach we cannot attribute a
  // later Hype mark to an open hedge. Keep only its independently proven prefix.
  const pfReached=!test?.pfPath || (test.pfPath.status==='pass' && test.pfPath.proof?.continuous);
  if (pfReached && (!admission || admission.status==='pass') && (!test?.before || test.before.status==='pass'))
    append(test?.path,row.hl,test?.debit??'0');
  const low=extreme(points,'surplus',-1), high=extreme(points,'marginUsed',1);
  const lowest=extreme(points,'free',-1), distance=extreme(points,'liquidationDistance',-1);
  return {maxMarginUsed:high?.marginUsed??null,minSurplus:low?.surplus??null,maintenance:low?.maintenance??null,
    minFreeCollateral:lowest?out(max(0,lowest.free)):null,maxCollateralDeficit:lowest?out(max(0,dec(lowest.free).neg())):null,
    minLiquidationDistance:distance?.liquidationDistance??null,liquidationMark:distance?.liquidationMark??null,
    distanceMark:distance?.mark??null,distanceSource:distance?.source??null};
}

function endpoint(test,row,end,dry,admission,boundary,ctx) {
  const numbers=metrics(test,admission,row,boundary);
  const stopped=admission && admission.status!=='pass';
  const cash=dry || stopped || test?.pathStatus!=='pass'?null:test.settlement?.[end==='fail'?'personal':'hype']??null;
  const exitFailed=test?.status==='fail' || test?.status==='insufficient';
  const status=dry?(ctx.checks.hardDepthD && exitFailed?'fail':'unknown'):
    exitFailed || admission?.status==='fail'?'fail':stopped?admission.status:test?.status??'unknown';
  // Known insufficient visible quantity rejects a configured exit even though
  // the missing price makes its cash outcome unverifiable.
  const verified=!dry && status!=='unknown' && (cash!=null || status==='fail' && test?.status!=='insufficient');
  const settled=test?.settlement;
  const split=end==='pass' && cash!=null && settled.pfEquity!=null && canClaimOnSuccess(ctx.book)
    ? projectedSplit(settled.pfEquity,ctx.book,ctx.params.target,ctx.checks.passTrigger) : null;
  const projectedPayout=cash==null?null:split?.user ?? (end==='fail' || !canClaimOnSuccess(ctx.book)?'0':null);
  const before=cash==null?null:settled.hype;
  const final=before==null || projectedPayout==null?null:dec(projectedPayout).isZero()?before:out(dec(before).plus(projectedPayout));
  const personalFunds=cash==null?null:{hype:settled.hype,before,final,projectedPayout,split,
    resetEquity:split && dec(split.qualified).gt(0)?ctx.book.withdrawal?.reset??ctx.book.baseline:null};
  function pathLeg(venue,mark,equity) {
    if (cash==null || mark==null || equity==null) return null;
    const start=ctx.market[venue].mark;
    return {start,mark,changePct:out(dec(mark).minus(start).times(100).div(start)),
      netPnl:out(dec(equity).minus(ctx.book[venue]))};
  }
  const prices=cash==null?null:{pf:pathLeg('pf',settled.pfMark,settled.pfEquity),
    hl:pathLeg('hl',settled.hlMark,settled.hype)};
  return {...numbers,cash,pfEquity:cash==null?null:settled.pfEquity,prices,personalFunds,exam:test?.exam??null,mathMarks:test?.mathMarks??null,
    breach:{pf:test?.pfPath?.firstBreach?.mark??null,hl:test?.path?.firstBreach?.mark??null},venue:test?.venue??null,derivation:test?.derivation??null,
    fees:cash==null?null:{pf:settled.pfFees,hl:settled.hlFees},initialMargin:admission?.point?.initial??row.initial??null,status,verified,
    admission:admission?.point?{status:admission.status,mark:admission.point.mark,
      free:admission.point.free,maintenanceSurplus:admission.point.surplus}:null,
    pathStatus:stopped?'unknown':test?.pathStatus??'unknown',
    reason:dry?exitDepthLabel(test):exitFailed?test.reason:stopped?admission.reason:test?.reason??null,
    pfMark:cash==null?null:test.settlement.pfMark,hypeMark:cash==null?null:test.settlement.hlMark,
    debit:test?.debit??null,funding:test?.funding??null};
}

function overall(items) {
  return items.includes('fail')?'fail':!items.length || items.includes('unknown')?'unknown':'pass';
}

function bounds(row,cases,ctx) {
  const b=dec(ctx.book.B).plus(ctx.params.recoveryBuffer??'0'), r=dec(ctx.params.R);
  const mm=dec(ctx.checks.minMaintenanceSurplus??'0');
  const observed=[];
  let binding=null;
  for(const c of cases.filter(c=>c.configured)) for(const name of ['fail','success']){
    const side=c[name];
    observed.push({...side,id:c.id,label:c.label,endpoint:name,reason:side.reason??c.reason});
    const floor=name==='fail'?b:r;
    for(const [value,required,label] of [[side.cash,floor,name==='fail'?'失败回收':'成功留存'],
      [side.minSurplus,mm,'维持保证金余量']]){
      if(value==null) continue;
      const headroom=dec(value).minus(required);
      if(!binding || headroom.lt(binding.headroom)) binding={id:c.id,label:c.label,endpoint:name,
        headroom:out(headroom),reason:label+'较门槛 '+headroom.toFixed(4)+' U'};
    }
  }
  function limit(rows,field,comparison){
    const e=extreme(rows,field,comparison);
    return e?{value:e[field],id:e.id,label:e.label,endpoint:e.endpoint}:null;
  }
  const issue=observed.find(e=>e.status==='fail' && e.cash==null) ??
    (binding && dec(binding.headroom).lt(0)?null:observed.find(e=>e.status==='fail')??observed.find(e=>e.status==='unknown'));
  const worst=issue?{id:issue.id,label:issue.label,endpoint:issue.endpoint,reason:issue.reason??'未取得可达结算结果'}:binding;
  const priced=observed.filter(e=>cases.some(c=>c.id===e.id && c.verified));
  const finalCash=priced.map(e=>({...e,final:e.personalFunds?.final,available:e.personalFunds?.before}));
  const failComponent=limit(finalCash.filter(e=>e.endpoint==='fail'),'available',-1);
  const successComponent=limit(finalCash.filter(e=>e.endpoint==='success'),'available',-1);
  const bothPaths=failComponent!=null && successComponent!=null;
  const successFinal=limit(finalCash.filter(e=>e.endpoint==='success'),'final',-1);
  const worstFinal=bothPaths?limit(finalCash,'final',-1):null;
  const worstAvailable=bothPaths?limit(finalCash,'available',-1):null;
  const minFailure=limit(priced.filter(e=>e.endpoint==='fail'),'cash',-1);
  const minSuccess=limit(priced.filter(e=>e.endpoint==='success'),'cash',-1);
  const fail=minFailure?out(dec(minFailure.value).minus(ctx.params.baseRecovery ?? ctx.book.B)):null;
  const success=minSuccess?out(dec(minSuccess.value).minus(ctx.params.baseReserve ?? r)):null;
  const distance=extreme(observed,'minLiquidationDistance',-1);
  return {key:[row.sign,row.i,row.j].join('/'),leverage:row.lev==null?null:String(row.lev),
    openingInitial:row.initial??null,openingFree:row.free!=null && row.verification?.initial==='pass'?
      {value:out(max(0,row.free)),id:'opening',label:'调仓完成',endpoint:'open'}:null,
    failComponent,successComponent,successFinal,worstFinal,worstAvailable,minFailure,minSuccess,cashBuffers:{fail,success,minimum:fail==null||success==null?null:out(min(fail,success))},
    maxMarginUsed:limit(observed,'maxMarginUsed',1),minSurplus:limit(observed,'minSurplus',-1),
    minFreeCollateral:limit(observed,'minFreeCollateral',-1),maxCollateralDeficit:limit(observed,'maxCollateralDeficit',1),
    minLiquidationDistance:distance?{...limit(observed,'minLiquidationDistance',-1),
      mark:distance.distanceMark,liquidationMark:distance.liquidationMark,source:distance.distanceSource,
      unit:ctx.market.hl.quoteCurrency??null}:null,worstCase:worst};
}

export function pressureSummary(ctx,row,liquidity,pathAudit={}) {
  if (!ctx.checks || !ctx.book.positions) return null; // Older display-only history.
  const amounts=inputs(ctx.checks), individual=['basis','async','delay','jump','funding'];
  const rates=ctx.checks.fundingRatesBps??[];
  const scheduled=rates.some(rate=>dec(rate).gt(0));
  const active=id=>id==='funding' && scheduled ||
    amounts[id]!=null && amounts[id]!=='' && dec(String(amounts[id])).gt(0);
  const cases=[];
  const boundary=liquidationBoundary(ctx);
  const leg=ctx.market.hl,sign=dec(row.hl).cmp(0);
  const delay=ctx.checks.stress?.delayBps??'0';
  const adjustment=row.paths?.fail?.hl?.adjustment??'0';
  const lateCost=out(dec(adjustment).abs().times(leg.multiplier).times(leg.fx).times(leg.mark).times(delay).div(10000));
  const funding=sign ? ctx.checks.stress?.fundingDebit??'0' : '0';
  const admission=active('delay')?delayedAdmission(ctx,row,delay,lateCost):null;
  let retryLeverage=admission?.retryLeverage===true;
  function add(id,check,{configured=true,reason=null,delayed=false}={}) {
    const fail=check?.('fail'), pass=check?.('pass');
    if(configured && (fail?.status!=='pass' || pass?.status!=='pass')) retryLeverage=false;
    const f=endpoint(fail,row,'fail',id==='D' && !fail?.settlement,delayed?admission:null,boundary,ctx);
    const s=endpoint(pass,row,'pass',id==='D' && !pass?.settlement,delayed?admission:null,boundary,ctx);
    const status=overall([f.status,s.status]);
    const verified=configured && f.verified && s.verified;
    cases.push({id,label:labels[id],configured,status,verified,fail:f,success:s,reason:reason??f.reason??s.reason});
  }
  add('A',end=>liquidity[end]?.full);
  add('B',end=>liquidity[end]);
  add('C',end=>liquidity[end]?.two);
  add('D',end=>liquidity[end]?.shortfall,{configured:!!ctx.checks.hardDepthD});
  for (const id of individual) {
    if (!active(id)) {
      const empty=(amounts[id]==null || amounts[id]==='') && !(id==='funding' && rates.length);
      add(id,null,{configured:false,reason:empty?'压力幅度未配置':'明确为零，非零压力未验证'});
      continue;
    }
    if (id==='basis' && ctx.checks.basisRate==null) {
      add(id,null,{reason:'缺少有效的跨平台基差参照汇率'});continue;
    }
    const delayed=id==='delay';
    const offset=id==='funding' || delayed ? '0' : out(dec(leg.mark).times(String(amounts[id])).div(10000).times(-sign));
    const shock={offset,delayed,arrivalMark:delayed?admission?.point?.mark:null,
      debit:delayed?lateCost:'0',funding:id==='funding',fixedFunding:funding,ratesBps:rates};
    add(id,end=>exitLiquidity(ctx,row,end,0,shock),{delayed});
  }
  const missing=individual.filter(id=>!active(id)).map(id=>labels[id]);
  if(individual.some(active)){
    const shock={offset:out(pressureExitOffset(leg,sign,ctx.checks)),
      debit:lateCost,delayed:active('delay'),arrivalMark:admission?.point?.mark,
      funding:active('funding'),fixedFunding:funding,ratesBps:rates};
    const basisUnknown=active('basis') && ctx.checks.basisRate==null;
    for(const [i,id] of ['combinedA','combinedB','combinedC'].entries())
      add(id,basisUnknown?null:end=>exitLiquidity(ctx,row,end,i,shock),
        {delayed:shock.delayed,reason:basisUnknown?'缺少有效的基差参照汇率':null});
  }
  // Additional modeled paths have their own ledgers. Reuse those actual
  // endpoints, including the recovery leg after a temporary dislocation.
  const additional={
    basisWiden:active('basis'),basisNarrow:active('basis'),basisFavorable:active('basis'),
    dislocation:active('basis') || active('async') || active('jump'),
    asyncExit:active('basis') || active('async') || active('jump'),
    delayedFill:active('delay') || active('jump') || active('basis') || active('funding')
  };
  for (const [id,enabled] of Object.entries(additional)) {
    if (!enabled || !pathAudit.fail?.[id] && !pathAudit.pass?.[id]) continue;
    add(id,end=>{
      const path=pathAudit[end]?.[id];
      if (!path) return null;
      const settlement=path.settlement;
      const floor=end==='fail'?dec(ctx.book.B).plus(ctx.params.recoveryBuffer??'0'):dec(ctx.params.R);
      const cash=settlement?.[end==='fail'?'personal':'hype'];
      const verifiedPath=path.status==='pass' && path.proof?.continuous && cash!=null;
      const meets=verifiedPath && dec(cash).gte(floor) &&
        dec(path.worst.surplus).gte(ctx.checks.minMaintenanceSurplus??'0');
      return {path,settlement,debit:path.debit??'0',before:id==='delayedFill'?pathAudit[end]?.beforeFill:null,
        pathStatus:verifiedPath?'pass':path.status==='fail'?'fail':'unknown',
        status:verifiedPath?(meets?'pass':'fail'):path.status==='fail'?'fail':'unknown',
        reason:verifiedPath?(meets?null:'路径资金或维持余量低于门槛'):'路径结算未核实'};
    },{delayed:id==='delayedFill' && active('delay')});
  }
  if (ctx.checks.venueScenarios) for (const [id,[,field]] of Object.entries(venueCases)) {
    const ordered=id==='vestFirst' || id==='hypeFirst';
    const magnitude=ctx.checks.venueScenarios[field];
    const lag=ordered?ctx.checks.venueScenarios.exitLagBps:null;
    const bps=magnitude ?? lag;
    const enabled=bps!=null && dec(bps).gt(0);
    const required=enabled || ordered && Number(ctx.checks.exitDelaySeconds)>0;
    add(id,enabled?end=>exitLiquidity(ctx,row,end,0,{venue:id,bps}):null,
      {configured:required,reason:enabled?null:'独立跨所压力幅度未配置或为零'});
  }
  if (ctx.checks.exam?.deriveMoves) add('examReachability',null,{
    configured:false,reason:'所需涨跌幅由触线价格反推，未验证能否在截止前到达'
  });
  const configured=cases.filter(c=>c.configured).map(c=>c.status);
  // Preserve exchange size, leverage, cross-pool availability and other hard
  // gates of the underlying candidate; e.g. a blocked order cannot open.
  if (row.verification?.initial!=='pass') configured.push(row.verification?.initial??'unknown');
  if (!row.physical && row.reason?.status) configured.push(row.reason.status);
  const status=overall(configured);
  const verified=cases.filter(c=>c.verified),unverified=cases.filter(c=>!c.verified);
  const passed=verified.filter(c=>c.status==='pass').length;
  const coverage={total:cases.length,verified:verified.length,unverified:unverified.length,passed,
    failed:verified.length-passed,allSpecifiedPassed:passed===cases.length && status==='pass',
    verifiedLabels:verified.map(c=>c.label),unverifiedLabels:unverified.map(c=>c.label)};
  const summary=bounds(row,cases,ctx);
  const M_verified=summary.cashBuffers.minimum;
  const fullyPriced=cases.every(c=>c.verified && c.fail.cash!=null && c.success.cash!=null);
  return {basis:basisObservation(ctx.market.pf.mark,leg.mark,ctx.checks.basisRate),cases,missing,retryLeverage,status,coverage,fullStress:coverage.allSpecifiedPassed,
    ...summary,M_eval:ctx.book.stage==='challenge'?M_verified:null,M_verified,M_full:fullyPriced?M_verified:null};
}
