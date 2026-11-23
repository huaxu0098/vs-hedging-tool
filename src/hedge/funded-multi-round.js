// Vest Live Funded multi-round profit claiming state machine & personal wealth ledger.
// Strictly enforces:
// 1. Fixed Funded drawdown floor L = S - D (NEVER moves with profit or claims); dynamic room = E_PF,t - L.
// 2. Unsettled/pending claims NEVER count as available Hype margin.
// 3. Transferring settled claim into Hype moves wealth between personal accounts (ZERO double-counting).
// 4. Every round re-solves PF/Hype size, ratio, legal leverage & claimable profit dynamically from live books.
// 5. Every round includes an explicit Funded stop-loss termination branch (account ends, prior claims retained).
import { dec, out, min, max, nonnegative, profitSplit } from './math.js';
import { unit } from './ratio-domain.js';
import { depthLimits } from './liquidity-search.js';
import { inspectRatio } from './ratio-scan.js';
import { solveFundedWBounds } from './loss-limits.js';

export const FUNDED_CLASSIFICATIONS = {
  single_round_dual_profit: { code: 'single_round_dual_profit', label: '一次领取双端盈利', tone: 'ok' },
  multi_round_profit_after_recovery: { code: 'multi_round_profit_after_recovery', label: '回本后继续盈利可行', tone: 'ok' },
  multi_round_recovery_feasible: { code: 'multi_round_recovery_feasible', label: '多轮累计回本可行', tone: 'ok' },
  openable_not_profitable: { code: 'openable_not_profitable', label: '可开仓但不满足盈利目标', tone: 'warn' },
  path_risk_failed: { code: 'path_risk_failed', label: '路径风险不通过', tone: 'bad' },
  no_legal_position: { code: 'no_legal_position', label: '无合法仓位', tone: 'bad' },
  unconfirmed_conditions: { code: 'unconfirmed_conditions', label: '条件未确认', tone: 'warn' }
};

// ===== Personal Wealth Ledger & R16.2 Six-Stage Round Lifecycle (Stages A - F) =====
// Stage A: OPEN_HOLDING (both sides open, margin & liquidation monitored along path, no advance credit)
// Stage B: TARGET_TRIGGERED_CLOSING -> BOTH_FLAT_CONFIRMED (close both sides, verify pfOpenQty=0 & hypeOpenQty=0)
// Stage C: ROUND_SETTLED (Hype_PostClose = H_k + dH_k, all fees & close slippage deducted once)
// Stage D: CLAIM_SUBMITTED_WAITING (requires bothFlatConfirmed===true; position=0, maintenance=0, liqRisk=false)
// Stage E: PAYOUT_RECEIVED_AND_TRANSFERRED (requested vs actual received recorded; transfer fee T_k deducted)
// Stage F: NEXT_ROUND_RE_SOLVED (only after Stage E; re-solves next round from H_{k+1}, A_{k+1}, C_{k+1})

export function createPersonalLedger({
  totalInvested,
  hypeEquity,
  vestMainCash = '0',
  externalCash = '0',
  pendingClaim = '0',
  settledClaims = '0',
  pfOpenQty = '0',
  hypeOpenQty = '0',
  bothFlatConfirmed = null,
  roundPhase = 'IDLE_FLAT'
}) {
  const pfQ = dec(pfOpenQty ?? '0');
  const hlQ = dec(hypeOpenQty ?? '0');
  const isFlat = bothFlatConfirmed != null ? Boolean(bothFlatConfirmed && pfQ.isZero() && hlQ.isZero()) : (pfQ.isZero() && hlQ.isZero());
  return {
    totalInvested: out(nonnegative(totalInvested)),
    hypeEquity: out(dec(hypeEquity)),
    vestMainCash: out(nonnegative(vestMainCash)),
    externalCash: out(nonnegative(externalCash)),
    pendingClaim: out(nonnegative(pendingClaim)),
    settledClaims: out(nonnegative(settledClaims)),
    pfOpenQty: out(pfQ),
    hypeOpenQty: out(hlQ),
    bothFlatConfirmed: isFlat,
    roundPhase: isFlat ? roundPhase : 'STAGE_A_OPEN_HOLDING',
    holdingRiskActive: !isFlat,
    maintenanceMarginOccupied: isFlat ? '0' : null,
    liquidationRiskActive: !isFlat,
    canStartNextRound: isFlat && dec(pendingClaim ?? '0').isZero(),
    events: []
  };
}

// Stage A: Open round positions on PF and Hype
export function openRoundPositions(ledger, { roundIndex, pfQty, hypeQty, hypeMaintenanceMargin = '0', hypeLiquidationPrice = null }) {
  const pfQ = dec(pfQty);
  const hlQ = dec(hypeQty);
  return {
    ...ledger,
    pfOpenQty: out(pfQ),
    hypeOpenQty: out(hlQ),
    bothFlatConfirmed: pfQ.isZero() && hlQ.isZero(),
    roundPhase: 'STAGE_A_OPEN_HOLDING',
    holdingRiskActive: true,
    maintenanceMarginOccupied: out(nonnegative(hypeMaintenanceMargin)),
    liquidationRiskActive: true,
    liquidationPrice: hypeLiquidationPrice,
    canStartNextRound: false,
    events: [
      ...ledger.events,
      { type: 'stage_a_opened', roundIndex, pfQty: out(pfQ), hypeQty: out(hlQ) }
    ]
  };
}

// Stage B & C: Close both sides, verify flat (0 / 0), and settle realized PnL (Hype_PostClose = H_k + dH_k)
export function closeAndSettleRoundPositions(ledger, {
  roundIndex,
  pfRealizedNetPnL = '0',
  hypeRealizedNetPnL = '0',
  pfQtyAfterClose = '0',
  hypeQtyAfterClose = '0',
  pfEntryAvgPrice = null,
  pfExitAvgPrice = null,
  hypeEntryAvgPrice = null,
  hypeExitAvgPrice = null,
  pfOpenFee = '0',
  pfCloseFee = '0',
  hypeOpenFee = '0',
  hypeCloseFee = '0',
  incurredFundingFee = '0',
  pfCloseSlippage = '0',
  hypeCloseSlippage = '0',
  asyncCloseDebit = '0',
  pfCloseAt = null,
  hypeCloseAt = null
}) {
  const pfRem = dec(pfQtyAfterClose ?? '0');
  const hlRem = dec(hypeQtyAfterClose ?? '0');
  const isFlat = pfRem.isZero() && hlRem.isZero();
  const dH = dec(hypeRealizedNetPnL);
  const hypePostClose = isFlat ? dec(ledger.hypeEquity).plus(dH) : dec(ledger.hypeEquity);
  return {
    ...ledger,
    hypeEquity: out(hypePostClose),
    pfOpenQty: out(pfRem),
    hypeOpenQty: out(hlRem),
    bothFlatConfirmed: isFlat,
    roundPhase: isFlat ? 'STAGE_C_SETTLED_FLAT' : 'STAGE_B_CLOSING_PARTIAL',
    // R16.2 Section 2E & 4 & 6: Once both sides are closed flat, holding/liquidation risk ends and maintenance margin is 0!
    holdingRiskActive: !isFlat,
    maintenanceMarginOccupied: isFlat ? '0' : ledger.maintenanceMarginOccupied,
    liquidationRiskActive: !isFlat,
    liquidationPrice: isFlat ? null : ledger.liquidationPrice,
    unrealizedPnL: isFlat ? '0' : null,
    canStartNextRound: false,
    lastSettlement: {
      roundIndex,
      pfRealizedNetPnL: out(dec(pfRealizedNetPnL)),
      hypeRealizedNetPnL: out(dH),
      hypePostClose: out(hypePostClose),
      pfQtyAfterClose: out(pfRem),
      hypeQtyAfterClose: out(hlRem),
      bothFlatConfirmed: isFlat,
      pfEntryAvgPrice,
      pfExitAvgPrice,
      hypeEntryAvgPrice,
      hypeExitAvgPrice,
      pfOpenFee: out(nonnegative(pfOpenFee)),
      pfCloseFee: out(nonnegative(pfCloseFee)),
      hypeOpenFee: out(nonnegative(hypeOpenFee)),
      hypeCloseFee: out(nonnegative(hypeCloseFee)),
      incurredFundingFee: out(dec(incurredFundingFee)),
      pfCloseSlippage: out(dec(pfCloseSlippage)),
      hypeCloseSlippage: out(dec(hypeCloseSlippage)),
      asyncCloseDebit: out(nonnegative(asyncCloseDebit)),
      pfCloseAt,
      hypeCloseAt
    },
    events: [
      ...ledger.events,
      {
        type: isFlat ? 'stage_c_settled_flat' : 'stage_b_partial_close',
        roundIndex,
        pfQtyAfterClose: out(pfRem),
        hypeQtyAfterClose: out(hlRem),
        bothFlatConfirmed: isFlat,
        hypePostClose: out(hypePostClose)
      }
    ]
  };
}

