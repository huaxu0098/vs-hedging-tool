import { dec, out, min, max, estimateFill } from './math.js';
import { exitBook, pressureExitOffset } from './exit-liquidity.js';
import { projectSettlementEquity, profileInputs } from './solver.js';
import { position } from './ratio-domain.js';
import { ratioSlice } from './ratio-scan.js';

function depthLimits(leg, sign) {
  const levels=exitBook(leg,String(sign),2)[sign>0 ? 'bids' : 'asks'];
  const cuts=[];
  let depth=dec('0');
  for (const [,size] of levels) {
    depth=depth.plus(size);
    cuts.push(depth.div(leg.step).floor().toNumber());
  }
  return {cuts,cap:cuts.at(-1) ?? 0};
}

// Price at the current mark with the entry book intact, then apply the original
// contract's signed settlement slope to a native price displacement.
function legTerms(ctx,side,q) {
  const leg=ctx.market[side], unit=dec(leg.multiplier).times(leg.fx);
  const marked=projectSettlementEquity(ctx.book,ctx.market,side,out(q),'0','mark_equity',ctx.checks.catalog);
  const qty=q.neg(), book=exitBook(leg,q,2);
  const fill=estimateFill(out(qty),book);
  const exit=dec(fill?.notional ?? '0').times(unit);
  const slope=q.minus(q.abs().times(leg.rate)).times(unit);
  const settled=marked.plus(exit.times(q.cmp(0))).minus(q.times(unit).times(leg.mark)).minus(exit.times(leg.rate));
  return {marked,settled,slope,signed:q.times(unit)};
}

function nativeEndpoints(ctx,pf,profile) {
  const term=legTerms(ctx,'pf',pf), {checks,market}=ctx;
  const factor=dec(market.hl.factor).div(market.pf.factor);
  const offset=pressureExitOffset(market.hl,-pf.cmp(0),checks);
  return Object.fromEntries([['fail',profile.floor,checks.failureTrigger],['pass',profile.target,checks.passTrigger]]
    .map(([end,target,trigger])=>{
      const mark=trigger==='mark_equity';
      const move=dec(target).minus(mark ? term.marked : term.settled).div(mark ? term.signed : term.slope);
      return [end,move.times(factor).plus(offset)];
    }));
}

// Cash is affine in the Hype lot index inside each entry/exit depth segment.
// Outward tolerance retains numerical boundary lots for exact ledger admission.
function cashBand(lo,hi,left,right,minimum,extraRecovery) {
  let from=lo, to=hi;
  for (const end of ['fail','pass']) {
    const floor=end==='fail' ? max(minimum,extraRecovery) : minimum;
    const a=left[end].minus(floor).plus('1e-12'), b=right[end].minus(floor).plus('1e-12');
    if (a.lt(0) && b.lt(0)) return null;
    if (a.lt(0)===b.lt(0)) continue;
    const x=dec(String(lo)).minus(a.times(hi-lo).div(b.minus(a)));
    if (a.lt(0)) from=Math.max(from,x.ceil().toNumber());
    else to=Math.min(to,x.floor().toNumber());
  }
  return from<=to ? [from,to] : null;
}

// Within a price segment the lower envelope of the two affine C-path cash
// headrooms peaks at an endpoint or at the crossing of the two lines. Trying
// that integer lot first gives a useful incumbent even in wide cash bands.
function* competitiveLots(first,last,margins,incumbent,extraRecovery) {
  const band=cashBand(first,last,margins(first),margins(last),incumbent(),extraRecovery);
  if (!band) return;
  const [lo,hi]=band;
  const left=margins(lo),right=margins(hi);
  const gap=left.fail.minus(left.pass);
  const slope=right.fail.minus(right.pass).minus(gap);
  const points=[lo,hi];
  if (!slope.isZero()) {
    const cross=dec(String(lo)).minus(gap.times(hi-lo).div(slope));
    if (cross.gt(lo) && cross.lt(hi)) points.push(cross.floor().toNumber(),cross.ceil().toNumber());
  }
  let peak=lo,bound=min(left.fail,left.pass);
  for (const j of points) {
    const cash=margins(j),value=min(cash.fail,cash.pass);
    if (value.gt(bound)) { peak=j; bound=value; }
  }
  yield peak;
  const rest=cashBand(lo,hi,left,right,incumbent(),extraRecovery);
  if (rest) for (let j=rest[0];j<=rest[1];j++) if (j!==peak) yield j;
}

