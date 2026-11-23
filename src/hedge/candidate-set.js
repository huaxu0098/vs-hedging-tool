import {D,dec,out,min,max,nonnegative,positive,fillEvidence,profitSplit} from './math.js';
import {position,unit} from './ratio-domain.js';
import {executionDetail,profileInputs,solveBoundaryPrices} from './solver.js';
import {adjustmentAfterOrders} from './order-adjustment.js';
import {compactScale,searchLiquidityMaximum,diagnoseScale,depthLimits,score} from './liquidity-search.js';
import {inspectRatio} from './ratio-scan.js';
import {termFit,compareFit} from './term-reference.js';
import {examMove} from './reachability.js';
import {hasValue,parseDailyLoss,resolveFundedTotalRule,resolveLossBoundary,solveFundedWBounds} from './loss-limits.js';
import {FUNDED_CLASSIFICATIONS,solveFundedMultiRound} from './funded-multi-round.js';

const covered=(q,leg)=>['covered','noTrade'].includes(fillEvidence(out(q),leg).status);

function transition(leg,current,target) {
  const delta=target.minus(current);
  const cost=q=>{
    if(!covered(q,leg)) return null;
    if(q.isZero()) return dec('0');
    const fill=executionDetail(leg,out(q));
    return dec(fill.fee).plus(q.times(leg.multiplier).times(leg.fx).times(dec(fill.price).minus(leg.mark)));
  };
  const reversal=target.times(current).lt(0);
  const close=reversal?cost(current.neg()):null, total=reversal?cost(delta):null;
  return {current:out(current),delta:out(delta),remaining:adjustmentAfterOrders(out(delta),leg.pendingQty??null).remaining,
    reversal,close:close==null?null:out(close),open:total==null||close==null?null:out(total.minus(close))};
}

function nearestTerm(scan,ctx,inspect,sign,minimum,maximum,ref,riskOnly=false) {
  if(!maximum || !ref || ref.issue) return null;
  const {book,market,params,checks}=ctx,pf=market.pf;
  const profile=profileInputs(book,params,market);
  const factor=dec(pf.factor).times(100).div(pf.mark);
  const base=maximum.pressureSummary.cases.find(c=>c.id==='A');
  const topFit=termFit(ref,base?.success.exam?.percent,base?.fail.exam?.percent);
  if(topFit?.rank===0) return {row:maximum,complete:true};
  const choices=[];
  if(scan.termSegments?.length) {
    for(const s of scan.termSegments.filter(s=>s.sign===sign)) {
      const [pa,pb]=s.pass.map(dec),[fa,fb]=s.fail.map(dec);
      for(let i=Math.min(s.hi,maximum.i);i>=Math.max(s.lo,minimum?.i??1);i--) {
        const fit=termFit(ref,pa.div(i).plus(pb),fa.div(i).plus(fb));
        if(i===maximum.i && fit.rank===0) return {row:maximum,complete:true};
        choices.push({i,fit});
      }
    }
  } else for(let i=maximum.i;i>=(minimum?.i??1);i--) {
    let marks;
    try {
      marks=solveBoundaryPrices(book,market,out(dec(pf.step).times(i*sign)),profile.target,profile.floor,
        checks.passTrigger,checks.failureTrigger,checks.catalog);
    } catch(error) {
      if(error.message==='INVALID_PRICE_ENDPOINT') continue;
      throw error;
    }
    const fit=termFit(ref,dec(marks.pass).times(factor),dec(marks.fail).times(factor));
    if(i===maximum.i && fit.rank===0) return {row:maximum,complete:true};
    choices.push({i,fit});
  }
  choices.sort((a,b)=>compareFit(a.fit,b.fit)||b.i-a.i);
  let complete=true;
  for(const {i} of choices) {
    if(i===maximum.i) return {row:maximum,complete};
    const search=searchLiquidityMaximum(scan,inspect,false,ctx,'scale',null,i,sign,false,Infinity,null,riskOnly);
    if(search.status==='incomplete') complete=false;
    if(search.row) return {row:search.row,complete};
  }
  return {complete:false};
}

function repayment(cash,principal) {
  if(cash==null || principal==null) return null;
  const net=dec(cash).minus(principal);
  return {net:out(net),gap:out(max(0,net.neg())),recovered:net.gte(0),strictProfit:net.gt(0)};
}

function stageNet(cash,startCash,payout,passCost) {
  if(cash==null || startCash==null || passCost==null) return null;
  const realPnl=dec(cash).minus(startCash);
  const net=realPnl.plus(payout??'0').minus(passCost);
  return {realPnl:out(realPnl),net:out(net),gap:out(max(0,net.neg())),recovered:net.gte(0),strictProfit:net.gt(0)};
}

function termFunding(quote,deadline,now) {
  if(!deadline) return {issue:'当前阶段无截止期限'};
  const end=Date.parse(deadline);
  const periods=Math.floor(end/3600000)-Math.floor(now/3600000);
  if(!Number.isFinite(periods) || periods<0) return {issue:'截止时间无效'};
  if(quote?.funding==null || quote.oracle==null) return {issue:'缺少 Hype 小时费率或预言机价格'};
  const at=Date.parse(quote.markAt??quote.asOf);
  if(!Number.isFinite(at) || now-at>3000 || at>now) return {issue:'Hype 资金费报价过期'};
  if(!Number.isFinite(Number(quote.funding)) || !(Number(quote.oracle)>0)) return {issue:'Hype 资金费报价无效'};
  return {rate:quote.funding,oracle:quote.oracle,periods,at};
}

function summarizeLegCost(leg) {
  if(!leg) return null;
  const openFee=leg.entryFee??'0';
  const closeFee=leg.closeFee??leg.exitFee??'0';
  const totalFee=leg.fees??out(dec(openFee).plus(closeFee));
  const execTotal=leg.executionCost!=null
    ? leg.executionCost
    : out(dec(leg.entryFill??'0').plus(leg.exitFill??'0').neg());
  return {
    mark:leg.mark,entryPrice:leg.entryPrice,exitMark:leg.exitMark,exitPrice:leg.exitPrice,
    entryNominal:leg.entryNominal??null,exitNominal:leg.exitNominal??null,rate:leg.rate??null,
    openFee,closeFee,totalFee,execTotal,friction:leg.friction??'0',
    start:leg.start??leg.startEquity??null,settled:leg.settled??leg.finalEquity??null,move:leg.move??leg.markPnl??null
  };
}

function summarizeBranchCosts(paths,branch,withdrawalFee='0') {
  const pf=summarizeLegCost(paths?.[branch]?.pf);
  const hl=summarizeLegCost(paths?.[branch]?.hl);
  if(!pf && !hl) return null;
  const wFee=branch==='pass'?(withdrawalFee??'0'):'0';
  return {
    pf,hl,
    pfTotalFee:pf?.totalFee??null,
    hlTotalFee:hl?.totalFee??null,
    combinedFee:pf && hl?out(dec(pf.totalFee).plus(hl.totalFee)):null,
    withdrawalFee:wFee
  };
}

function summarizeLeverageGrid(grid) {
  const passing=(grid??[]).filter(t=>t.status==='pass' && t.leverage!=null);
  if(!passing.length) return {options:[],range:null};
  const picks=[passing[0]];
  if(passing.length>=3) picks.push(passing[Math.floor(passing.length/2)]);
  if(passing.length>=2) picks.push(passing.at(-1));
  return {
    options:[...new Map(picks.map(t=>[t.leverage,{leverage:t.leverage,initial:t.initial,freeAfter:t.freeAfter}])).values()],
    range:{min:passing[0].leverage,max:passing.at(-1).leverage,count:passing.length}
  };
}

function buildFundingInfo(stage,funding,termDebit,checks) {
  const configured=checks?.stress?.fundingDebit;
  const hasConfigured=configured!=null && dec(configured).gt(0);
  if(stage==='funded') {
    return {
      stage:'funded',
      includedInNet:hasConfigured,
      configuredDebit:hasConfigured?out(dec(configured)):'0',
      estimatedDebit:null,
      periods:null,
      note:hasConfigured
        ? 'Funded 资金费：已按用户配置计入实盘预算 '+dec(configured).toFixed(2)+' U（只扣一次，不重复扣减）'
        : 'Funded 资金费：无固定持有期限，未预估且未计入净利润（缺失成本不自动按 0 假定）'
    };
  }
  if(hasConfigured) {
    return {
      stage:'challenge',
      includedInNet:true,
      configuredDebit:out(dec(configured)),
      estimatedDebit:termDebit,
      periods:funding?.periods??null,
      note:'考核资金费：已按用户配置计入实盘预算 '+dec(configured).toFixed(2)+' U（只扣一次）'+
        (termDebit!=null?'；按当前小时费率估算持至截止（'+funding.periods+'h）约 '+(dec(termDebit).lt(0)?'收入 ':'支出 ')+dec(termDebit).abs().toFixed(2)+' U（仅供核对）':'')
    };
  }
  if(termDebit!=null) {
    const isIncome=dec(termDebit).lt(0);
    return {
      stage:'challenge',
      includedInNet:false,
      configuredDebit:'0',
      estimatedDebit:termDebit,
      periods:funding.periods,
      note:'考核资金费（持至截止 '+funding.periods+'h 估算）：'+(isIncome?'预计收入 ':'预计支出 ')+dec(termDebit).abs().toFixed(2)+
        ' U（未计入上表净利润，不重复扣减，亦非已到账收入）'
    };
  }
  return {
    stage:'challenge',
    includedInNet:false,
    configuredDebit:'0',
    estimatedDebit:null,
    periods:null,
    note:'考核资金费：'+(funding?.issue??'未提供费率或截止时间')+'（未计入结果，不自动按 0 假定）'
  };
}

function pathMovePct(mark,exitMark) {
  if(mark==null || exitMark==null || !dec(mark).gt(0)) return null;
  return out(dec(exitMark).minus(mark).div(mark).times(100));
}

function legTriggerEquity(leg) {
  if(!leg) return null;
  if(leg.markedEquity!=null) return leg.markedEquity;
  if(leg.start!=null && leg.entryFill!=null && leg.entryFee!=null && leg.move!=null) {
    return out(dec(leg.start).plus(leg.entryFill).minus(leg.entryFee).plus(leg.move));
  }
  return null;
}

// Compute the exact verified executable W interval for a FIXED discrete Funded position (sign, i, j):
// Holds unrounded quantities fixed; checks dual-venue price mapping, all declared open/close fees &
// orderbook execution costs, cross-margin initial/maintenance/liquidation tiers to endpoint, zero
// advance credit of future payout, and strict > 0 profit on both Funded outcomes.
function solveFixedComboWRange(fundedCtx,point,chosenWStr,baseline,fundedStart,carryCash,passCost,share,withdrawal,fLoss,wBounds,fundingIncluded) {
  if(!fLoss?.failureComplete || chosenWStr==null || passCost==null || carryCash==null) return null;
  const chosenW=dec(chosenWStr);
  if(chosenW.lte(0)) return null;
  const evalW=wDec=>{
    if(wDec.lte(0)) return false;
    if(wDec.lt(withdrawal?.minimum??'0')) return false;
    const target=dec(baseline).plus(wDec);
    if(target.lte(fundedStart)) return false;
    const targetStr=out(target);
    const split=profitSplit(targetStr,baseline,share,withdrawal);
    if(!dec(split.user).gt(0)) return false;
    try {
      const ctxAtW={...fundedCtx,params:{...fundedCtx.params,target:targetStr}};
      const res=inspectRatio(ctxAtW,point,{minimizeMargin:false});
      if(!res.physical || res.success==null || res.fail==null) return false;
      const failRep=stageNet(res.fail,carryCash,'0',passCost);
      const payRep=stageNet(res.success,carryCash,split.user,passCost);
      return Boolean(failRep?.strictProfit && payRep?.strictProfit);
    } catch { return false; }
  };
  if(!evalW(chosenW)) return null;

  // 1. Lower bound W_min (inward-rounded ceil so reported bound is guaranteed passing)
  const floorBase=max(dec(withdrawal?.minimum??'0'),dec(fundedStart).minus(baseline).plus('0.01'));
  let minW=chosenW;
  if(floorBase.lt(chosenW)) {
    if(evalW(floorBase)) {
      minW=floorBase.toDecimalPlaces(2,D.ROUND_CEIL);
    } else {
      let lo=floorBase,hi=chosenW;
      for(let k=0;k<11;k++) {
        const mid=lo.plus(hi).div(2);
        if(evalW(mid)) hi=mid; else lo=mid;
      }
      const cand=hi.toDecimalPlaces(2,D.ROUND_CEIL);
      minW=cand.lte(chosenW) && evalW(cand) ? cand : chosenW;
    }
  }

  // 2. Upper bound W_max (inward-rounded floor so reported bound is guaranteed passing)
  let loUp=chosenW;
  let hiUp=wBounds?.wMaxCash && dec(wBounds.wMaxCash).gt(chosenW) ? dec(wBounds.wMaxCash) : chosenW.times(2);
  let unboundedAbove=false;
  for(let expand=0;expand<4 && evalW(hiUp);expand++) {
    loUp=hiUp;
    hiUp=hiUp.times(2);
    if(expand===3 && evalW(hiUp)) unboundedAbove=true;
  }
  let maxW=loUp;
  if(!unboundedAbove) {
    let lo=loUp,hi=hiUp;
    for(let k=0;k<11;k++) {
      const mid=lo.plus(hi).div(2);
      if(evalW(mid)) lo=mid; else hi=mid;
    }
    const cand=lo.toDecimalPlaces(2,D.ROUND_FLOOR);
    maxW=cand.gte(chosenW) && evalW(cand) ? cand : chosenW;
  }

  // 3. Continuity check: never wrap an infeasible hole inside one reported span
  for(const frac of [0.25,0.5,0.75]) {
    const probe=minW.plus(maxW.minus(minW).times(frac));
    if(!evalW(probe)) {
      if(probe.lt(chosenW)) minW=chosenW;
      else maxW=chosenW;
    }
  }
  const feeTag=fundingIncluded?'含配置资金费':'按已计费用·未含资金费';
  return {
    min:out(minW),
    max:out(maxW),
    unboundedAbove,
    isSinglePoint:minW.eq(maxW),
    scopeNote:'固定当前 Funded 数量与比例实测（'+feeTag+'，已验算全仓维持保证金与防强平，不预支未来分成）'
  };
}

// ===== Layered Funded & Multi-Round Seed Cache (worker-persistent) =====
// Layer B/D (Incremental & Multi-Round Seed Replay):
//   Re-verifies already-discovered Funded 1st-round & multi-round lot pairs at the row's EXACT
//   carryCash (row.pass) and current live orderbook/mark (2-3 inspectRatio calls instead of ~80,
//   zero approximation, 100% bound to the specific Evaluation candidate).
// Layer C (Full Search):
//   Runs whenever rules/funds/parameters change, price moves >= 0.08%, or seed replay does not
//   preserve physical margin / recovery classification. Never narrows the legal search domain.
const FUNDED_SEED_CACHE=new Map();
const FUNDED_SEED_MAX=400;
const RESEARCH_MOVE=0.0008;  // 0.08% mark move triggers full re-search
const RESEARCH_TTL=20000;    // 20s TTL before full re-search
export const fundedCacheStats={hits:0,misses:0,lastFullMs:0};
let lastFullEvalSearch=null;

