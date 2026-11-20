import { dec, out, estimateFill } from './math.js';
import { exitBook } from './exit-liquidity.js';
import { projectSettlementEquity, profileInputs, pathDislocation } from './solver.js';
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
  const offset=pathDislocation(market.hl,-pf.cmp(0),checks);
  return Object.fromEntries([['fail',profile.floor,checks.failureTrigger],['pass',profile.target,checks.passTrigger]]
    .map(([end,target,trigger])=>{
      const mark=trigger==='mark_equity';
      const move=dec(target).minus(mark ? term.marked : term.settled).div(mark ? term.signed : term.slope);
      return [end,move.times(factor).plus(offset)];
    }));
}

// Cash is affine in the Hype lot index inside each entry/exit depth segment.
// Outward tolerance retains numerical boundary lots for exact ledger admission.
function cashBand(lo,hi,left,right) {
  let from=lo, to=hi;
  for (const end of ['fail','pass']) {
    const a=left[end].plus('1e-12'), b=right[end].plus('1e-12');
    if (a.lt(0) && b.lt(0)) return null;
    if (a.lt(0)===b.lt(0)) continue;
    const x=dec(String(lo)).minus(a.times(hi-lo).div(b.minus(a)));
    if (a.lt(0)) from=Math.max(from,x.ceil().toNumber());
    else to=Math.min(to,x.floor().toNumber());
  }
  return from<=to ? [from,to] : null;
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
  const directions=[1,-1].map(sign=>({
    sign,pf:depthLimits(market.pf,sign),hl:depthLimits(hl,-sign),hype:new Map()
  }));
  const top=Math.min(eligible.largest.i,Math.max(...directions.map(d=>d.pf.cap)));
  for (let i=top; i>=1; i--) for (const d of directions) {
    if (i>d.pf.cap) continue;
    const bands=ratioSlice(scan,d.sign,i,'eligible').filter(([lo])=>lo<=d.hl.cap);
    if (!bands.length) continue;
    const moves=nativeEndpoints(ctx,dec(market.pf.step).times(i*d.sign),profile);
    const margins=j=>{
      if (!d.hype.has(j)) {
        const q=dec(hl.step).times(-d.sign*j), term=legTerms(ctx,'hl',q);
        const friction=dec(profile.k).plus(q.minus(old).abs().times(delayUnit))
          .plus(q.isZero()?'0':checks.stress?.fundingDebit ?? '0');
        d.hype.set(j,{start:term.settled.minus(friction),slope:term.slope});
      }
      const {start,slope}=d.hype.get(j);
      return {fail:start.plus(slope.times(moves.fail)).minus(failure),
        pass:start.plus(slope.times(moves.pass)).minus(reserve)};
    };
    for (const [first,last] of bands) {
      let lo=first;
      const hi=Math.min(last,d.hl.cap);
      // The input grid already splits at original entry-depth and delta-sign
      // changes. Split again at the retained exit levels and at the flat lot.
      for (const cut of [0,...d.hl.cuts]) {
        const end=Math.min(cut,hi);
        if (end<lo) continue;
        const interval=cashBand(lo,end,margins(lo),margins(end));
        if (interval) for(let j=interval[0]; j<=interval[1]; j++) {
          result.checked++;
          const row=inspect({i,j,sign:d.sign});
          if (row.configuredPass) return {...result,status:checks.fullStress?'feasible':'conditional',
            reason:checks.fullStress?'已通过配置的价格与流动性压力':'通过已配置条件，完整价格压力未验证',key:row.key,row};
        }
        lo=end+1;
        if (lo>hi) break;
      }
    }
  }
  return result;
}