function score(row, failureFloor, reserve, maintenanceFloor) {
  const p=row.pressureSummary;
  if (!row.configuredPass || p?.status!=='pass' || ![p.minFailure,p.minSuccess,p.minSurplus,p.maxMarginUsed]
    .every(metric=>metric?.value!=null) || p.cashBuffers?.minimum==null) return null;
  const surplus=dec(p.minSurplus.value);
  if (dec(p.minFailure.value).lt(failureFloor) || dec(p.minSuccess.value).lt(reserve) ||
      surplus.lt(maintenanceFloor)) return null;
  return {row,headroom:dec(p.cashBuffers.minimum),surplus,peakMargin:dec(p.maxMarginUsed.value)};
}

function safer(candidate,best) {
  if (!best) return true;
  const rank=candidate.headroom.cmp(best.headroom) || candidate.surplus.cmp(best.surplus) ||
    best.peakMargin.cmp(candidate.peakMargin) ||
    dec(best.row.leverage ?? '0').cmp(candidate.row.leverage ?? '0');
  if (rank) return rank>0;
  return candidate.row.sign!==best.row.sign ? candidate.row.sign>best.row.sign : candidate.row.j<best.row.j;
}

export function searchLiquidityMaximum(scan,inspect,pending=false,ctx=scan.ctx) {
  const eligible=scan.sets.eligible ?? scan.sets.both;
  const scope=ctx.checks.stress ? 'configured' : 'bookOnly';
  const result={status:'none',key:null,checked:0,scope,configuredStatus:'none',liveSafety:'unverified',
    allSpecified:{status:'none',key:null,reason:'已配置条件下无可行仓位，增加指定压力条件后仍无解'},
    reason:'没有同时满足两端资金、保证金和撤档退出条件的仓位'};
  const incomplete=reason=>({...result,status:'incomplete',configuredStatus:'unknown',reason,
    allSpecified:{status:'unverified',key:null,reason}});
  if (pending || !scan.complete) return incomplete(pending?'分成待结算':'数量网格搜索未完成');
  if (dec(ctx.checks.basisBps ?? '0').gt(0) && ctx.checks.basisRate==null)
    return incomplete('已配置基差压力，双边基差方向缺少有效参照汇率');
  if (ctx.params.externalPriced===false)
    return incomplete('已到账外部资金缺少有效计值，本金保护待核实');
  if (!eligible.largest) return result;
  const {book,market,checks,params}=ctx, profile=profileInputs(book,params,market);
  const hl=market.hl, old=position(book,'hl');
  const extraRecovery=dec(params.recoveryBuffer ?? '0');
  const failure=dec(book.B).minus(book.external);
  const reserve=dec(params.R);
  const delayUnit=dec(hl.mark).times(hl.multiplier).times(hl.fx).times(checks.stress?.delayBps ?? '0').div(10000);
  // The adverse funding schedule values the position at its peak path mark,
  // at least today's mark. Only this necessary lower debit is used in pruning.
  const rateSum=(checks.fundingRatesBps??[]).reduce((total,rate)=>total.plus(rate),dec('0'));
  const scheduledPerLot=dec(hl.step).times(hl.mark).times(hl.multiplier).times(hl.fx).times(rateSum).div(10000);
  const fixedFunding=dec(checks.stress?.fundingDebit ?? '0');
  const crossing=scheduledPerLot.gt(0) ? fixedFunding.div(scheduledPerLot).floor() : null;
  const directions=[1,-1].map(sign=>({
    sign,pf:depthLimits(market.pf,sign),hl:depthLimits(hl,-sign),hype:new Map()
  }));
  if (crossing && crossing.lte(Number.MAX_SAFE_INTEGER)) {
    const lot=crossing.toNumber();
    for (const d of directions) if (lot>0 && lot<d.hl.cap)
      d.hl.cuts=[...new Set([...d.hl.cuts,lot])].sort((a,b)=>a-b);
  }
  const top=Math.min(eligible.largest.i,Math.max(...directions.map(d=>d.pf.cap)));
  const floor=dec(book.B).plus(extraRecovery);
  const maintenanceFloor=dec(checks.minMaintenanceSurplus ?? '0');
  for (let i=top; i>=1; i--) {
    let best=null, unknownBound=null;
    const incumbent=()=>best?.headroom ?? dec('0');
    for (const d of directions) {
      if (i>d.pf.cap) continue;
      const bands=ratioSlice(scan,d.sign,i,'eligible').filter(([lo])=>lo<=d.hl.cap);
      if (!bands.length) continue;
      const moves=nativeEndpoints(ctx,dec(market.pf.step).times(i*d.sign),profile);
      const margins=j=>{
        if (!d.hype.has(j)) {
          const q=dec(hl.step).times(-d.sign*j), term=legTerms(ctx,'hl',q);
          const friction=dec(profile.k).plus(q.minus(old).abs().times(delayUnit))
            .plus(q.isZero()?'0':max(fixedFunding,scheduledPerLot.times(j)));
          d.hype.set(j,{start:term.settled.minus(friction),slope:term.slope});
        }
        const {start,slope}=d.hype.get(j);
        return {fail:start.plus(slope.times(moves.fail)).minus(failure),
          pass:start.plus(slope.times(moves.pass)).minus(reserve)};
      };
      for (const [first,last] of bands) {
        let lo=first;
        const hi=Math.min(last,d.hl.cap);
        // Each cell already splits at the original order-book depth and at a
        // change in adjustment direction. Add retained exit levels and zero.
        for (const cut of [0,...d.hl.cuts]) {
          const end=Math.min(cut,hi);
          if (end<lo) continue;
          for (const j of competitiveLots(lo,end,margins,incumbent,extraRecovery)) {
            result.checked++;
            const row=inspect({i,j,sign:d.sign});
            const candidate=score(row,floor,reserve,maintenanceFloor);
            if (candidate && safer(candidate,best)) best=candidate;
            const v=row.verification??{};
            const verdicts=[row.pressureSummary?.status,v.path,v.initial,v.liquidation,row.depthStatus];
            if (checks.fullStress) verdicts.push(v.stress);
            if (!candidate && !verdicts.includes('fail') && !verdicts.includes('insufficient') &&
                (row.configuredPass || verdicts.some(status=>status==null || status==='unknown'))) {
              const upper=margins(j);
              const bound=min(upper.fail,upper.pass).plus('1e-12');
              unknownBound=unknownBound==null?bound:max(unknownBound,bound);
            }
          }
          lo=end+1;
          if (lo>hi) break;
        }
      }
    }
    // No smaller PF position can win once all candidates at this size have
    // been compared. Unresolved required scenarios at higher lots preclude
    // publishing a smaller position as the verified maximum.
    if (unknownBound!=null && (!best || unknownBound.gte(best.headroom))) {
      return incomplete(best?'同一最大规模有已配置压力待核实，并列候选排序未完成':'较大仓位有已配置的压力项目尚无法核实');
    }
    if (best) {
      const row=best.row, full=row.pressureSummary.coverage?.allSpecifiedPassed===true;
      const reason=full?'所有指定压力下的最大候选已核验':
        scope==='bookOnly'?'A–C 已配置盘口压力下的最大候选':'已配置盘口、价格或资金费压力下的最大候选';
      const missing=row.pressureSummary.coverage?.unverifiedLabels ?? [];
      return {...result,status:full?'feasible':'conditional',configuredStatus:'pass',
        scope:full?'allSpecified':scope,reason,key:row.key,row,
        allSpecified:full?{status:'verified',key:row.key,reason}:
          {status:'unverified',key:null,reason:missing.length?'待核验：'+missing.join('、'):'尚未取得全部指定压力下的最大仓位证明'}};
    }
  }
  return result;
}
