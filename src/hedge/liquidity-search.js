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
function cashBand(lo,hi,left,right,minimum) {
  let from=lo, to=hi;
  for (const end of ['fail','pass']) {
    const a=left[end].minus(minimum).plus('1e-12'), b=right[end].minus(minimum).plus('1e-12');
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
function* competitiveLots(first,last,margins,incumbent) {
  const band=cashBand(first,last,margins(first),margins(last),incumbent());
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
  const rest=cashBand(lo,hi,left,right,incumbent());
  if (rest) for (let j=rest[0];j<=rest[1];j++) if (j!==peak) yield j;
}

function score(row, failureFloor, reserve) {
  const p=row.pressureSummary;
  if (!row.configuredPass || p?.status!=='pass' || ![p.minFailure,p.minSuccess,p.minSurplus,p.maxMarginUsed]
    .every(metric=>metric?.value!=null)) return null;
  const headroom=min(dec(p.minFailure.value).minus(failureFloor),dec(p.minSuccess.value).minus(reserve));
  return headroom.lt(0) ? null : {row,headroom,surplus:dec(p.minSurplus.value),peakMargin:dec(p.maxMarginUsed.value)};
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
  const result={status:'none',key:null,checked:0,reason:'没有同时满足两端资金、保证金和撤档退出条件的仓位'};
  if (pending || !scan.complete) return {...result,status:'incomplete',reason:pending?'分成待结算':'数量网格搜索未完成'};
  if (dec(ctx.checks.basisBps ?? '0').gt(0) && ctx.checks.basisRate==null)
    return {...result,status:'incomplete',reason:'已配置基差压力，双边基差方向缺少有效参照汇率'};
  if (ctx.params.externalPriced===false)
    return {...result,status:'incomplete',reason:'已到账外部资金缺少有效计值，本金保护待核实'};
  if (!eligible.largest) return result;
  const {book,market,checks,params}=ctx, profile=profileInputs(book,params,market);
  const hl=market.hl, old=position(book,'hl');
  const failure=dec(book.B).plus(params.recoveryBuffer ?? '0').minus(book.external);
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
  const floor=dec(book.B).plus(params.recoveryBuffer ?? '0');
  for (let i=top; i>=1; i--) {
    let best=null, unknown=false;
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
          for (const j of competitiveLots(lo,end,margins,incumbent)) {
            result.checked++;
            const row=inspect({i,j,sign:d.sign});
            const candidate=score(row,floor,reserve);
            if (candidate && safer(candidate,best)) best=candidate;
            const v=row.verification??{};
            const verdicts=[row.pressureSummary?.status,v.path,v.initial,v.liquidation,row.depthStatus];
            if (checks.fullStress) verdicts.push(v.stress);
            if (!candidate && !verdicts.includes('fail') && !verdicts.includes('insufficient') &&
                (row.configuredPass || verdicts.some(status=>status==null || status==='unknown'))) unknown=true;
          }
          lo=end+1;
          if (lo>hi) break;
        }
      }
    }
    // No smaller PF position can win once all candidates at this size have
    // been compared. Unresolved required scenarios at higher lots preclude
    // publishing a smaller position as the verified maximum.
    if (best) {
      const row=best.row, full=checks.fullStress && row.pressureSummary.fullStress;
      return {...result,status:full?'feasible':'conditional',reason:full
        ? '已通过配置的价格、资金费与退出压力' : '已配置项目通过，完整压力未验证',key:row.key,row};
    }
    if (unknown) return {...result,status:'incomplete',reason:'较大仓位有已配置的压力项目尚无法核实'};
  }
  return result;
}