// Stage D: Submit profit claim request.
// R16.2 Gate: Strictly forbidden to enter withdrawal-waiting or submit claim before BOTH sides are confirmed flat (0 / 0)!
export function submitClaim(ledger, { roundIndex, gross, netExpected, requestedAt = null }) {
  const pfQ = dec(ledger.pfOpenQty ?? '0');
  const hlQ = dec(ledger.hypeOpenQty ?? '0');
  if (!pfQ.isZero() || !hlQ.isZero() || ledger.bothFlatConfirmed === false) {
    throw Error('R16.2 门控拦截：Vest 与 Hyperliquid 双方尚未全部平仓确认归零（当前 PF=' + out(pfQ) + ', Hype=' + out(hlQ) + '），禁止进入提现等待或提交利润领取申请');
  }
  const grossDec = nonnegative(gross);
  const net = nonnegative(netExpected);
  return {
    ...ledger,
    pendingClaim: out(dec(ledger.pendingClaim).plus(net)),
    pfOpenQty: '0',
    hypeOpenQty: '0',
    bothFlatConfirmed: true,
    roundPhase: 'STAGE_D_CLAIM_WAITING',
    holdingRiskActive: false,
    maintenanceMarginOccupied: '0',
    liquidationRiskActive: false,
    liquidationPrice: null,
    unrealizedPnL: '0',
    canStartNextRound: false,
    lastClaimRequest: {
      roundIndex,
      requestedGrossW: out(grossDec),
      requestedPersonalShare: out(net),
      actualReceivedPayout: null,
      status: 'pending_waiting',
      requestedAt,
      pfPositionDuringWait: '0',
      hypePositionDuringWait: '0',
      maintenanceMarginDuringWait: '0',
      liquidationRiskDuringWait: false,
      hypeAvailableMarginDuringWait: ledger.hypeEquity
    },
    events: [
      ...ledger.events,
      {
        type: 'claim_submitted',
        roundIndex,
        claimGross: out(grossDec),
        claimNetPending: out(net),
        status: 'pending',
        pfOpenQty: '0',
        hypeOpenQty: '0',
        hypeAvailableMargin: ledger.hypeEquity
      }
    ]
  };
}

// Stage E (Part 1): Claim settles to user's Vest main account or external wallet (still NOT in Hype until transferred!).
export function settleClaim(ledger, {
  roundIndex,
  actualNetReceived,
  pendingReleased = actualNetReceived,
  destination = 'external_wallet',
  vestProcessedAt = null,
  receivedAt = null
}) {
  if (!dec(ledger.pfOpenQty ?? '0').isZero() || !dec(ledger.hypeOpenQty ?? '0').isZero() || ledger.bothFlatConfirmed === false) {
    throw Error('R16.2 门控拦截：双方未确认空仓，禁止结算领取资金');
  }
  const received = nonnegative(actualNetReceived);
  const released = nonnegative(pendingReleased);
  const toVestMain = destination === 'vest_main';
  return {
    ...ledger,
    pendingClaim: out(max(dec('0'), dec(ledger.pendingClaim).minus(released))),
    vestMainCash: toVestMain ? out(dec(ledger.vestMainCash ?? '0').plus(received)) : (ledger.vestMainCash ?? '0'),
    externalCash: toVestMain ? ledger.externalCash : out(dec(ledger.externalCash).plus(received)),
    settledClaims: out(dec(ledger.settledClaims).plus(received)),
    roundPhase: 'STAGE_E_PAYOUT_RECEIVED',
    canStartNextRound: !toVestMain && destination === 'external_wallet',
    lastClaimRequest: ledger.lastClaimRequest
      ? {
          ...ledger.lastClaimRequest,
          actualReceivedPayout: out(received),
          destination,
          vestProcessedAt,
          receivedAt,
          status: toVestMain ? 'vest_main_received' : 'external_received'
        }
      : null,
    events: [
      ...ledger.events,
      { type: 'claim_settled', roundIndex, claimNetReceived: out(received), destination, status: 'settled' }
    ]
  };
}

// Stage E (Part 2): Transfer already-settled personal cash into Hype, deducting transfer fee T_k once:
//   H_{k+1} = H_k + dH_k + P_k - T_k
//   A_{k+1} = A_k + dH_k + P_k - T_k
export function transferExternalToHype(ledger, { roundIndex, amount, transferFee = '0', source = 'external_wallet', transferredAt = null }) {
  const amt = nonnegative(amount);
  const tFee = nonnegative(transferFee);
  if (tFee.gt(amt)) throw Error('转账费用不能超过转入金额');
  const fromVest = source === 'vest_main';
  const avail = dec(fromVest ? (ledger.vestMainCash ?? '0') : ledger.externalCash);
  if (amt.gt(avail)) throw Error('转入 Hype 金额超过已到账个人可用现金（禁止预支待处理分成）');
  const netToHype = amt.minus(tFee);
  return {
    ...ledger,
    vestMainCash: fromVest ? out(avail.minus(amt)) : (ledger.vestMainCash ?? '0'),
    externalCash: fromVest ? ledger.externalCash : out(avail.minus(amt)),
    hypeEquity: out(dec(ledger.hypeEquity).plus(netToHype)),
    roundPhase: 'STAGE_F_READY_FOR_NEXT_ROUND',
    canStartNextRound: true,
    lastClaimRequest: ledger.lastClaimRequest
      ? {
          ...ledger.lastClaimRequest,
          transferredToHypeAmount: out(netToHype),
          transferFee: out(tFee),
          transferredAt,
          status: 'transferred_to_hype'
        }
      : null,
    events: [
      ...ledger.events,
      { type: 'transfer_to_hype', roundIndex, grossTransfer: out(amt), transferFee: out(tFee), amount: out(netToHype) }
    ]
  };
}

// Additional external personal deposit increases BOTH personal equity AND totalInvested (never fake profit!).
export function recordExternalDeposit(ledger, { roundIndex = 0, amount, destination = 'hype' }) {
  const amt = nonnegative(amount);
  return {
    ...ledger,
    totalInvested: out(dec(ledger.totalInvested).plus(amt)),
    hypeEquity: destination === 'hype' ? out(dec(ledger.hypeEquity).plus(amt)) : ledger.hypeEquity,
    externalCash: destination === 'hype' ? ledger.externalCash : out(dec(ledger.externalCash).plus(amt)),
    events: [
      ...ledger.events,
      { type: 'external_deposit', roundIndex, amount: out(amt), destination }
    ]
  };
}

// Unified personal wealth accounting (excludes Funded virtual capital & unsettled pending claims!)
export function summarizeLedger(ledger) {
  const hype = dec(ledger.hypeEquity);
  const vestMain = dec(ledger.vestMainCash ?? '0');
  const ext = dec(ledger.externalCash);
  const totalAsset = hype.plus(vestMain).plus(ext);
  const invested = dec(ledger.totalInvested);
  const cumNet = totalAsset.minus(invested);
  const unrecovered = max(dec('0'), invested.minus(totalAsset));
  const recoveredPrincipal = min(invested, max(dec('0'), totalAsset));
  return {
    hypeEquity: out(hype),
    vestMainCash: out(vestMain),
    externalCash: out(ext),
    pendingClaim: ledger.pendingClaim,
    settledClaims: ledger.settledClaims,
    pfOpenQty: ledger.pfOpenQty ?? '0',
    hypeOpenQty: ledger.hypeOpenQty ?? '0',
    bothFlatConfirmed: ledger.bothFlatConfirmed !== false,
    roundPhase: ledger.roundPhase ?? 'IDLE_FLAT',
    personalTotalAsset: out(totalAsset),
    totalInvested: out(invested),
    recoveredPrincipal: out(recoveredPrincipal),
    unrecoveredCost: out(unrecovered),
    cumulativeNetPnL: out(cumNet),
    recovered: totalAsset.gte(invested),
    strictProfit: cumNet.gt(0)
  };
}

