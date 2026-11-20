// Per-candidate stress evidence. Monetary extrema always retain the scenario
// and endpoint that produced them. Only certified exits can contribute cash.
import { dec, out } from './math.js';
import { exitLiquidity, pressureExitOffset } from './exit-liquidity.js';
import { validateMargin, preservesCrossExposure } from './solver.js';

const labels={A:'A 完整盘口', B:'B 撤退出最优档', C:'C 撤退出前两档', D:'D 可见退出深度不足',
  basis:'不利基差扩大', async:'双边价格不同步', delay:'单边延迟', jump:'不利跳价', funding:'持仓期累计资金费',
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

function metrics(test,admission) {
  const points=admission?.point?[admission.point]:[];
  const opened=(!admission || admission.status==='pass') && (!test?.before || test.before.status==='pass');
  for (const path of [test?.before,opened?test?.path:null]) {
    if (!path?.checkpoints?.length) continue;
    const hit=path.firstBreach;
    if (!hit) {points.push(...path.checkpoints);continue;}
    // Ignore modeled data after liquidation, including a profitable recovery.
    points.push(...path.checkpoints.slice(0,hit.segment));
    const start=path.checkpoints[0];
    points.push({marginUsed:out(dec(start.initial).times(hit.mark).div(start.mark).plus(start.otherUsed)),
      surplus:out(dec(hit.equity).minus(hit.maintenance)),maintenance:hit.maintenance});
  }
  const low=extreme(points,'surplus',-1), high=extreme(points,'marginUsed',1);
  return {maxMarginUsed:high?.marginUsed??null,minSurplus:low?.surplus??null,maintenance:low?.maintenance??null};
}

function endpoint(test,initial,end,dry=false,admission=null) {
  const numbers=metrics(test,admission);
  const stopped=admission && admission.status!=='pass';
  const cash=dry || stopped?null:test?.settlement?.[end==='fail'?'personal':'hype']??null;
  const status=dry?'unknown':stopped?admission.status:test?.status==='insufficient'?'fail':test?.status??'unknown';
  return {...numbers,cash,initialMargin:admission?.point?.initial??initial,status,
    pathStatus:stopped?'unknown':test?.pathStatus??'unknown',
    reason:dry?'可见深度无法全量退出':stopped?admission.reason:test?.reason??null,
    pfMark:test?.settlement?.pfMark??null,hypeMark:test?.settlement?.hlMark??null,
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
  const issue=observed.find(e=>e.status==='fail' && e.cash==null)??observed.find(e=>e.status==='unknown');
  const worst=issue?{id:issue.id,label:issue.label,endpoint:issue.endpoint,reason:issue.reason??'未取得可达结算结果'}:binding;
  return {key:[row.sign,row.i,row.j].join('/'),leverage:row.lev==null?null:String(row.lev),
    openingInitial:row.initial??null,minFailure:limit(observed.filter(e=>e.endpoint==='fail'),'cash',-1),
    minSuccess:limit(observed.filter(e=>e.endpoint==='success'),'cash',-1),
    maxMarginUsed:limit(observed,'maxMarginUsed',1),minSurplus:limit(observed,'minSurplus',-1),worstCase:worst};
}

export function pressureSummary(ctx,row,liquidity) {
  if (!ctx.checks || !ctx.book.positions) return null; // Older display-only history.
  const amounts=inputs(ctx.checks), individual=['basis','async','delay','jump','funding'];
  const rates=ctx.checks.fundingRatesBps??[];
  const scheduled=rates.some(rate=>dec(rate).gt(0));
  const active=id=>id==='funding' && scheduled ||
    amounts[id]!=null && amounts[id]!=='' && dec(String(amounts[id])).gt(0);
  const cases=[];
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
    const f=endpoint(fail,row.initial,'fail',id==='D',delayed?admission:null);
    const s=endpoint(pass,row.initial,'pass',id==='D',delayed?admission:null);
    const status=overall([f.status,s.status]);
    cases.push({id,label:labels[id],configured,status,fail:f,success:s,reason:reason??f.reason??s.reason});
  }
  add('A',end=>liquidity[end]?.full);
  add('B',end=>liquidity[end]);
  add('C',end=>liquidity[end]?.two);
  add('D',end=>liquidity[end]?.shortfall,{configured:false,reason:'退出侧可见数量不足，全量结算未验证'});
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
  const configured=cases.filter(c=>c.configured).map(c=>c.status);
  // Preserve exchange size, leverage, cross-pool availability and other hard
  // gates of the underlying candidate; e.g. a blocked order cannot open.
  if (row.verification?.initial!=='pass') configured.push(row.verification?.initial??'unknown');
  if (!row.physical && row.reason?.status) configured.push(row.reason.status);
  return {cases,missing,retryLeverage,status:overall(configured),fullStress:!missing.length && ctx.checks.basisRate!=null,
    ...bounds(row,cases,ctx)};
}
