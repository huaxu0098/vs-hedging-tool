// Invert the existing PF ledger on each VWAP segment. Quantity limits and
// account admission are applied afterwards, never to the inverse target.
import {dec,out,min,max,fillEvidence} from './math.js';
import {inspectRatio} from './ratio-scan.js';
import {examMove} from './reachability.js';
import {position} from './ratio-domain.js';
import {projectSettlementEquity,executionDetail} from './solver.js';
import {searchLiquidityMaximum,diagnoseScale} from './liquidity-search.js';

export function requiredPosition(ctx,sign,percent) {
  try { return invertSettlement(ctx,sign,percent); }
  catch(error) { return {reason:'该方向无法核价 · '+error.message}; }
}

function invertSettlement(ctx,sign,percent) {
  const leg=ctx.market.pf, step=dec(leg.step), mark=dec(leg.mark), old=position(ctx.book,'pf').times(sign);
  const shift=mark.times(sign).times(percent).div(100).div(leg.factor);
  if(dec(percent).lte(0) || mark.plus(shift.times(leg.factor)).lte(0)) return {reason:'幅度不能得到正的情景终价'};
  const target=dec(ctx.book.challengeTarget), unit=mark.times(leg.multiplier).times(leg.fx);
  const trigger=ctx.checks.passTrigger??'net_settlement';
  const equity=q=>projectSettlementEquity(ctx.book,ctx.market,'pf',out(q.times(sign)),out(shift),trigger,ctx.checks.catalog);
  const cuts=[old,dec('0')];
  const depth=(levels,origin,direction)=>{
    let end=origin;
    for(const [,size] of levels) {end=end.plus(dec(size).times(direction));cuts.push(end);}
    return end;
  };
  const lower=max(0,depth(sign>0?leg.bids:leg.asks,old,-1));
  let upper=depth(sign>0?leg.asks:leg.bids,old,1);
  if(trigger!=='mark_equity') upper=min(upper,depth(sign>0?leg.bids:leg.asks,dec('0'),1));
  const knots=[...new Set(cuts.filter(q=>q.gte(lower) && q.lte(upper)).map(out))].map(dec).sort((a,b)=>a.cmp(b));
  let left=knots[0], a=left==null?null:equity(left);
  for(const right of knots.length===1?knots:knots.slice(1)) {
    const b=equity(right);
    if(a.gte(target) || b.gte(target)) {
      const root=a.gte(target)?left:left.plus(right.minus(left).times(target.minus(a)).div(b.minus(a)));
      let i=max(1,root.div(step).ceil()), qty=i.times(step);
      if(qty.lte(upper) && equity(qty).lt(target) && b.gt(a)) {i=i.plus(1);qty=i.times(step);}
      if(qty.lte(upper) && equity(qty).gte(target)) {
        const signed=qty.times(sign);
        const lines={};
        for(const [name,threshold,type] of [['pass',target,trigger],['fail',ctx.book.challengeFloor,ctx.checks.failureTrigger??'net_settlement']]) {
          try {
            const start=projectSettlementEquity(ctx.book,ctx.market,'pf',out(signed),'0',type,ctx.checks.catalog);
            const slope=signed.minus(type==='net_settlement'?qty.times(leg.rate):0).times(leg.multiplier).times(leg.fx);
            const move=dec(threshold).minus(start).div(slope);
            lines[name]={price:out(mark.plus(move)),percent:out(move.times(100).div(mark))};
          } catch(error) {lines[name]={reason:error.message};}
        }
        const entry=executionDetail(leg,out(qty.minus(old).times(sign)));
        const exitQty=out(signed.neg());
        let exit;
        if(fillEvidence(exitQty,leg).status==='covered') {
          try {exit=executionDetail(leg,exitQty,out(shift));} catch { /* Shifted exit can be unpriceable near zero. */ }
        }
        return {lines,fees:{entry:entry.fee,exit:exit?.fee??null},i:i.toNumber(),qty:out(signed),
        notional:out(qty.times(unit)),continuous:out(root.times(unit)),equity:out(equity(qty)),end:out(mark.plus(shift.times(leg.factor)))};
      }
    }
    left=right;a=b;
  }
  return {reason:'可核价盘口内没有达到目标的可执行数量',pricedNotional:out(max(0,upper).times(unit)),idealNotional:out(max(0,dec(ctx.book.challengeTarget).minus(ctx.book.pf)).times(100).div(percent))};
}