function fundedRuleSignature(ctx) {
  const {book,params,market}=ctx;
  return JSON.stringify([book.stage,book.pf,book.hl,book.B,params.profitBasis,params.registration,params.fundedRules,
    params.target,market.pf?.step,market.hl?.step,market.pf?.rate,market.hl?.rate,market.hl?.exchangeMaxLeverage,market.pf?.leverage]);
}

function fundedWithCache(row,ctx,activeLoss,audit,fundingIncluded,now,forceFull=false) {
  const {market}=ctx;
  const ruleSig=fundedRuleSignature(ctx);
  const pfMark=Number(market.pf.mark), hlMark=Number(market.hl.mark);
  // Strictly bind Funded cache to THIS specific candidate row.key (never share across different candidates or different carryCash!)
  const exactKey='key:'+row.key+'|'+ruleSig;

  let seedHint=null;
  if(!forceFull) {
    const candidateHit=FUNDED_SEED_CACHE.get(exactKey);
    if(candidateHit && now-candidateHit.at<RESEARCH_TTL &&
       Math.abs(pfMark/candidateHit.pfMark-1)<RESEARCH_MOVE &&
       Math.abs(hlMark/candidateHit.hlMark-1)<RESEARCH_MOVE &&
       (row.pass==null)===(candidateHit.carry==null) &&
       (row.pass==null || dec(row.pass).minus(candidateHit.carry).abs().lt('0.05'))) {
      seedHint=candidateHit;
    }
  }

  const t0=performance.now();
  const value=evaluateConditionalFunded(row,ctx,activeLoss,audit,fundingIncluded,seedHint);
  const elapsed=Math.round(performance.now()-t0);
  if(value?._seedReused) {
    fundedCacheStats.hits++;
  } else {
    fundedCacheStats.misses++;
    fundedCacheStats.lastFullMs=elapsed;
  }
  if(value?._seedToSave) {
    const entry={
      at:now,
      pfMark,
      hlMark,
      carry:row.pass??null,
      ...value._seedToSave
    };
    FUNDED_SEED_CACHE.delete(exactKey);
    FUNDED_SEED_CACHE.set(exactKey,entry);
    while(FUNDED_SEED_CACHE.size>FUNDED_SEED_MAX) FUNDED_SEED_CACHE.delete(FUNDED_SEED_CACHE.keys().next().value);
  }
  delete value._seedReused;
  delete value._seedToSave;
  return value;
}

