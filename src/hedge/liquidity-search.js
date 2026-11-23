import { dec, out, min, max, estimateFill, fillEvidence } from './math.js';
import { exitBook, pressureExitOffset } from './exit-liquidity.js';
import { projectSettlementEquity, profileInputs, executionDetail } from './solver.js';
import { position } from './ratio-domain.js';
import { ratioSlice } from './ratio-scan.js';

export function depthLimits(leg, sign) {
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
function legTerms(ctx,side,q,removed=2) {
  const leg=ctx.market[side], unit=dec(leg.multiplier).times(leg.fx);
  const marked=projectSettlementEquity(ctx.book,ctx.market,side,out(q),'0','mark_equity',ctx.checks.catalog);
  const qty=q.neg(), book=exitBook(leg,q,removed);
  const fill=estimateFill(out(qty),book);
  const exit=dec(fill?.notional ?? '0').times(unit);
  const slope=q.minus(q.abs().times(leg.rate)).times(unit);
  const settled=marked.plus(exit.times(q.cmp(0))).minus(q.times(unit).times(leg.mark)).minus(exit.times(leg.rate));
  return {marked,settled,slope,signed:q.times(unit)};
}

export function pfDisplacements(ctx,pf,profile,removed=2) {
  const term=legTerms(ctx,'pf',pf,removed), {checks}=ctx;
  return Object.fromEntries([['fail',profile.floor,checks.failureTrigger],['pass',profile.target,checks.passTrigger]]
    .map(([end,target,trigger])=>{
      const mark=trigger==='mark_equity';
      const move=dec(target).minus(mark ? term.marked : term.settled).div(mark ? term.signed : term.slope);
      return [end,move];
    }));
}

export function nativeEndpoints(ctx,pf,profile) {
  const moves=pfDisplacements(ctx,pf,profile);
  const factor=dec(ctx.market.hl.factor).div(ctx.market.pf.factor);
  const offset=pressureExitOffset(ctx.market.hl,-pf.cmp(0),ctx.checks);
  return {fail:moves.fail.times(factor).plus(offset),pass:moves.pass.times(factor).plus(offset)};
}

// Cash is affine in the Hype lot index inside each entry/exit depth segment.
// Outward tolerance retains numerical boundary lots for exact ledger admission.
function cashBand(lo,hi,left,right,minimum,extraRecovery,extraSuccess) {
  let from=lo, to=hi;
  for (const end of ['fail','pass']) {
    const floor=end==='fail' ? max(minimum,extraRecovery) : max(minimum,extraSuccess);
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
function* competitiveLots(first,last,margins,incumbent,extraRecovery,extraSuccess) {
  const band=cashBand(first,last,margins(first),margins(last),incumbent(),extraRecovery,extraSuccess);
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
  const rest=cashBand(lo,hi,left,right,incumbent(),extraRecovery,extraSuccess);
  if (rest) for (let j=rest[0];j<=rest[1];j++) if (j!==peak) yield j;
}

export function score(row, failureFloor, reserve, maintenanceFloor, riskOnly = false) {
  const p=row.pressureSummary;
  if ((!riskOnly && !row.configuredPass) || (riskOnly && !row.physical) || p?.status!=='pass' || ![p.minFailure,p.minSuccess,p.minSurplus,p.maxMarginUsed,p.worstFinal]
    .every(metric=>metric?.value!=null) || p.M_verified==null) return null;
  const surplus=dec(p.minSurplus.value);
  if ((!riskOnly && dec(p.minFailure.value).lt(failureFloor)) || dec(p.minSuccess.value).lt(reserve) ||
      surplus.lt(maintenanceFloor)) return null;
  const headroom=riskOnly ? min(dec(p.minFailure.value), dec(p.minSuccess.value).minus(reserve)) : dec(p.M_verified);
  return {row,headroom,final:dec(p.worstFinal.value),surplus,peakMargin:dec(p.maxMarginUsed.value)};
}

function safer(candidate,best,cashPriority) {
  if (!best) return true;
  const margin=best.peakMargin.cmp(candidate.peakMargin), surplus=candidate.surplus.cmp(best.surplus);
  const rank=candidate.headroom.cmp(best.headroom) ||
    (cashPriority ? margin || surplus : candidate.final.cmp(best.final) || surplus || margin) ||
    dec(best.row.leverage ?? '0').cmp(candidate.row.leverage ?? '0');
  if (rank) return rank>0;
  return candidate.row.sign!==best.row.sign ? candidate.row.sign>best.row.sign : candidate.row.j!==best.row.j ? candidate.row.j<best.row.j : candidate.row.i<best.row.i;
}

export function missingPressureRate(checks) {
  return checks.basisRate==null && (dec(checks.basisBps??'0').gt(0) ||
    Object.values(checks.venueScenarios??{}).some(v=>v!=null && dec(v).gt(0)));
}

export function searchLiquidityMaximum(scan,inspect,pending=false,ctx=scan.ctx,objective='size',seed=null,fixedI=null,onlySign=null,collect=false,upperI=Infinity,tradeoff=null,riskOnly=false) {
  const sliceKey=riskOnly?'risk':'eligible';
  const eligible=riskOnly?scan.sets.risk:(scan.sets.eligible ?? scan.sets.both);
  const scope=ctx.checks.stress ? 'configured' : 'bookOnly';
  const result={status:'none',key:null,checked:0,scope,configuredStatus:'none',liveSafety:'unverified',
    allSpecified:{status:'none',key:null,reason:'已配置条件下无可行仓位，增加指定压力条件后仍无解'},
    reason:'没有同时满足两端资金、保证金和撤档退出条件的仓位'};
  const incomplete=reason=>({...result,status:'incomplete',configuredStatus:'unknown',reason,
    allSpecified:{status:'unverified',key:null,reason}});
  // D removes levels until less than the positive PF exit quantity remains.
  if (ctx.checks.hardDepthD) return {...result,reason:'D 为硬性约束：可见深度不足，无法证明双边全量退出'};
  if (pending || !scan.complete) return incomplete(pending?'分成待结算':'数量网格搜索未完成');
  if (missingPressureRate(ctx.checks))
    return incomplete('已配置基差压力，双边基差方向缺少有效参照汇率');
  if (!eligible.largest) return result;
  const {book,market,checks,params}=ctx, profile=profileInputs(book,params,market);
  const hl=market.hl, old=position(book,'hl');
  const recovery=riskOnly?dec('0'):dec(params.baseRecovery ?? book.B);
  const seekEdge=['hedgeLow','hedgeHigh','repayFailure','keepExposure'].includes(objective);
  const extraRecovery=riskOnly?dec('0'):(objective==='repayFailure'?dec(params.profitBasis).minus(recovery):dec(book.B).minus(recovery).plus(params.recoveryBuffer ?? '0'));
  const extraSuccess=dec(params.successBuffer ?? '0');
  const failure=recovery.minus(book.external);
  const reserve=dec(params.R);
  const delayUnit=dec(hl.mark).times(hl.multiplier).times(hl.fx).times(checks.stress?.delayBps ?? '0').div(10000);
  // The adverse funding schedule values the position at its peak path mark,
  // at least today's mark. Only this necessary lower debit is used in pruning.
  const rateSum=(checks.fundingRatesBps??[]).reduce((total,rate)=>total.plus(rate),dec('0'));
  const scheduledPerLot=dec(hl.step).times(hl.mark).times(hl.multiplier).times(hl.fx).times(rateSum).div(10000);
  const fixedFunding=dec(checks.stress?.fundingDebit ?? '0');
  const crossing=scheduledPerLot.gt(0) ? fixedFunding.div(scheduledPerLot).floor() : null;
  const directions=(onlySign?[onlySign]:[1,-1]).map(sign=>({
    sign,pf:depthLimits(market.pf,sign),hl:depthLimits(hl,-sign),hype:new Map()
  }));
  if (crossing && crossing.lte(Number.MAX_SAFE_INTEGER)) {
    const lot=crossing.toNumber();
    for (const d of directions) if (lot>0 && lot<d.hl.cap)
      d.hl.cuts=[...new Set([...d.hl.cuts,lot])].sort((a,b)=>a-b);
  }
  const top=Math.min(upperI,eligible.largest.i,Math.max(...directions.map(d=>d.pf.cap)));
  if (fixedI!=null && (fixedI<1 || fixedI>top)) return result;
  const floor=recovery.plus(extraRecovery);
  const maintenanceFloor=dec(checks.minMaintenanceSurplus ?? '0');
  const prioritizeCash=objective==='cash';
  const acrossSizes=prioritizeCash || tradeoff!=null;
  // Translate the current objective bound back to cash before pruning any
  // Hype quantity. Within one PF size the added scale utility is constant.
  const sizeCredit=i=>tradeoff?tradeoff.rate.times(i-tradeoff.first):dec('0');
  const utility=(headroom,i)=>tradeoff?headroom.plus(sizeCredit(i)):headroom;
  const beats=(candidate,best)=>{
    if (tradeoff && best) {
      const difference=utility(candidate.headroom,candidate.row.i).cmp(utility(best.headroom,best.row.i));
      if(difference) return difference>0;
    }
    return safer(candidate,best,acrossSizes || objective==='scale');
  };
  let best=null, unknownBound=null;
  // Reprice the previous winning lot and its neighbours on this book. The
  // incumbent only tightens the affine bounds; both directions remain in the global search.
  const seeded=new Map();
  if (prioritizeCash && seed && [1,-1].includes(seed.sign)) {
    const d=directions.find(dir=>dir.sign===seed.sign);
    for (const [di,dj] of [[0,0],[-1,0],[1,0],[0,-1],[0,1]]) {
      const i=seed.i+di,j=seed.j+dj;
      if (!Number.isSafeInteger(i) || !Number.isSafeInteger(j) || i<1 || i>top || i>d.pf.cap || j<0 || j>d.hl.cap ||
          !ratioSlice(scan,d.sign,i,'eligible').some(([lo,hi])=>lo<=j && j<=hi)) continue;
      const row=inspect({sign:d.sign,i,j});
      seeded.set(row.key,row);
      const candidate=score(row,floor,reserve,maintenanceFloor);
      if (candidate && beats(candidate,best)) best=candidate;
    }
  }
  result.localEvaluations=seeded.size;
  const evaluateAtI = (i, finalize = true) => {
    if(!acrossSizes) {best=null; unknownBound=null;}
    const incumbent=()=> {
      if(collect) return dec('0');
      if(!tradeoff) return best?.headroom??dec('0');
      const threshold=best?max(tradeoff.baseline,utility(best.headroom,best.row.i)):tradeoff.baseline;
      return max(0,threshold.minus(sizeCredit(i)));
    };
    for (const d of directions) {
      if (i>d.pf.cap) continue;
      const bands=ratioSlice(scan,d.sign,i,sliceKey).filter(([lo])=>lo<=d.hl.cap);
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
          pass:start.plus(slope.times(moves.pass)).minus(params.baseReserve ?? reserve)};
      };
      if (seekEdge) {
        // Each segment has affine C-path cash. Clip to its necessary floors,
        // then verify actual lots in objective order against every hard scenario.
        const ranges=[];
        for (const [first,last] of bands) {
          let lo=first;
          for(const cut of [0,...d.hl.cuts]) {
            const hi=Math.min(last,cut);
            if(hi<lo) continue;
            const band=cashBand(lo,hi,margins(lo),margins(hi),dec('0'),extraRecovery,extraSuccess);
            if(band) ranges.push(band);
            lo=hi+1;
            if(lo>last) break;
          }
        }
        const held=old.times(-d.sign).div(hl.step).toNumber();
        const distance=([lo,hi])=>Math.max(0,lo-held,held-hi);
        if(objective==='hedgeHigh') ranges.reverse();
        if(objective==='keepExposure') ranges.sort((a,b)=>distance(a)-distance(b));
        let nearest=Infinity;
        for(const band of ranges) {
          const [lo,hi]=band;
          if(objective==='keepExposure' && distance(band)>=nearest) break;
          const start=objective==='hedgeHigh'?hi:objective==='keepExposure'?Math.max(lo,Math.min(hi,Math.round(held))):lo;
          const span=Math.max(start-lo,hi-start);
          for(let offset=0;offset<=span;offset++) {
            const points=offset?[start-offset,start+offset]:[start];
            let found=false;
            for(const j of points) {
              if(j<lo || j>hi) continue;
              result.checked++;
              const row=inspect({i,j,sign:d.sign});
              const candidate=score(row,floor,reserve,maintenanceFloor,riskOnly);
              if(!candidate) continue;
              if(objective!=='keepExposure') return {done:true,kind:'found',value:{...result,row,key:row.key,status:'conditional',configuredStatus:'pass'}};
              const delta=Math.abs(j-held);
              if(delta<nearest) { nearest=delta;best=candidate; }
              found=true;
            }
            if(found) break;
          }
        }
        if(best) return {done:true,kind:'found',value:{...result,row:best.row,key:best.row.key,status:'conditional',configuredStatus:'pass'}};
        continue;
      }
      let pfBlocked=false;
      for (const [first,last] of bands) {
        if (pfBlocked) break;
        let lo=first;
        const hi=Math.min(last,d.hl.cap);
        // Each cell already splits at the original order-book depth and at a
        // change in adjustment direction. Add retained exit levels and zero.
        for (const cut of [0,...d.hl.cuts]) {
          if (pfBlocked) break;
          const end=Math.min(cut,hi);
          if (end<lo) continue;
          const evalLot=j=>{
            result.checked++;
            const row=seeded.get([d.sign,i,j].join('/')) ?? inspect({i,j,sign:d.sign});
            const candidate=score(row,floor,reserve,maintenanceFloor,riskOnly);
            if(candidate && collect) (result.lots??=[]).push(j);
            if (candidate && beats(candidate,best)) best=candidate;
            const v=row.verification??{};
            const verdicts=[row.pressureSummary?.status,v.path,v.initial,v.liquidation,row.depthStatus];
            if (checks.fullStress) verdicts.push(v.stress);
            if (!candidate && !verdicts.includes('fail') && !verdicts.includes('insufficient') &&
                (row.configuredPass || verdicts.some(status=>status==null || status==='unknown'))) {
              const upper=margins(j);
              const bound=utility(min(upper.fail,upper.pass),i).plus('1e-12');
              unknownBound=unknownBound==null?bound:max(unknownBound,bound);
            }
            const pfDepthBad=['fail','pass'].some(e=>{
              const st=row.liquidity?.[e]?.two?.depth?.pf?.status;
              return st && st!=='covered' && st!=='noTrade';
            });
            if(pfDepthBad) pfBlocked=true;
            return {row,candidate};
          };
          // Exact unimodal + monotone search on [lo, end]:
          // fail cash increases with j; pass cash and Hype maintenance surplus decrease with j.
          if (!collect && !riskOnly && end-lo>12) {
            const band=cashBand(lo,end,margins(lo),margins(end),incumbent(),extraRecovery,extraSuccess);
            if (!band) {
              lo=end+1;
              if (lo>hi) break;
              continue;
            }
            const [bLo0,bHi0]=band;
            const leftM=margins(bLo0), rightM=margins(bHi0);
            const gap=leftM.fail.minus(leftM.pass), slope=rightM.fail.minus(rightM.pass).minus(gap);
            const pts=[bLo0,bHi0];
            if (!slope.isZero()) {
              const cross=dec(String(bLo0)).minus(gap.times(bHi0-bLo0).div(slope));
              if (cross.gt(bLo0) && cross.lt(bHi0)) pts.push(cross.floor().toNumber(),cross.ceil().toNumber());
            }
            let peak=bLo0, peakBound=min(leftM.fail,leftM.pass);
            for (const pj of pts) {
              const cm=margins(pj), val=min(cm.fail,cm.pass);
              if (val.gt(peakBound)) { peak=pj; peakBound=val; }
            }
            const seenJ=new Set();
            const evalOnce=j=>{
              if (seenJ.has(j)) return null;
              seenJ.add(j);
              return evalLot(j);
            };
            const classifyFail=row=>{
              const p=row.pressureSummary;
              const failShort=p?.minFailure?.value!=null && dec(p.minFailure.value).lt(floor);
              const passOrRiskBad=(p?.minSuccess?.value!=null && dec(p.minSuccess.value).lt(reserve)) ||
                (p?.minSurplus?.value!=null && dec(p.minSurplus.value).lt(maintenanceFloor)) ||
                row.verification?.liquidation==='fail' || row.verification?.path==='fail' || row.verification?.initial==='fail';
              return {failShort,passOrRiskBad};
            };
            let minJ=bLo0, maxJ=bHi0, provedEmpty=false, anchor=peak;
            const peakRes=evalOnce(peak);
            if (!pfBlocked && peakRes && !peakRes.candidate) {
              const {failShort,passOrRiskBad}=classifyFail(peakRes.row);
              if (failShort && passOrRiskBad) {
                provedEmpty=true;
              } else if (passOrRiskBad) {
                maxJ=Math.min(maxJ,peak-1);
                let sLo=minJ, sHi=maxJ, foundHi=null, ambiguous=false;
                while (sLo<=sHi && !pfBlocked) {
                  const mid=Math.floor((sLo+sHi)/2);
                  const mr=evalOnce(mid);
                  if (pfBlocked || !mr) break;
                  if (mr.candidate) { foundHi=mid; sLo=mid+1; continue; }
                  const cf=classifyFail(mr.row);
                  if (cf.failShort && cf.passOrRiskBad) { provedEmpty=foundHi==null; break; }
                  if (cf.failShort) { minJ=Math.max(minJ,mid+1); sLo=mid+1; }
                  else if (cf.passOrRiskBad) { maxJ=Math.min(maxJ,mid-1); sHi=mid-1; }
                  else { ambiguous=true; break; }
                }
                if (foundHi!=null) anchor=foundHi;
                else if (!ambiguous) provedEmpty=true;
              } else if (failShort) {
                minJ=Math.max(minJ,peak+1);
                let sLo=minJ, sHi=maxJ, foundLo=null, ambiguous=false;
                while (sLo<=sHi && !pfBlocked) {
                  const mid=Math.floor((sLo+sHi)/2);
                  const mr=evalOnce(mid);
                  if (pfBlocked || !mr) break;
                  if (mr.candidate) { foundLo=mid; sHi=mid-1; continue; }
                  const cf=classifyFail(mr.row);
                  if (cf.failShort && cf.passOrRiskBad) { provedEmpty=foundLo==null; break; }
                  if (cf.failShort) { minJ=Math.max(minJ,mid+1); sLo=mid+1; }
                  else if (cf.passOrRiskBad) { maxJ=Math.min(maxJ,mid-1); sHi=mid-1; }
                  else { ambiguous=true; break; }
                }
                if (foundLo!=null) anchor=foundLo;
                else if (!ambiguous) provedEmpty=true;
              }
            }
            if (!pfBlocked && !provedEmpty && minJ<=maxJ) {
              const rest=cashBand(minJ,maxJ,margins(minJ),margins(maxJ),incumbent(),extraRecovery,extraSuccess);
              if (rest) {
                let rLo=rest[0], rHi=rest[1];
                const center=Math.max(rLo,Math.min(rHi,anchor));
                // Radiate outward from anchor; stop each side as soon as affine upper bound drops below live incumbent.
                for (let j=center; j>=rLo && j>=minJ && !pfBlocked; j--) {
                  const m=margins(j);
                  if (min(m.fail,m.pass).plus('1e-12').lt(incumbent())) break;
                  const res=evalOnce(j);
                  if (!res || pfBlocked) continue;
                  if (!res.candidate) {
                    const cf=classifyFail(res.row);
                    if (cf.failShort) { minJ=Math.max(minJ,j+1); break; }
                  }
                }
                for (let j=center+1; j<=rHi && j<=maxJ && !pfBlocked; j++) {
                  const m=margins(j);
                  if (min(m.fail,m.pass).plus('1e-12').lt(incumbent())) break;
                  const res=evalOnce(j);
                  if (!res || pfBlocked) continue;
                  if (!res.candidate) {
                    const cf=classifyFail(res.row);
                    if (cf.passOrRiskBad) { maxJ=Math.min(maxJ,j-1); break; }
                  }
                }
              }
            }
            lo=end+1;
            if (lo>hi) break;
            continue;
          }
          let riskProbes=0;
          let minJ=lo, maxJ=end;
          for (const j of competitiveLots(lo,end,margins,incumbent,extraRecovery,extraSuccess)) {
            if (pfBlocked || minJ>maxJ) break;
            if (j<minJ || j>maxJ) continue;
            const {row,candidate}=evalLot(j);
            if (pfBlocked) break;
            if (riskOnly && !collect && !acrossSizes && (best || ++riskProbes>=2)) break;
            if (!candidate && !riskOnly) {
              const p=row.pressureSummary;
              if (p?.minFailure?.value!=null && dec(p.minFailure.value).lt(floor)) minJ=Math.max(minJ,j+1);
              if ((p?.minSuccess?.value!=null && dec(p.minSuccess.value).lt(reserve)) ||
                  (p?.minSurplus?.value!=null && dec(p.minSurplus.value).lt(maintenanceFloor)) ||
                  row.verification?.liquidation==='fail') maxJ=Math.min(maxJ,j-1);
            }
          }
          if (riskOnly && best && !collect && !acrossSizes) break;
          lo=end+1;
          if (lo>hi) break;
        }
        if (riskOnly && best && !collect && !acrossSizes) break;
      }
    }
    if (!finalize) return {done:false,kind:'continue'};
    if (unknownBound!=null && (collect || !best || unknownBound.gte(utility(best.headroom,best.row.i)))) {
      return {done:true,kind:'incomplete',value:incomplete(best?'同一最大规模有已配置压力待核实，并列候选排序未完成':'较大仓位有已配置的压力项目尚无法核实')};
    }
    if (best) {
      const row=best.row, full=row.pressureSummary.coverage?.allSpecifiedPassed===true;
      const reason=prioritizeCash?'已配置压力下最差现金缓冲最大':full?'所有指定压力下的最大候选已核验':
        scope==='bookOnly'?'A-C已配置盘口压力下的最大候选':'已配置盘口、价格或资金费压力下的最大候选';
      const missing=row.pressureSummary.coverage?.unverifiedLabels ?? [];
      // At fixed PF lots, equal C-path headrooms have a continuous Hype
      // quantity: entry costs common to both endpoints cancel in the difference.
      if ((prioritizeCash || objective==='scale') && row.j>0) {
        const moves=nativeEndpoints(ctx,dec(row.pf),profile);
        const unit=dec(hl.multiplier).times(hl.fx).times(dec('1').plus(dec(hl.rate).times(row.sign)));
        const denominator=moves.fail.minus(moves.pass).times(unit);
        if (!denominator.isZero()) {
          const q=failure.minus(params.baseReserve ?? reserve).div(denominator);
          if (q.cmp(0)===dec(row.hl).cmp(0)) result.continuousBalance={
            h:out(dec(row.notionalRatio??row.h).times(q.div(row.hl))),q:out(q),
            roundsToWinner:q.abs().div(hl.step).toDecimalPlaces(0).eq(row.j)
          };
        }
      }
      return {done:true,kind:'found',value:{...result,status:full?'feasible':'conditional',configuredStatus:'pass',
        scope:full?'allSpecified':scope,reason,key:row.key,row,
        allSpecified:full?{status:'verified',key:row.key,reason}:
          {status:'unverified',key:null,reason:missing.length?'待核验：'+missing.join('、'):'尚未取得全部指定压力下的最大仓位证明'}}};
    }
    return {done:false,kind:'none'};
  };

  // Fast boundary search for single-size descending/ascending objectives (scale / size / minimumSize)
  // avoids O(top) linear lot stepping across thousands of infeasible PF sizes.
  if (fixedI==null && !collect && !acrossSizes && !seekEdge && top>32) {
    const lowBound=Math.max(1,Math.min(top,eligible.smallest?.i ?? 1));
    if (objective==='minimumSize') {
      const firstRes=evaluateAtI(lowBound,true);
      if (firstRes.done) return firstRes.value;
      const raw=[lowBound+1,lowBound+2,lowBound+4,lowBound+8,lowBound+16,
        ...[0.02,0.03,0.05,0.07,0.1,0.15,0.2,0.25,0.3,0.35,0.4,0.45,0.5,0.55,0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.95,1].map(r=>Math.round(top*r))];
      const probes=[...new Set(raw.filter(v=>v>lowBound && v<=top))].sort((a,b)=>a-b);
      let failI=lowBound;
      const runAscProbe=(list)=>{
        for (const p of list) {
          const r=evaluateAtI(p,true);
          if (r.kind==='incomplete') return r.value;
          if (r.kind==='found') {
            let loF=failI, hiP=p, bestRes=r;
            while (hiP-loF>1) {
              const mid=Math.floor((loF+hiP)/2);
              const mr=evaluateAtI(mid,true);
              if (mr.kind==='incomplete') return mr.value;
              if (mr.kind==='found') { hiP=mid; bestRes=mr; }
              else loF=mid;
            }
            return bestRes.value;
          }
          failI=p;
        }
        return null;
      };
      const hit=runAscProbe(probes);
      if (hit) return hit;
      const mids=[];
      const seq=[lowBound,...probes];
      for (let k=0;k<seq.length-1;k++) if (seq[k+1]-seq[k]>1) mids.push(Math.floor((seq[k]+seq[k+1])/2));
      failI=lowBound;
      const hit2=runAscProbe(mids);
      return hit2 ?? result;
    } else {
      const topRes=evaluateAtI(top,true);
      if (topRes.done) return topRes.value;
      const raw=[top-1,top-2,top-4,top-8,top-16,
        ...[0.95,0.9,0.85,0.8,0.75,0.7,0.65,0.6,0.55,0.5,0.45,0.4,0.35,0.3,0.25,0.2,0.15,0.1,0.07,0.05,0.03,0.02,0.01].map(r=>Math.round(top*r)),
        lowBound];
      const probes=[...new Set(raw.filter(v=>v>=lowBound && v<top))].sort((a,b)=>b-a);
      let prevFail=top;
      const runDescProbe=(list)=>{
        for (const p of list) {
          const r=evaluateAtI(p,true);
          if (r.kind==='incomplete') return r.value;
          if (r.kind==='found') {
            let passI=p, failI=prevFail, bestRes=r;
            while (failI-passI>1) {
              const mid=Math.floor((passI+failI)/2);
              const mr=evaluateAtI(mid,true);
              if (mr.kind==='incomplete') return mr.value;
              if (mr.kind==='found') { passI=mid; bestRes=mr; }
              else failI=mid;
            }
            return bestRes.value;
          }
          prevFail=p;
        }
        return null;
      };
      const hit=runDescProbe(probes);
      if (hit) return hit;
      const mids=[];
      const seq=[top,...probes];
      for (let k=0;k<seq.length-1;k++) if (seq[k]-seq[k+1]>1) mids.push(Math.floor((seq[k]+seq[k+1])/2));
      prevFail=top;
      const hit2=runDescProbe(mids);
      return hit2 ?? result;
    }
  }

  for (let n=tradeoff?tradeoff.first-1:0;n<(fixedI==null?top:1);n++) {
    const i=fixedI ?? (acrossSizes || objective==='minimumSize' ? n+1 : top-n);
    const finalize=!(fixedI==null && acrossSizes && n+1<top);
    const step=evaluateAtI(i,finalize);
    if (step.done) return step.value;
  }
  return result;
}

export function compactScale(row) {
  const p=row.pressureSummary, a=p.cases.find(c=>c.id==='A');
  const priced=p.cases.filter(c=>c.configured);
  const lowest=end=>{
    const amounts=priced.map(c=>c[end].cash).filter(v=>v!=null);
    return amounts.length?out(min(...amounts)):null;
  };
  const missing=priced.find(c=>c.fail.cash==null || c.success.cash==null);
  return {sign:row.sign,i:row.i,j:row.j,deadline:row.deadline,pf:row.pf,hl:row.hl,pfValue:row.pfValue,hypeValue:row.hypeValue,h:row.notionalRatio,
    fail:lowest('fail'),pass:lowest('success'),margin:p.maxMarginUsed?.value??null,
    surplus:p.minSurplus?.value??null,leverage:row.leverage,
    cashComplete:!missing,cashReason:missing && (missing.reason??missing.label+'缺少路径结算'),
    failMark:a?.fail.mathMarks?.trigger??null,passMark:a?.success.mathMarks?.trigger??null,
    failMove:a?.fail.exam?.percent??null,passMove:a?.success.exam?.percent??null};
}

export function diagnoseScale(scan,ctx,i,inspect,onlySign=null) {
  const {market,params,book,checks}=ctx, pf=market.pf, hl=market.hl;
  const quantity=dec(pf.step).times(i);
  const reasons=[];
  let witness=null,best=null,nearest=null;
  for (const sign of onlySign?[onlySign]:[1,-1]) {
    const side=sign>0?'PF 多':'PF 空';
    const cap=depthLimits(pf,sign).cap;
    if(i>cap) {
      reasons.push(side+'撤前两档后退出深度短缺 '+quantity.minus(dec(pf.step).times(cap)).toFixed(6)+' '+pf.unit);
      continue;
    }
    const bands=ratioSlice(scan,sign,i,'legal');
    if(!bands.length) {
      const limit=scan.cells.reduce((n,c)=>c.sign===sign?Math.max(n,c.to):n,0);
      const q=quantity.times(sign);
      let reason='无同时满足双边开仓限额及正触线价的数量步长';
      if(i>limit) reason='超出本帧开仓数量上界 '+quantity.minus(dec(pf.step).times(limit)).toFixed(6)+' '+pf.unit;
      else if(['noTrade','covered'].includes(fillEvidence(out(q.minus(position(book,'pf'))),pf).status)) {
        const moves=pfDisplacements(ctx,q,profileInputs(book,params,market));
        for(const [end,move] of Object.entries(moves)) {
          if(move.plus(pf.mark).lte(0)) reason=(end==='pass'?'通过':'失败')+'需下跌 '+move.abs().div(pf.mark).times(100).toFixed(2)+'%，触线价不为正';
        }
      }
      const held=position(book,'pf'),delta=q.minus(held),d=delta.lt(0)?1:0;
      const available=pf.directionalFree?.[d]??pf.free;
      const gaps=[];
      if(pf.capacity?.[d]!=null && delta.abs().gt(pf.capacity[d]))
        gaps.push('PF 方向可下单额度短缺 '+out(delta.abs().minus(pf.capacity[d]))+' '+pf.unit);
      if(available!=null && pf.leverage && !delta.isZero() && fillEvidence(out(delta),pf).status==='covered') {
        const fee=executionDetail(pf,out(delta)).fee;
        const change=q.abs().minus(held.abs()).times(pf.mark).times(pf.multiplier).times(pf.fx).div(pf.leverage);
        // Net free collateral already excludes current usage and order holds.
        const shortfall=change.plus(fee).plus(pf.reserve??0).minus(available);
        if(shortfall.gt(0)) gaps.push('PF 可用抵押品短缺 '+shortfall.toFixed(4)+' U（含本次调仓手续费）');
      }
      if(gaps.length) reason=gaps.join('、');
      reasons.push(side+'：'+reason);
      continue;
    }
    const moves=nativeEndpoints(ctx,quantity.times(sign),profileInputs(book,params,market));
    const slope=dec(hl.step).times(-sign).times(hl.multiplier).times(hl.fx)
      .times(dec('1').plus(dec(hl.rate).times(sign)));
    const denominator=slope.times(moves.fail.minus(moves.pass));
    const balance=denominator.isZero()?dec('0'):dec(params.baseRecovery??book.B).minus(book.external)
      .minus(params.baseReserve??params.R).div(denominator);
    const capHL=depthLimits(hl,-sign).cap;
    let sideReason=null,sideBest=null;
    for(const [lo,last] of bands) {
      const hi=Math.min(last,capHL);
      if(hi<lo) {sideReason??='Hype 撤档退出深度短缺 '+dec(hl.step).times(lo-hi).toFixed(6)+' '+hl.unit;continue;}
      const near=max(lo,min(hi,balance));
      for(const j of new Set([near.floor().toNumber(),near.ceil().toNumber()])) {
        const row=inspect({sign,i,j}), p=row.pressureSummary, a=p.cases.find(c=>c.id==='A');
        const deficits=[['失败',a.fail],['通过',a.success]].filter(([,e])=>e.exam?.status==='fail' && e.exam.limit!=null)
          .map(([label,e])=>label+'需'+(dec(e.exam.percent).lt(0)?'下跌 ':'上涨 ')+dec(e.exam.percent).abs().toFixed(2)+'%，窗口上限 '+dec(e.exam.limit).toFixed(2)+'%');
        const gap=p.worstCase;
        const issue=row.constraintIssue;
        const shortfall=issue?.status==='fail' && issue.shortfall!=null && dec(issue.shortfall).gt(0)?
          issue.code+' 差 '+dec(issue.shortfall).toFixed(4)+' '+issue.unit:null;
        const reason=deficits.join('、') || (shortfall?[gap?.reason,shortfall].filter(Boolean).join('，'):gap?.reason) || row.failStop || row.passStop || '未通过双边资金和保证金约束';
        const score=p.M_verified==null?null:dec(p.M_verified);
        if(sideReason==null || score!=null && (sideBest==null || score.gt(sideBest))) {sideReason=reason;sideBest=score;}
        const distance=balance.minus(j).abs();
        if(!witness || (score!=null && (best==null || score.gt(best))) || (best==null && score==null && distance.lt(nearest))) {
          witness=compactScale(row);best=score;nearest=distance;
        }
      }
    }
    reasons.push(side+'：'+(sideReason??'无可验证的全量退出'));
  }
  return {witness,reason:reasons.join('；')};
}