// Compute dynamic remaining loss room against FIXED floor L (L never moves!)
export function computeRemainingLossRoom(pfEquityRaw, pfFixedFloorRaw) {
  const eq = dec(pfEquityRaw);
  const fl = dec(pfFixedFloorRaw);
  return out(eq.minus(fl));
}

// R16.2 Section 2 & 3: Exact per-round Stage A -> F lifecycle & personal capital accounting:
//   Hype_PostClose = H_k + dH_k
//   P_k = W_k * s - extraCost
//   A_{k+1} = A_k + dH_k + P_k - T_k
//   C_{k+1} = max(0, B - A_{k+1})
//   H_{k+1} = H_k + dH_k + P_k - T_k (if transferred to Hype) or H_k + dH_k (if kept in Vest main / external wallet)
export function evaluateRoundAccounting({
  roundIndex = 1,
  totalInvested,
  hypeStart,
  vestMainCash = '0',
  externalCash = '0',
  priorSettledClaims = '0',
  claimGrossW,
  share,
  extraCost = '0',
  transferFee = '0',
  hypeSuccessPnL,
  hypeStopPnL,
  pfFixedFloor = '0',
  pfOpenQty = '0',
  hypeOpenQty = '0',
  pfQtyAfterClose = '0',
  hypeQtyAfterClose = '0',
  payoutDestination = null,
  reinvestToHype = true
}) {
  const invested = dec(totalInvested);
  const hl0 = dec(hypeStart);
  const vm0 = dec(vestMainCash);
  const ext0 = dec(externalCash);
  const startAsset = hl0.plus(vm0).plus(ext0);
  const wDec = nonnegative(claimGrossW);
  const sDec = nonnegative(share);
  const extraDec = nonnegative(extraCost);
  const tFeeDec = nonnegative(transferFee);
  const userPayout = wDec.times(sDec).minus(extraDec);
  const succPnL = dec(hypeSuccessPnL);
  const hypeAfterClose = hl0.plus(succPnL);
  const roundNetGain = succPnL.plus(userPayout).minus(tFeeDec);
  const dest = payoutDestination ?? (reinvestToHype ? 'hype' : 'external_wallet');

  // Stage A -> Stage B/C (Open -> Close & confirm both sides flat 0 / 0)
  let ledger = createPersonalLedger({
    totalInvested: out(invested),
    hypeEquity: out(hl0),
    vestMainCash: out(vm0),
    externalCash: out(ext0),
    settledClaims: priorSettledClaims
  });
  if (!dec(pfOpenQty).isZero() || !dec(hypeOpenQty).isZero()) {
    ledger = openRoundPositions(ledger, { roundIndex, pfQty: pfOpenQty, hypeQty: hypeOpenQty });
  }
  const closedLedger = closeAndSettleRoundPositions(ledger, {
    roundIndex,
    pfRealizedNetPnL: out(wDec),
    hypeRealizedNetPnL: out(succPnL),
    pfQtyAfterClose,
    hypeQtyAfterClose
  });

  // Stage D: Submit claim (throws if pfQtyAfterClose !== 0 or hypeQtyAfterClose !== 0!)
  const pendingState = submitClaim(closedLedger, {
    roundIndex,
    gross: out(wDec),
    netExpected: out(userPayout)
  });

  // Stage E: Settle claim to Vest main or external wallet, then optionally transfer to Hype deducting T_k
  const settleDest = dest === 'vest_main' ? 'vest_main' : 'external_wallet';
  const settledState = settleClaim(pendingState, {
    roundIndex,
    actualNetReceived: out(userPayout),
    destination: settleDest
  });
  let finalLedger = settledState;
  let reinvestedAmount = dec('0');
  if (dest === 'hype' && userPayout.gt(0)) {
    finalLedger = transferExternalToHype(settledState, {
      roundIndex,
      amount: out(userPayout),
      transferFee: out(tFeeDec),
      source: settleDest
    });
    reinvestedAmount = userPayout.minus(tFeeDec);
  }
  const endSummary = summarizeLedger(finalLedger);

  const stPnL = dec(hypeStopPnL);
  const stopHypeEnd = hl0.plus(stPnL);
  const stopLedger = createPersonalLedger({
    totalInvested: out(invested),
    hypeEquity: out(stopHypeEnd),
    vestMainCash: out(vm0),
    externalCash: out(ext0),
    settledClaims: priorSettledClaims
  });
  const stopSummary = summarizeLedger(stopLedger);

  return {
    roundIndex,
    startAsset: out(startAsset),
    hypePostClose: out(hypeAfterClose),
    hypeBeforeTransfer: out(hypeAfterClose),
    claimGross: out(wDec),
    requestedGrossW: out(wDec),
    requestedPersonalShare: out(userPayout),
    claimNetReceived: out(userPayout),
    transferFee: out(tFeeDec),
    hypePnL: out(succPnL),
    roundNetGain: out(roundNetGain),
    reinvestedToHype: out(reinvestedAmount),
    pendingClaimAtSubmit: pendingState.pendingClaim,
    waitingPeriodState: {
      pfPositionQty: '0',
      hypePositionQty: '0',
      bothFlatConfirmed: true,
      maintenanceMarginOccupied: '0',
      unrealizedPnL: '0',
      liquidationRiskActive: false,
      liquidationPrice: null,
      hypeAvailableMargin: out(hypeAfterClose),
      nextRoundStarted: false
    },
    endSummary,
    stopOutcome: {
      fundedTerminated: true,
      pfFixedFloor: out(dec(pfFixedFloor)),
      priorSettledClaimsRetained: out(nonnegative(priorSettledClaims)),
      priorExternalCashRetained: out(ext0),
      hypePnL: out(stPnL),
      hypeEquityEnd: stopSummary.hypeEquity,
      personalTotalAsset: stopSummary.personalTotalAsset,
      recoveredPrincipal: stopSummary.recoveredPrincipal,
      gapToBreakeven: stopSummary.unrecoveredCost,
      finalNetPnL: stopSummary.cumulativeNetPnL,
      recovered: stopSummary.recovered,
      strictProfit: stopSummary.strictProfit
    }
  };
}

function summarizeLegCostMini(leg) {
  if (!leg) return null;
  const openFee = leg.entryFee ?? '0';
  const closeFee = leg.closeFee ?? leg.exitFee ?? '0';
  const totalFee = leg.fees ?? out(dec(openFee).plus(closeFee));
  const execTotal = leg.executionCost != null
    ? leg.executionCost
    : out(dec(leg.entryFill ?? '0').plus(leg.exitFill ?? '0').neg());
  return { openFee, closeFee, totalFee, execTotal };
}