// Evaluate Funded two outcomes from a single audited candidate & snapshot:
//   A. Funded stop-loss net profit = realPnl(stop) - C_pass
//   B. Funded payout net profit    = userPayout + realPnl(payout) - C_pass
// Both must be strictly > 0 (with complete loss rules) to mark dualPositive.
// Never invent an arbitrary W: W comes solely from user's fundedTarget or real solved bounds (W_min, W_max_cash).
export function evaluateConditionalFunded(row,ctx,activeLoss,audit,fundingIncluded,seedHint=null) {
  const {book,market,params,checks}=ctx;
  const principal=params.profitBasis;
  if(book.stage==='funded') {
    const split=profitSplit(params.target,book.baseline,book.share,book.withdrawal);
    const beforePayout=row.pass;
    const totalCash=beforePayout==null?null:out(dec(beforePayout).plus(split.user));
    const failMissing=activeLoss?.caseCode==='E';
    const failCash=failMissing?null:row.fail;
    const passCost=params.passCostInput ?? (principal!=null ? out(dec(principal).minus(book.hl)) : '0');
    const payRep=stageNet(beforePayout,book.hl,split.user,passCost);
    const failRep=failMissing ? null : stageNet(failCash,book.hl,'0',passCost);
    const dualPositive=Boolean(activeLoss?.failureComplete && failRep?.strictProfit && payRep?.strictProfit);
    const w=out(max('0',dec(params.target).minus(book.baseline)));
    const wFee=book.withdrawal?.fee??'0';
    const pfIM=out(dec(row.pfValue).div(market.pf.leverage));
    const hlIM=audit?.initialMarginHL ?? (row.leverage?out(dec(row.hypeValue).div(row.leverage)):null);
    const fixedWRange=dualPositive
      ? solveFixedComboWRange(ctx,{sign:row.sign,i:row.i,j:row.j},w,book.baseline,book.pf,book.hl,passCost,book.share,book.withdrawal,activeLoss,params.fundedWBounds,fundingIncluded)
      : null;
    const directMulti=beforePayout!=null && !failMissing && activeLoss?.failureComplete && !dualPositive && dec(book.hl).gt(0) && activeLoss?.effectiveFloor!=null
      ? solveFundedMultiRound({
          pfStart:book.pf,
          pfFixedFloor:activeLoss.effectiveFloor,
          baseline:book.baseline,
          resetBaseline:book.withdrawal?.reset??book.baseline,
          initialHypeCash:book.hl,
          totalInvested:principal??book.B??book.hl,
          share:book.share,
          withdrawal:book.withdrawal,
          fundedMarketBase:market,
          ctx,
          preferredSign:row.sign,
          userTarget:null,
          singleRoundDualProfit:false,
          maxRounds:6,
          reinvestToHype:true
        })
      : (dualPositive ? {
          mode:'single_round',
          classification:FUNDED_CLASSIFICATIONS.single_round_dual_profit,
          rounds:[],roundCount:1,recoveredFeasible:true,recoveredAtRound:1,
          profitAfterRecoveryFeasible:true,profitAfterRecoveryRound:1,assumptions:[],stoppedReason:null
        } : null);
    const directClass=failMissing || !activeLoss?.failureComplete
      ? FUNDED_CLASSIFICATIONS.unconfirmed_conditions
      : (dualPositive ? FUNDED_CLASSIFICATIONS.single_round_dual_profit : (directMulti?.classification ?? FUNDED_CLASSIFICATIONS.openable_not_profitable));
    return {
      status:'active',
      classification:directClass,
      multiRound:directMulti,
      conditional:false,
      canOpen:true,
      isDiagnostic:!dualPositive && !failMissing,
      supported:beforePayout!=null,
      protected:Boolean(activeLoss?.failureComplete && failRep?.recovered),
      dualPositive,
      autoW:params.autoFundedTarget===true,
      w,
      wBounds:params.fundedWBounds??null,
      fixedWRange,
      lossBoundary:activeLoss,
      triggerModes:{fail:checks.failureTrigger??'mark_equity',pass:checks.passTrigger??'net_settlement'},
      carryCash:book.hl,
      passCost,
      fundedStart:book.pf,
      fundedFloor:activeLoss?.effectiveFloor??null,
      fundedTarget:params.target,
      baseline:book.baseline,
      resetBaseline:book.withdrawal?.reset??book.baseline,
      qualified:split.qualified,
      payout:split.user,
      platformPayout:split.platform,
      withdrawalFee:wFee,
      beforePayout,
      totalCash,
      fundedFailCash:failCash,
      repayment:payRep,
      failRepayment:failRep,
      shortfall:'0',
      entryPriceSource:'当前实时盘口/标记价快照（PF Mark '+market.pf.mark+' / Hype Mark '+market.hl.mark+'）',
      position:{
        pf:row.pf,hl:row.hl,
        pfDir:dec(row.pf).gt(0)?'做多':'做空',hlDir:dec(row.hl).gt(0)?'做多':dec(row.hl).lt(0)?'做空':'空仓',
        pfUnit:market.pf.unit,hlUnit:market.hl.unit,
        pfMark:market.pf.mark,pfRefPrice:audit?.paths?.pass?.pf?.entryPrice??market.pf.mark,
        hlMark:market.hl.mark,hlRefPrice:audit?.paths?.pass?.hl?.entryPrice??market.hl.mark,
        pfValue:row.pfValue,hypeValue:row.hypeValue,h:row.h,
        pfLeverage:market.pf.leverage,pfEffectiveLev:dec(book.pf).gt(0)?out(dec(row.pfValue).div(book.pf)):null,
        leverage:row.leverage,hlEffectiveLev:dec(book.hl).gt(0)?out(dec(row.hypeValue).div(book.hl)):null,
        leverageRange:audit?.leverageRange??null,leverageOptions:audit?.leverageOptions??[],
        initialMargin:{pf:pfIM,hl:hlIM}
      },
      lines:{
        fail:failMissing?null:{
          source:activeLoss?.bindingSource??'total',floor:activeLoss?.effectiveFloor??null,
          triggerMode:checks.failureTrigger??'mark_equity',
          pfTriggerEquity:legTriggerEquity(audit?.paths?.fail?.pf),
          pfSettledEquity:audit?.paths?.fail?.pf?.finalEquity??audit?.paths?.fail?.pf?.settled??null,
          pfMark:audit?.paths?.fail?.pf?.exitMark??row.failMark??null,
          hlMark:audit?.paths?.fail?.hl?.exitMark??null,
          pfExitPrice:audit?.paths?.fail?.pf?.exitPrice??null,
          hlExitPrice:audit?.paths?.fail?.hl?.exitPrice??null,
          percent:pathMovePct(market.pf.mark,audit?.paths?.fail?.pf?.exitMark??row.failMark)
        },
        pass:{
          target:params.target,w,
          triggerMode:checks.passTrigger??'net_settlement',
          pfTriggerEquity:legTriggerEquity(audit?.paths?.pass?.pf),
          pfSettledEquity:audit?.paths?.pass?.pf?.finalEquity??audit?.paths?.pass?.pf?.settled??null,
          pfMark:audit?.paths?.pass?.pf?.exitMark??row.passMark??null,
          hlMark:audit?.paths?.pass?.hl?.exitMark??null,
          pfExitPrice:audit?.paths?.pass?.pf?.exitPrice??null,
          hlExitPrice:audit?.paths?.pass?.hl?.exitPrice??null,
          percent:pathMovePct(market.pf.mark,audit?.paths?.pass?.pf?.exitMark??row.passMark)
        }
      },
      costs:{
        fail:failMissing?null:summarizeBranchCosts(audit?.paths,'fail','0'),
        pass:summarizeBranchCosts(audit?.paths,'pass',wFee)
      },
      marginCondition:{
        pfInitialMargin:pfIM,hlInitialMargin:hlIM,
        hlMaintenance:audit?.maintenanceHL??null,hlFreeAfter:audit?.freeAfterHL??null,
        hlMinSurplus:row.surplus,hlPeakMargin:row.margin,
        hlLiqMark:audit?.liquidationHL??null,hlPriceBuffer:audit?.priceBufferHL??null,
        supportedToEndpoint:beforePayout!=null
      },
      fundingInfo:buildFundingInfo('funded',null,null,checks),
      reason:activeLoss && !activeLoss.failureComplete ? activeLoss.notice : (params.fundedWBounds?.feasible===false ? params.fundedWBounds.reason : null)
    };
  }

  const fr=params.fundedRules;
  const carryCash=row.pass;
  const passCost=principal!=null && carryCash!=null ? out(dec(principal).minus(carryCash)) : null;
  const regFee=params.registration!=null && params.registration!=='' ? out(nonnegative(params.registration)) : null;
  const startRealCash=book.hl!=null ? out(dec(book.hl)) : null;
  const challengeHedgeCost=startRealCash!=null && carryCash!=null ? out(dec(startRealCash).minus(carryCash)) : null;
  const challengeBreakdown={
    principal:principal??null,
    registration:regFee,
    startRealCash,
    carryCash:carryCash??null,
    challengeHedgeCost,
    passCost
  };
  const baseFailShape={
    conditional:true,candidateKey:row.key??null,singleRoundId:null,canOpen:null,isDiagnostic:false,carryCash,passCost,challengeBreakdown,
    classification:FUNDED_CLASSIFICATIONS.unconfirmed_conditions,multiRound:null,
    fundedStart:null,fundedFloor:null,fundedTarget:null,baseline:null,
    resetBaseline:null,lossBoundary:null,position:null,w:null,autoW:false,wBounds:null,fixedWRange:null,
    attemptedWs:[],qualified:null,payout:null,platformPayout:null,withdrawalFee:null,beforePayout:carryCash,
    totalCash:null,fundedFailCash:null,failRepayment:null,repayment:null,costs:null,shortfall:null,
    openShortfall:null,minRequiredOpenCash:null,dualBlockReason:null,diagnosticWNote:null
  };
  if(!fr) {
    return {...baseFailShape,status:'unconfigured',supported:null,protected:null,dualPositive:false,
      reason:'缺少 Funded 阶段规则'};
  }
  let fundedStart,baseline,share,withdrawal;
  try {
    baseline=out(positive(fr.accountSize||fr.baseline||'10000'));
    fundedStart=out(positive(fr.resetBaseline||fr.accountSize||baseline));
    share=out(nonnegative(fr.share||'0.8'));
    withdrawal={
      platformShare:fr.platformShare??out(dec('1').minus(share)),
      minimum:out(nonnegative(fr.minimumProfit||'0')),
      fee:out(nonnegative(fr.withdrawalFee||'0')),
      reset:fundedStart
    };
  } catch(e) {
    return {...baseFailShape,status:'unconfigured',supported:null,protected:null,dualPositive:false,
      reason:'Funded 分成规则无效：'+e.message};
  }
  const withRules={...baseFailShape,fundedStart,baseline,resetBaseline:fundedStart,withdrawalFee:withdrawal.fee};
  // Independently resolve Funded total stop-loss; unconfirmed daily mode stays 'missing' (never coerced to 'none').
  const fTotal=resolveFundedTotalRule(fr,fundedStart);
  const fDaily=parseDailyLoss(fr.fundedDailyMode,fr.fundedDailyFloor);
  if(fTotal.state==='invalid' || fDaily.state==='invalid') {
    return {...withRules,status:'unconfigured',supported:null,protected:null,dualPositive:false,
      invalidField:fTotal.state==='invalid'?'fundedFloor':'fundedDailyFloor',
      reason:fTotal.error||fDaily.error};
  }
  const fLoss=resolveLossBoundary('funded',fundedStart,fTotal,fDaily);
  const withLoss={...withRules,lossBoundary:fLoss,fundedFloor:fLoss.effectiveFloor??null};

  const userTargetSpec=hasValue(fr.fundedTarget);
  let userTarget=null;
  if(userTargetSpec) {
    let targetValid=false;
    try {
      const tVal=positive(fr.fundedTarget);
      if(tVal.gt(fundedStart) && tVal.gt(baseline)) {
        userTarget=out(tVal);
        targetValid=true;
      }
    } catch { targetValid=false; }
    if(!targetValid) {
      return {
        ...withLoss,status:'invalid_target',supported:null,protected:null,dualPositive:false,
        autoW:false,invalidField:'fundedTarget',
        reason:'Funded 出金目标（fundedTarget）无效：须为大于 Funded 起始权益（'+fundedStart+' U）且大于分成基准（'+baseline+' U）的数值'
      };
    }
  }

  if(fLoss.breached || fLoss.zeroSpace) {
    return {
      ...withLoss,status:'unconfigured',supported:false,protected:false,dualPositive:false,
      reason:fLoss.notice
    };
  }

  // Case E: Funded total loss missing (no daily floor) — retain user's payout if provided, never fabricate failure or arbitrary W!
  if(fLoss.caseCode==='E') {
    if(!userTarget) {
      return {
        ...withLoss,status:'missing_total',supported:null,protected:false,dualPositive:false,
        autoW:true,
        reason:'缺少 Funded 总止损数据且未填出金目标，无法计算后续 Funded 结局'
      };
    }
    const split=profitSplit(userTarget,baseline,share,withdrawal);
    const payRep=passCost!=null ? stageNet(carryCash,carryCash,split.user,passCost) : repayment(carryCash==null?null:out(dec(carryCash).plus(split.user)),principal);
    return {
      ...withLoss,status:'missing_total',supported:null,protected:false,dualPositive:false,
      autoW:false,w:out(dec(userTarget).minus(baseline)),fundedTarget:userTarget,
      qualified:split.qualified,payout:split.user,platformPayout:split.platform,
      totalCash:carryCash==null?null:out(dec(carryCash).plus(split.user)),
      repayment:payRep,
      reason:'缺少 Funded 总止损数据，无法完成失败净利与双端盈利计算（仅保留出金目标参考）'
    };
  }

  const fundedFloor=fLoss.effectiveFloor;
  const lossSpace=fLoss.effectiveSpace;
  const wBounds=passCost!=null ? solveFundedWBounds(passCost,lossSpace,carryCash??'0',share,withdrawal.minimum) : null;

  // W comes strictly from user's fundedTarget OR real solved feasible window (W_min, W_max_cash) — NEVER an arbitrary W!
  const candidateTargets=[];
  if(userTarget) {
    candidateTargets.push({target:userTarget,auto:false});
  } else if(wBounds?.feasible && wBounds.candidates.length) {
    for(const wVal of wBounds.candidates) {
      const tStr=out(dec(baseline).plus(wVal));
      if(!candidateTargets.some(x=>x.target===tStr)) candidateTargets.push({target:tStr,auto:true});
    }
  }
  const attemptedWs=candidateTargets.map(x=>out(dec(x.target).minus(baseline)));

  const pfLev=fr.pfLeverage||market.pf.leverage;
  const hlMaxLevStr=String(market.hl.exchangeMaxLeverage??market.hl.leverage);
  const fundedMarket={
    ...market,
    pf:{...market.pf,leverage:pfLev,free:fundedStart,directionalFree:null,capacity:null,pendingQty:'0',hold:'0',otherMaintenance:'0',reserve:'0'},
    hl:{...market.hl,leverage:hlMaxLevStr,configuredLeverage:null,free:carryCash!=null && dec(carryCash).gt(0)?carryCash:'0',directionalFree:null,capacity:null,pendingQty:'0',hold:'0',otherMaintenance:'0',currentMarginCredit:'0',currentLiquidation:null,reserve:'0'}
  };
  const pfLotNotional=unit(fundedMarket.pf).times(fundedMarket.pf.step).times(fundedMarket.pf.mark);
  const hlLotNotional=unit(fundedMarket.hl).times(fundedMarket.hl.step).times(fundedMarket.hl.mark);
  const minPFLots=Math.max(
    1,
    fundedMarket.pf.minQty!=null ? dec(fundedMarket.pf.minQty).div(fundedMarket.pf.step).ceil().toNumber() : 1,
    fundedMarket.pf.minNotional!=null ? dec(fundedMarket.pf.minNotional).div(pfLotNotional).ceil().toNumber() : 1
  );
  const minHLLots=Math.max(
    1,
    fundedMarket.hl.minQty!=null ? dec(fundedMarket.hl.minQty).div(fundedMarket.hl.step).ceil().toNumber() : 1,
    fundedMarket.hl.minNotional!=null ? dec(fundedMarket.hl.minNotional).div(hlLotNotional).ceil().toNumber() : 1
  );
  const pfMarginCap=dec(fundedStart).times(pfLev).div(pfLotNotional).floor().toNumber();
  const hlMarginCap=carryCash!=null && dec(carryCash).gt(0)
    ? dec(carryCash).times(hlMaxLevStr).div(hlLotNotional).floor().toNumber()
    : 0;
  const maxPFGlobal=Math.max(0,Math.min(pfMarginCap,fundedMarket.pf.maxQty!=null?dec(fundedMarket.pf.maxQty).div(fundedMarket.pf.step).floor().toNumber():Infinity));
  const maxHLGlobal=Math.max(0,Math.min(hlMarginCap,fundedMarket.hl.maxQty!=null?dec(fundedMarket.hl.maxQty).div(fundedMarket.hl.step).floor().toNumber():Infinity));
  const hNeed=passCost==null?dec('0'):max(0,dec(passCost)).div(lossSpace);
  const hlMatchedPF=hNeed.gt(0) && maxHLGlobal>=minHLLots
    ? Math.min(maxPFGlobal,hlLotNotional.times(maxHLGlobal).div(hNeed.times(pfLotNotional)).floor().toNumber())
    : maxPFGlobal;
  const heuristicPfLots=[...new Set([
    Math.max(minPFLots,Math.floor(hlMatchedPF*0.5)),
    Math.max(minPFLots,Math.floor(hlMatchedPF*0.2)),
    Math.max(minPFLots,Math.floor(hlMatchedPF*0.08)),
    Math.min(row.i,hlMatchedPF)
  ])].filter(n=>Number.isSafeInteger(n) && n>=minPFLots && n<=maxPFGlobal);

  const makeFundedCtx=(targetStr)=>({
    book:{
      ...book,stage:'funded',status:'FUNDED_ACTIVE',pf:fundedStart,hl:carryCash,B:principal??'0',external:'0',
      fundedFloor,baseline,share,withdrawal,challengeDeadlineAt:null,positions:{}
    },
    market:fundedMarket,
    params:{
      ...params,openingCapacity:true,target:targetStr,baseReserve:'0',baseRecovery:principal??'0',R:'0',
      recoveryBuffer:'0',successBuffer:'0',deadline:null,deadlineMark:null
    },
    checks:{...checks,exam:null,examEquityFloor:null,crossAccount:null,accountVerified:false}
  });

  const buildDetailedOutcome=({best:rawBest,fundedCtx,targetStr,isAuto,split,status,isDiagnostic,dualBlockReason,diagnosticWNote,searchExhausted=true,diagSeedUsed=false})=>{
    const fullBest=inspectRatio(fundedCtx,{sign:rawBest.sign,i:rawBest.i,j:rawBest.j},{minimizeMargin:false,includeLeverageGrid:true});
    const best=fullBest.physical && fullBest.success!=null && fullBest.fail!=null ? fullBest : rawBest;
    const levMeta=summarizeLeverageGrid(fullBest.leverageGrid);
    const beforePayout=best.success;
    const totalCash=out(dec(beforePayout).plus(split.user));
    const failRep=passCost!=null ? stageNet(best.fail,carryCash,'0',passCost) : repayment(best.fail,principal);
    const payRep=passCost!=null ? stageNet(beforePayout,carryCash,split.user,passCost) : repayment(totalCash,principal);
    const dualPositive=Boolean(fLoss.failureComplete && failRep?.strictProfit && payRep?.strictProfit);
    const w=out(dec(targetStr).minus(baseline));
    const pfIM=out(dec(best.pfValue).div(pfLev));
    const hlIM=best.initial ?? (best.lev?out(dec(best.hypeValue).div(best.lev)):null);
    const fixedWRange=dualPositive
      ? solveFixedComboWRange(fundedCtx,{sign:best.sign,i:best.i,j:best.j},w,baseline,fundedStart,carryCash,passCost,share,withdrawal,fLoss,wBounds,fundingIncluded)
      : null;
    const finalStatus=dualPositive ? 'supported' : status;
    const finalDiagnostic=!dualPositive && (isDiagnostic || finalStatus==='openable_no_dual');
    const singleRoundPfExitMark=best.paths?.pass?.pf?.exitMark ?? null;
    const singleRoundMovePct=singleRoundPfExitMark!=null && dec(fundedMarket.pf.mark).gt(0)
      ? out(dec(singleRoundPfExitMark).minus(fundedMarket.pf.mark).div(fundedMarket.pf.mark).times(100))
      : (dec(best.pfValue).gt(0) ? out(dec(w).div(best.pfValue).times(100)) : null);
    const singleRoundStopMovePct=dec(best.pfValue).gt(0) ? out(dec(lossSpace).div(best.pfValue).times(100)) : null;
    const singleRoundHypePostCloseRatioPct=carryCash!=null && dec(carryCash).gt(0)
      ? out(dec(beforePayout).div(carryCash).times(100))
      : '0';
    const singleRoundExtremeMove=singleRoundMovePct!=null && Math.abs(Number(singleRoundMovePct))>15;
    const singleRoundLowCushion=Number(singleRoundHypePostCloseRatioPct)<15;
    const roundTransferFee=withdrawal?.fee ?? '0';
    let multiSeedUsed=false;
    let multiRound=solveFundedMultiRound({
      pfStart:fundedStart,
      pfFixedFloor:fundedFloor,
      baseline,
      resetBaseline:fundedStart,
      initialHypeCash:carryCash,
      totalInvested:principal??carryCash,
      share,
      withdrawal,
      fundedMarketBase:fundedMarket,
      ctx,
      preferredSign:row.sign,
      userTarget,
      singleRoundDualProfit:dualPositive,
      maxRounds:6,
      reinvestToHype:true,
      transferFeePerRound:roundTransferFee,
      seedChoices:seedHint?.multiSeedChoices ?? null
    });
    if(!dualPositive && seedHint?.multiSeedChoices?.length) {
      if(seedHint.expectedClassCode && multiRound.classification?.code!==seedHint.expectedClassCode) {
        // Seed replay did not preserve classification at this carryCash/tick -> run full multi-round search!
        multiRound=solveFundedMultiRound({
          pfStart:fundedStart,
          pfFixedFloor:fundedFloor,
          baseline,
          resetBaseline:fundedStart,
          initialHypeCash:carryCash,
          totalInvested:principal??carryCash,
          share,
          withdrawal,
          fundedMarketBase:fundedMarket,
          ctx,
          preferredSign:row.sign,
          userTarget,
          singleRoundDualProfit:false,
          maxRounds:6,
          reinvestToHype:true,
          transferFeePerRound:roundTransferFee,
          seedChoices:null
        });
      } else {
        multiSeedUsed=true;
      }
    }
    const classification=dualPositive
      ? FUNDED_CLASSIFICATIONS.single_round_dual_profit
      : (!fLoss.failureComplete ? FUNDED_CLASSIFICATIONS.unconfirmed_conditions : multiRound.classification);
    const singleRoundId='SR:'+row.key+':'+best.sign+'/'+best.i+'/'+best.j+'@W'+w;
    if(multiRound) {
      multiRound.pathId='MR:'+row.key+':'+(multiRound.roundCount??0)+'R';
      multiRound.sourceCandidateKey=row.key;
      multiRound.firstRoundStopOutcome=multiRound.rounds?.[0]?.stopOutcome ?? null;
    }
    const failureCategory=dualPositive
      ? null
      : (wBounds?.code==='LOSS_SPACE_TOO_SMALL' || wBounds?.feasible===false
        ? {code:'NO_SINGLE_ROUND_DUAL_SOLUTION',label:'单轮双端回本无解'}
        : {code:'NO_SINGLE_ROUND_DUAL_SOLUTION',label:'单轮双端回本无解'});
    const thinStopBuffer=Boolean(failRep?.net!=null && dec(failRep.net).gt(0) && dec(failRep.net).lte('5'));
    const thinClaimBuffer=Boolean(payRep?.net!=null && dec(payRep.net).gt(0) && dec(payRep.net).lte('5'));
    const thinProfitBuffer=thinStopBuffer || thinClaimBuffer;
    const srStopNet=failRep?.net!=null ? dec(failRep.net) : null;
    const srClaimNet=payRep?.net!=null ? dec(payRep.net) : null;
    const srHonestVerdict=dualPositive
      ? '单轮两头都保本盈利'
      : (srStopNet && srClaimNet && srStopNet.lt(0) && srClaimNet.gte(0))
        ? '止损亏 '+srStopNet.abs().toFixed(2)+' U / 领取赚 +'+srClaimNet.toFixed(2)+' U（无法两头都保本）'
        : (srStopNet && srClaimNet && srStopNet.gte(0) && srClaimNet.lt(0))
          ? '止损保本 +'+srStopNet.toFixed(2)+' U / 领取差 '+srClaimNet.abs().toFixed(2)+' U（无法两头都保本）'
          : '单轮两头均未回本';
    let primaryPlan=null;
    if(dualPositive) {
      primaryPlan={
        mode:'single_round_dual',
        verdictLabel:thinProfitBuffer ? '1 轮两头保本（安全垫薄）' : '1 轮两头都保本盈利',
        tone:thinProfitBuffer ? 'warn' : 'ok',
        pfPosition:{dir:dec(best.pf).gt(0)?'做多':'做空',qty:best.pf,unit:fundedMarket.pf.unit,notional:best.pfValue,leverage:pfLev},
        hypePosition:{dir:dec(best.hl).gt(0)?'做多':dec(best.hl).lt(0)?'做空':'空仓',qty:best.hl,unit:fundedMarket.hl.unit,notional:best.hypeValue,leverage:best.lev},
        hedgeRatio:best.h,
        stopMovePct:singleRoundStopMovePct,
        claimMovePct:singleRoundMovePct,
        profitAtClaim:w,
        payout:split.user,
        stopCash:best.fail,
        stopNet:failRep?.net??null,
        firstClaimCash:totalCash,
        firstClaimNet:payRep?.net??null,
        firstRoundRecovered:true,
        recoveredAtRound:1,
        totalRounds:1,
        finalCash:totalCash,
        finalNet:payRep?.net??null,
        lastRoundStopCash:best.fail,
        lastRoundStopNet:failRep?.net??null,
        extremeMoveWarning:singleRoundExtremeMove,
        lowHypeCushionWarning:singleRoundLowCushion
      };
    } else if(multiRound?.rounds?.length>0) {
      const r1=multiRound.rounds[0];
      const rLast=multiRound.rounds.at(-1);
      const r1StopNet=dec(r1.stopOutcome.finalNetPnL);
      const r1ClaimNet=dec(r1.cumulativeNetPnL);
      const r1Rec=r1ClaimNet.gte(0);
      const verdictLabel=r1StopNet.lt(0) && r1Rec
        ? '止损亏 '+r1StopNet.abs().toFixed(0)+' U / 领取赚 +'+r1ClaimNet.toFixed(0)+' U（无法两头都保本）'
        : r1StopNet.gte(0) && r1Rec
          ? '首轮两头均已回本'
          : multiRound.recoveredAtRound!=null
            ? '需 '+multiRound.recoveredAtRound+' 轮回本（首轮止损亏 '+r1StopNet.abs().toFixed(0)+' U）'
            : '推演 '+multiRound.roundCount+' 轮尚未回本';
      primaryPlan={
        mode:'multi_round',
        verdictLabel,
        tone:r1StopNet.gte(0) && r1Rec && !multiRound.hasExtremeMove && !multiRound.hasLowHypeCushion ? 'ok' : (multiRound.recoveredAtRound!=null ? 'warn' : 'bad'),
        pfPosition:r1.pfPosition,
        hypePosition:r1.hypePosition,
        hedgeRatio:r1.hedgeRatio,
        stopMovePct:r1.pfStopMovePct,
        claimMovePct:r1.pfClaimMovePct,
        profitAtClaim:r1.profitAtClaim,
        payout:r1.claimNetReceived,
        stopCash:r1.stopOutcome.personalTotalAsset,
        stopNet:r1.stopOutcome.finalNetPnL,
        firstClaimCash:r1.personalTotalAsset,
        firstClaimNet:r1.cumulativeNetPnL,
        firstRoundRecovered:r1Rec,
        recoveredAtRound:multiRound.recoveredAtRound,
        totalRounds:multiRound.roundCount,
        finalCash:multiRound.finalCumulativeAsset,
        finalNet:multiRound.finalCumulativeNetPnL,
        lastRoundStopCash:rLast?.stopOutcome?.personalTotalAsset ?? null,
        lastRoundStopNet:rLast?.stopOutcome?.finalNetPnL ?? null,
        extremeMoveWarning:multiRound.hasExtremeMove,
        lowHypeCushionWarning:multiRound.hasLowHypeCushion
      };
    } else {
      primaryPlan={
        mode:'single_round_diag',
        verdictLabel:srHonestVerdict,
        tone:'warn',
        pfPosition:{dir:dec(best.pf).gt(0)?'做多':'做空',qty:best.pf,unit:fundedMarket.pf.unit,notional:best.pfValue,leverage:pfLev},
        hypePosition:{dir:dec(best.hl).gt(0)?'做多':dec(best.hl).lt(0)?'做空':'空仓',qty:best.hl,unit:fundedMarket.hl.unit,notional:best.hypeValue,leverage:best.lev},
        hedgeRatio:best.h,
        stopMovePct:singleRoundStopMovePct,
        claimMovePct:singleRoundMovePct,
        profitAtClaim:w,
        payout:split.user,
        stopCash:best.fail,
        stopNet:failRep?.net??null,
        firstClaimCash:totalCash,
        firstClaimNet:payRep?.net??null,
        firstRoundRecovered:Boolean(srClaimNet && srClaimNet.gte(0)),
        recoveredAtRound:srClaimNet && srClaimNet.gte(0) ? 1 : null,
        totalRounds:1,
        finalCash:totalCash,
        finalNet:payRep?.net??null,
        lastRoundStopCash:best.fail,
        lastRoundStopNet:failRep?.net??null,
        extremeMoveWarning:singleRoundExtremeMove,
        lowHypeCushionWarning:singleRoundLowCushion
      };
    }
    return {
      ...withLoss,
      candidateKey:row.key,
      singleRoundId,
      singleRoundMovePct,
      singleRoundStopMovePct,
      singleRoundHypePostCloseRatioPct,
      extremeMoveWarning:singleRoundExtremeMove,
      lowHypeCushionWarning:singleRoundLowCushion,
      failureCategory,
      srHonestVerdict,
      primaryPlan,
      thinProfitBuffer,
      thinBufferNote:thinProfitBuffer?'安全垫极薄（正净利 ≤ 5 U，轻微滑点或资金费即可转亏，不视为可靠盈利）':null,
      _seedReused:Boolean(diagSeedUsed || multiSeedUsed),
      _seedToSave:{
        diagChoice:{sign:best.sign,i:best.i,j:best.j,targetStr,isAuto,note:diagnosticWNote},
        multiSeedChoices:multiRound?.seedChoices ?? null,
        expectedClassCode:classification?.code ?? null
      },
      status:finalStatus,
      classification,
      multiRound,
      canOpen:true,
      isDiagnostic:finalDiagnostic,
      supported:dualPositive,
      protected:Boolean(fLoss.failureComplete && failRep?.recovered),
      dualPositive,
      autoW:isAuto,w,wBounds,attemptedWs,fixedWRange,
      triggerModes:{fail:fundedCtx.checks.failureTrigger??'mark_equity',pass:fundedCtx.checks.passTrigger??'net_settlement'},
      fundedTarget:targetStr,
      qualified:split.qualified,payout:split.user,platformPayout:split.platform,
      beforePayout,totalCash,fundedFailCash:best.fail,
      repayment:payRep,failRepayment:failRep,
      shortfall:dualPositive?'0':(wBounds?.cashShortfall??'0'),
      openShortfall:'0',
      searchExhausted,
      dualBlockReason:dualPositive?null:(dualBlockReason??wBounds?.reason??null),
      diagnosticWNote:finalDiagnostic?(diagnosticWNote??null):null,
      entryPriceSource:(finalDiagnostic?'诊断方案（可开仓但双端盈利不成立，非双端盈利推荐；':'通过后的条件方案（')+
        '按当前实时盘口/标记价快照测算：PF Mark '+fundedMarket.pf.mark+' / Hype Mark '+fundedMarket.hl.mark+'，非已成交；实际通过后须按真实资金与当时行情重算）',
      position:{
        pf:best.pf,hl:best.hl,
        pfDir:dec(best.pf).gt(0)?'做多':'做空',hlDir:dec(best.hl).gt(0)?'做多':dec(best.hl).lt(0)?'做空':'空仓',
        pfUnit:fundedMarket.pf.unit,hlUnit:fundedMarket.hl.unit,
        pfMark:fundedMarket.pf.mark,pfRefPrice:best.paths?.pass?.pf?.entryPrice??fundedMarket.pf.mark,
        hlMark:fundedMarket.hl.mark,hlRefPrice:best.paths?.pass?.hl?.entryPrice??fundedMarket.hl.mark,
        pfValue:best.pfValue,hypeValue:best.hypeValue,h:best.h,
        pfLeverage:pfLev,pfEffectiveLev:dec(fundedStart).gt(0)?out(dec(best.pfValue).div(fundedStart)):null,
        leverage:best.lev,hlEffectiveLev:dec(carryCash).gt(0)?out(dec(best.hypeValue).div(carryCash)):null,
        leverageRange:levMeta.range,leverageOptions:levMeta.options,
        initialMargin:{pf:pfIM,hl:hlIM}
      },
      lines:{
        fail:{
          source:fLoss.bindingSource,floor:fundedFloor,
          triggerMode:fundedCtx.checks.failureTrigger??'mark_equity',
          pfTriggerEquity:legTriggerEquity(best.paths?.fail?.pf),
          pfSettledEquity:best.paths?.fail?.pf?.settled??null,
          pfMark:best.paths?.fail?.pf?.exitMark??null,
          hlMark:best.paths?.fail?.hl?.exitMark??null,
          pfExitPrice:best.paths?.fail?.pf?.exitPrice??null,
          hlExitPrice:best.paths?.fail?.hl?.exitPrice??null,
          percent:pathMovePct(fundedMarket.pf.mark,best.paths?.fail?.pf?.exitMark)
        },
        pass:{
          target:targetStr,w,
          triggerMode:fundedCtx.checks.passTrigger??'net_settlement',
          pfTriggerEquity:legTriggerEquity(best.paths?.pass?.pf),
          pfSettledEquity:best.paths?.pass?.pf?.settled??null,
          pfMark:best.paths?.pass?.pf?.exitMark??null,
          hlMark:best.paths?.pass?.hl?.exitMark??null,
          pfExitPrice:best.paths?.pass?.pf?.exitPrice??null,
          hlExitPrice:best.paths?.pass?.hl?.exitPrice??null,
          percent:pathMovePct(fundedMarket.pf.mark,best.paths?.pass?.pf?.exitMark)
        }
      },
      costs:{
        fail:summarizeBranchCosts(best.paths,'fail','0'),
        pass:summarizeBranchCosts(best.paths,'pass',withdrawal.fee)
      },
      marginCondition:{
        pfInitialMargin:pfIM,hlInitialMargin:hlIM,
        hlMaintenance:best.maintenance??null,hlFreeAfter:best.free??null,
        hlMinSurplus:best.surplus??null,hlLiqMark:best.liquidation??null,hlPriceBuffer:best.buffer??null,
        supportedToEndpoint:best.physical===true
      },
      fundingInfo:buildFundingInfo('funded',null,null,checks),
      constraintsAudit:makeConstraintsAudit(
        best.physical===true,
        best.physical===true
          ? '通过（初始保证金 '+dec(hlIM??'0').toFixed(2)+' U · 维持保证金 '+dec(best.maintenance??'0').toFixed(2)+' U · 路径最低维持余量 '+dec(best.surplus??'0').toFixed(2)+' U，持仓至两终点无强平）'
          : '路径维持保证金或强平条件未通过',
        w
      ),
      reason:dualPositive?(!fLoss.failureComplete ? fLoss.notice : null):(dualBlockReason??wBounds?.reason??'可开仓但双端盈利不成立')
    };
  };

  // Separate four distinct constraint layers (A/B/C/D) so B/C/D gaps are NEVER misreported as A min-order failure!
  const minHlQtyStr=out(dec(fundedMarket.hl.step).times(minHLLots));
  const minHlNotional=hlLotNotional.times(minHLLots);
  const minHlIM=minHlNotional.div(hlMaxLevStr);
  const minHlOpenFee=minHlNotional.times(fundedMarket.hl.rate??'0');
  const minOrderTotal=minHlIM.plus(minHlOpenFee);
  const minOrderCashNum=carryCash!=null?dec(carryCash):dec('0');
  const minOrderPassed=minOrderCashNum.gte(minOrderTotal) && maxPFGlobal>=minPFLots && maxHLGlobal>=minHLLots;
  const minOrderShortfall=max(dec('0'),minOrderTotal.minus(minOrderCashNum));
  const stopMinRatio=passCost!=null && dec(passCost).gt(0) ? dec(passCost).div(lossSpace) : dec('0');
  const makeConstraintsAudit=(pathPassed,pathNote,refWStr=null)=>{
    const wRef=refWStr!=null ? dec(refWStr) : (wBounds?.wMaxCash!=null && dec(wBounds.wMaxCash).gt(0) ? dec(wBounds.wMaxCash) : null);
    const payoutMaxRatio=wRef && wRef.gt(0) && passCost!=null ? dec(share).minus(dec(passCost).div(wRef)) : null;
    return {
      minOrder:{
        passed:minOrderPassed,
        qty:minHlQtyStr,
        unit:fundedMarket.hl.unit,
        notional:out(minHlNotional),
        maxLeverage:hlMaxLevStr,
        initialMargin:out(minHlIM),
        openFee:out(minHlOpenFee),
        totalRequired:out(minOrderTotal),
        shortfall:out(minOrderShortfall),
        note:minOrderPassed
          ? '通过（最小合法下单 '+minHlQtyStr+' '+fundedMarket.hl.unit+'，名义 '+minHlNotional.toFixed(2)+' U，'+hlMaxLevStr+'× 初始保证金 '+minHlIM.toFixed(2)+' U + 开仓费 '+minHlOpenFee.toFixed(4)+' U ≈ '+minOrderTotal.toFixed(2)+' U；当前实盘 '+minOrderCashNum.toFixed(2)+' U 充足）'
          : '未通过（最小合法下单 '+minHlQtyStr+' '+fundedMarket.hl.unit+'，名义 '+minHlNotional.toFixed(2)+' U，至少需初始保证金+开仓费 '+minOrderTotal.toFixed(2)+' U；当前实盘 '+minOrderCashNum.toFixed(2)+' U，缺 '+minOrderShortfall.toFixed(2)+' U）'
      },
      stopCoverage:{
        minHedgeRatio:out(stopMinRatio),
        passCost:passCost??'0',
        lossSpace,
        note:passCost!=null && dec(passCost).gt(0)
          ? '覆盖通关成本 '+dec(passCost).toFixed(2)+' U（止损空间 '+dec(lossSpace).toFixed(2)+' U）要求最小对冲比例 > '+stopMinRatio.times(100).toFixed(2)+'%'
          : '通关成本 ≤ 0，止损端无需额外对冲覆盖'
      },
      payoutCoverage:{
        share,
        wMin:wBounds?.floorW??wBounds?.wMin??null,
        wMaxCash:wBounds?.wMaxCash??null,
        wGap:wBounds?.wGap??null,
        hNeededMin:wBounds?.hNeededMin??null,
        cashShortfall:wBounds?.cashShortfall??null,
        maxHedgeRatioAtW:payoutMaxRatio!=null?out(payoutMaxRatio):null,
        note:wBounds?.feasible===false
          ? (wBounds.limitCondition ?? wBounds.reason)
          : (wRef && payoutMaxRatio!=null
            ? '分成 '+dec(share).times(100).toFixed(0)+'% 在 W = '+wRef.toFixed(2)+' U 下要求对冲比例 < '+payoutMaxRatio.times(100).toFixed(2)+'%'
            : '按分成 '+dec(share).times(100).toFixed(0)+'% 核算出金端净利')
      },
      pathMargin:{
        passed:pathPassed,
        note:pathNote
      }
    };
  };

  const buildCannotOpen=(reasonDetail,extraReq=null,aFailed=true,explicitCategory=null)=>{
    const cur=carryCash!=null?dec(carryCash):dec('0');
    const reqCash=extraReq!=null?max(minOrderTotal,dec(extraReq)):minOrderTotal;
    const openGap=max(dec('0'),reqCash.minus(cur));
    const fallbackW=userTarget?out(dec(userTarget).minus(baseline)):null;
    const fallbackSplit=userTarget?profitSplit(userTarget,baseline,share,withdrawal):null;
    const failureCategory=explicitCategory ?? (
      aFailed
        ? (cur.lte(0) || openGap.gt(0)
          ? {code:'INSUFFICIENT_FUNDS',label:'资金不足'}
          : {code:'CANNOT_OPEN',label:'无法开仓'})
        : {code:'MARGIN_PATH_FAILED',label:'保证金/强平路径失败'}
    );
    return {
      ...withLoss,
      status:'cannot_open',
      failureCategory,
      classification:aFailed ? FUNDED_CLASSIFICATIONS.no_legal_position : FUNDED_CLASSIFICATIONS.path_risk_failed,
      multiRound:null,
      canOpen:false,
      isDiagnostic:false,
      supported:false,
      protected:false,
      dualPositive:false,
      autoW:!userTarget,
      w:fallbackW,
      wBounds,
      attemptedWs,
      fundedTarget:userTarget,
      qualified:fallbackSplit?.qualified??null,
      payout:fallbackSplit?.user??null,
      platformPayout:fallbackSplit?.platform??null,
      minRequiredOpenCash:out(reqCash),
      openShortfall:out(openGap),
      shortfall:wBounds?.cashShortfall??out(openGap),
      dualBlockReason:wBounds?.reason??reasonDetail,
      constraintsAudit:makeConstraintsAudit(false,aFailed?'因 A（最小合法下单保证金与开仓费）未通过，未进入路径持仓':reasonDetail,fallbackW),
      reason:reasonDetail
    };
  };

  // ===== Judgment A (Fast precheck): Strictly check A (minimum legal order initial margin + open fee) =====
  if(carryCash==null || dec(carryCash).lte(0)) {
    return buildCannotOpen(
      'A 最小合法下单未通过：考核通过后实盘结余 '+(carryCash==null?'未核价':dec(carryCash).toFixed(2)+' U')+
      '，低于最小合法订单（'+minHlQtyStr+' '+fundedMarket.hl.unit+'，名义 '+minHlNotional.toFixed(2)+' U）所需初始保证金 '+
      minHlIM.toFixed(2)+' U + 开仓费 '+minHlOpenFee.toFixed(4)+' U（合计约 '+minOrderTotal.toFixed(2)+' U），缺 '+minOrderShortfall.toFixed(2)+' U',
      minOrderTotal,
      true
    );
  }
  if(!minOrderPassed) {
    return buildCannotOpen(
      'A 最小合法下单未通过：当前实盘 '+dec(carryCash).toFixed(2)+' U 低于最小合法订单（'+
      minHlQtyStr+' '+fundedMarket.hl.unit+'，名义 '+minHlNotional.toFixed(2)+
      ' U）所需初始保证金 '+minHlIM.toFixed(2)+' U + 开仓费 '+minHlOpenFee.toFixed(4)+' U（合计约 '+minOrderTotal.toFixed(2)+' U），至少缺 '+minOrderShortfall.toFixed(2)+' U',
      minOrderTotal,
      true
    );
  }

  let sawDepthFailure=false;
  const minPositivePFLots=Math.max(minPFLots,dec(lossSpace).times('1.05').div(pfLotNotional).ceil().toNumber());

  // ===== Judgment B: Fast joint search over (W, PF size i, Hype size j / hedge ratio h) for dual strictly-positive profit =====
  const testTarget=(targetStr,isAuto)=>{
    const gain=dec(targetStr).minus(fundedStart);
    const neededCash=passCost==null?dec('0'):max(0,dec(passCost)).times(gain).div(dec(lossSpace));
    const split=profitSplit(targetStr,baseline,share,withdrawal);
    if(passCost!=null && dec(carryCash).lt(neededCash)) {
      return {ok:false,targetStr,isAuto,split,neededCash,shortfall:out(neededCash.minus(carryCash)),exhausted:true,mathematicallyBlocked:true};
    }
    const fundedCtx=makeFundedCtx(targetStr);
    const hMaxAtW=gain.gt(0) && passCost!=null
      ? max(hNeed,dec(share).minus(dec(passCost).div(gain)))
      : dec(share);
    const probe=(fSign,i,j,fMaxHL)=>{
      if(j<0 || j>fMaxHL) return null;
      try {
        // Use fastProbe during grid search; buildDetailedOutcome runs full leverage-grid inspection once on the winner.
        const inspected=inspectRatio(fundedCtx,{sign:fSign,i,j},{minimizeMargin:false,fastProbe:true});
        if(!inspected.physical || inspected.success==null || inspected.fail==null) return null;
        return inspected;
      } catch (e) {
        if(String(e?.message||'').includes('INSUFFICIENT_DEPTH')) sawDepthFailure=true;
        return null;
      }
    };
    const scoreRes=res=>{
      if(!res) return null;
      const frRep=passCost!=null ? stageNet(res.fail,carryCash,'0',passCost) : repayment(res.fail,principal);
      const prRep=passCost!=null ? stageNet(res.success,carryCash,split.user,passCost) : repayment(out(dec(res.success).plus(split.user)),principal);
      const dual=Boolean(frRep?.strictProfit && prRep?.strictProfit);
      const worstNet=frRep && prRep ? min(dec(frRep.net),dec(prRep.net)) : dec('-1e18');
      const sumNet=frRep && prRep ? dec(frRep.net).plus(prRep.net) : dec('-1e18');
      return {res,frRep,prRep,dual,worstNet,sumNet};
    };
    let best=null;
    let bestScored=null;
    const consider=(res)=>{
      if(!res) return false;
      const sc=scoreRes(res);
      if(!sc) return false;
      if(sc.frRep && !sc.frRep.recovered) return false;
      if(!bestScored) {
        best=res;
        bestScored=sc;
      } else if(sc.dual && !bestScored.dual) {
        best=res;
        bestScored=sc;
      } else if(sc.dual===bestScored.dual) {
        if(sc.worstNet.gt(bestScored.worstNet.plus('0.25')) ||
           (sc.worstNet.minus(bestScored.worstNet).abs().lte('0.25') && sc.sumNet.gt(bestScored.sumNet))) {
          best=res;
          bestScored=sc;
        }
      }
      return sc.dual;
    };

    const searchJAtI=(fSign,i,fMaxHL,allowBinaryFallback=false)=>{
      const pfN=pfLotNotional.times(i);
      if(hNeed.isZero()) {
        if(consider(probe(fSign,i,0,fMaxHL))) return true;
        if(fMaxHL>=minHLLots && consider(probe(fSign,i,minHLLots,fMaxHL))) return true;
        return false;
      }
      if(fMaxHL<minHLLots) return false;
      const rawLoJ=pfN.times(hNeed).div(hlLotNotional);
      const rawHiJ=pfN.times(max(hNeed,hMaxAtW)).div(hlLotNotional);
      const baseJ=Math.max(minHLLots,Math.min(fMaxHL,rawLoJ.ceil().toNumber()));
      const hiBandJ=Math.max(baseJ,Math.min(fMaxHL,rawHiJ.floor().toNumber()));
      const midBandJ=Math.floor((baseJ+hiBandJ)/2);
      const q1BandJ=Math.floor(baseJ*0.65+hiBandJ*0.35);
      const q3BandJ=Math.floor(baseJ*0.35+hiBandJ*0.65);
      const seen=new Set();
      let hitDual=false;
      const evalJ=j=>{
        if(j<0 || j>fMaxHL || seen.has(j)) return null;
        seen.add(j);
        const res=probe(fSign,i,j,fMaxHL);
        if(!res) return {res:null,failOk:false,passOrMarginBad:true,dual:false};
        const failRep=passCost!=null ? stageNet(res.fail,carryCash,'0',passCost) : null;
        const payRep=passCost!=null ? stageNet(res.success,carryCash,split.user,passCost) : null;
        const dual=consider(res);
        if(dual) hitDual=true;
        return {
          res,
          failOk:failRep ? failRep.strictProfit : true,
          passOrMarginBad:Boolean(payRep && !payRep.strictProfit),
          dual
        };
      };
      // Probe interior of ratio window (C/D, s - C/W) directly in 4 fast probes
      const fastList=[...new Set([midBandJ,q1BandJ,q3BandJ,Math.ceil(baseJ*1.03),baseJ+1])].filter(j=>j>=minHLLots && j<=fMaxHL);
      for(const j of fastList) {
        const ev=evalJ(j);
        if(ev?.dual && bestScored?.worstNet?.gt('2')) return true;
      }
      if(hitDual || !allowBinaryFallback) return hitDual;
      let lo=baseJ, hi=Math.min(fMaxHL,Math.max(hiBandJ,Math.ceil(baseJ*1.25)));
      while(lo<=hi) {
        const mid=Math.floor((lo+hi)/2);
        const ev=evalJ(mid);
        if(!ev || ev.res==null) { hi=mid-1; continue; }
        if(ev.dual) return true;
        if(!ev.failOk && ev.passOrMarginBad) break;
        if(!ev.failOk) lo=mid+1;
        else if(ev.passOrMarginBad) hi=mid-1;
        else break;
      }
      return hitDual;
    };

    let allExhausted=true;
    for(const fSign of [row.sign,-row.sign]) {
      const fMaxPF=Math.min(maxPFGlobal,depthLimits(fundedMarket.pf,fSign).cap);
      const fMaxHL=Math.min(maxHLGlobal,depthLimits(fundedMarket.hl,-fSign).cap);
      if(fMaxPF<minPFLots) continue;
      const testedI=new Set();
      let foundDual=false;
      const capRef=Math.max(minPFLots,Math.min(fMaxPF,hlMatchedPF>0?hlMatchedPF:fMaxPF));
      const baseLo=Math.min(fMaxPF,minPositivePFLots);
      const jointPfGrid=[...new Set([
        baseLo,
        Math.round(baseLo*2.5),
        Math.round(capRef*0.10),
        Math.round(capRef*0.35),
        capRef,
        Math.min(row.i,capRef)
      ])].filter(n=>Number.isSafeInteger(n) && n>=minPFLots && n<=fMaxPF);

      for(let idx=0;idx<jointPfGrid.length;idx++) {
        const i=jointPfGrid[idx];
        if(testedI.has(i)) continue;
        testedI.add(i);
        if(searchJAtI(fSign,i,fMaxHL,idx===0)) {
          foundDual=true;
          if(bestScored?.worstNet?.gt('2')) break;
        }
      }
      if(foundDual) break;
      allExhausted=false;
    }
    return {ok:!!best,targetStr,isAuto,split,best,bestScored,fundedCtx,neededCash,shortfall:'0',exhausted:allExhausted,mathematicallyBlocked:false};
  };

  let chosen=null;
  let firstAttempt=null;
  let allAttemptsExhausted=true;
  let anyMathBlocked=false;
  for(const item of candidateTargets) {
    const attempt=testTarget(item.target,item.auto);
    if(!firstAttempt) firstAttempt=attempt;
    if(!attempt.exhausted) allAttemptsExhausted=false;
    if(attempt.mathematicallyBlocked) anyMathBlocked=true;
    if(attempt.ok) {
      const failRep=passCost!=null ? stageNet(attempt.best.fail,carryCash,'0',passCost) : null;
      const payRep=passCost!=null ? stageNet(attempt.best.success,carryCash,attempt.split.user,passCost) : null;
      if(fLoss.failureComplete && failRep?.strictProfit && payRep?.strictProfit) {
        chosen=attempt;
        break;
      } else if(!chosen) {
        chosen=attempt;
      }
    }
  }
  const active=chosen ?? firstAttempt;
  if(active?.ok && active.best) {
    const failRepCheck=passCost!=null ? stageNet(active.best.fail,carryCash,'0',passCost) : null;
    const payRepCheck=passCost!=null ? stageNet(active.best.success,carryCash,active.split.user,passCost) : null;
    const isDualNow=Boolean(fLoss.failureComplete && failRepCheck?.strictProfit && payRepCheck?.strictProfit);
    return buildDetailedOutcome({
      best:active.best,
      fundedCtx:active.fundedCtx,
      targetStr:active.targetStr,
      isAuto:active.isAuto,
      split:active.split,
      status:isDualNow?'supported':'openable_no_dual',
      isDiagnostic:!isDualNow,
      dualBlockReason:isDualNow?null:(wBounds?.reason ?? '可开仓但未能同时使止损与出金两端净利润严格为正'),
      diagnosticWNote:isDualNow?null:'可开仓诊断方案（未同时满足双端严格盈利）'
    });
  }

  // ===== Judgment A (Fast joint search over (W, PF size i, Hype ratio h -> j) when single-round dual-profit does not hold) =====
  const diagTargets=[];
  const pushDiagTarget=(wDec,isAuto,note)=>{
    if(wDec==null || !wDec.gt(0)) return;
    const wRounded=wDec.toDecimalPlaces(2);
    if(wRounded.lt(withdrawal.minimum)) return;
    const tDec=dec(baseline).plus(wRounded);
    if(tDec.lte(fundedStart)) return;
    const tStr=out(tDec);
    if(!diagTargets.some(x=>x.target===tStr)) diagTargets.push({target:tStr,auto:isAuto,note});
  };
  if(userTarget) {
    diagTargets.push({target:userTarget,auto:false,note:'按用户设定的出金目标测算（诊断方案，非双端盈利推荐）'});
  } else {
    if(wBounds?.wMaxCash && dec(wBounds.wMaxCash).gt(0)) {
      const wCap=dec(wBounds.wMaxCash);
      pushDiagTarget(wCap.times('1.25'),true,'按扩展领取目标 W = '+wCap.times('1.25').toFixed(2)+' U 联合搜索仓位与比例（诊断方案，非双端盈利推荐）');
      pushDiagTarget(wCap,true,'按当前资金理论支撑 W = '+wCap.toFixed(2)+' U 联合搜索仓位与比例（诊断方案，非双端盈利推荐）');
    }
    pushDiagTarget(dec(lossSpace).times('1.5'),true,'按 1.5×亏损空间 W = '+dec(lossSpace).times('1.5').toFixed(2)+' U 联合搜索仓位与比例（诊断方案，非双端盈利推荐）');
    pushDiagTarget(dec(lossSpace),true,'按 Funded 有效亏损空间 D_F = '+dec(lossSpace).toFixed(2)+' U 联合搜索仓位与比例（诊断方案，非双端盈利推荐）');
    if(!diagTargets.length) {
      pushDiagTarget(max(dec(withdrawal.minimum||'0'),dec('1')),true,'按最小允许盈利门槛测算（诊断方案，非双端盈利推荐）');
    }
  }
  const activeDiagTargets=diagTargets.slice(0,2);

  let bestDiag=null;
  let diagSeedUsed=false;

  if(seedHint?.diagChoice && activeDiagTargets.length) {
    const dc=seedHint.diagChoice;
    const dt=activeDiagTargets.find(x=>x.target===dc.targetStr) ?? activeDiagTargets[0];
    const dSplit=profitSplit(dt.target,baseline,share,withdrawal);
    const dCtx=makeFundedCtx(dt.target);
    const fMaxPF=Math.min(maxPFGlobal,depthLimits(fundedMarket.pf,dc.sign).cap);
    const fMaxHL=Math.min(maxHLGlobal,depthLimits(fundedMarket.hl,-dc.sign).cap);
    if(dc.i>=minPFLots && dc.i<=fMaxPF && fMaxHL>=minHLLots) {
      const tryJ=Math.min(fMaxHL,Math.max(minHLLots,dc.j));
      try {
        const ins=inspectRatio(dCtx,{sign:dc.sign,i:dc.i,j:tryJ},{minimizeMargin:false,fastProbe:true});
        if(ins?.physical && ins.fail!=null && ins.success!=null && (dc.i<fMaxPF || dec(ins.h??'0').gte('0.25'))) {
          const fRep=passCost!=null ? stageNet(ins.fail,carryCash,'0',passCost) : null;
          const pRep=passCost!=null ? stageNet(ins.success,carryCash,dSplit.user,passCost) : null;
          const worstNet=fRep && pRep ? min(dec(fRep.net),dec(pRep.net)) : dec(ins.fail);
          const sumNet=fRep && pRep ? dec(fRep.net).plus(pRep.net) : dec(ins.fail);
          bestDiag={best:ins,fundedCtx:dCtx,targetStr:dt.target,isAuto:dt.auto,split:dSplit,note:dt.note,worstNet,sumNet};
          diagSeedUsed=true;
        }
      } catch {}
    }
  }

  const betterDiag=(cand,cur)=>{
    if(!cur) return true;
    if(cand.dual && !cur.dual) return true;
    if(!cand.dual && cur.dual) return false;
    if((cand.practicalTier??0)!==(cur.practicalTier??0)) return (cand.practicalTier??0)>(cur.practicalTier??0);
    const wDiff=cand.worstNet.minus(cur.worstNet);
    if(wDiff.abs().gt('3')) return wDiff.gt(0);
    if(Math.abs((cand.movePct??999)-(cur.movePct??999))>1.5) return (cand.movePct??999)<(cur.movePct??999);
    const sDiff=cand.sumNet.minus(cur.sumNet);
    if(sDiff.abs().gt('1')) return sDiff.gt(0);
    return wDiff.gt(0);
  };

  for(const dt of bestDiag ? [] : activeDiagTargets) {
    const dSplit=profitSplit(dt.target,baseline,share,withdrawal);
    const dGain=dec(dt.target).minus(fundedStart);
    const dCtx=makeFundedCtx(dt.target);
    for(const fSign of [row.sign,-row.sign]) {
      const fMaxPF=Math.min(maxPFGlobal,depthLimits(fundedMarket.pf,fSign).cap);
      const fMaxHL=Math.min(maxHLGlobal,depthLimits(fundedMarket.hl,-fSign).cap);
      if(fMaxPF<minPFLots || fMaxHL<minHLLots) continue;
      const loI=Math.min(fMaxPF,minPositivePFLots);
      const rSurv=dGain.gt(0) ? dec(carryCash).div(dGain) : dec('0.5');
      const rTarget=min(dec(share),max(dec('0.35'),min(hNeed,dec('0.75'))));
      const rRef=rSurv.gt(0) ? min(rSurv,rTarget) : dec('0.4');
      const matchedPF=rRef.gt(0)
        ? Math.max(loI,Math.min(fMaxPF,hlLotNotional.times(fMaxHL).div(rRef.times(pfLotNotional)).floor().toNumber()))
        : fMaxPF;
      const diagLotsForMove=(pct)=>dGain.gt(0)
        ? Math.max(loI,Math.min(fMaxPF,dGain.div(pfLotNotional.times(pct)).ceil().toNumber()))
        : loI;
      const pfCandidates=[...new Set([
        diagLotsForMove('0.05'),
        diagLotsForMove('0.09'),
        matchedPF
      ].filter(n=>Number.isSafeInteger(n) && n>=loI && n<=fMaxPF))];

      const probeDiagJ=(i,j)=>{
        if(j<minHLLots || j>fMaxHL) return null;
        try {
          const ins=inspectRatio(dCtx,{sign:fSign,i,j},{minimizeMargin:false,fastProbe:true});
          return ins?.physical && ins.fail!=null && ins.success!=null ? ins : null;
        } catch { return null; }
      };
      const evalDiagIns=(ins)=>{
        if(!ins) return false;
        const fRep=passCost!=null ? stageNet(ins.fail,carryCash,'0',passCost) : null;
        const pRep=passCost!=null ? stageNet(ins.success,carryCash,dSplit.user,passCost) : null;
        const dual=Boolean(fLoss.failureComplete && fRep?.strictProfit && pRep?.strictProfit);
        const worstNet=fRep && pRep ? min(dec(fRep.net),dec(pRep.net)) : dec(ins.fail);
        const sumNet=fRep && pRep ? dec(fRep.net).plus(pRep.net) : dec(ins.fail);
        const pfN=dec(ins.pfValue);
        const movePct=pfN.gt(0) ? Number(dGain.div(pfN).times(100)) : 999;
        const postRatio=dec(carryCash).gt(0) ? Number(dec(ins.success).div(carryCash)) : 0;
        const practicalTier=(movePct<=8 && postRatio>=0.20) ? 2 : (movePct<=15 && postRatio>=0.12) ? 1 : 0;
        const cand={best:ins,fundedCtx:dCtx,targetStr:dt.target,isAuto:dt.auto,split:dSplit,note:dt.note,worstNet,sumNet,dual,practicalTier,movePct,postRatio};
        if(betterDiag(cand,bestDiag)) bestDiag=cand;
        return true;
      };

      const survNum=Number(rSurv)||0.5;
      const targetRatios=[
        Math.min(0.74,survNum*0.92),
        Math.min(0.54,survNum*0.80),
        Math.min(0.38,survNum*0.62)
      ].filter(r=>r>0.03);

      let foundForSign=false;
      for(const i of pfCandidates) {
        const pfN=pfLotNotional.times(i);
        const ratioLots=[...new Set(targetRatios.map(r=>
          Math.max(minHLLots,Math.min(fMaxHL,pfN.times(String(r)).div(hlLotNotional).round().toNumber()))
        ))];
        for(const j of ratioLots) {
          if(evalDiagIns(probeDiagJ(i,j))) foundForSign=true;
        }
        if(!foundForSign) {
          if(evalDiagIns(probeDiagJ(i,minHLLots))) foundForSign=true;
        }
      }
      if(foundForSign) break;
    }
    if(bestDiag?.dual) break;
  }

  const mathematicallyProven=Boolean(wBounds?.feasible===false || anyMathBlocked || (candidateTargets.length>0 && allAttemptsExhausted));
  const dualBlockReason=wBounds?.feasible===false
    ? wBounds.reason
    : active?.shortfall && dec(active.shortfall).gt(0)
      ? '取得分成前实盘结余 '+dec(carryCash).toFixed(2)+' U 不足以支撑目标 '+dec(active.targetStr).toFixed(0)+' U 的双端盈利仓位（缺口约 '+dec(active.shortfall).toFixed(2)+' U）'
      : !mathematicallyProven
        ? '在已试探的 W 与离散手数网格内未命中双端盈利组合（非数学无解；下方提供当前资金可开仓诊断方案）'
        : '经双边手续费、步长及维持保证金核验，当前资金 '+dec(carryCash).toFixed(2)+' U 可开仓但无法同时覆盖通关总成本 '+dec(passCost??'0').toFixed(2)+' U 实现双端盈利';

  if(bestDiag) {
    return buildDetailedOutcome({
      best:bestDiag.best,
      fundedCtx:bestDiag.fundedCtx,
      targetStr:bestDiag.targetStr,
      isAuto:bestDiag.isAuto,
      split:bestDiag.split,
      status:'openable_no_dual',
      isDiagnostic:true,
      dualBlockReason,
      diagnosticWNote:bestDiag.note,
      searchExhausted:mathematicallyProven,
      diagSeedUsed
    });
  }

  // A (min legal order) passed, but D (full price-path maintenance margin & liquidation) or depth failed!
  const estPathReq=minOrderTotal.plus(minHlNotional.times('0.05'));
  const depthCat=sawDepthFailure ? {code:'INSUFFICIENT_DEPTH',label:'INSUFFICIENT_DEPTH（盘口深度不足）'} : {code:'MARGIN_PATH_FAILED',label:'保证金/强平路径失败'};
  return buildCannotOpen(
    (sawDepthFailure
      ? 'INSUFFICIENT_DEPTH（盘口深度不足）：当前盘口深度无法覆盖止损或领取目标平仓冲击'
      : '保证金/强平路径失败（A 最小合法下单 '+minHlQtyStr+' '+fundedMarket.hl.unit+' 仅需约 '+minOrderTotal.toFixed(2)+
        ' U 已满足，但当前实盘 '+dec(carryCash).toFixed(2)+' U 在完整价格路径至止损/目标终点时无法维持最小对冲仓位而不触发强平）'),
    estPathReq,
    false,
    depthCat
  );
}

