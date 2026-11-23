import {examEnvelope,examMove} from './reachability.js';
import {venuePath} from './venue-scenarios.js';
import { dec, out, fillEvidence, canClaimOnSuccess, projectedShare } from './math.js';
import { settlementBridge, sumPostings } from './settlement-ledger.js';
import { executionDetail, validateMargin } from './solver.js';

// Re-use only the observed levels. Nothing is extrapolated past their sizes.
// An empty or partially covered exit cannot produce a terminal cash amount.
export function exitBook(leg, target, removedLevels) {
  const side = dec(target).gt(0) ? 'bids' : 'asks';
  const levels=leg[side];
  if (!removedLevels || !levels) return leg;
  const shortfall=removedLevels==='shortfall';
  const quantity=dec(target).abs();
  let remaining=shortfall ? dec(sumPostings(levels.map(level=>level[1]))) : null;
  let i=0, n=0;
  while (i<levels.length && (shortfall ? remaining.gte(quantity) : n<removedLevels)) {
    const start=i;
    const price=dec(levels[i++][0]);
    while (i<levels.length && price.eq(levels[i][0])) i++;
    n++;
    if (shortfall) for (let k=start;k<i;k++) remaining=remaining.minus(levels[k][1]);
  }
  return {...leg,[side]:levels.slice(i)};
}

export function exitDepthLabel(test) {
  const fills=[test?.depth?.pf,test?.depth?.hl];
  if (fills.some(fill=>!fill || fill.status==='unknown' || fill.covered==null || fill.uncovered==null)) return '可成交深度未验证';
  if (fills.every(fill=>dec(fill.uncovered).isZero()))
    return test.status==='pass'?'可全量成交且满足资金门槛':'可全量成交，资金或路径未通过核验';
  return fills.some(fill=>dec(fill.covered).gt(0))
    ? '部分可成交，剩余数量无法估值' : '无可成交数量，完全无法全量退出';
}

function reprice(leg, book, entry, shift, extraDebit) {
  const exit = executionDetail(book,out(dec(entry.target).neg()),shift);
  return settlementBridge(entry.start,leg,entry.target,entry.adjustment,shift,
    {price:entry.entryPrice,fee:entry.entryFee,impact:entry.entrySlippage},exit,
    sumPostings([entry.friction,extraDebit]),book);
}

// Independent configured event magnitudes can coincide at exit. The direction
// refers to the Hype position and all movements here are in its native unit.
export function pressureExitOffset(leg,sign,checks) {
  const width=sumPostings([checks.basisBps ?? checks.adverseBps ?? '0', checks.asyncBps ?? '0',
    checks.stress?.jumpBps ?? '0', checks.stress?.delayBps ?? '0']);
  return dec(width).times(leg.mark).div(10000).times(-sign);
}

// The precise future settlement marks are unknown. Each scheduled adverse
// rate is applied to an upper bound on native notional over this price path.
function fundingOnPath(leg,qty,shock,offset,exitMark) {
  const marks=[dec(leg.mark),dec(leg.mark).plus(offset),dec(exitMark)];
  if (shock.arrivalMark!=null) marks.push(dec(shock.arrivalMark));
  const peak=marks.reduce((a,b)=>a.gt(b)?a:b);
  const notional=dec(qty).abs().times(leg.multiplier).times(leg.fx).times(peak);
  const rates=shock.ratesBps??[];
  const sumBps=sumPostings(rates);
  const rateDebit=notional.times(sumBps).div(10000);
  const fixed=dec(qty).isZero()?dec('0'):dec(shock.fixedFunding??'0');
  return {periods:rates.length,sumBps,peakMark:out(peak),peakNotional:out(notional),
    rateDebit:out(rateDebit),fixedDebit:out(fixed),charged:out(fixed.gt(rateDebit)?fixed:rateDebit)};
}

