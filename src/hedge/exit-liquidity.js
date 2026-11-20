import { dec, out, fillEvidence } from './math.js';
import { settlementBridge, sumPostings } from './settlement-ledger.js';
import { executionDetail, validateMargin } from './solver.js';

// Re-use only the observed levels. Nothing is extrapolated past their sizes.
// An empty or partially covered exit cannot produce a terminal cash amount.
function exitBook(leg, target, withdrawAll) {
  const side = dec(target).gt(0) ? 'bids' : 'asks';
  return {...leg,[side]:withdrawAll ? [] : leg[side]?.slice(1)};
}

function reprice(leg, book, entry, shift, extraDebit) {
  const exit = executionDetail(book,out(dec(entry.target).neg()),shift);
  return settlementBridge(entry.start,leg,entry.target,entry.adjustment,shift,
    {price:entry.entryPrice,fee:entry.entryFee,impact:entry.entrySlippage},exit,
    sumPostings([entry.friction,extraDebit]),book);
}

export function exitLiquidity(ctx,row,end) {
  const pair=row.paths?.[end], market=ctx.market;
  if (!pair || !market.pf.bids || !row.lines) return null;
  const sides=['pf','hl'], books={}, removed={}, fills={}, empty={}, costs={};
  for (const side of sides) {
    const leg=market[side], order=out(dec(row[side]).neg());
    books[side]=exitBook(leg,row[side],false);
    const original=fillEvidence(order,leg);
    removed[side]=original.topSize;
    fills[side]=fillEvidence(order,books[side]);
    empty[side]=fillEvidence(order,exitBook(leg,row[side],true));
    costs[side]=null;
  }
  const report={removed,depth:fills,withdrawn:empty,extraExitCost:costs,status:'unknown',settlement:null};
  if (Object.values(fills).some(f=>!['covered','noTrade'].includes(f.status))) {
    report.status=Object.values(fills).some(f=>f.status==='insufficient') ? 'insufficient' : 'unknown';
    // If the PF trigger cannot be mapped, the top levels still establish
    // quantity coverage, but the observed book cannot price a future exit.
    for (const fill of Object.values(fills)) {
      fill.vwap=null;
      fill.slippage=null;
    }
    return report;
  }

  // At a net-equity boundary the PF closing VWAP (and hence closing fee)
  // must still hit the rule. Moving the closing book changes its required mark.
  const pf=pair.pf, hl=pair.hl;
  let pfShift=dec(row.lines[end]);
  const trigger=end==='fail' ? ctx.checks.failureTrigger : ctx.checks.passTrigger;
  if (trigger!=='mark_equity') {
    const oldVwap=dec(pf.exitPrice).minus(dec(pf.exitMark).minus(pf.mark));
    pfShift=pfShift.plus(oldVwap.minus(fills.pf.vwap).div(market.pf.factor));
  }
  if (pfShift.cmp(0)!==(end==='pass' ? row.sign : -row.sign)) {
    report.reason='撤档后 PF 边界已越过起始价';
    return report;
  }
  const afterLag=row.pathAudit?.[end]?.asyncExit;
  const offset=dec(afterLag?.nativeOffset ?? row.stress?.priceShock ?? '0');
  const hlShift=pfShift.plus(offset.div(market.hl.factor));
  const shifts={pf:out(pfShift),hl:out(hlShift)};
  for (const side of sides) {
    const leg=market[side], displacement=out(dec(shifts[side]).times(leg.factor));
    fills[side]=fillEvidence(out(dec(row[side]).neg()),books[side],displacement);
    if (!['covered','noTrade'].includes(fills[side].status) || dec(leg.mark).plus(displacement).lte(0)) {
      report.reason='移动后的退出价格无法核实';
      return report;
    }
    if (fills[side].status==='covered') {
      const order=dec(row[side]).neg();
      const ordinary=fillEvidence(out(order),leg,displacement);
      if (ordinary.status==='covered') costs[side]=out(dec(fills[side].vwap).minus(ordinary.vwap)
        .times(order).times(leg.multiplier).times(leg.fx));
    }
  }
  const debit=sumPostings([row.stress?.delayDebit ?? '0',row.stress?.fundingDebit ?? '0']);
  const model={...market,hl:{...market.hl,leverage:String(row.lev ?? market.hl.leverage)}};
  const interim=out(offset.div(market.hl.factor));
  const walk=validateMargin(ctx.book,model,'hl',row.hl,['0',interim,shifts.hl],ctx.checks.catalog,debit,{openFree:row.free}).at(-1);
  const pfWalk=validateMargin(ctx.book,model,'pf',row.pf,['0',shifts.pf],ctx.checks.catalog,'0',{}).at(-1);
  report.path=walk;
  if (row.verification.initial!=='pass' || walk.status!=='pass' || pfWalk.status!=='pass' ||
      !walk.proof?.continuous || !pfWalk.proof?.continuous || (row.pathAudit?.[end]?.beforeFill && row.pathAudit[end].beforeFill.status!=='pass')) {
    report.status=[walk.status,pfWalk.status,row.verification.initial,row.pathAudit?.[end]?.beforeFill?.status].includes('fail')?'fail':'unknown';
    report.reason='退出前的保证金或路径未通过核验';
    return report;
  }
  const pfEnd=reprice(market.pf,books.pf,pf,shifts.pf,'0');
  const hlEnd=reprice(market.hl,books.hl,hl,shifts.hl,debit);
  const personal=sumPostings([hlEnd.settled,ctx.book.external]);
  const covered=end==='pass' ? dec(hlEnd.settled).gte(ctx.params.R) :
    dec(personal).gte(dec(ctx.book.B).plus(ctx.params.recoveryBuffer ?? '0'));
  report.status=covered ? 'pass' : 'fail';
  report.reason=covered ? null : '撤档后未达该路径资金门槛';
  report.settlement={pfMark:pfEnd.exitMark,pfPrice:pfEnd.exitPrice,pfEquity:pfEnd.settled,
    hlMark:hlEnd.exitMark,hlPrice:hlEnd.exitPrice,hype:hlEnd.settled,personal};
  return report;
}