function buildVerdicts(row,stage,activeLoss,fundedOutcome) {
  const failR=row.repayment.fail;
  const passR=row.repayment.pass;
  let failRecovered;
  if(activeLoss?.caseCode==='E') {
    failRecovered={ok:null,incomplete:true,label:'缺少总止损数据'};
  } else if(failR==null) {
    failRecovered={ok:null,incomplete:!activeLoss?.failureComplete,label:'失败回本待核'};
  } else if(!activeLoss?.failureComplete) {
    const tag=activeLoss?.caseCode==='C'?'缺日限配置':'缺必需总止损';
    failRecovered={ok:null,incomplete:true,label:(failR.recovered?'参考回本':'参考未回本')+'（'+tag+'）'};
  } else if(failR.recovered) {
    failRecovered={ok:true,incomplete:false,label:stage==='funded' && failR.strictProfit?'失败净盈利':'失败回本'};
  } else {
    failRecovered={ok:false,incomplete:false,label:'失败未回本（缺 '+dec(failR.gap).toFixed(2)+' U）'};
  }

  const passRecovered=stage==='funded'
    ? {ok:row.pass!=null,label:row.pass!=null?'分成前实盘可支撑':'分成前支撑待核'}
    : passR==null
      ? {ok:null,label:'通关成本待核'}
      : passR.recovered
        ? {ok:true,label:'通过当下回本'}
        : {ok:false,label:'通关成本 '+dec(row.passCost??passR.gap).toFixed(2)+' U'};

  let fundedRecovered;
  const cls=fundedOutcome?.classification;
  const mr=fundedOutcome?.multiRound;
  if(!fundedOutcome || fundedOutcome.status==='unconfigured' || cls?.code==='unconfirmed_conditions') {
    const label=fundedOutcome?.status==='invalid_target'
      ? '条件未确认（出金目标无效）'
      : fundedOutcome?.status==='missing_total'
        ? '条件未确认（缺总止损）'
        : '条件未确认';
    fundedRecovered={ok:null,supported:null,dualPositive:false,code:'unconfirmed_conditions',label};
  } else if(cls?.code==='single_round_dual_profit' || fundedOutcome.dualPositive) {
    fundedRecovered={ok:true,supported:true,canOpen:true,dualPositive:true,code:'single_round_dual_profit',
      label:stage==='challenge'?'一次领取双端盈利（条件）':'一次领取双端盈利'};
  } else if(cls?.code==='multi_round_profit_after_recovery') {
    const rTag=mr?.recoveredAtRound!=null ? ' · 约 '+mr.recoveredAtRound+' 轮回本' : '';
    fundedRecovered={ok:true,supported:false,canOpen:true,dualPositive:false,code:'multi_round_profit_after_recovery',
      label:'回本后继续盈利可行（条件'+rTag+'）'};
  } else if(cls?.code==='multi_round_recovery_feasible') {
    const rTag=mr?.recoveredAtRound!=null ? ' · 约 '+mr.recoveredAtRound+' 轮' : '';
    fundedRecovered={ok:true,supported:false,canOpen:true,dualPositive:false,code:'multi_round_recovery_feasible',
      label:'多轮累计回本可行（条件'+rTag+'）'};
  } else if(cls?.code==='openable_not_profitable' || fundedOutcome.status==='openable_no_dual') {
    fundedRecovered={ok:false,supported:false,canOpen:true,dualPositive:false,code:'openable_not_profitable',
      label:'可开仓但不满足盈利目标'};
  } else if(cls?.code==='path_risk_failed') {
    fundedRecovered={ok:false,supported:false,canOpen:false,dualPositive:false,code:'path_risk_failed',
      label:'路径风险不通过'};
  } else if(cls?.code==='no_legal_position' || fundedOutcome.status==='cannot_open') {
    fundedRecovered={ok:false,supported:false,canOpen:false,dualPositive:false,code:'no_legal_position',
      label:'无合法仓位'};
  } else {
    fundedRecovered={ok:null,supported:fundedOutcome.supported,dualPositive:false,code:'unconfirmed_conditions',label:'条件未确认'};
  }

  const termEvaluated=stage==='funded'
    ? {ok:null,status:'notApplicable',label:'Funded无考核期限'}
    : !row.fit
      ? {ok:null,status:'unassessed',label:'期限可达性未评估'}
      : row.fit.rank===0
        ? {ok:true,status:'within',label:'双边在期限参考内'}
        : row.fit.rank===1
          ? {ok:true,status:'withinPass',label:'通过线在期限参考内'}
          : {ok:false,status:'outside',label:'超出期限参考'};

  return {
    canOpen:{ok:true,label:'资金可开'},
    failRecovered,
    passRecovered,
    fundedRecovered,
    termEvaluated
  };
}