export function exitLiquidity(ctx,row,end,removedLevels=1,shock={}) {
  const pair=row.paths?.[end], market=ctx.market;
  if (!pair || !market.pf.bids || !row.lines) return null;
  const sides=['pf','hl'], books={}, removed={}, fills={}, empty={}, costs={}, fees={};
  for (const side of sides) {
    const leg=market[side], order=out(dec(row[side]).neg());
    books[side]=exitBook(leg,row[side],removedLevels);
    const original=fillEvidence(order,leg);
    const levels=leg[original.side==='ask'?'asks':'bids'];
    removed[side]=levels ? sumPostings(levels.slice(0,levels.length-books[side][original.side==='ask'?'asks':'bids'].length).map(level=>level[1])) : null;
    fills[side]=fillEvidence(order,books[side]);
    empty[side]=fillEvidence(order,exitBook(leg,row[side],Infinity));
    costs[side]=null; fees[side]=null;
  }
  const report={removed,depth:fills,withdrawn:empty,extraExitCost:costs,exitFees:fees,status:'unknown',pathStatus:'unknown',settlement:null};
  const complete=fill=>['covered','noTrade'].includes(fill.status);
  function recordCoverage(side,shift,atEndpoint) {
    const leg=market[side], order=dec(row[side]).neg();
    const fill=fillEvidence(out(order),books[side],shift);
    fills[side]=fill;
    // A leg that runs out of depth can price its covered part only.
    if (fill.covered!=null && dec(fill.covered).gt(0)) {
      const part=complete(fill) ? fill : fillEvidence(out(dec(fill.covered).times(order.cmp(0))),books[side],shift);
      if (part.status==='covered') {
        const fee=out(dec(part.vwap).times(fill.covered).times(leg.multiplier).times(leg.fx).times(leg.rate));
        fill.coveredExecution={atEndpoint,vwap:part.vwap,slippage:part.slippage,fee};
        if (atEndpoint && complete(fill)) fees[side]=fee;
      }
    }
    if (!atEndpoint) { fill.vwap=null; fill.slippage=null; }
    if (atEndpoint && fill.status==='noTrade') fees[side]='0';
  }
  const trigger=end==='fail' ? ctx.checks.failureTrigger : ctx.checks.passTrigger;
  if (trigger!=='mark_equity' && !complete(fills.pf)) {
    for(const side of sides) recordCoverage(side,'0',false);
    report.status=fills.pf.status;
    report.reason='PF 无法全量退出，净结算触线价及最终资金未知';
    return report;
  }

  // At a net-equity boundary the PF closing VWAP (and hence closing fee)
  // must still hit the rule. Moving the closing book changes its required mark.
  const pf=pair.pf, hl=pair.hl;
  let pfShift=dec(row.lines[end]);
  if (trigger!=='mark_equity') {
    const oldVwap=dec(pf.exitPrice).minus(dec(pf.exitMark).minus(pf.mark));
    pfShift=pfShift.plus(oldVwap.minus(fills.pf.vwap).div(market.pf.factor));
  }
  if (pfShift.cmp(0)!==(end==='pass' ? row.sign : -row.sign)) {
    report.status='fail'; report.pathStatus='fail';
    report.reason='撤档后 PF 边界已越过起始价';
    return report;
  }
  const unit=dec(market.pf.multiplier).times(market.pf.fx);
  const slope=dec(row.pf).minus(trigger==='mark_equity'?'0':dec(row.pf).abs().times(market.pf.rate)).times(unit);
  const line=end==='fail'?(ctx.book.stage==='funded'?ctx.book.fundedFloor:ctx.book.challengeFloor):(ctx.book.stage==='challenge'?ctx.book.challengeTarget:ctx.params.target);
  const markedStart=dec(pf.start).plus(pf.entryFill).minus(pf.entryFee);
  const nativeFill=fills.pf.vwap;
  const intercept=trigger==='mark_equity'?markedStart:markedStart.plus(dec(row.pf).times(unit).times(dec(nativeFill).minus(market.pf.mark)))
    .minus(dec(row.pf).abs().times(unit).times(nativeFill).times(market.pf.rate)).minus(pf.friction);
  report.derivation={line,trigger:trigger??'net_settlement',slope:out(slope),intercept:out(intercept)};
  report.mathMarks={start:market.pf.mark,trigger:out(dec(market.pf.mark).plus(pfShift.times(market.pf.factor)))};
  const independent=shock.venue ? venuePath(shock.venue,market,out(dec(market.pf.mark).plus(pfShift.times(market.pf.factor))),
    ctx.checks.basisRate,shock.bps,row.hl) : null;
  if (independent?.error) {report.reason=independent.error;return report;}
  report.venue=independent;
  if(ctx.checks.exam) {
    const delayed=shock.venue==='vestFirst' || shock.venue==='hypeFirst';
    const envelope=delayed && Number(ctx.checks.exitDelaySeconds)>0?
      examEnvelope(ctx.params.horizon,ctx.params.deadline,ctx.checks.now,ctx.checks.exitDelaySeconds):ctx.checks.exam;
    report.exam=examMove(envelope,market.pf.mark,independent?.pfEnd??report.mathMarks.trigger);
    if(report.exam.status==='fail' || report.exam.status==='unknown' && !ctx.checks.exam.deriveMoves) {
      report.pathStatus=report.status=report.exam.status;
      report.reason=report.exam.status==='fail'?'所需价格变化超出考核窗口上限':'未填写该方向的考核波动情景';
      return report;
    }
  }
  const offset=independent ? dec(independent.hlEnd).minus(market.hl.mark).minus(pfShift.times(market.hl.factor)) : dec(shock.offset ?? '0');
  const hlShift=pfShift.plus(offset.div(market.hl.factor));
  const shifts={pf:independent?out(dec(independent.pfEnd).minus(market.pf.mark).div(market.pf.factor)):out(pfShift),hl:out(hlShift)};
  for (const side of sides) {
    const leg=market[side], displacement=out(dec(shifts[side]).times(leg.factor));
    recordCoverage(side,displacement,true);
    if (dec(leg.mark).plus(displacement).lte(0)) {
      report.status='fail'; report.pathStatus='fail'; report.reason='移动后的退出价格越界';
      return report;
    }
    if (fills[side].status==='covered') {
      const order=dec(row[side]).neg();
      const ordinary=fillEvidence(out(order),leg,displacement);
      if (ordinary.status==='covered') costs[side]=out(dec(fills[side].vwap).minus(ordinary.vwap)
        .times(order).times(leg.multiplier).times(leg.fx));
    }
  }
  if (!sides.every(side=>complete(fills[side]))) {
    report.status=sides.some(side=>fills[side].status==='insufficient')?'insufficient':'unknown';
    report.reason='可见盘口未能覆盖双边退出';
    return report;
  }
  const before=shock.delayed ? row.pathAudit?.[end]?.beforeFill : null;
  if (shock.delayed && !dec(row.hl).minus(hl.adjustment).isZero() &&
      (!before || !market.hl.configuredLeverage)) {
    report.reason=!before?'延迟成交前的已有仓位缺少同帧清算路径':'延迟前原仓的实际杠杆及保证金占用未核实';
    return report;
  }
  const funding=shock.funding ? fundingOnPath(market.hl,row.hl,shock,offset,
    dec(market.hl.mark).plus(hlShift.times(market.hl.factor))) : null;
  const debit=sumPostings([shock.debit??'0',funding?.charged??'0']);
  report.funding=funding;
  report.before=before ?? null;
  report.debit=debit;
  if (row.verification?.initial!=='pass') {
    report.status=row.verification?.initial??'unknown';
    report.reason='初始保证金准入未通过，无法建立目标仓位';
    return report;
  }
  const model={...market,hl:{...market.hl,leverage:String(row.lev ?? market.hl.leverage)}};
  const interim=out((independent?dec(independent.hlInterim).minus(model.hl.mark):offset).div(market.hl.factor));
  if (dec(model.hl.mark).plus(dec(interim).times(market.hl.factor)).lte(0)) {
    report.status='fail'; report.pathStatus='fail'; report.reason='不利错位导致中间标记价越界';
    return report;
  }
  // The original exposure owns the delay prefix; the new position begins at
  // its own arrival mark. Check the entire return/catch-up segment as well.
  const pathMarks=['0',interim,shifts.hl];
  if (shock.arrivalMark!=null) pathMarks.unshift(out(dec(shock.arrivalMark).minus(market.hl.mark).div(market.hl.factor)));
  const walk=validateMargin(ctx.book,model,'hl',row.hl,pathMarks,ctx.checks.catalog,debit,{openFree:row.free}).at(-1);
  const pfPath=independent?['0',out(dec(independent.pfInterim).minus(market.pf.mark).div(market.pf.factor)),shifts.pf]:['0',shifts.pf];
  const pfWalk=validateMargin(ctx.book,model,'pf',row.pf,pfPath,ctx.checks.catalog,'0',{}).at(-1);
  report.path=walk;
  report.pfPath=pfWalk;
  if (walk.status!=='pass' || pfWalk.status!=='pass' ||
      !walk.proof?.continuous || !pfWalk.proof?.continuous || (before && (before.status!=='pass' || !before.proof?.continuous))) {
    report.status=[walk.status,pfWalk.status,row.verification.initial,before?.status].includes('fail')?'fail':'unknown';
    report.pathStatus=report.status;
    report.reason='退出前的保证金或路径未通过核验';
    return report;
  }
  if(ctx.checks.examEquityFloor!=null && pfWalk.checkpoints.some(point=>dec(point.equity).lte(ctx.checks.examEquityFloor))) {
    report.pathStatus=report.status='fail';report.reason='途中触及额外考核最低标记权益线';return report;
  }
  report.pathStatus='pass';
  const cushion=dec(ctx.checks.minMaintenanceSurplus ?? '0');
  const reserveMark=dec(ctx.checks.minPriceBuffer ?? '0');
  if (!dec(row.hl).isZero() || before) {
    const marginFloor=dec(walk.worst.surplus).gte(cushion) && (!before || dec(before.worst.surplus).gte(cushion));
    const guarded=out(dec(shifts.hl).minus(reserveMark.times(dec(row.hl).cmp(0)).div(model.hl.factor)));
    const guardPrice=dec(model.hl.mark).plus(dec(guarded).times(model.hl.factor));
    const guard=end!=='pass' || reserveMark.isZero() || dec(row.hl).isZero() ||
      (guardPrice.gt(0) && validateMargin(ctx.book,model,'hl',row.hl,[shifts.hl,guarded],
        ctx.checks.catalog,debit,{openFree:row.free}).at(-1).status==='pass');
    if (!marginFloor || !guard) {
      report.riskIssue=marginFloor?'成功端最低强平距离不足':'路径最低维持余量不足';
    }
  }
  const pfEnd=reprice(market.pf,books.pf,pf,shifts.pf,'0');
  const hlEnd=reprice(market.hl,books.hl,hl,shifts.hl,debit);
  const personal=sumPostings([hlEnd.settled,ctx.book.external]);
  const covered=end==='pass' ? dec(hlEnd.settled).gte(ctx.params.R) :
    dec(personal).gte(dec(ctx.book.B).plus(ctx.params.recoveryBuffer ?? '0'));
  fees.pf=pfEnd.exitFee; fees.hl=hlEnd.exitFee;
  const b=ctx.book, params=ctx.params;
  const payoutIfCredited=end==='pass' && canClaimOnSuccess(b) ? projectedShare(pfEnd.settled,b,params.target,trigger) : '0';
  const roundOK=end!=='pass' || b.stage!=='funded' || b.ref==null ||
    dec(personal).plus(payoutIfCredited).minus(b.ref).minus(b.roundIn).plus(b.roundOut).gte(params.g ?? '0');
  report.status=covered && roundOK && !report.riskIssue ? 'pass' : 'fail';
  report.reason=report.riskIssue ?? (!roundOK?'出金后周期收益不足':covered ? null : '退出后未达该路径资金门槛');
  report.settlement={pfFees:sumPostings([pfEnd.entryFee,pfEnd.exitFee]),hlFees:sumPostings([hlEnd.entryFee,hlEnd.exitFee]),pfMark:pfEnd.exitMark,pfPrice:pfEnd.exitPrice,pfEquity:pfEnd.settled,
    hlMark:hlEnd.exitMark,hlPrice:hlEnd.exitPrice,hype:hlEnd.settled,personal,payoutIfCredited};
  return report;
}