// ===== Single Round Dynamic Solver =====
export function solveFundedRound({
  roundIndex,
  pfEquityStart,
  pfFixedFloor,
  baseline,
  resetBaseline,
  hypeEquityStart,
  vestMainCash = '0',
  externalCash = '0',
  priorSettledClaims = '0',
  priorTransferFees = '0',
  transferFee = '0',
  payoutDestination = null,
  totalInvested,
  share,
  withdrawal,
  fundedMarketBase,
  ctx,
  preferredSign = 1,
  userTarget = null,
  claimEquityRule = 'reset_to_baseline',
  reinvestToHype = true,
  seedChoice = null
}) {
  const pfEq = dec(pfEquityStart);
  const fixedFloor = dec(pfFixedFloor);
  const room = pfEq.minus(fixedFloor);
  if (room.lte(0)) {
    return { ok: false, reason: '第 ' + roundIndex + ' 轮 PF 当前权益已无剩余止损空间（' + out(pfEq) + ' ≤ 底线 ' + out(fixedFloor) + '）' };
  }
  const hlStart = dec(hypeEquityStart);
  if (hlStart.lte(0)) {
    return { ok: false, reason: '第 ' + roundIndex + ' 轮 Hype 可用资金不足（' + out(hlStart) + ' U）' };
  }

  const hlMaxLevStr = String(fundedMarketBase.hl.exchangeMaxLeverage ?? fundedMarketBase.hl.leverage);
  const pfLev = fundedMarketBase.pf.leverage;
  const roundMarket = {
    ...fundedMarketBase,
    pf: { ...fundedMarketBase.pf, free: out(pfEq) },
    hl: { ...fundedMarketBase.hl, leverage: hlMaxLevStr, free: out(hlStart) }
  };
  const pfLotNotional = unit(roundMarket.pf).times(roundMarket.pf.step).times(roundMarket.pf.mark);
  const hlLotNotional = unit(roundMarket.hl).times(roundMarket.hl.step).times(roundMarket.hl.mark);
  const minPFLots = Math.max(
    1,
    roundMarket.pf.minQty != null ? dec(roundMarket.pf.minQty).div(roundMarket.pf.step).ceil().toNumber() : 1,
    roundMarket.pf.minNotional != null ? dec(roundMarket.pf.minNotional).div(pfLotNotional).ceil().toNumber() : 1
  );
  const minHLLots = Math.max(
    1,
    roundMarket.hl.minQty != null ? dec(roundMarket.hl.minQty).div(roundMarket.hl.step).ceil().toNumber() : 1,
    roundMarket.hl.minNotional != null ? dec(roundMarket.hl.minNotional).div(hlLotNotional).ceil().toNumber() : 1
  );
  const pfMarginCap = pfEq.times(pfLev).div(pfLotNotional).floor().toNumber();
  const hlMarginCap = hlStart.times(hlMaxLevStr).div(hlLotNotional).floor().toNumber();
  const maxPFGlobal = Math.max(0, Math.min(pfMarginCap, roundMarket.pf.maxQty != null ? dec(roundMarket.pf.maxQty).div(roundMarket.pf.step).floor().toNumber() : Infinity));
  const maxHLGlobal = Math.max(0, Math.min(hlMarginCap, roundMarket.hl.maxQty != null ? dec(roundMarket.hl.maxQty).div(roundMarket.hl.step).floor().toNumber() : Infinity));
  if (maxPFGlobal < minPFLots || maxHLGlobal < minHLLots) {
    return { ok: false, reason: '第 ' + roundIndex + ' 轮 Hype 可用保证金不足以建立最小合法仓位' };
  }

  const invested = dec(totalInvested);
  const vestStart = nonnegative(vestMainCash);
  const extStart = nonnegative(externalCash);
  const currentTotalAsset = hlStart.plus(vestStart).plus(extStart);
  const unrecoveredStart = max(dec('0'), invested.minus(currentTotalAsset));
  const baseDec = dec(baseline);
  const minProfit = dec(withdrawal?.minimum ?? '0');

  // Dynamically generate candidate claimable profits W_i from this round's real loss room, Hype equity & unrecovered cost (ZERO hardcoded amounts!)
  const wCandidateSet = new Map();
  const addW = (wDec) => {
    if (wDec == null || !wDec.gt(0)) return;
    const rounded = wDec.toDecimalPlaces(2);
    if (rounded.lt(minProfit)) return;
    const targetDec = baseDec.plus(rounded);
    if (targetDec.lte(pfEq)) return;
    const key = out(rounded);
    if (!wCandidateSet.has(key)) wCandidateSet.set(key, { w: key, target: out(targetDec) });
  };

  if (userTarget != null && dec(userTarget).gt(pfEq) && dec(userTarget).gt(baseDec)) {
    addW(dec(userTarget).minus(baseDec));
  } else {
    const rb = solveFundedWBounds(out(unrecoveredStart), out(room), out(hlStart), share, withdrawal?.minimum ?? '0');
    if (rb?.feasible && rb.candidates?.length) {
      addW(dec(rb.candidates[0]));
    }
    const sDec = dec(share);
    // Anchor W_k strictly to FIXED Funded loss room D (room) & current Hype cash H_k — NEVER scale W_k blindly to huge H_k!
    // Realistic per-round claim target stays bounded around 0.8x–2.0x of fixed loss room D so PF never needs 7x–12x leverage or 0.5% stop-loss!
    const maxRealisticW = room.times('2.0');
    if (unrecoveredStart.gt(0) && sDec.gt(0)) {
      const hProg = min(
        sDec.times('0.68'),
        max(sDec.times('0.38'), sDec.times(unrecoveredStart).div(sDec.times(room).plus(unrecoveredStart)))
      );
      addW(min(maxRealisticW, max(room.times('0.85'), hlStart.times('0.55').div(hProg))));
      addW(min(maxRealisticW, max(room.times('1.15'), hlStart.times('0.70').div(hProg))));
      addW(min(maxRealisticW, room.times('1.50')));
    } else if (sDec.gt(0)) {
      // Post-recovery steady profit round: anchored to fixed PF loss room D (0.9x–1.4x D), NEVER snowballing with H_k!
      addW(min(maxRealisticW, room.times('1.0')));
      addW(min(maxRealisticW, room.times('1.35')));
    }
  }
  const wCandidates = [...wCandidateSet.values()].slice(0, 3);
  if (!wCandidates.length) {
    return { ok: false, reason: '第 ' + roundIndex + ' 轮无满足最低盈利门槛的目标出金金额' };
  }

  const minPosPF = Math.max(minPFLots, room.times('1.08').div(pfLotNotional).ceil().toNumber());
  // Cap PF size so stop-loss room D is at least ~2.5% price move (prevents 7x–12x PF leverage & 0.5% hair-trigger stop-loss!)
  const maxSafeStopPFLots = Math.max(minPosPF, room.div(pfLotNotional.times('0.025')).floor().toNumber());
  let bestChoice = null;

  for (const wc of wCandidates) {
    const targetStr = wc.target;
    const split = profitSplit(targetStr, baseline, share, withdrawal);
    if (!dec(split.user).gt(0)) continue;
    const gainDec = dec(targetStr).minus(pfEq);
    const roundCtx = {
      book: {
        ...ctx.book,
        stage: 'funded',
        status: 'FUNDED_ACTIVE',
        pf: out(pfEq),
        hl: out(hlStart),
        B: out(invested),
        external: out(extStart),
        fundedFloor: out(fixedFloor),
        baseline,
        share,
        withdrawal,
        challengeDeadlineAt: null,
        positions: {}
      },
      market: roundMarket,
      params: {
        ...ctx.params,
        openingCapacity: true,
        target: targetStr,
        baseReserve: '0',
        baseRecovery: out(invested),
        R: '0',
        recoveryBuffer: '0',
        successBuffer: '0',
        deadline: null,
        deadlineMark: null
      },
      checks: { ...ctx.checks, exam: null, examEquityFloor: null, crossAccount: null, accountVerified: false }
    };

    for (const fSign of [preferredSign, -preferredSign]) {
      const fMaxPF = Math.min(maxPFGlobal, depthLimits(roundMarket.pf, fSign).cap);
      const fMaxHL = Math.min(maxHLGlobal, depthLimits(roundMarket.hl, -fSign).cap);
      if (fMaxPF < minPFLots || fMaxHL < minHLLots) continue;
      const loI = Math.min(fMaxPF, minPosPF);
      const hiSafeI = Math.min(fMaxPF, maxSafeStopPFLots);
      // Target hedge ratio upper bound that keeps claim PnL strictly positive: r < share - fees, and survives pre-payout: r < hlStart / gain
      const rSurv = gainDec.gt(0) ? hlStart.div(gainDec) : dec('0.5');
      const claimNet = dec(split.user);
      const rProfitCap = gainDec.gt(0) ? claimNet.div(gainDec) : dec(share);
      const rCap = min(rSurv, rProfitCap.times('0.98'));
      // Anchor PF position samples to realistic 3.5%–6% moves while respecting the safe stop-loss move ceiling (>= 2.5% stop move!)
      const lotsForMove = (pct) => gainDec.gt(0)
        ? Math.max(loI, Math.min(hiSafeI, gainDec.div(pfLotNotional.times(pct)).ceil().toNumber()))
        : loI;
      const pfSamples = [...new Set([
        lotsForMove('0.04'),
        lotsForMove('0.055'),
        hiSafeI
      ].filter((n) => Number.isSafeInteger(n) && n >= loI && n <= fMaxPF))];

      const probeRoundJ = (i, j) => {
        if (j < minHLLots || j > fMaxHL) return null;
        try {
          const ins = inspectRatio(roundCtx, { sign: fSign, i, j }, { minimizeMargin: false, fastProbe: true });
          return ins?.physical && ins.fail != null && ins.success != null ? ins : null;
        } catch {
          return null;
        }
      };

      for (const i of pfSamples) {
        const pfN = pfLotNotional.times(i);
        // Tighten upper binary search bound to the exact survival & positive-round-gain ceiling at this PF size
        // (Include ~6% maintenance margin & fee reserve in rSurv so hiCap passes on the very first probe!)
        const jCeilBySurv = gainDec.gt(0)
          ? Math.max(minHLLots, pfN.times(min(rSurv.times('0.92'), rProfitCap.times('0.96'))).div(hlLotNotional).floor().toNumber())
          : fMaxHL;
        const hiCap = Math.min(fMaxHL, Math.max(minHLLots, jCeilBySurv));
        let lo = minHLLots, hi = hiCap, maxValidJ = null;
        // Fast check at hiCap first: in ~90% of rounds, hiCap is already margin-safe (1 probe instead of 8!)
        const insAtHi = probeRoundJ(i, hi);
        if (insAtHi) {
          maxValidJ = { j: hi, ins: insAtHi };
        } else {
          hi--;
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const ins = probeRoundJ(i, mid);
            if (ins) {
              maxValidJ = { j: mid, ins };
              lo = mid + 1;
            } else {
              hi = mid - 1;
            }
          }
        }
        if (!maxValidJ) continue;

        // Test balanced hedge intensities within [minHLLots, maxValidJ.j] so rounds make steady progress without extreme 0% naked or 78% +4U creep:
        const idealStopJ = unrecoveredStart.gt(0)
          ? Math.max(minHLLots, Math.min(maxValidJ.j, pfN.times(unrecoveredStart).div(room.times(hlLotNotional)).ceil().toNumber()))
          : Math.max(minHLLots, Math.min(maxValidJ.j, pfN.times('0.35').div(hlLotNotional).round().toNumber()));
        const jAtRatio = (r) => Math.max(minHLLots, Math.min(maxValidJ.j, pfN.times(r).div(hlLotNotional).round().toNumber()));
        const jTestList = [...new Set([
          jAtRatio('0.45'),
          jAtRatio('0.35'),
          jAtRatio('0.55'),
          idealStopJ,
          maxValidJ.j
        ].filter((j) => j >= minHLLots && j <= maxValidJ.j))];

        for (const j of jTestList) {
          const ins = j === maxValidJ.j ? maxValidJ.ins : probeRoundJ(i, j);
          if (!ins) continue;

          const hypeAfterClose = dec(ins.success);
          const hypePnL = hypeAfterClose.minus(hlStart);
          const claimNet = dec(split.user);
          // True net wealth created by this claim round (strictly includes all fees, spread & slippage)
          const roundNetGain = claimNet.plus(hypePnL);
          if (roundNetGain.lte(0)) continue; // Never accept a round that loses wealth!

          const stopHypeEnd = dec(ins.fail);
          const stopTotalAsset = stopHypeEnd.plus(vestStart).plus(extStart);
          const stopFinalNet = stopTotalAsset.minus(invested);

          const claimTotalAsset = hypeAfterClose.plus(vestStart).plus(extStart).plus(claimNet);
          const claimFinalNet = claimTotalAsset.minus(invested);
          const oneShotDual = stopFinalNet.gt(0) && claimFinalNet.gt(0);

          // Real-world executability metrics:
          // 1. Required PF price move (%) to reach this round's claim target
          const exitMarkStr = ins.paths?.pass?.pf?.exitMark;
          const movePctNum = exitMarkStr != null && dec(roundMarket.pf.mark).gt(0)
            ? Math.abs(Number(dec(exitMarkStr).minus(roundMarket.pf.mark).div(roundMarket.pf.mark).times(100)))
            : (pfN.gt(0) ? Number(gainDec.div(pfN).times(100)) : 999);
          // 2. Stop-loss move (%) & symmetry against claim move (%)
          const stopMovePctNum = pfN.gt(0) ? Number(room.div(pfN).times(100)) : 999;
          const symmetryRatio = Math.min(movePctNum, stopMovePctNum) / Math.max(movePctNum, stopMovePctNum, 0.01);
          // 3. Hype post-close residual margin safety cushion (hypeAfterClose / hlStart)
          const postCloseRatioNum = hlStart.gt(0) ? Number(hypeAfterClose.div(hlStart)) : 0;
          // 4. Meaningful progress toward recovery (prevents 6-round +4U/round creep!)
          const minUsefulGain = unrecoveredStart.gt(0)
            ? min(unrecoveredStart.times('0.35'), room.times('0.18'))
            : room.times('0.18');
          const hasUsefulProgress = roundNetGain.gte(minUsefulGain) ? 1 : 0;

          // Tiered practicality: BOTH claim move AND stop-loss move must be realistic (>= 2.0% stop room, <= 8% claim move, >= 25% Hype cushion!)
          const practicalTier =
            movePctNum <= 8 && stopMovePctNum >= 2.0 && postCloseRatioNum >= 0.25
              ? 2
              : movePctNum <= 15 && stopMovePctNum >= 1.2 && postCloseRatioNum >= 0.15
                ? 1
                : 0;

          // Composite utility within the same practicality tier:
          const movePenalty = Math.max(0, movePctNum - 5) * 18 + Math.max(0, 2.5 - stopMovePctNum) * 40;
          const cushionBonus = Math.min(0.6, postCloseRatioNum) * 120;
          const symmetryBonus = symmetryRatio * 55;
          const compositeScore =
            Number(min(stopFinalNet, claimFinalNet)) * 0.45 +
            Number(roundNetGain) * 0.90 +
            cushionBonus +
            symmetryBonus -
            movePenalty;

          const score = {
            practicalTier,
            hasUsefulProgress,
            oneShotDual: oneShotDual ? 1 : 0,
            stopProtected: stopFinalNet.gte(0) ? 1 : 0,
            compositeScore,
            balanced: min(stopFinalNet, claimFinalNet),
            roundNetGain,
            movePctNum,
            stopMovePctNum,
            postCloseRatioNum
          };

          const isBetter =
            !bestChoice
              ? true
              : score.practicalTier !== bestChoice.score.practicalTier
                ? score.practicalTier > bestChoice.score.practicalTier
                : score.oneShotDual !== bestChoice.score.oneShotDual
                  ? score.oneShotDual > bestChoice.score.oneShotDual
                  : score.hasUsefulProgress !== bestChoice.score.hasUsefulProgress
                    ? score.hasUsefulProgress > bestChoice.score.hasUsefulProgress
                    : score.stopProtected !== bestChoice.score.stopProtected
                      ? score.stopProtected > bestChoice.score.stopProtected
                      : Math.abs(score.compositeScore - bestChoice.score.compositeScore) > 1
                        ? score.compositeScore > bestChoice.score.compositeScore
                        : score.roundNetGain.gt(bestChoice.score.roundNetGain);

          if (isBetter) {
            bestChoice = { ins, roundCtx, targetStr, w: wc.w, split, score, fSign, i, j };
          }
        }
      }
      // Once preferred sign yields a practical solution (Tier >= 1), skip opposite sign for speed
      if (bestChoice && bestChoice.score.practicalTier >= 1) break;
    }
    if (bestChoice && bestChoice.score.practicalTier >= 2) break;
  }

  if (!bestChoice) {
    return {
      ok: false,
      reason: '第 ' + roundIndex + ' 轮在真实手续费、滑点与路径防强平约束下，不存在使领取后净资产正增长的合法组合'
    };
  }

  const { roundCtx, targetStr, w, split, fSign, i: winI, j: winJ } = bestChoice;
  const ins = bestChoice.ins?.paths?.pass?.pf?.exitMark != null
    ? bestChoice.ins
    : (inspectRatio(roundCtx, { sign: fSign, i: winI, j: winJ }, { minimizeMargin: false, fastProbe: false }) ?? bestChoice.ins);
  const hypeAfterClose = dec(ins.success);
  const hypePnL = hypeAfterClose.minus(hlStart);
  const claimGross = dec(split.qualified);
  const claimNet = dec(split.user);
  const roundTransferFeeDec = nonnegative(transferFee);

  const passPfPath = ins.paths?.pass?.pf ?? null;
  const passHlPath = ins.paths?.pass?.hl ?? null;
  const passPfCosts = summarizeLegCostMini(passPfPath);
  const passHlCosts = summarizeLegCostMini(passHlPath);

  const pfEntryMark = roundMarket.pf.mark;
  const pfClaimTriggerPrice = passPfPath?.exitMark ?? null;
  const pfClaimMovePct = (pfClaimTriggerPrice != null && dec(pfEntryMark).gt(0))
    ? out(dec(pfClaimTriggerPrice).minus(pfEntryMark).div(pfEntryMark).times(100))
    : null;
  const absPfMovePctNum = pfClaimMovePct != null ? Math.abs(Number(pfClaimMovePct)) : null;
  const pfStopMovePct = dec(ins.pfValue).gt(0) ? out(room.div(ins.pfValue).times(100)) : null;
  const hypePostCloseRatioPct = hlStart.gt(0) ? out(hypeAfterClose.div(hlStart).times(100)) : '0';
  const extremeMoveWarning = absPfMovePctNum != null && absPfMovePctNum > 15;
  const lowHypeCushionWarning = Number(hypePostCloseRatioPct) < 15;
  const hypeMappedExitMark = passHlPath?.exitMark ?? null;
  const pfRealizedNetPnL = out(claimGross);
  const hypeRealizedNetPnL = out(hypePnL);

  // R16.2 Six-Stage Ledger Flow:
  // Stage 0 -> Stage A (open & hold) -> Stage B/C (target trigger, dual close to 0/0, realized settlement)
  // -> Stage D (submit claim only after 0/0 confirmed) -> Stage E (claim receipt & transfer)
  const startLedger = createPersonalLedger({
    totalInvested: out(invested),
    hypeEquity: out(hlStart),
    vestMainCash: out(vestStart),
    externalCash: out(extStart),
    settledClaims: priorSettledClaims,
    transferFees: priorTransferFees
  });
  const stageAState = openRoundPositions(startLedger, {
    roundIndex,
    pfQty: ins.pf,
    hypeQty: ins.hl,
    pfEntryPrice: passPfPath?.entryPrice ?? roundMarket.pf.mark,
    hypeEntryPrice: passHlPath?.entryPrice ?? roundMarket.hl.mark
  });
  const stageBCState = closeAndSettleRoundPositions(stageAState, {
    roundIndex,
    pfQtyAfterClose: '0',
    hypeQtyAfterClose: '0',
    pfEntryAvgPrice: passPfPath?.entryPrice ?? roundMarket.pf.mark,
    pfExitAvgPrice: passPfPath?.exitPrice ?? pfClaimTriggerPrice ?? roundMarket.pf.mark,
    hypeEntryAvgPrice: passHlPath?.entryPrice ?? roundMarket.hl.mark,
    hypeExitAvgPrice: passHlPath?.exitPrice ?? hypeMappedExitMark ?? roundMarket.hl.mark,
    pfRealizedNetPnL,
    hypeRealizedNetPnL,
    pfOpenFee: passPfCosts.openFee,
    pfCloseFee: passPfCosts.closeFee,
    hypeOpenFee: passHlCosts.openFee,
    hypeCloseFee: passHlCosts.closeFee,
    fundingFee: out(dec(passPfPath?.funding ?? '0').plus(passHlPath?.funding ?? '0')),
    pfCloseExecCost: passPfCosts.execTotal,
    hypeCloseExecCost: passHlCosts.execTotal,
    pfCloseAt: 'target_trigger_t0',
    hypeCloseAt: 'target_trigger_t0',
    partialFillCount: 0,
    asyncExposureMs: 0
  });
  const pendingState = submitClaim(stageBCState, {
    roundIndex,
    gross: out(claimGross),
    netExpected: out(claimNet),
    traderShare: share,
    submittedAt: 'post_close_flat_confirmed'
  });
  const waitingSummary = summarizeLedger(pendingState);

  const dest = payoutDestination ?? (reinvestToHype ? 'hype' : 'external_wallet');
  const settleDest = dest === 'vest_main' ? 'vest_main' : 'external_wallet';
  const settledState = settleClaim(pendingState, {
    roundIndex,
    actualNetReceived: out(claimNet),
    destination: settleDest,
    vestProcessedAt: 'vest_payout_approved',
    receivedAt: settleDest === 'external_wallet' ? 'external_wallet_credited' : 'vest_main_credited'
  });
  let finalLedger = settledState;
  let reinvestedAmount = dec('0');
  if (dest === 'hype' && claimNet.gt(0)) {
    reinvestedAmount = max(dec('0'), claimNet.minus(roundTransferFeeDec));
    finalLedger = transferExternalToHype(settledState, {
      roundIndex,
      amount: out(claimNet),
      transferFee: out(roundTransferFeeDec),
      source: settleDest,
      transferredAt: 'hype_margin_credited'
    });
  }
  const endSummary = summarizeLedger(finalLedger);
  const cumTransferFeesStr = out(nonnegative(priorTransferFees).plus(dest === 'hype' && claimNet.gt(0) ? roundTransferFeeDec : dec('0')));

  // Stop-loss branch for THIS round (Funded account terminates immediately; prior settled claims retained!)
  const stopHypeEnd = dec(ins.fail);
  const stopHypePnL = stopHypeEnd.minus(hlStart);
  const stopLedger = createPersonalLedger({
    totalInvested: out(invested),
    hypeEquity: out(stopHypeEnd),
    vestMainCash: out(vestStart),
    externalCash: out(extStart),
    settledClaims: priorSettledClaims,
    transferFees: priorTransferFees
  });
  const stopSummary = summarizeLedger(stopLedger);

  // Post-claim PF equity (explicitly documented assumption; fixed floor L NEVER moves!)
  const pfAfterClaim = claimEquityRule === 'reset_to_baseline'
    ? dec(resetBaseline || baseline)
    : max(fixedFloor, dec(targetStr).minus(claimGross));
  const pfRemainingAfter = pfAfterClaim.minus(fixedFloor);
  const pfIM = out(dec(ins.pfValue).div(pfLev));
  const hlIM = ins.initial ?? (ins.lev ? out(dec(ins.hypeValue).div(ins.lev)) : null);

  return {
    ok: true,
    seedChoice: {
      fSign: bestChoice.fSign,
      i: bestChoice.i,
      j: bestChoice.j,
      targetStr,
      w
    },
    round: {
      roundIndex,
      pfEquityStart: out(pfEq),
      pfFixedFloor: out(fixedFloor),
      pfRemainingLossRoom: out(room),
      hypeEquityStart: out(hlStart),
      // 1. 本轮双方开仓数量
      pfPosition: {
        dir: dec(ins.pf).gt(0) ? '做多' : '做空',
        qty: ins.pf,
        unit: roundMarket.pf.unit,
        notional: ins.pfValue,
        leverage: pfLev,
        effectiveLeverage: pfEq.gt(0) ? out(dec(ins.pfValue).div(pfEq)) : null,
        initialMargin: pfIM
      },
      hypePosition: {
        dir: dec(ins.hl).gt(0) ? '做多' : dec(ins.hl).lt(0) ? '做空' : '空仓',
        qty: ins.hl,
        unit: roundMarket.hl.unit,
        notional: ins.hypeValue,
        leverage: ins.lev,
        effectiveLeverage: hlStart.gt(0) ? out(dec(ins.hypeValue).div(hlStart)) : null,
        initialMargin: hlIM
      },
      // 2. 本轮实际对冲比例
      hedgeRatio: ins.h,
      // 3. 达到领取目标需要的 PF 价格
      pfEntryMark,
      pfClaimTriggerPrice,
      pfClaimMovePct,
      pfStopMovePct,
      hypeMappedExitMark,
      hypePostCloseRatioPct,
      extremeMoveWarning,
      lowHypeCushionWarning,
      priceBasisNote: roundIndex === 1
        ? '按当前实时市价基准计算'
        : '按当前实时市价基准与相对涨跌幅推演（非假设承接上一轮收盘价）',
      // 4. 双方平仓后的实际净盈亏（及平仓后双边持仓 0 / 0）
      pfRealizedNetPnL,
      hypeRealizedNetPnL,
      combinedCloseNetPnL: out(claimGross.plus(hypePnL)),
      postClosePositions: {
        pfQty: '0',
        hypeQty: '0',
        bothFlatConfirmed: true
      },
      closeSettlement: finalLedger.lastSettlement,
      // 5. PF 可领取毛利润 (W)
      profitAtClaim: w,
      targetEquity: targetStr,
      claimGross: out(claimGross),
      // 6. 个人实际分成 (P = W × s)
      traderSplit: share,
      claimNetReceived: out(claimNet),
      // 7. Hype 平仓后的剩余资金 (Hype_PostClose = Hype_PreviousEquity + Hype_RealizedNetPnL)
      hypePostClose: out(hypeAfterClose),
      hypeBeforeTransfer: out(hypeAfterClose),
      hypePnL: out(hypePnL),
      // 8. 领取到账状态与提现等待期零仓位状态
      claimStatus: 'settled_conditional',
      pendingClaimAtSubmit: pendingState.pendingClaim,
      waitingPeriodState: {
        pfPositionQty: '0',
        hypePositionQty: '0',
        bothFlatConfirmed: true,
        maintenanceMargin: '0',
        unrealizedPnL: '0',
        liquidationRisk: false,
        pendingClaimIncludedInMargin: false,
        hypeAvailableMarginDuringWait: waitingSummary.hypeEquity
      },
      claimLifecycle: {
        stageBFlatConfirmed: true,
        requestedGrossW: out(claimGross),
        requestedPersonalShare: out(claimNet),
        processingStatusAtSubmit: 'pending_review',
        finalStatus: dest === 'hype'
          ? 'settled_and_transferred_to_hype'
          : dest === 'vest_main'
            ? 'settled_in_vest_main'
            : 'settled_in_external_wallet',
        actualReceivedPayout: out(claimNet),
        transferFee: out(roundTransferFeeDec),
        netTransferredToHype: out(reinvestedAmount),
        destination: dest,
        timestamps: {
          submittedAt: pendingState.lastClaimRequest?.requestedAt ?? 'post_close_flat_confirmed',
          vestProcessedAt: 'vest_payout_approved',
          vestMainReceivedAt: 'vest_main_credited',
          externalReceivedAt: settleDest === 'external_wallet' ? 'external_wallet_credited' : null,
          hypeCreditedAt: dest === 'hype' ? 'hype_margin_credited' : null
        }
      },
      hypeSurvivesBeforeClaim: hypeAfterClose.gt(0) && ins.physical === true,
      // 9. 下一轮实际可用资金
      pfEquityAfterClaim: out(pfAfterClaim),
      pfRemainingAfterClaim: out(pfRemainingAfter),
      reinvestedToHype: out(reinvestedAmount),
      transferFee: out(roundTransferFeeDec),
      cumulativeTransferFees: cumTransferFeesStr,
      hypeEquityEnd: endSummary.hypeEquity,
      vestMainCash: endSummary.vestMainCash,
      externalCash: endSummary.externalCash,
      cumulativeSettledClaims: endSummary.settledClaims,
      personalTotalAsset: endSummary.personalTotalAsset,
      unrecoveredCost: endSummary.unrecoveredCost,
      cumulativeNetPnL: endSummary.cumulativeNetPnL,
      roundNetGain: out(claimNet.plus(hypePnL).minus(roundTransferFeeDec)),
      nextRoundAvailableFunds: {
        pfAccountValue: out(pfAfterClaim),
        pfFixedFloor: out(fixedFloor),
        pfLossRoom: out(pfRemainingAfter),
        hypeActualEquity: endSummary.hypeEquity,
        vestMainCash: endSummary.vestMainCash,
        externalCash: endSummary.externalCash,
        personalCumulativeAsset: endSummary.personalTotalAsset,
        unrecoveredPrincipal: endSummary.unrecoveredCost,
        cumulativeNetPnL: endSummary.cumulativeNetPnL
      },
      // 10. 下一轮自动重新计算的双方仓位（由 solveFundedMultiRound 在本轮到账资金基础上重算填入）
      nextRoundPosition: null,
      costs: {
        fail: { pf: summarizeLegCostMini(ins.paths?.fail?.pf), hl: summarizeLegCostMini(ins.paths?.fail?.hl) },
        pass: { pf: passPfCosts, hl: passHlCosts, withdrawalFee: withdrawal?.fee ?? '0', transferFee: out(roundTransferFeeDec) }
      },
      marginCondition: {
        hlInitialMargin: hlIM,
        hlMaintenance: ins.maintenance ?? null,
        hlMinSurplus: ins.surplus ?? null,
        hlLiqMark: ins.liquidation ?? null
      },
      stopOutcome: {
        fundedTerminated: true,
        pfFixedFloor: out(fixedFloor),
        priorSettledClaimsRetained: out(nonnegative(priorSettledClaims)),
        priorVestMainCashRetained: out(vestStart),
        priorExternalCashRetained: out(extStart),
        hypePnL: out(stopHypePnL),
        hypeEquityEnd: stopSummary.hypeEquity,
        personalTotalAsset: stopSummary.personalTotalAsset,
        recoveredPrincipal: stopSummary.recoveredPrincipal,
        gapToBreakeven: stopSummary.unrecoveredCost,
        finalNetPnL: stopSummary.cumulativeNetPnL,
        recovered: stopSummary.recovered,
        strictProfit: stopSummary.strictProfit
      }
    }
  };
}