// Classify practical pace tier & pick up to 6 practical schemes across pace tiers (稳健低杠杆 / 中等均衡 / 偏紧凑快触发) × both directions.
// Extreme micro-positions (e.g. +166% / -99% required move) are excluded from the homepage featured cards and folded into "全部候选".
function classifyPaceTier(r) {
  const passPct=Math.abs(Number(r?.lines?.pass?.percent));
  const failPct=Math.abs(Number(r?.lines?.fail?.percent));
  if(!Number.isFinite(passPct) || passPct>18 || (Number.isFinite(failPct) && failPct>12)) {
    return {practical:false,code:'micro',label:'极小仓参考'};
  }
  if(passPct>=4.5) return {practical:true,code:'steady',label:'稳健低杠杆'};
  if(passPct>=2.4) return {practical:true,code:'balanced',label:'中等均衡'};
  return {practical:true,code:'compact',label:'偏紧凑快触发'};
}

function pickFeaturedKeys(rankedKeys,byKey) {
  for(const k of rankedKeys) {
    const item=byKey.get(k);
    if(item?.r) item.r.paceTier=classifyPaceTier(item.r);
  }
  const practicalKeys=rankedKeys.filter(k=>byKey.get(k)?.r?.paceTier?.practical===true);
  const pool=practicalKeys.length ? practicalKeys : rankedKeys;
  if(pool.length<=6) return pool;

  const chosen=[];
  const used=new Set();
  const addKey=k=>{ if(k && !used.has(k)) { used.add(k); chosen.push(k); } };
  // 1. Pick top-ranked candidate for each practical pace tier × direction: 稳健低杠杆 -> 中等均衡 -> 偏紧凑快触发
  for(const tierCode of ['steady','balanced','compact']) {
    for(const sign of [1,-1]) {
      if(chosen.length>=6) break;
      const match=pool.find(k=>{
        const item=byKey.get(k);
        return item && item.group.sign===sign && item.r.paceTier?.code===tierCode;
      });
      addKey(match);
    }
  }
  // 2. Fill remaining slots up to 6 with distinct-scale practical candidates alternating directions
  for(const sign of [1,-1]) {
    const dirKeys=pool.filter(k=>byKey.get(k)?.group.sign===sign);
    for(const k of dirKeys) {
      if(chosen.length>=6) break;
      const r=byKey.get(k).r;
      const sameDirChosen=chosen.map(c=>byKey.get(c)).filter(x=>x.group.sign===sign).map(x=>x.r);
      const distinctScale=sameDirChosen.every(p=>Math.abs(r.i-p.i)/Math.max(r.i,p.i)>=0.25);
      if(distinctScale) addKey(k);
    }
  }
  for(const k of pool) {
    if(chosen.length>=6) break;
    addKey(k);
  }
  return chosen;
}