function ranges(lots,step) {
  const runs=[];
  for(const j of [...new Set(lots)].sort((a,b)=>a-b)) {
    const last=runs.at(-1);
    if(last && last[1]+1===j) last[1]=j;
    else runs.push([j,j]);
  }
  return runs.map(pair=>pair.map(j=>out(dec(step).times(j))));
}
function metric(label,actual,threshold,unit,maximum=false) {
  return {label,actual,threshold,unit,margin:out(maximum?dec(threshold).minus(actual):dec(actual).minus(threshold))};
}
export function moveDecision(scan,ctx,inspect,global,settings) {
  const {market,params,book}=ctx;
  const pf=position(book,'pf'),hl=position(book,'hl');
  const adopted=pf.cmp(0)||-hl.cmp(0)||Number(settings.direction)||1;
  const mode=settings.mode==='maximum'?'maximum':'move';
  const percentages=[settings.percent];
  const directions=[];
  let action=null;
  for(const sign of [1,-1]) {
    const cap=global.row?.sign===sign || global.status==='none'?global:
      searchLiquidityMaximum(scan,inspect,false,ctx,'scale',null,null,sign,false,global.row?.i);
    const maximum=cap.row;
    let nextLimit=null;
    if(maximum) {
      const next=dec(market.pf.step).times(maximum.i+1);
      if(market.pf.maxQty!=null && next.gt(market.pf.maxQty))
        nextLimit={reason:'PF 数量上限（合约与账户取较小值）',quantity:out(next),constraint:metric('PF 数量上限（合约与账户取较小值）',out(next),market.pf.maxQty,market.pf.unit,true)};
      else {
        const probe=diagnoseScale(scan,ctx,maximum.i+1,inspect,sign);
        nextLimit={reason:probe.reason,quantity:out(next),fail:probe.witness?.fail,pass:probe.witness?.pass};
      }
    }
    const levels=percentages.map(percent=>{
      const req=requiredPosition(ctx,sign,percent);
      const constraints=[],reasons=[];
      let match,diagnostic,hedges=[],complete=cap.status!=='incomplete';
      if(req.i && Number.isSafeInteger(req.i)) {
        if(market.pf.maxQty!=null) {
          const quantityCap=metric('PF 数量上限（合约与账户取较小值）',out(dec(req.qty).abs()),market.pf.maxQty,market.pf.unit,true);
          constraints.push(quantityCap);
          if(dec(quantityCap.margin).lt(0)) reasons.push('超过 PF 数量上限（合约与账户取较小值） '+out(dec(quantityCap.margin).neg())+' '+market.pf.unit);
        }
        const delta=dec(req.qty).minus(pf);
        if(!delta.isZero()) {
          const side=delta.gt(0)?0:1, leg=market.pf;
          if(leg.capacity?.[side]!=null) constraints.push(metric('PF 方向可下单额度',out(delta.abs()),leg.capacity[side],leg.unit,true));
          const available=leg.directionalFree?.[side]??leg.free;
          if(available!=null && leg.leverage) {
            const nominalChange=dec(req.qty).abs().minus(pf.abs()).times(leg.mark).times(leg.multiplier).times(leg.fx);
            const needed=max(0,nominalChange.div(leg.leverage).plus(req.fees.entry));
            constraints.push(metric('PF 调仓可用保证金',available,out(needed),'U'));
          }
          for(const check of constraints.filter(x=>dec(x.margin).lt(0) && !x.label.startsWith('PF 数量上限')))
            reasons.push(check.label+'短缺 '+out(dec(check.margin).neg())+' '+check.unit);
        }
        if(maximum) constraints.push(metric('已配置硬约束允许的 PF 名义额',req.notional,maximum.pfValue,'U',true));
        if(cap.status==='incomplete' || maximum && req.i<=maximum.i) {
          const search=searchLiquidityMaximum(scan,inspect,false,ctx,'scale',null,req.i,sign,true);
          match=search.row;hedges=ranges(search.lots??[],market.hl.step);complete=search.status!=='incomplete';
          if(!complete) reasons.push(search.reason);
        }
        if(!match && complete) {
          const diag=diagnoseScale(scan,ctx,req.i,inspect,sign);
          reasons.push(ctx.checks.hardDepthD?cap.reason:diag.reason);
          const w=diag.witness;diagnostic=w;
          if(w?.cashReason) reasons.push(w.cashReason);
          if(w?.fail!=null) constraints.push(metric('诊断候选失败回收',w.fail,out(dec(book.B).plus(params.recoveryBuffer??0)),'U'));
          if(w?.pass!=null) constraints.push(metric('诊断候选通过留存',w.pass,params.R,'U'));
        }
        constraints.push(metric('情景 PF 权益',req.equity,book.challengeTarget,'U'));
      } else {
        complete=false;
        reasons.push(req.reason??'所需数量超出可精确索引范围');
      }
      if(cap.status==='incomplete') reasons.push(cap.reason);
      if(match) {
        const p=match.pressureSummary;
        constraints.push(metric('失败回收',p.minFailure.value,out(dec(book.B).plus(params.recoveryBuffer??0)),'U'),
          metric('通过留存',p.minSuccess.value,params.R,'U'),metric('最低维持余量',p.minSurplus.value,ctx.checks.minMaintenanceSurplus??'0','U'));
      }
      const checked=match??diagnostic;
      if(checked) {
        const detail=inspectRatio(ctx,checked,{fixedLeverage:checked.leverage==null?null:Number(checked.leverage),includeConstraints:true});
        for(const x of detail.constraints??[]) constraints.push({label:x.name??x.code,threshold:x.required,actual:x.actual,
          unit:x.unit,margin:x.actual!=null && x.required!=null?out(dec(x.actual).minus(x.required)):null,status:x.status,source:x.source});
      }
      if(sign===adopted && percent===settings.percent) action=mode==='maximum'?maximum??null:match??null;
      const time={};
      for(const key of ['pass','fail']) {
        const line=req.lines?.[key];
        if(!line?.price || !ctx.checks.exam) time[key]={status:'unknown',reason:line?.reason??req.reason??'缺少考核窗口'};
        else if(dec(line.price).lte(0)) time[key]={status:'fail',reason:'触线价格非正'};
        else time[key]=examMove(ctx.checks.exam,market.pf.mark,line.price);
      }
      return {percent,time,requiredPosition:req,hedgeFeasibleSet:hedges,complete,constraintResults:constraints,bindingConstraints:reasons,
        diagnostic:diagnostic?{hl:diagnostic.hl,h:diagnostic.h,value:diagnostic.hypeValue,fail:diagnostic.fail,pass:diagnostic.pass}:null,choice:match?{hl:match.hl,h:match.notionalRatio,value:match.hypeValue}:null};
    });
    const aimed=levels.find(l=>l.percent===settings.percent);
    const reverseTarget=mode==='move' && aimed?.choice?{pf:aimed.requiredPosition.qty,hl:aimed.choice.hl}:maximum;
    let reversal=null;
    if(pf.cmp(0)===-sign || hl.cmp(0)===sign) {
      reversal=['pf','hl'].map(side=>{
        const leg=market[side], old=position(book,side);
        const cost=n=>{
          if(!['covered','noTrade'].includes(fillEvidence(out(n),leg).status)) return null;
          const trade=executionDetail(leg,out(n));
          return out(dec(trade.fee).plus(n.isZero()?0:n.times(leg.multiplier).times(leg.fx).times(dec(trade.price).minus(leg.mark))));
        };
        const close=cost(old.neg()), transition=reverseTarget?cost(dec(reverseTarget[side]).minus(old)):null;
        return {side,close,transition,opening:close==null || transition==null?null:out(dec(transition).minus(close))};
      });
    }
    directions.push({sign,maxFeasiblePosition:maximum?{qty:maximum.pf,notional:maximum.pfValue,hl:maximum.hl,h:maximum.notionalRatio,hypeValue:maximum.hypeValue,leverage:maximum.leverage,margin:maximum.pressureSummary.maxMarginUsed.value,surplus:maximum.pressureSummary.minSurplus.value,moves:maximum.pressureSummary.cases[0]?.success.exam?.percent,fail:maximum.pressureSummary.minFailure.value,pass:maximum.pressureSummary.minSuccess.value}:null,
      status:cap.status,nextLimit,levels,reversal,reversalScope:reverseTarget===maximum?'允许上限':'幅度目标'});
  }
  return {adopted,mode,percent:settings.percent,directions,action,current:{pf:out(pf),hl:out(hl)},
    capital:{pf:book.pf,hl:book.hl,B:params.baseRecovery??book.B,R:params.baseReserve??params.R,target:book.challengeTarget,floor:book.challengeFloor}};
}