// ===== Multi-Round State Machine Orchestrator =====
export function solveFundedMultiRound({
  pfStart,
  pfFixedFloor,
  baseline,
  resetBaseline,
  initialHypeCash,
  totalInvested,
  share,
  withdrawal,
  fundedMarketBase,
  ctx,
  preferredSign = 1,
  userTarget = null,
  singleRoundDualProfit = false,
  maxRounds = 6,
  reinvestToHype = true,
  transferFeePerRound = '0',
  payoutDestination = null,
  seedChoices = null
}) {
  const rounds = [];
  const chosenSeeds = [];
  let curPfEquity = out(dec(pfStart));
  let curHypeEquity = out(dec(initialHypeCash));
  let curVestMainCash = '0';
  let curExternalCash = '0';
  let curSettledClaims = '0';
  let curTransferFees = '0';
  let recoveredAtRound = null;
  let profitAfterRecoveryRound = null;
  let stoppedReason = null;

  const baseAssumptions = [
    'R16.2 双边平仓门禁：每轮 PF 达到领取目标后，必须先关闭 Vest 与 Hyperliquid 双方全部对应仓位并确认持仓均为 0 / 0，才可提交本轮利润领取申请',
    '提现等待期零敞口与保证金隔离：提现等待期间双边仓位为 0、维持保证金为 0、不假设未平仓盈亏、不计算已关闭仓位强平风险，且申请中/处理中分成绝不计入 Hype 可用保证金',
    '下一轮动态重算（绝不复制上一轮仓位）：仅在本轮实际到账并完成资金转移后，按最新 PF 权益、原固定止损底线 ' + out(dec(pfFixedFloor)) + ' U、最新 Hype 实际权益 H_{k+1} 与待回收本金 C_{k+1} 重新求解下一轮仓位、比例、杠杆与领取目标 W'
  ];

  if (singleRoundDualProfit) {
    return {
      mode: 'single_round',
      classification: FUNDED_CLASSIFICATIONS.single_round_dual_profit,
      rounds: [],
      roundCount: 1,
      recoveredFeasible: true,
      recoveredAtRound: 1,
      profitAfterRecoveryFeasible: true,
      profitAfterRecoveryRound: 1,
      assumptions: baseAssumptions,
      stoppedReason: null
    };
  }

  let effectiveMaxRounds = maxRounds;
  for (let rIdx = 1; rIdx <= effectiveMaxRounds; rIdx++) {
    const res = solveFundedRound({
      roundIndex: rIdx,
      pfEquityStart: curPfEquity,
      pfFixedFloor,
      baseline,
      resetBaseline,
      hypeEquityStart: curHypeEquity,
      vestMainCash: curVestMainCash,
      externalCash: curExternalCash,
      priorSettledClaims: curSettledClaims,
      priorTransferFees: curTransferFees,
      transferFee: transferFeePerRound,
      payoutDestination,
      totalInvested,
      share,
      withdrawal,
      fundedMarketBase,
      ctx,
      preferredSign,
      userTarget,
      reinvestToHype,
      seedChoice: Array.isArray(seedChoices) ? (seedChoices[rIdx - 1] ?? null) : null
    });
    if (!res.ok) {
      stoppedReason = res.reason;
      break;
    }
    const rd = res.round;
    rounds.push(rd);
    if (res.seedChoice) chosenSeeds.push(res.seedChoice);

    const cumNet = dec(rd.cumulativeNetPnL);
    const assetNow = dec(rd.personalTotalAsset);
    if (recoveredAtRound == null && assetNow.gte(totalInvested)) {
      recoveredAtRound = rIdx;
      // Show recovery round k + at most 1 steady post-recovery profit round (k+1) — NEVER roll 8 rounds of snowball!
      effectiveMaxRounds = Math.min(5, Math.max(maxRounds, recoveredAtRound + 1));
    }
    if (recoveredAtRound != null && cumNet.gt(0)) {
      if (profitAfterRecoveryRound == null) profitAfterRecoveryRound = rIdx;
      if (rIdx >= recoveredAtRound + 1) break;
    }

    // Advance to next round using post-claim PF equity & settled available Hype equity (Stage F)
    curPfEquity = rd.pfEquityAfterClaim;
    curHypeEquity = rd.hypeEquityEnd;
    curVestMainCash = rd.vestMainCash ?? curVestMainCash;
    curExternalCash = rd.externalCash;
    curSettledClaims = rd.cumulativeSettledClaims ?? curSettledClaims;
    curTransferFees = rd.cumulativeTransferFees ?? curTransferFees;
    if (dec(rd.pfRemainingAfterClaim).lte(0)) {
      stoppedReason = '第 ' + rIdx + ' 轮领取后 PF 权益已无剩余止损空间';
      break;
    }
  }

  // Populate Item 10 (下一轮自动重新计算的双方仓位) for every round in `rounds`
  for (let idx = 0; idx < rounds.length; idx++) {
    const cur = rounds[idx];
    const nxt = rounds[idx + 1] ?? null;
    if (nxt) {
      cur.nextRoundPosition = {
        roundIndex: nxt.roundIndex,
        status: 're_solved',
        reSolvedFromActualArrival: true,
        copiedFromPreviousRound: false,
        pfEquityStart: nxt.pfEquityStart,
        hypeEquityStart: nxt.hypeEquityStart,
        pfPosition: nxt.pfPosition,
        hypePosition: nxt.hypePosition,
        hedgeRatio: nxt.hedgeRatio,
        profitAtClaim: nxt.profitAtClaim,
        pfClaimTriggerPrice: nxt.pfClaimTriggerPrice,
        pfClaimMovePct: nxt.pfClaimMovePct
      };
    } else if (dec(cur.pfRemainingAfterClaim).gt(0) && dec(cur.hypeEquityEnd).gt(0)) {
      // Solve the continuation preview position for round (k + 1) from round k's actual settled funds
      const previewRes = solveFundedRound({
        roundIndex: cur.roundIndex + 1,
        pfEquityStart: cur.pfEquityAfterClaim,
        pfFixedFloor,
        baseline,
        resetBaseline,
        hypeEquityStart: cur.hypeEquityEnd,
        vestMainCash: cur.vestMainCash ?? '0',
        externalCash: cur.externalCash ?? '0',
        priorSettledClaims: cur.cumulativeSettledClaims ?? '0',
        priorTransferFees: cur.cumulativeTransferFees ?? '0',
        transferFee: transferFeePerRound,
        payoutDestination,
        totalInvested,
        share,
        withdrawal,
        fundedMarketBase,
        ctx,
        preferredSign,
        userTarget,
        reinvestToHype
      });
      if (previewRes.ok) {
        const pr = previewRes.round;
        cur.nextRoundPosition = {
          roundIndex: pr.roundIndex,
          status: 're_solved_continuation',
          reSolvedFromActualArrival: true,
          copiedFromPreviousRound: false,
          pfEquityStart: pr.pfEquityStart,
          hypeEquityStart: pr.hypeEquityStart,
          pfPosition: pr.pfPosition,
          hypePosition: pr.hypePosition,
          hedgeRatio: pr.hedgeRatio,
          profitAtClaim: pr.profitAtClaim,
          pfClaimTriggerPrice: pr.pfClaimTriggerPrice,
          pfClaimMovePct: pr.pfClaimMovePct
        };
      } else {
        cur.nextRoundPosition = {
          roundIndex: cur.roundIndex + 1,
          status: 'unavailable',
          reSolvedFromActualArrival: true,
          copiedFromPreviousRound: false,
          reason: previewRes.reason
        };
      }
    }
  }

  const lastRound = rounds.at(-1) ?? null;
  let classification = FUNDED_CLASSIFICATIONS.openable_not_profitable;
  if (profitAfterRecoveryRound != null) {
    classification = FUNDED_CLASSIFICATIONS.multi_round_profit_after_recovery;
  } else if (recoveredAtRound != null) {
    classification = FUNDED_CLASSIFICATIONS.multi_round_recovery_feasible;
  }
  const roundMoves = rounds.map((rd) => Math.abs(Number(rd.pfClaimMovePct))).filter(Number.isFinite);
  const roundCushions = rounds.map((rd) => Number(rd.hypePostCloseRatioPct)).filter(Number.isFinite);
  const maxRoundMovePct = roundMoves.length ? out(dec(String(Math.max(...roundMoves))).toDecimalPlaces(2)) : null;
  const minHypePostCloseRatioPct = roundCushions.length ? out(dec(String(Math.min(...roundCushions))).toDecimalPlaces(2)) : null;
  const hasExtremeMove = rounds.some((rd) => rd.extremeMoveWarning);
  const hasLowHypeCushion = rounds.some((rd) => rd.lowHypeCushionWarning);
  const postRecovery1 = recoveredAtRound != null ? rounds.find((rd) => rd.roundIndex === recoveredAtRound + 1) ?? null : null;
  const postRecovery2 = recoveredAtRound != null ? rounds.find((rd) => rd.roundIndex === recoveredAtRound + 2) ?? null : null;
  const stopNets = rounds.map((rd) => rd.stopOutcome?.finalNetPnL).filter((v) => v != null);
  const worstStopNetPnL = stopNets.length ? out(stopNets.reduce((lo, v) => (dec(v).lt(lo) ? dec(v) : lo), dec(stopNets[0]))) : null;
  let stopLockedProfitFromRound = null;
  for (let i = 0; i < rounds.length; i++) {
    if (rounds.slice(i).every((rd) => rd.stopOutcome?.recovered === true)) {
      stopLockedProfitFromRound = rounds[i].roundIndex;
      break;
    }
  }

  return {
    mode: rounds.length ? 'multi_round' : 'none',
    classification,
    rounds,
    seedChoices: chosenSeeds,
    roundCount: rounds.length,
    recoveredFeasible: recoveredAtRound != null,
    recoveredAtRound,
    profitAfterRecoveryFeasible: profitAfterRecoveryRound != null,
    profitAfterRecoveryRound,
    postRecoveryNetPnL1: postRecovery1?.cumulativeNetPnL ?? null,
    postRecoveryNetPnL2: postRecovery2?.cumulativeNetPnL ?? null,
    worstStopNetPnL,
    stopLockedProfitFromRound,
    maxRoundMovePct,
    minHypePostCloseRatioPct,
    hasExtremeMove,
    hasLowHypeCushion,
    priceBasisNote: '基准价口径：第 2 轮及后续轮次均以当前实时市价为基准并按相对涨跌幅（%）推演，便于横向对比各轮波动需求（非假设承接上一轮收盘价）',
    transferFeePerRound: out(nonnegative(transferFeePerRound)),
    finalCumulativeAsset: lastRound?.personalTotalAsset ?? out(dec(initialHypeCash)),
    finalCumulativeNetPnL: lastRound?.cumulativeNetPnL ?? out(dec(initialHypeCash).minus(totalInvested)),
    finalUnrecoveredCost: lastRound?.unrecoveredCost ?? out(max(dec('0'), dec(totalInvested).minus(initialHypeCash))),
    assumptions: baseAssumptions,
    stoppedReason
  };
}