export function buildCandidateSet(scan,ctx,inspect,globalScale,globalCash,reference,now,quote) {
  const buildStartMs=performance.now();
  let evalSearchMs=0;
  let fundedSolveMs=0;
  const hitsBefore=fundedCacheStats.hits;
  const missesBefore=fundedCacheStats.misses;
  const {book,market,checks,params}=ctx;
  const stage=book.stage;
  const opening=params.openingCapacity===true;
  const activeLoss=params.lossBoundary ?? {stage,caseCode:'A',bindingSource:'total',failureDefined:true,failureComplete:true,effectiveFloor:stage==='funded'?book.fundedFloor:book.challengeFloor};
  const failMissing=activeLoss.caseCode==='E';
  // If B-protected eligible set is empty (or Case E missing total floor), fall back to riskOnly diagnostic search
  // while keeping book.B at the true personal principal (never 0 U!).
  const useRiskFallback=opening && (failMissing || !scan.sets.both.largest);
  const funding=stage==='challenge'?termFunding(quote,params.deadline,now):{issue:'Funded 阶段无考核截止期限'};
  const current={pf:position(book,'pf'),hl:position(book,'hl')};
  const timeBounds={normal:[],delayed:[]};
  const groups=[];
  const pfLotNotional=unit(market.pf).times(market.pf.step).times(market.pf.mark);
  const pfTargetGap=max('0',dec(params.target).minus(book.pf));
  const naturalAnchorLot=pfLotNotional.gt(0) && pfTargetGap.gt(0)
    ? pfTargetGap.div(pfLotNotional).ceil().toNumber() : 1;

  const ruleSig=fundedRuleSignature(ctx)+'|'+String(current.pf)+'|'+String(current.hl)+'|'+String(useRiskFallback);
  const pfMarkNum=Number(market.pf.mark), hlMarkNum=Number(market.hl.mark);
  const canTryIncremental=
    lastFullEvalSearch &&
    lastFullEvalSearch.ruleSig===ruleSig &&
    now-lastFullEvalSearch.at<RESEARCH_TTL &&
    Math.abs(pfMarkNum/lastFullEvalSearch.pfMark-1)<RESEARCH_MOVE &&
    Math.abs(hlMarkNum/lastFullEvalSearch.hlMark-1)<RESEARCH_MOVE;
  let usedIncremental=false;
  const nextGroupSpecs=[];

  for(const sign of [1,-1]) {
    const tEval0=performance.now();
    const points=new Map(), bands=new Map();
    let reason='', termComplete=stage==='funded', maxPFStr=null, groupStatus='verified';
    let incrementalOkForSign=false;

    if(canTryIncremental) {
      const savedGroup=lastFullEvalSearch.groups.find(g=>g.sign===sign);
      if(savedGroup) {
        let allValid=true;
        for(const item of savedGroup.items) {
          const audit=inspect({sign,i:item.i,j:item.j});
          if(!audit || (!useRiskFallback && audit.configuredPass===false)) {
            allValid=false;
            break;
          }
          points.set(audit.key,{audit,tags:new Set(item.tags)});
          if(item.band) bands.set(audit.key,item.band);
        }
        if(allValid) {
          reason=savedGroup.reason;
          termComplete=savedGroup.termComplete;
          maxPFStr=savedGroup.maxPF;
          groupStatus=savedGroup.status;
          incrementalOkForSign=true;
          usedIncremental=true;
        } else {
          points.clear();
          bands.clear();
        }
      }
    }

    if(!incrementalOkForSign) {
      usedIncremental=false;
      const directional=(global,objective,riskOnly=false)=>
        !riskOnly && (global.row?.sign===sign || global.status==='none')
          ? global
          : searchLiquidityMaximum(scan,inspect,false,ctx,objective,null,null,sign,false,riskOnly?Infinity:globalScale.row?.i,null,riskOnly);
      const maximum=directional(globalScale,'scale',useRiskFallback);
      const add=(audit,label)=>{
        if(!audit) return;
        if(!points.has(audit.key)) points.set(audit.key,{audit,tags:new Set()});
        points.get(audit.key).tags.add(label);
      };
      const repayAt=i=>(failMissing || useRiskFallback)?null:searchLiquidityMaximum(scan,inspect,false,ctx,'repayFailure',null,i,sign,false,Infinity,null,false).row;
      // In challenge opening mode, prefer repayAt(maximum.row.i) over the over-hedged maximum.row so extra capital B is NEVER wasted!
      const maxRepayRow=(opening && stage==='challenge' && !failMissing && !useRiskFallback && params.profitBasis!=null && maximum.row)
        ? repayAt(maximum.row.i)
        : null;
      if(maxRepayRow) {
        add(maxRepayRow,'本方向最大规模');
        add(maxRepayRow,'最大规模且失败回本');
      } else {
        add(maximum.row,useRiskFallback?'本方向最大可开规模':'本方向最大规模');
      }
      reason=maximum.reason;
      termComplete=stage==='funded' || maximum.status==='none';
      maxPFStr=maximum.row?out(dec(maximum.row.pf).abs()):null;
      groupStatus=maximum.status;
      if(maximum.row || maximum.status==='incomplete') {
        const balance=globalCash && !useRiskFallback?directional(globalCash,'cash',false):{row:null};
        add(balance.row,'两端最差现金缓冲最大');
        const left=balance.row,right=maximum.row;
        if(left && right && left.i<right.i && !useRiskFallback) {
          const baseline=dec(left.pressureSummary.M_verified);
          const gain=baseline.minus(right.pressureSummary.M_verified);
          if(gain.gt(0)) {
            const rate=gain.div(right.i-left.i);
            const middle=searchLiquidityMaximum(scan,inspect,false,ctx,'tradeoff',null,null,sign,false,right.i,
              {first:left.i,baseline,rate},false).row;
            if(middle && middle.i>left.i && middle.i<right.i &&
                dec(middle.pressureSummary.M_verified).plus(rate.times(middle.i-left.i)).gt(baseline.plus('1e-12')))
              add(middle,'规模与现金缓冲折中');
          }
        }
        const minimum=searchLiquidityMaximum(scan,inspect,false,ctx,'minimumSize',null,null,sign,false,maximum.row?.i,null,useRiskFallback);
        if(stage==='challenge' && !failMissing) {
          const term=nearestTerm(scan,ctx,inspect,sign,minimum.row,maximum.row,reference,useRiskFallback);
          termComplete=term?.complete===true;
          const termRepay=(opening && !useRiskFallback && params.profitBasis!=null && term?.row) ? repayAt(term.row.i) : null;
          add(termRepay ?? term?.row,termComplete?'本方向期限优先':'已核价期限候选');
        }
        if(maximum.row) {
          const nextQty=dec(market.pf.step).times(maximum.row.i+1);
          reason=market.pf.maxQty!=null && nextQty.gt(market.pf.maxQty)?
            'PF 数量上限 '+market.pf.maxQty+' '+market.pf.unit+'，超出 '+out(nextQty.minus(market.pf.maxQty))+' '+market.pf.unit:
            diagnoseScale(scan,ctx,maximum.row.i+1,inspect,sign).reason;
          reason='再增加一个 PF 步长（'+market.pf.step+' '+market.pf.unit+'）受限：'+reason;
        }
        const sizes=new Set([...points.values()].map(p=>p.audit.i));
        let repayBoundary=maxRepayRow;
        if(opening && !failMissing && !useRiskFallback && params.profitBasis!=null && minimum.row && maximum.row && !repayBoundary) {
          const maxRepay=repayAt(maximum.row.i);
          if(maxRepay) {
            add(maxRepay,'最大规模且失败回本');
            repayBoundary=maxRepay;
          }
        }
        const addDistinctSize=n=>{
          if(!Number.isSafeInteger(n) || n<1) return;
          for(const existing of sizes) if(Math.abs(n-existing)/Math.max(n,existing)<0.22) return;
          sizes.add(n);
        };
        if(opening && minimum.row && maximum.row && minimum.row.i<maximum.row.i) {
          const topRepay=repayBoundary?.i ?? maximum.row.i;
          const anchorLo=Math.max(minimum.row.i,Math.min(topRepay,naturalAnchorLot));
          const spanLo=anchorLo<topRepay?anchorLo:minimum.row.i;
          // Use capital-invariant PF capacity anchor so the exact same PF scales (and identical C_pass) are preserved when B increases!
          const pfCapLot=pfLotNotional.gt(0)
            ? Math.max(spanLo,dec(book.pf).times(market.pf.leverage).div(pfLotNotional).floor().toNumber())
            : topRepay;
          // Explicitly sample 3 practical Evaluation pace tiers (稳健 ~6%, 中等 ~3.5%, 偏紧凑 ~1.9%) so homepage always offers realistic rhythms!
          if(pfLotNotional.gt(0) && pfTargetGap.gt(0)) {
            for(const movePct of ['0.06','0.035','0.019']) {
              const paceLot=pfTargetGap.div(pfLotNotional.times(movePct)).ceil().toNumber();
              if(paceLot>=minimum.row.i && paceLot<=topRepay) addDistinctSize(paceLot);
            }
          }
          sizes.add(minimum.row.i);
          if(anchorLo>=minimum.row.i && anchorLo<=topRepay) sizes.add(anchorLo);
          for(const fraction of [0.25,0.50,0.72]) {
            const targetI=Math.min(topRepay,Math.round(spanLo*Math.pow(pfCapLot/spanLo,fraction)));
            addDistinctSize(targetI);
          }
          const minRepay=(!failMissing && !useRiskFallback && params.profitBasis!=null)?repayAt(minimum.row.i):null;
          add(minRepay ?? minimum.row,'本方向最小可行规模');
        } else if(minimum.row) {
          sizes.add(minimum.row.i);
          const minRepay=(opening && !failMissing && !useRiskFallback && params.profitBasis!=null)?repayAt(minimum.row.i):null;
          add(minRepay ?? minimum.row,'本方向最小可行规模');
        }

        const heldLots=current.pf.abs().div(market.pf.step);
        const heldI=current.pf.cmp(0)===sign && heldLots.isInteger()?heldLots.toNumber():null;
        if(Number.isSafeInteger(heldI) && (maximum.row==null || heldI<=maximum.row.i)) sizes.add(heldI);

        const orderedSizes=[...sizes].filter(n=>Number.isSafeInteger(n) && n>=1).sort((a,b)=>b-a);
        const maintenanceFloor=dec(checks.minMaintenanceSurplus??'0');
        for(let sIdx=0;sIdx<orderedSizes.length;sIdx++) {
          const i=orderedSizes[sIdx];
          if(opening) {
            const repayRow=(!failMissing && !useRiskFallback && params.profitBasis!=null)?repayAt(i):null;
            const highRow=(!repayRow || sIdx<=1 || stage==='funded')
              ? searchLiquidityMaximum(scan,inspect,false,ctx,'hedgeHigh',null,i,sign,false,Infinity,null,useRiskFallback).row
              : null;
            if(repayRow) {
              add(repayRow,'失败回本最少对冲');
              if(stage==='funded' && dec(repayRow.pressureSummary.minFailure.value).lte(params.profitBasis) && highRow && repayRow.j<highRow.j) {
                const strictAudit=inspect({sign,i,j:repayRow.j+1});
                if(score(strictAudit,dec(params.profitBasis),dec('0'),maintenanceFloor,false))
                  add(strictAudit,'失败严格盈利最少对冲');
              }
              if(highRow && highRow.j>repayRow.j && sIdx<=1) {
                const cappedJ=stage==='challenge'
                  ? Math.min(highRow.j,Math.max(repayRow.j+1,Math.round(repayRow.j*1.18)))
                  : Math.floor((repayRow.j+highRow.j)/2);
                if(cappedJ>repayRow.j && cappedJ<=highRow.j) {
                  const midAudit=inspect({sign,i,j:cappedJ});
                  const midOk=score(midAudit,dec(params.profitBasis),dec('0'),maintenanceFloor,false);
                  if(midOk && dec(midAudit.pressureSummary.minFailure.value).minus(repayRow.pressureSummary.minFailure.value).gte('3'))
                    add(midAudit,'提高对冲 · 失败盈利更高');
                }
              }
            } else {
              if(highRow) add(highRow,failMissing?'缺少总止损 · 可开仓参考':'该规模最高可行对冲（失败仍有缺口）');
            }
            if(stage==='funded' && i===maximum.row?.i && !useRiskFallback) {
              const lowRow=searchLiquidityMaximum(scan,inspect,false,ctx,'hedgeLow',null,i,sign,false,Infinity,null,false).row;
              if(lowRow && lowRow.key!==repayRow?.key) add(lowRow,'该规模最低对冲 · 出金端盈利更高');
            }
            if(i===heldI) add(searchLiquidityMaximum(scan,inspect,false,ctx,'keepExposure',null,i,sign,false,Infinity,null,useRiskFallback).row,'保留 PF 现仓，实盘调整量最小');
            continue;
          }
          const slice=searchLiquidityMaximum(scan,inspect,false,ctx,'scale',null,i,sign,true);
          const lots=[...new Set(slice.lots??[])].sort((a,b)=>a-b);
          if(!lots.length) continue;
          if(i===heldI) {
            const heldHype=current.hl.times(-sign).div(market.hl.step);
            const nearest=lots.reduce((best,j)=>heldHype.minus(j).abs().lt(heldHype.minus(best).abs())?j:best);
            add(inspect({sign,i,j:nearest}),slice.status==='incomplete'?'保留 PF 现仓的已核实组合':'保留 PF 现仓，Hype 调整量最小');
          }
          const intervals=[];
          for(const j of lots) {
            const tail=intervals.at(-1);
            if(tail && tail[1]+1===j) tail[1]=j;
            else intervals.push([j,j]);
          }
          for(const [lo,hi] of intervals) {
            const lower=inspect({sign,i,j:lo}),upper=inspect({sign,i,j:hi});
            const complete=slice.status!=='incomplete';
            if(lo===hi) add(lower,complete && intervals.length===1?'该规模仅一个合格对冲量':'独立可行数量');
            else {
              add(lower,complete?'该规模对冲下界':'已核实的对冲仓位');
              add(upper,complete?'该规模对冲上界':'已核实的对冲仓位');
            }
            const interval=complete?[lower.notionalRatio,upper.notionalRatio]:null;
            for(const {audit} of points.values())
              if(audit.i===i && audit.j>=lo && audit.j<=hi && interval) bands.set(audit.key,interval);
          }
        }
      } else if(scan.complete && !checks.hardDepthD && scan.sets.legal.largest) {
        const probe=diagnoseScale(scan,ctx,scan.sets.legal.largest.i,inspect,sign);
        if(probe.reason) reason+='。'+probe.reason;
      }
    }
    evalSearchMs+=Math.round(performance.now()-tEval0);
    nextGroupSpecs.push({
      sign,
      reason,
      termComplete,
      maxPF:maxPFStr,
      status:groupStatus,
      items:[...points.values()].map(({audit,tags})=>({i:audit.i,j:audit.j,tags:[...tags],band:bands.get(audit.key)??null}))
    });

    const rows=[];
    for(const {audit,tags} of points.values()) {
      const row=compactScale(audit), summary=audit.pressureSummary;
      if(failMissing) {
        row.fail=null;
        row.failMark=null;
        row.failMove=null;
      }
      const lines={},fees={},cost={};
      const triggerModes={fail:checks.failureTrigger??'mark_equity',pass:checks.passTrigger??'net_settlement'};
      for(const [end,mark] of [['pass',row.passMark],['fail',row.failMark]]) {
        if(mark!=null) {
          lines[end]={
            mark,
            triggerMode:triggerModes[end],
            pfTriggerEquity:legTriggerEquity(audit.paths?.[end]?.pf),
            pfSettledEquity:audit.paths?.[end]?.pf?.finalEquity??audit.paths?.[end]?.pf?.settled??null,
            hlMark:audit.paths?.[end]?.hl?.exitMark??null,
            pfExitPrice:audit.paths?.[end]?.pf?.exitPrice??null,
            hlExitPrice:audit.paths?.[end]?.hl?.exitPrice??null,
            ...examMove(checks.exam??{up:null,down:null},market.pf.mark,mark)
          };
        }
        const legs=['pf','hl'].map(side=>audit.paths?.[end]?.[side]);
        fees[end]=legs.every(l=>l?.fees!=null)?out(dec(legs[0].fees).plus(legs[1].fees)):null;
        cost[end]=fees[end]!=null && legs.every(l=>l.executionCost!=null)?
          out(dec(fees[end]).plus(legs[0].executionCost).plus(legs[1].executionCost)):null;
      }
      const branchCosts={
        fail:failMissing?null:summarizeBranchCosts(audit.paths,'fail','0'),
        pass:summarizeBranchCosts(audit.paths,'pass',stage==='funded'?(book.withdrawal?.fee??'0'):'0')
      };
      for(const scenario of summary.cases.filter(c=>c.configured)) {
        const bounds=timeBounds[['vestFirst','hypeFirst'].includes(scenario.id)?'delayed':'normal'];
        for(const end of [scenario.fail,scenario.success]) {
          if(failMissing && end===scenario.fail) continue;
          const mark=end.venue?.pfEnd??end.mathMarks?.trigger??end.prices?.pf?.mark;
          if(mark!=null) bounds.push(mark);
        }
      }
      const repaymentByEnd={
        fail:failMissing?null:(stage==='funded' && params.passCostInput!=null
          ? stageNet(row.fail,book.hl,'0',params.passCostInput)
          : repayment(row.fail,params.profitBasis)),
        pass:repayment(row.pass,params.profitBasis)
      };
      const passCost=stage==='challenge'
        ? (params.profitBasis!=null && row.pass!=null ? out(dec(params.profitBasis).minus(row.pass)) : null)
        : params.pendingPassCost;
      const termDebit=funding.issue?null:out(dec(row.hl).times(market.hl.multiplier).times(market.hl.fx)
        .times(funding.oracle).times(funding.rate).times(funding.periods));
      const fundingInfo=buildFundingInfo(stage,funding,termDebit,checks);
      const fundingIncluded=fundingInfo.includedInNet===true || Boolean(checks.fundingRatesBps?.length);
      const fit=stage==='challenge' && !failMissing?termFit(reference,lines.pass?.percent,lines.fail?.percent):null;
      const tFunded0=performance.now();
      const funded=fundedWithCache({...row,key:audit.key,sign},ctx,activeLoss,audit,fundingIncluded,now,false);
      fundedSolveMs+=Math.round(performance.now()-tFunded0);
      const pfEffectiveLev=dec(book.pf).gt(0)?out(dec(row.pfValue).div(book.pf)):null;
      const hlEffectiveLev=dec(book.hl).gt(0)?out(dec(row.hypeValue).div(book.hl)):null;
      const pfIM=out(dec(row.pfValue).div(market.pf.leverage));
      const hlIM=audit.initialMarginHL ?? (row.leverage?out(dec(row.hypeValue).div(row.leverage)):null);
      const evalTotalFriction=out(
        dec(branchCosts?.pass?.pf?.totalFee??'0')
          .plus(branchCosts?.pass?.pf?.execTotal??'0')
          .plus(branchCosts?.pass?.hl?.totalFee??'0')
          .plus(branchCosts?.pass?.hl?.execTotal??'0')
      );
      const fundedLossD=funded?.lossBoundary?.effectiveSpace ?? null;
      const fundedTheoreticalCap=fundedLossD!=null && book.share!=null ? out(dec(book.share).times(fundedLossD)) : null;
      const fundedHeadroom=passCost!=null && fundedTheoreticalCap!=null
        ? out(dec(fundedTheoreticalCap).minus(passCost))
        : null;
      const enriched={
        ...row,passCost,evalTotalFriction,fundedTheoreticalCap,fundedHeadroom,repayment:repaymentByEnd,funded,termDebit,fundingInfo,fundingIncluded,triggerModes,fit,lossBoundary:activeLoss,
        entryPrices:{
          pfMark:market.pf.mark,pfEntry:audit.paths?.pass?.pf?.entryPrice??market.pf.mark,
          hlMark:market.hl.mark,hlEntry:audit.paths?.pass?.hl?.entryPrice??market.hl.mark
        },
        initialMargin:{pf:pfIM,hl:hlIM},
        pfLeverage:market.pf.leverage,pfEffectiveLev,hlEffectiveLev,
        leverageRange:audit.leverageRange??null,
        leverageOptions:audit.leverageOptions??[],
        marginCondition:{
          pfInitialMargin:pfIM,hlInitialMargin:hlIM,
          hlMaintenance:audit.maintenanceHL??null,hlFreeAfter:audit.freeAfterHL??null,
          hlMinSurplus:row.surplus,hlPeakMargin:row.margin,
          hlLiqMark:audit.liquidationHL??null,hlPriceBuffer:audit.priceBufferHL??null
        },
        key:audit.key,tags:[...tags],lines,fees,cost,costs:branchCosts,band:bands.get(audit.key)??null,
        status:'pass',
        reason:opening?'双边资金与保证金可开': '失败保护余量 '+dec(row.fail??'0').minus(book.B).minus(params.recoveryBuffer??0).toFixed(4)+
          ' U · 通过留存余量 '+dec(row.pass).minus(params.R).toFixed(4)+' U',
        adjust:{pf:transition(market.pf,current.pf,dec(row.pf)),hl:transition(market.hl,current.hl,dec(row.hl))}
      };
      enriched.verdicts=buildVerdicts(enriched,stage,activeLoss,funded);
      rows.push(enriched);
    }
    groups.push({sign,rows,reason,termComplete,maxPF:maxPFStr,status:groupStatus,reverse:current.pf.times(sign).lt(0)||current.hl.times(sign).gt(0)});
  }

  if(!usedIncremental) {
    lastFullEvalSearch={
      ruleSig,
      pfMark:pfMarkNum,
      hlMark:hlMarkNum,
      at:now,
      groups:nextGroupSpecs
    };
  }

  const extremes=values=>values.length?values.reduce(([lo,hi],v)=>
    [dec(v).lt(lo)?v:lo,dec(v).gt(hi)?v:hi],[values[0],values[0]]):[];
  const all=groups.flatMap(g=>g.rows);
  const byKey=new Map();
  for(const group of groups) for(const r of group.rows) byKey.set(r.key,{group,r});
  const classRank=r=>{
    const c=r.funded?.classification?.code;
    if(c==='single_round_dual_profit' || r.funded?.dualPositive===true) return 5;
    if(c==='multi_round_profit_after_recovery') return 4;
    if(c==='multi_round_recovery_feasible') return 3;
    if(c==='openable_not_profitable' || r.funded?.canOpen===true) return 2;
    if(c==='path_risk_failed') return 1;
    return 0;
  };
  const failOK=r=>activeLoss.failureComplete && r.repayment.fail?.recovered===true?1:0;
  const singleDual=r=>r.funded?.dualPositive===true?1:0;
  const ratioWindowOK=r=>r.funded?.wBounds?.ratioWindowFeasible===true?1:0;
  const recRounds=r=>r.funded?.dualPositive?1:(r.funded?.multiRound?.recoveredAtRound??99);
  const evalHlEffLev=r=>{
    const h0=dec(book.hl??'0');
    return h0.gt(0) && r.hypeValue!=null ? Number(dec(r.hypeValue).div(h0)) : 999;
  };
  const evalSafeTier=r=>{
    const lev=evalHlEffLev(r);
    const fNet=r.repayment?.fail?.net!=null ? Number(r.repayment.fail.net) : -999;
    const eMove=Math.abs(Number(r.lines?.pass?.percent ?? 999));
    if(lev<=18 && fNet>=0 && eMove<=12) return 2;
    if(lev<=26 && fNet>=0 && eMove<=25) return 1;
    return 0;
  };
  const fundedExecutableTier=r=>{
    const f=r.funded;
    if(!f) return 0;
    if(f.dualPositive) {
      const mPct=f.singleRoundMovePct!=null ? Math.abs(Number(f.singleRoundMovePct)) : 99;
      const cPct=f.singleRoundHypePostCloseRatioPct!=null ? Number(f.singleRoundHypePostCloseRatioPct) : 0;
      if(mPct<=8 && cPct>=20) return 3;
      if(mPct<=15 && cPct>=12) return 2;
      return 1;
    }
    const mr=f.multiRound;
    if(mr?.rounds?.length && mr.recoveredAtRound!=null) {
      const maxM=mr.maxRoundMovePct!=null ? Number(mr.maxRoundMovePct) : 99;
      const minC=mr.minHypePostCloseRatioPct!=null ? Number(mr.minHypePostCloseRatioPct) : 0;
      if(!mr.hasExtremeMove && !mr.hasLowHypeCushion && maxM<=8 && minC>=25) return 3;
      if(!mr.hasExtremeMove && !mr.hasLowHypeCushion) return 2;
      return 0; // Penalize >15% extreme crash or <15% Hype residual cushion!
    }
    return 0;
  };
  const crossStageScore=r=>{
    const lev=evalHlEffLev(r);
    const fNet=r.repayment?.fail?.net!=null ? Number(r.repayment.fail.net) : -500;
    const hPass=r.pass!=null ? Number(r.pass) : 0;
    const cPass=r.passCost!=null ? Number(r.passCost) : 999;
    const mr=r.funded?.multiRound;
    const r1Stop=mr?.firstRoundStopOutcome?.finalNetPnL!=null ? Number(mr.firstRoundStopOutcome.finalNetPnL) : -500;
    const maxM=r.funded?.dualPositive
      ? Math.abs(Number(r.funded?.singleRoundMovePct ?? 20))
      : Number(mr?.maxRoundMovePct ?? 30);
    const minC=r.funded?.dualPositive
      ? Number(r.funded?.singleRoundHypePostCloseRatioPct ?? 0)
      : Number(mr?.minHypePostCloseRatioPct ?? 0);
    const evalMove=Math.abs(Number(r.lines?.pass?.percent ?? 15));
    const friction=r.evalTotalFriction!=null ? Number(r.evalTotalFriction) : 0;
    const headroom=r.fundedHeadroom!=null ? Number(r.fundedHeadroom) : 0;
    // Balanced cross-stage score:
    // - Reward Funded theoretical headroom (s*D - C_pass) & lower Eval total fee/slippage friction
    // - Lower C_pass (more Funded capital room) & positive fail cushion
    // - Penalize extreme Eval Hype leverage (>15x) and extreme Funded price move (>6%)
    // - Reward healthy Funded post-close Hype cushion & better Round-1 stop-loss outcome
    return (
      hPass * 0.60 -
      cPass * 0.50 +
      headroom * 0.90 -
      friction * 1.10 +
      Math.min(80, Math.max(-200, fNet)) * 0.8 +
      r1Stop * 0.35 +
      Math.min(55, minC) * 2.2 -
      Math.max(0, lev - 15) * 14 -
      Math.max(0, maxM - 6) * 18 -
      Math.max(0, evalMove - 8) * 6
    );
  };
  const fundedWorstNet=r=>{
    const f=r.funded;
    if(f?.failRepayment?.net!=null && f?.repayment?.net!=null) {
      return min(dec(f.failRepayment.net),dec(f.repayment.net));
    }
    return dec('-1e18');
  };
  const ranked=all.toSorted((a,b)=>
    (opening
      ? (failOK(b)-failOK(a)) ||
        (fundedExecutableTier(b)-fundedExecutableTier(a)) ||
        (evalSafeTier(b)-evalSafeTier(a)) ||
        (singleDual(b)-singleDual(a)) ||
        (classRank(b)-classRank(a)) ||
        (ratioWindowOK(b)-ratioWindowOK(a)) ||
        (Math.abs(crossStageScore(b)-crossStageScore(a))>5 ? (crossStageScore(b)-crossStageScore(a)) : 0) ||
        (recRounds(a)-recRounds(b)) ||
        ((a.fit?.rank??3)-(b.fit?.rank??3))
      : 0) ||
    compareFit(a.fit,b.fit) ||
    fundedWorstNet(b).cmp(fundedWorstNet(a)) ||
    dec(b.pass??'0').cmp(dec(a.pass??'0')) ||
    b.i-a.i ||
    a.key.localeCompare(b.key));
  const rankedKeys=ranked.map(r=>r.key);
  const featuredKeys=pickFeaturedKeys(rankedKeys,byKey);
  const verified=stage==='challenge' && !failMissing && all.length>0 && all.every(r=>r.fit) && groups.every(g=>g.termComplete);
  const failGaps=all.map(r=>r.repayment.fail?.gap).filter(v=>v!=null);
  const fundedGaps=all.map(r=>r.funded?.repayment?.gap).filter(v=>v!=null);
  const countClass=code=>all.filter(r=>r.funded?.classification?.code===code).length;
  const summary={
    total:all.length,
    featured:featuredKeys.length,
    failRecovered:activeLoss.failureComplete?all.filter(r=>r.repayment.fail?.recovered===true).length:0,
    passRecovered:all.filter(r=>r.repayment.pass?.recovered===true).length,
    fundedSupported:all.filter(r=>r.funded?.supported===true).length,
    fundedCanOpen:all.filter(r=>r.funded?.canOpen===true || r.funded?.supported===true).length,
    fundedDiagnostic:all.filter(r=>r.funded?.status==='openable_no_dual').length,
    fundedCannotOpen:all.filter(r=>r.funded?.status==='cannot_open').length,
    fundedIncomplete:all.filter(r=>['unconfigured','missing_total','invalid_target','unverified'].includes(r.funded?.status)).length,
    fundedRecovered:all.filter(r=>r.funded?.repayment?.recovered===true && r.funded?.supported!==false).length,
    dualPositive:all.filter(r=>r.funded?.dualPositive===true).length,
    singleRoundDual:countClass('single_round_dual_profit'),
    multiRoundProfit:countClass('multi_round_profit_after_recovery'),
    multiRoundRecovery:countClass('multi_round_recovery_feasible'),
    openableNotProfitable:countClass('openable_not_profitable'),
    pathRiskFailed:countClass('path_risk_failed'),
    noLegalPosition:countClass('no_legal_position'),
    unconfirmed:countClass('unconfirmed_conditions'),
    bestFailShortfall:failGaps.length?out(min(...failGaps)):null,
    bestFundedShortfall:fundedGaps.length?out(min(...fundedGaps)):null
  };
  const fundingIncluded=Boolean((checks.stress?.fundingDebit && dec(checks.stress.fundingDebit).gt(0)) || checks.fundingRatesBps?.length);
  const totalBuildMs=Math.round(performance.now()-buildStartMs);
  const timings={
    layer:usedIncremental?'B_incremental':'C_full_search',
    evalSearchMs,
    fundedSolveMs,
    totalBuildMs,
    fundedSeedHits:fundedCacheStats.hits-hitsBefore,
    fundedFullSearches:fundedCacheStats.misses-missesBefore,
    lastFullSearchAt:lastFullEvalSearch?.at ? new Date(lastFullEvalSearch.at).toISOString() : new Date(now).toISOString()
  };
  return {
    kind:'joint',stage,opening,funding,fundingIncluded,timings,
    triggerModes:{fail:checks.failureTrigger??'mark_equity',pass:checks.passTrigger??'net_settlement'},
    principal:params.profitBasis,pendingPassCost:params.pendingPassCost,
    registration:params.registration??null,lossBoundary:activeLoss,
    fundedRules:params.fundedRules??null,autoFundedTarget:params.autoFundedTarget===true,
    fundedWBounds:params.fundedWBounds??null,summary,
    reference:stage==='challenge'?(reference??{issue:'缺少该标的历史K线'}):null,
    remainingMs:stage==='challenge' && params.deadline?Date.parse(params.deadline)-now:null,
    rankedKeys,featuredKeys,noTermMatch:verified && all.every(r=>r.fit.rank!==0),
    capital:{pf:book.pf,hl:book.hl,B:out(dec(book.B).plus(params.recoveryBuffer??0)),R:params.R,
      floor:activeLoss.effectiveFloor,target:params.target},
    groups,timeBounds:{normal:extremes(timeBounds.normal),delayed:extremes(timeBounds.delayed)}
  };
}
