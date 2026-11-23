import {buildCandidateSet} from './candidate-set.js';
import {moveDecision} from './move-position.js';
import { evaluationClose, investmentBasis } from './account-stages.js';
import { hasValue, parseTotalLoss, parseDailyLoss, resolveFundedTotalRule, resolveLossBoundary, solveFundedWBounds } from './loss-limits.js';
import {examSchedule} from './exam-clock.js';
import { examEnvelope, examMove } from './reachability.js';
import { venueFields } from './venue-scenarios.js';
import { scanContext, buildRatioScan, ratioSlice, inspectRatio, ratioBin } from './ratio-scan.js';
import {
  dec,
  max,
  out,
  positive,
  nonnegative,
  profitSplit, projectedShare, canClaimOnSuccess,
  fundingInterval,
  solveBudgetBounds,
  normalizeExposure,
  estimateFill, fillEvidence
} from './math.js';
import { remainingOrder } from './order-adjustment.js';
export { remainingOrder } from './order-adjustment.js';
import { searchLiquidityMaximum, missingPressureRate } from './liquidity-search.js';
import { buildPlanReport, planRecord, pointKey, recordFromInspection } from './position-plans.js';
import { analyzeRatios } from './ratio-analysis.js';
import { validLeverageCap } from './leverage.js';
import { auditCross } from './cross-check.js';
import { adjustmentTarget, comparePlans } from './optimization.js';
import { settlementBridge } from './settlement-ledger.js';
import { solveAuto } from './auto.js';
import { currencyMapping, requiredSpotAssets } from './quote-currencies.js';
import { calculationTrace } from './trace.js';
import {
  solve,
  executionDetail,
  solveBoundaryPrices,
  projectSettlementEquity,
  validateMargin
} from './solver.js';

const specified = (x) => x != null && x !== '';
const optional = (x) =>
  specified(x) ? out(dec(String(x).replace(/^([+-]?)\./, (_, sign) => sign + '0.'))) : null;
export const fresh = (stamp, now, ms) =>
  Number.isFinite(Date.parse(stamp)) && now - Date.parse(stamp) >= -1000 && now - Date.parse(stamp) <= ms;
// Historical fixtures may have only source clocks. Public live inputs also
// require evidence from this socket session on every calculation and publish.
export function subscriptionHealthy(data,side,now) {
  if(!data.health && data.source!=='Vest / Hyperliquid 公开行情') return true;
  const h=data.health?.[side];
  return !!(h?.connected && h.ready && h.subscription==='streaming' && h.heartbeat &&
    fresh(h.lastBookAt,now,3000) && fresh(h.lastMarkAt,now,3000) &&
    (side!=='hl' || h.continuous && fresh(h.lastPongAt,now,11000)));
}
// Two independent venue clocks; older atomic snapshots use their common timestamp.
export function quoteClock(q, now, ttl) {
  const bookAt = q?.bookAt ?? q?.asOf;
  const splitFeed = q?.bookSource?.startsWith('Hyperliquid') || q?.bookAt != null;
  const markAt = q?.markAt ?? (splitFeed ? null : q?.asOf);
  const age = (x) => (Number.isFinite(Date.parse(x)) ? now - Date.parse(x) : null);
  const levels = q?.levels;
  const depthOK =
    Array.isArray(levels) &&
    levels.length === 2 &&
    levels.every(
      (side, i) =>
        Array.isArray(side) &&
        side.length &&
        side.every(
          (row, j) =>
            Array.isArray(row) &&
            row.slice(0, 2).length === 2 &&
            row.slice(0, 2).every((v) => Number.isFinite(Number(v)) && Number(v) > 0) &&
            (!j || (i ? Number(row[0]) >= Number(side[j - 1][0]) : Number(row[0]) <= Number(side[j - 1][0])))
        )
    ) &&
    Number(levels[0][0][0]) <= Number(levels[1][0][0]);
  const bookOK = fresh(bookAt, now, ttl),
    markOK = fresh(markAt, now, ttl) && Number(q?.mark) > 0;
  return {
    bookAt,
    markAt,
    bookAge: age(bookAt),
    markAge: age(markAt),
    bookOK,
    markOK,
    depthOK,
    ok: bookOK && markOK && depthOK
  };
}
export const rules = {
  stage: 'challenge',
  challengeFloor: '9400',
  challengeDailyMode: 'none',
  challengeDailyFloor: '',
  challengeTarget: '11000',
  fundedFloor: '9400',
  fundedLossMode: 'floor',
  fundedMaxLoss: '600',
  fundedDailyMode: 'none',
  fundedDailyFloor: '',
  fundedTarget: '',
  fundedDrawdown: '',
  passCost: '',
  baseline: '10000',
  share: '0.8',
  platformShare:'0.2', minimumProfit:'0', withdrawalFee:'0', resetBaseline:'10000',
  B: '500',
  investedCapital: '',
  registration: '142.50',
  outsideCosts: '0',
  minBuffer: '0',
  minMaintenanceSurplus: '0',
  R_success: '100',
  successBuffer: '',
  hardDepthD: '',
  R_free: '0',
  g: '0',
  roundIn: '0',
  roundOut: '0',
  hlFee: '0.0005',
  pfFee: '0.0001',
  k: '0',
  mode: 'auto',
  objective: 'size',
  pfUtil: '100',
  hlUtil: '100',
  adverseBps: '',
  asyncBps: '',
  jumpBps: '',
  delayBps: '',
  fundingDebit: '',
  fundingRatesBps: '',
  quoteSecs: '5',
  depegAlertBps: '50',
  quoteSkewMs: '3000',
  accountSkewSecs: '120',
  rebalanceSteps: '2',
  riskPreference: '0',
  accountSecs: '300'
};

export const stressFields = {
  adverseBps: '基差及汇率',
  asyncBps: '跨平台异步偏移',
  jumpBps: '跳价',
  delayBps: '调仓延迟',
  fundingDebit: '资金费'
};
export function stressCoverage(r) {
  const missing = [],
    zero = [],
    positive = [];
  let fundingRatesBps=[], fundingScheduleError=null;
  if (r.fundingRatesBps!=null && String(r.fundingRatesBps).trim()!=='') {
    try {
      if (typeof r.fundingRatesBps!=='string') throw Error();
      fundingRatesBps=r.fundingRatesBps.split(/[,，]/).map(item=>out(nonnegative(item.trim())));
    } catch {
      fundingScheduleError='逐期资金费须以逗号分隔，每期填写有效的非负 bp 数值';
    }
  }
  const scheduledFunding=fundingRatesBps.some(rate=>dec(rate).gt(0));
  for (const [field,label] of Object.entries(stressFields)) {
    if (field==='fundingDebit' && fundingScheduleError) { missing.push(label); continue; }
    const scalar=specified(r[field]) ? nonnegative(r[field]) : null;
    if (scalar?.gt(0) || field==='fundingDebit' && scheduledFunding) positive.push(label);
    else if (scalar!=null || field==='fundingDebit' && fundingRatesBps.length) zero.push(label);
    else missing.push(label);
  }
  const label = missing.length ? '压力未配置：' + missing.join('、') : '';
  const zeros = zero.length ? '零压力假设：' + zero.join('、') : '';
  return {
    missing,
    zero,
    positive,
    fundingRatesBps, fundingScheduleError,
    label: [fundingScheduleError, label, zeros].filter(Boolean).join('；') || '五项非零压力参数已设置'
  };
}

// A whole API snapshot has one timestamp. Manual values retain individual confirmation times.
export function fieldTime(account, field) {
  const key = field + 'At';
  return Object.hasOwn(account, key) ? account[key] : (account.origins?.[field]?.at ?? account.at);
}
function hlTiers(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) return null;
  let prior = dec('0'),
    deduction = dec('0'),
    previousBound = null;
  const normalized = [];
  for (const t of tiers) {
    if (!validLeverageCap(t?.maxLeverage) || !specified(t?.lowerBound)) return null;
    const from = nonnegative(String(t.lowerBound));
    const rate = dec('0.5').div(String(t.maxLeverage));
    if (previousBound ? from.lte(previousBound) || rate.lt(prior) : !from.isZero()) return null;
    deduction = deduction.plus(from.times(rate.minus(prior)));
    normalized.push({
      from: out(from),
      mmr: out(rate),
      deduction: out(deduction),
      maxLeverage: String(t.maxLeverage)
    });
    prior = rate;
    previousBound = from;
  }
  return normalized;
}

function buildMarket(data, r, a, currencies) {
  const { pf, hl, spec, asset } = data;
  if (
    !pf ||
    !hl ||
    !spec ||
    !['BTC', 'ETH', 'SOL'].includes(asset) ||
    spec.symbol !== currencies.pf.symbol ||
    pf.symbol !== spec.symbol ||
    hl.symbol !== currencies.hl.symbol ||
    [spec, hl].some((l) => l.payoffType != null && l.payoffType !== 'linear')
  )
    return null;
  const market = { id: asset };
  for (const key of ['pf', 'hl']) {
    const isPF = key === 'pf',
      q = data[key],
      ac = a[key];
    const n = isPF ? spec.sizeDecimals : hl.sizeDecimals;
    if (!Number.isInteger(n) || n < 0 || n > 16 || !Array.isArray(q.levels) || q.levels.length !== 2)
      return null;
    const step = out(dec('10').pow(-n));
    const im = r.stage === 'challenge' ? spec.capitalInitMarginRatio : spec.fundedInitMarginRatio;
    const rate = isPF ? r.pfFee : (ac.fee ?? r.hlFee);
    const pfCaps=isPF?[im==null?null:out(dec('1').div(positive(im))),spec.maxLeverage,ac.maxLeverage,ac.leverage].filter(specified):[];
    const lev =
      isPF && pfCaps.length
        ? out(pfCaps.map(v=>positive(String(v))).reduce((x,y)=>x.lte(y)?x:y))
        : optional(!isPF && r.mode === 'auto' ? ac.configuredLeverage : ac.leverage);
    if (nonnegative(String(rate)).gte(1)) throw Error('单边费率须小于 100%');
    const utilization = nonnegative(String((isPF ? r.pfUtil : r.hlUtil) ?? '100')).div(100);
    if (utilization.gt(1)) throw Error('最大保证金占用率必须在 0 至 100% 之间');
    const limits = [(isPF ? spec : hl).maxQty, ac.maxQty]
      .filter(specified)
      .map((x) => nonnegative(String(x)));
    market[key] = {
      symbol: q.symbol,
      underlying: asset,
      unit: currencies[key].quantityUnit,
      quoteCurrency: currencies[key].quoteAsset,
      type: 'linear',
      mappingVerified: true,
      multiplier: currencies.legs[key].multiplier,
      fx: currencies.legs[key].pointToLedger.mid,
      // Native price movement per unit change of the common (Vest quote) price.
      factor: isPF ? '1' : currencies.nativeMovePerVestPoint,
      step,
      minQty: out(positive(String((isPF ? spec : hl).minQty ?? step))),
      minNotional: out(nonnegative(String((isPF ? spec : hl).minNotional ?? (isPF ? '0' : '10'))).times(currencies.legs[key].settleToLedger.mid)),
      mark: out(positive(String(q.mark))),
      open: isPF ? pf.open : true,
      // An accepted grid retains the exact native liquidity used for its fills.
      bids: q.levels[0].map(([price, size]) => [price, size]),
      asks: q.levels[1].map(([price, size]) => [price, size]),
      rate: out(nonnegative(String(rate))),
      pool: 'current',
      leverage: lev,
      configuredLeverage: isPF
        ? null
        : validLeverageCap(ac.configuredLeverage)
          ? String(ac.configuredLeverage)
          : null,
      exchangeMaxLeverage: isPF ? null : (ac.maxLeverage!=null && validLeverageCap(hl.maxLeverage)
        ? validLeverageCap(Math.min(Number(ac.maxLeverage),Number(hl.maxLeverage))) : validLeverageCap(hl.maxLeverage)),
      currentMarginCredit:
        !isPF && ac.currentMarginCredit != null ? out(nonnegative(ac.currentMarginCredit)) : null,
      marginMode: ac.marginMode || null,
      hold: optional(ac.otherHold),
      tiers:
        isPF && spec.maintMarginRatio
          ? [{ from: '0', mmr: spec.maintMarginRatio, deduction: '0' }]
          : isPF
            ? null
            : hlTiers(hl.marginTiers)?.map(t => ({ ...t,
                from: out(dec(t.from).times(currencies.legs.hl.settleToLedger.mid)),
                deduction: out(dec(t.deduction).times(currencies.legs.hl.settleToLedger.mid))
              })) ?? null,
      utilization: out(utilization),
      reserve: isPF ? '0' : out(nonnegative(r.R_free)),
      maxQty: limits.length ? out(limits.reduce((a, b) => (a.lt(b) ? a : b))) : null,
      capacity: ac.capacity,
      currentLiquidation: isPF ? null : ac.liquidation,
      directionalFree: ac.directionalFree,
      free: optional(ac.free)
    };
  }
  return market;
}

function equityAt(s, q, px, unit) {
  const eq = optional(s.equity);
  if (eq === null || q === null || !specified(s.anchor) || !px) return eq;
  return out(
    dec(eq).plus(
      dec(q)
        .times(unit)
        .times(dec(String(px)).minus(positive(String(s.anchor))))
    )
  );
}
export function reason(code) {
  return (
    {
      CHALLENGE_FAILED: 'VS 已触及考核失败线',
      FUNDED_FAILED: 'VS 已触及出金户失败线',
      REFERENCE_REACHED: '已到提款参考点，核对可申领金额',
      CHALLENGE_PASS_PENDING_SETTLEMENT: '考核目标已到，待平台确认结算',
      hl_STRESS_SURPLUS: 'Hype 路径最低维持保证金余量',
      hl_ORDER_LEVERAGE: '挂单在新档位的资金占用待确认',
      hl_SWITCH_TIER: '变更杠杆前的原仓档位上限',
      hl_SWITCH_MARGIN: '变更杠杆时原仓初始保证金',
      LEVERAGE_UNVERIFIED: '杠杆与清算模型未验证',
      NO_PAYOUT_TARGET: '提款参考点须高于分成基线',
      LEDGER_MISMATCH: '成交价独立验算与资金流水不符，已阻断结算与仓位建议',
      EXAM_TIME_fail: '考核剩余期限内的失败触线幅度',
      EXAM_TIME_pass: '考核剩余期限内的成功触线幅度',
      EXAM_EQUITY_fail: '失败路径提前触及额外考核权益线',
      EXAM_EQUITY_pass: '成功路径提前触及额外考核权益线',
      INVALID_PF_RULES: 'PF 失败线必须低于成功线',
      FUNDING_RECONCILIATION: '资金公式与双边成交现金未能对账',
      NO_DISCRETE_MATCH: '按步长取整后没有可行仓位',
      NO_MATCH_IN_SEARCH: '当前搜索范围没有满足约束的仓位',
      INSUFFICIENT_DEPTH: '盘口深度不足',
      INVALID_PRICE_ENDPOINT: '该仓位无法在正价格范围触线',
      CASH_BEFORE_PAYOUT: '到账前现金不足',
      PROFIT_TARGET_UNATTAINABLE: '本轮收益上限低于保护下限',
      FAILURE_RECOVERY: '失败端资金保护',
      ROUND_GAIN: '本轮最低增益',
      hl_INITIAL_MARGIN: 'Hype 初始保证金',
      pf_INITIAL_MARGIN: 'PF 初始保证金',
      hl_AVAILABLE: 'Hype 可增开额度',
      pf_PENDING: 'VS 未成交挂单的方向及数量',
      hl_PENDING: 'Hype 未成交挂单的方向及数量',
      AUTO_HOLD: '双边空仓，保持等待',
      AUTO_INFEASIBLE: '完整合法仓位范围内无解',
      AUTO_PARTIAL: '搜索范围内尚无可验证结论',
      pf_UTILIZATION: 'VS 保证金占用上限',
      hl_UTILIZATION: 'Hype 保证金占用上限',
      pf_POSITION_LIMIT: 'VS 合约数量上限',
      hl_POSITION_LIMIT: 'Hype 合约数量上限',
      pf_FREE_RESERVE: 'VS 可用抵押品',
      hl_FREE_RESERVE: 'Hype 调仓后可用抵押品留存',
      STRESS_FAILURE: '基差压力下失败端保护金',
      STRESS_RESERVE: '基差压力下成功端留存',
      STRESS_GAIN: '压力情景整轮增益',
      STRESS_MAINTENANCE: '压力路径维持保证金',
      pf_AVAILABLE: 'PF 可增开额度',
      hl_MAINTENANCE_PATH: 'Hype 维持保证金',
      hl_TIER_LEVERAGE: 'Hype 仓位档位杠杆上限',
      hl_REFERENCE_LIQ: '当前仓平台参考强平线余量',
      hl_PRICE_BUFFER: 'Hype 最低强平距离下的保证金',
      pf_MAINTENANCE_PATH: 'PF 维持保证金',
      MARKET_CLOSED: '一侧休市'
    }[code] ?? code
  );
}

// If no adjustment passes, retain cash outcomes for the actual holdings where the path can reach the VS line.
function heldOutcomes(book, market, p, pf, hl, checks) {
  if (dec(pf).isZero()) return null;
  const lines = solveBoundaryPrices(book, market, pf, p.target, p.floor, checks.passTrigger, checks.failureTrigger);
  const notes = [];
  const cash = {};
  for (const [key, shift] of Object.entries(lines)) {
    const label = key === 'fail' ? '失败线' : '成功线';
    const pfMove=dec(shift).times(market.pf.factor);
    const pfEnd=out(dec(market.pf.mark).plus(pfMove));
    if (checks.exam && examMove(checks.exam,market.pf.mark,pfEnd).status==='fail') {
      notes.push('现仓'+label+'超出考核可达范围，终点资金未知');
      continue;
    }
    if (checks.examEquityFloor!=null && [book.pf,projectSettlementEquity(book,market,'pf',pf,shift,'mark_equity')]
        .some(equity=>dec(equity).lte(checks.examEquityFloor))) {
      notes.push('现仓先触及额外考核权益线，终点资金未知');
      continue;
    }
    const path = ['pf', 'hl'].map((v) =>
      validateMargin(book, market, v, v === 'pf' ? pf : hl, ['0', shift]).at(-1)
    );
    const mark = dec(market.hl.mark).plus(dec(shift).times(market.hl.factor));
    const platformLiq = market.hl.currentLiquidation;
    const crossed = platformLiq != null && !dec(hl).eq(0) && mark.minus(platformLiq).times(dec(hl)).lte(0);
    if (crossed || path.some((c) => c.status === 'fail')) {
      notes.push('现仓可能在 VS ' + label + '之前触及强平，终点现金不可用');
      continue;
    }
    if (path.some((c) => c.status === 'unknown')) notes.push('现仓到' + label + '的保证金路径未验证');
    const bridges = (cash.paths ??= {});
    const legs = {};
    for (const [side, qty] of [
      ['pf', pf],
      ['hl', hl]
    ]) {
      const l = market[side];
      legs[side] = settlementBridge(
        book[side],
        l,
        qty,
        '0',
        shift,
        executionDetail(l, '0'),
        executionDetail(l, out(dec(qty).neg()), shift),
        side === 'hl' ? p.k : '0'
      );
    }
    const settled = dec(legs.hl.settled);
    bridges[key] = legs;
    if (key === 'fail') {
      cash.failureCash = out(settled);
      cash.failureHypeCash = legs.hl.settled;
      cash.bridge = legs.hl;
    } else {
      cash.cashBeforePayout = out(settled);
      cash.hlBeforePayout = legs.hl.settled;
      const payout = canClaimOnSuccess(p) ? projectedShare(legs.pf.settled,p,p.target,checks.passTrigger) : '0';
      cash.expectedUserPayout = payout;
      cash.pressureCashAfter = out(dec(cash.cashBeforePayout).plus(payout));
    }
  }
  return { cash, notes };
}

function attachHeldCash(result,book,market,p,pf,hl,checks,protection) {
  try {
    const held = heldOutcomes(book, market, p, pf, hl, checks);
    if (held) {
      result.heldCash = held.cash;
      result.bridge = held.cash.bridge;
      result.paths = held.cash.paths;
      result.notices.push('以下现金按现有已成交仓位、保持不动计算', ...held.notes);
      if (held.cash.failureCash != null)
        result.failVsPrincipal = out(dec(held.cash.failureCash).minus(protection));
      if (held.cash.pressureCashAfter != null)
        result.passVsPrincipal = out(dec(held.cash.pressureCashAfter).minus(protection));
    }
  } catch (e) {
    result.notices.push('现仓终点无法核算 · ' + reason(e.message));
  }
}

// An old R was entered as a success-path reserve. The new collateral floor is independent.
export function splitReserves(saved = {}) {
  const { R, scanEndpoint: obsoletePath, fx: obsoleteRatio, fxAt: obsoleteRatioTime, ...rest } = saved;
  // Prior versions persisted manual claims. Retire their fields when importing
  // rules, so they cannot affect new calculations or enter new trace files.
  for (const field of ['inTransit','external','externalAt','externalCurrency','externalFx','externalFxAt','payoutRounds','payoutMode','approvalStatus','creditStatus','claimId','claimEquity',
    'claimEquityAt','appliedPayout','approvedPayout','receivedPayout','receivedPayoutAt','receiptSource',
    'postPayoutEquity','receivable','approvalDeduction','claimLimit','withdrawalStart']) delete rest[field];
  if (rest.platformShare == null && specified(rest.share)) {
    try { rest.platformShare = out(dec('1').minus(rest.share)); }
    catch { /* Preserve invalid saved input for editing in the rule form. */ }
  }
  return { ...rest, R_success: rest.R_success ?? R ?? rules.R_success, R_free: rest.R_free ?? rules.R_free };
}
function baseContext(ctx) {
  return {...ctx,checks:{...ctx.checks,stress:undefined,venueScenarios:null,pressureInputs:{},fundingRatesBps:[],adverseBps:'0',asyncBps:null,basisBps:null,fullStress:false}};
}
// For a fixed pair of cross-margin quantities the cash paths and maintenance
// schedule are independent of leverage. Check settings in increasing order of
// margin and stop only after a full pressure audit admits that setting.
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
function cashCandidate(ctx,point) {
  // Pick the lowest legal integer leverage that satisfies all constraints and retain the full legal tier range for comparison.
  const inspected=inspectRatio(ctx,point,{minimizeMargin:!ctx.params.openingCapacity,includePathAudit:true,includeLeverageGrid:true});
  const first=recordFromInspection(ctx,inspected);
  const levMeta=summarizeLeverageGrid(inspected.leverageGrid);
  first.leverageOptions=levMeta.options;
  first.leverageRange=levMeta.range;
  first.initialMarginHL=inspected.initial;
  first.freeAfterHL=inspected.free;
  first.maintenanceHL=inspected.maintenance;
  first.liquidationHL=inspected.liquidation;
  first.priceBufferHL=inspected.buffer;
  if (first.configuredPass || !inspected.leverageGrid?.length || !dec(ctx.checks.stress?.delayBps??'0').gt(0)) return first;
  let unresolved=first;
  for (const tier of inspected.leverageGrid) {
    if (tier.status!=='pass' || tier.leverage==null || Number(first.leverage)===tier.leverage) continue;
    const nextInspected=inspectRatio(ctx,point,{fixedLeverage:tier.leverage,includePathAudit:true});
    const row=recordFromInspection(ctx,nextInspected);
    row.leverageOptions=first.leverageOptions;
    row.leverageRange=first.leverageRange;
    row.initialMarginHL=nextInspected.initial;
    row.freeAfterHL=nextInspected.free;
    row.maintenanceHL=nextInspected.maintenance;
    row.liquidationHL=nextInspected.liquidation;
    row.priceBufferHL=nextInspected.buffer;
    if (row.configuredPass) return row;
    if (row.pressureSummary?.status==='unknown') unresolved=row;
  }
  return unresolved;
}
// Account equity is already in ledger units. Never substitute an exit quote for a flat Hype balance.
function closedHype(a, at, now, ttl) {
  if (a.error || a.unsupported || a.otherPositions || !specified(a.equity) || !specified(a.qty) ||
      !dec(a.qty).isZero() || a.orders?.length!==0) return null;
  if (a.sourceKind==='plan') return null; // The planning deposit is an opening balance.
  if (!['equity','qty','orders'].every(k=>fresh(fieldTime(a,k),now,ttl))) return null;
  const equityAt=Date.parse(fieldTime(a,'equity'));
  return equityAt>=Math.max(Date.parse(at),Date.parse(fieldTime(a,'qty'))) ? a.equity : null;
}
function observedEvaluation(r,a,now) {
  if (r.stage!=='challenge' || a.pf.error || !specified(a.pf.equity)) return null;
  const plan=a.pf.sourceKind==='plan', ttl=positive(r.accountSecs).toNumber()*1000;
  if (plan && !r.planCrossFlat) return null;
  const at=plan ? new Date(now).toISOString() : fieldTime(a.pf,'equity');
  const stamp=Date.parse(at), exam=examSchedule(r,now);
  if (exam.issue || !fresh(at,now,ttl) || stamp<exam.start || stamp>exam.cutoff) return null;
  const totalRule=parseTotalLoss(r.challengeFloor);
  const dailyRule=parseDailyLoss(r.challengeDailyMode, r.challengeDailyFloor);
  if (totalRule.state==='invalid' || dailyRule.state==='invalid') return null;
  const loss=resolveLossBoundary('challenge', a.pf.equity, totalRule, dailyRule);
  if (loss.effectiveFloor==null) {
    // Missing total loss floor: still recognize explicit pass target breach, never fabricate a failure close.
    if (specified(r.challengeTarget) && dec(a.pf.equity).gte(positive(r.challengeTarget))) {
      const close=evaluationClose({...r,challengeFloor:'0'},a.pf.equity,closedHype(a.hl,at,now,ttl),at,plan);
      if (close && a.hl.accountId) close.hypeSource=a.hl.accountId;
      return close;
    }
    return null;
  }
  const close=evaluationClose({...r,challengeFloor:loss.effectiveFloor},a.pf.equity,closedHype(a.hl,at,now,ttl),at,plan);
  if (close && a.hl.accountId) close.hypeSource=a.hl.accountId;
  return close;
}
export function calculateCurrent(r, a, data = {}, fxData = {}, now = Date.now(), options = {}) {
  if (r.evaluationClose) {
    const close=r.evaluationClose;
    const matching=!close.hypeSource || close.hypeSource===a.hl.accountId;
    const hype=close.hype ?? (matching ? closedHype(a.hl,close.at,now,positive(r.accountSecs).toNumber()*1000) : null);
    return {issues:[],notices:['考核已结算'],cash:{},qty:{},currentNotional:{},frameState:'paused',
      currencies:currencyMapping(data,fxData,now,3000,r.depegAlertBps??rules.depegAlertBps),
      evaluationClose:{...close,hype,personal:hype}};
  }
  r = splitReserves(r);
  // Keep real personal principal protection basis B (never zero it out!).
  // Only remove the unrequested arbitrary post-pass reserve R_success.
  const openingCapacity=options.openingCapacity===true && ['challenge','funded'].includes(r.stage) && r.mode==='auto';
  const isPlanning=a.pf.sourceKind==='plan' && a.hl.sourceKind==='plan';
  const principalBasis=openingCapacity?investmentBasis(r,isPlanning):null;
  const effective=openingCapacity?{...r,B:principalBasis??r.B,R_success:'0',recoveryBuffer:'0',successBuffer:'0'}:r;
  const result = computeCurrent(effective, a, data, fxData, now, {...options,openingCapacity});
  if (result.autoStatus === 'AUTO_FEASIBLE' && result.currencies?.warnings.length) {
    const required = requiredSpotAssets(result.currencies.pf, result.currencies.hl, r);
    if ([...required].some((asset) => result.currencies.spots[asset]?.alert)) {
      result.autoStatus = 'AUTO_PARTIAL';
      result.notices.push('账本所需的外币估值触及脱锚阈值');
    }
  }
  if (result.ratioScan) {
    const scan=result.ratioScan;
    if(options.compareDirection) {
      const ctx=result.pressureContext??scan.ctx;
      const cap=searchLiquidityMaximum(scan,point=>cashCandidate(ctx,point),false,ctx,'scale',null,options.fixedLot?.i,options.compareDirection);
      return {capacity:cap.row,status:cap.status,reason:cap.reason,theoreticalRatio:result.theoreticalRatio};
    }
    const makeReport=grid=>{
      const view={...result,ratioScan:grid};
      attachRepresentative(view,r);
      grid.analysis=analyzeRatios(view,r);
      grid.plans={...buildPlanReport(grid,false),pfQuote:result.currencies.pf.quoteAsset,
        hlQuote:result.currencies.hl.quoteAsset};
    };
    if(openingCapacity) {
      // The calculator publishes audited positions directly. Detailed ratio
      // histograms and the three historical optimizer reports live in analysis.
      scan.analysis={};
      scan.plans={rows:[],targetKeys:[null,null,null],eligible:0};
    } else makeReport(scan);
    const riskContext=result.pressureContext ?? scan.ctx;
    const configuredRows=riskContext===scan.ctx ? new Map(scan.plans.rows.map(row=>[row.key,row])) : new Map();
    // Every pressure candidate must also pass A. Its grid is a sufficient
    // search domain even when the report publishes the three base objectives.
    const evaluated=new Map();
    const inspect=point=>{
      const key=pointKey(point);
      if (!evaluated.has(key)) {
        if (evaluated.size>=64) evaluated.delete(evaluated.keys().next().value);
        evaluated.set(key,cashCandidate(riskContext,point));
      }
      return evaluated.get(key);
    };
    const pressure=searchLiquidityMaximum(scan,inspect,false,riskContext,'scale');
    const cash=openingCapacity?null:searchLiquidityMaximum(scan,inspect,false,riskContext,'cash',options.cashSeed);
    if(['challenge','funded'].includes(riskContext.book.stage)) {
      scan.plans.collection=buildCandidateSet(scan,riskContext,inspect,pressure,cash,data.termReference,now,data.source==='手工确认盘口'?null:data.hl);
      if(riskContext.book.stage==='challenge' && options.decision) scan.plans.decision=moveDecision(scan,riskContext,inspect,pressure,options.decision);
    }
    if(scan.plans.decision) scan.plans.decision.sourceKind=a.pf.sourceKind==='plan'?'plan':'account';
    const decision=scan.plans.decision, trial=options.decision?.trial;
    if(decision && trial) {
      const sign=decision.adopted;
      const level=decision.directions.find(d=>d.sign===sign).levels.find(l=>l.percent===decision.percent);
      const reserve=trial.field==='R'?'R_success':trial.field==='B'?'B':null;
      const compare=(value,oneSize=false)=>{
        const variant={...r}, accounts={...a,hl:{...a.hl}};
        if(reserve) variant[reserve]=value;
        else {
          const add=v=>out(dec(v).plus(value));
          accounts.hl.equity=add(a.hl.equity);
          if(specified(a.hl.free)) accounts.hl.free=add(a.hl.free);
          if(a.hl.directionalFree) accounts.hl.directionalFree=a.hl.directionalFree.map(add);
          if(trial.field==='depositB') variant.B=add(r.B);
        }
        const alt=calculateCurrent(variant,accounts,data,fxData,now,{scanRatios:true,baseObjectives:true,compareDirection:sign,
          fixedLot:oneSize?{i:level.requiredPosition.i,sign}:null});
        return {alt,variant};
      };
      const {alt,variant}=compare(trial.value), row=alt.capacity;
      // For a fixed Evaluation lot each extra cent of free Hype collateral
      // relaxes cash/margin checks. Raising B alongside it cancels its effect
      // only on the failure cash inequality. Reducing B or R also only relaxes.
      const limit=reserve?dec(r[reserve]).minus(trial.value):dec(trial.value);
      let minimum={reason:'请输入要比较的补资额或更低的门槛'};
      if(level.choice) minimum={change:'0'};
      else if(!level.complete || !level.requiredPosition.i) minimum={reason:'所需仓位或原方案核验不完整'};
      else if(limit.gt(0)) {
        const bound=limit.times(100).floor().toNumber();
        const check=cents=>{
          const change=dec(String(cents)).div(100);
          const test=compare(reserve?out(dec(r[reserve]).minus(change)):out(change),true).alt;
          return test.capacity?'pass':test.status==='none'?'fail':'unknown';
        };
        minimum={reason:'该比较范围内没有核实可行的补资或放宽额'};
        if(Number.isSafeInteger(bound) && bound>0) {
          // If the complete full search could not reach this PF size, no lot
          // in this direction at that input can realise the requested move.
          const end=alt.status==='none' || (row && row.i<level.requiredPosition.i)?'fail':check(bound);
          if(end==='pass') {
            let lo=0,hi=bound,known=true;
            while(hi-lo>1) {
              const mid=lo+Math.floor((hi-lo)/2), status=check(mid);
              if(status==='unknown'){known=false;break;}
              if(status==='pass') hi=mid;else lo=mid;
            }
            if(known) minimum={change:out(dec(String(hi)).div(100))};
          }
        }
      }
      decision.trial={...trial,minimum,reason:alt.reason??alt.issues?.join(' · '),theory:alt.theoreticalRatio,
        B:variant.B,R:variant.R_success,cap:row?{pf:row.pfValue,h:row.notionalRatio,hl:row.hypeValue,
        moves:row.pressureSummary.cases[0]?.success.exam?.percent,fail:row.pressureSummary.minFailure.value,
        pass:row.pressureSummary.minSuccess.value}:null};
    }
    scan.plans.cashPriority=cash;
    scan.plans.pressure=pressure;
    if(openingCapacity) result.autoStatus=pressure.status==='none'?'AUTO_INFEASIBLE':'AUTO_PARTIAL';
    let ordinary=scan;
    if (!openingCapacity && scan.ctx.checks.stress) {
      const cache=options.marketCache;
      ordinary=buildRatioScan(baseContext(scan.ctx),{cache:cache && {
        reuse:(slot,key,fn)=>cache.reuse('base-'+slot,key,fn)
      }});
      makeReport(ordinary);
      ordinary.plans.decision=scan.plans.decision;
      ordinary.plans.collection=scan.plans.collection;
      ordinary.plans.pressure=pressure;
      ordinary.plans.cashPriority=cash;
      result.baseScan=ordinary;
    }
    if (riskContext.checks.stress) {
      for (const target of ordinary.plans.rows) {
        const previous=configuredRows.get(target.key);
        const audit=previous && previous.leverage===target.leverage ? previous :
          recordFromInspection(riskContext,inspectRatio(riskContext,target,{
            fixedLeverage:target.leverage==null?null:Number(target.leverage),includePathAudit:true}));
        target.configuredPass=audit.configuredPass;
        target.pressureSummary=audit.pressureSummary;
        target.depthStatus=audit.depthStatus;
        target.liquidity=audit.liquidity;
        target.pathAudit=audit.pathAudit;
        target.coverage=audit.coverage;
        target.verification={...target.verification,stress:audit.verification.stress,
          path:audit.verification.path,liquidation:audit.verification.liquidation};
      }
    }
    delete result.pressureContext;
    if (result.autoStatus==='AUTO_FEASIBLE' &&
        (pressure.allSpecified.status!=='verified' || pressure.row?.coverage!=='verified' ||
        ordinary.plans.rows.some(row=>ordinary.plans.targetKeys.includes(row.key) && row.coverage!=='verified'))) {
      result.autoStatus='AUTO_PARTIAL';
      result.unverified=[...(result.unverified??[]),pressure.allSpecified.status==='unverified'
        ?pressure.allSpecified.reason:'部分目标的退出深度、路径资金或全仓数据未通过完整核验'];
    }
  }
  if (result.autoStatus==='AUTO_FEASIBLE' && !result.ratioScan && !result.needsSearch) {
    result.autoStatus='AUTO_PARTIAL';
    result.unverified=[...(result.unverified??[]),'未执行逐仓盘口与价格压力核验'];
  }
  result.missingFields = [];
  const add = (id, label) => {
    if (!result.missingFields.some((x) => x.label === label)) result.missingFields.push({ id, label });
  };
  if (result.autoStatus === 'AUTO_PARTIAL' || result.autoStatus === 'AUTO_DATA_BLOCKED') {
    for (const gap of result.inputGaps ?? []) add(gap.id, gap.text);
    for (const [field,label] of Object.entries(stressFields)) {
      if (field==='fundingDebit' && result.stress?.fundingScheduleError) continue;
      if (result.stress?.missing.includes(label)) add(field,label+'未配置');
      else if (result.stress?.zero.includes(label)) add(field,label+'采用零压力假设');
    }
    if (r.stage === 'challenge' && !result.deadline) add('deadline', '考核实际截止时间未配置');
    for (const label of [...result.issues, ...(result.unverified ?? [])]) {
      if (/压力未配置|零压力假设/.test(label) || result.inputGaps?.some((g) => g.text === label)) continue;
      const id = /杠杆|费率|额度/.test(label)
        ? 'hl-source'
        : /清算|全仓|持仓|挂单/.test(label)
          ? 'snapshot'
          : /规划/.test(label)
            ? 'funding-view'
            : /截止/.test(label)
              ? 'deadline'
              : /盘口|行情|报价|汇率|熔断/.test(label)
                ? 'connections'
                : /基准/.test(label)
                  ? 'ref'
                  : 'result-heading';
      add(id, label);
    }
  }
  if (result.deriveMoves) {
    // Quantities price the two conditional exits. Time reachability is still unverified.
    if (result.autoStatus==='AUTO_FEASIBLE') result.autoStatus='AUTO_PARTIAL';
    result.advice=null;
    result.adjust={};
  }
  if (!result.needsSearch) {
    result.trace = calculationTrace(r, a, data, fxData, now, options);
    const collection=result.ratioScan?.plans?.collection;
    if(collection) collection.snapshotId=result.trace.id;
  }
  return result;
}

function attachRepresentative(result, r) {
  const scan = result.ratioScan,
    candidate = result.candidate;
  const { market } = scan.ctx;
  let point, group, objective;
  if (candidate?.code === 'FEASIBLE') {
    const i = dec(candidate.vsTargetQuantity).abs().div(market.pf.step).toNumber();
    const j = dec(candidate.hlTargetQuantity).abs().div(market.hl.step).toNumber();
    const sign = dec(candidate.vsTargetQuantity).cmp(0);
    if (ratioSlice(scan, sign, i, 'eligible').some(([lo, hi]) => lo <= j && j <= hi)) {
      point = { i, j, sign };
      group = 'both';
      objective = result.preference?.objective ?? 'fixed';
    }
  }
  const eligible = scan.sets.eligible ?? scan.sets.both;
  if (eligible.largest && !Number(r.riskPreference) && point?.i !== eligible.largest.i) {
    point = eligible.largest;
    group = 'both';
    objective = 'max_pf';
  }
  if (!point) {
    group = ['both', 'protect', 'survive', 'risk'].find((k) => scan.sets[k].count);
    if (!group) return;
    point = scan.sets[group].largest;
    objective = 'diagnostic';
  }
  const row = inspectRatio(scan.ctx, point);
  if (!row.physical || (group === 'both' && !row.both)) throw Error('自动代表方案与网格风控结果不一致');
  const segment = ratioBin(scan.buckets, point);
  const segmentRange = scan.buckets[segment]?.ranges[group];
  if (!segmentRange) throw Error('自动代表方案缺少完整分段记录');
  for (const range of [scan.sets[group].range, segmentRange].filter(Boolean)) {
    for (const [key, amount] of [
      ['failure', row.fail],
      ['success', row.successPersonal],
      ['pfValue', row.pfValue],
      ['hlValue', row.hypeValue],
      ['pfQty', dec(row.pf).abs()],
      ['hlQty', dec(row.hl).abs()]
    ]) {
      const [lo, hi] = range[key];
      if (dec(lo).minus(amount).gt('1e-12') || dec(amount).minus(hi).gt('1e-12'))
        throw Error('自动代表方案超出所属区间 · ' + key);
    }
    if (
      row.initial != null &&
      (range.maxMargin == null || dec(row.initial).minus(range.maxMargin).gt('1e-12'))
    )
      throw Error('代表方案初始保证金超出分段统计');
    if (row.buffer != null && (range.minBuffer == null || dec(range.minBuffer).minus(row.buffer).gt('1e-12')))
      throw Error('代表方案清算距离与分段统计不符');
  }
  const buffer = nonnegative(r.recoveryBuffer || '0');
  if (objective !== 'diagnostic' && dec(row.failureVsProtection).lt(buffer))
    throw Error('自动方案未达到额外回收缓冲');
  scan.defaultPoint = point;
  scan.representative = {
    row,
    group,
    segment,
    objective,
    buffer: out(buffer),
    complete: !!result.search?.complete && scan.complete
  };
}

function computeCurrent(r, a, data, fxData, now, options) {
  const issues = [],
    result = {
      issues,
      cash: {},
      qty: {},
      currentNotional: {},
      notices: [],
      evaluationClose:observedEvaluation(r,a,now),
      leverageStatus: r.mode === 'auto' ? 'LEVERAGE_UNVERIFIED' : null,
      autoStatus: r.mode === 'auto' ? 'AUTO_DATA_BLOCKED' : null
    };
  const stage = r.stage,
    funded = stage === 'funded';
  const totalRule = funded
    ? resolveFundedTotalRule(r, r.resetBaseline ?? r.baseline ?? '10000')
    : parseTotalLoss(r.challengeFloor);
  const dailyRule = parseDailyLoss(
    funded ? r.fundedDailyMode : r.challengeDailyMode,
    funded ? r.fundedDailyFloor : r.challengeDailyFloor
  );
  if (totalRule.state === 'invalid') issues.push(totalRule.error);
  if (dailyRule.state === 'invalid') issues.push(dailyRule.error);
  const rawTarget = funded ? r.fundedTarget : r.challengeTarget;
  if (!funded && !specified(rawTarget)) issues.push('请填写考核通过净值（U）');
  if (funded && !options.openingCapacity && !specified(rawTarget)) issues.push('请填写 Funded 首次分成目标权益（U）');
  const withdrawal=funded ? {
    platformShare:r.platformShare, reset:out(positive(r.resetBaseline ?? '10000')),
    minimum:out(nonnegative(r.minimumProfit || '0')), fee:out(nonnegative(r.withdrawalFee || '0'))
  } : undefined;
  if(funded && !nonnegative(r.platformShare??out(dec('1').minus(r.share))).plus(nonnegative(r.share)).eq(1))
    throw Error('个人和平台分成比例之和必须为 100%');

  if (!funded) {
    const schedule=examSchedule(r,now);
    if(schedule.issue) issues.push(schedule.issue);
    if(Number.isFinite(schedule.start)) result.challengeStart=new Date(schedule.start).toISOString();
    if(Number.isFinite(schedule.cutoff)) r={...r,deadline:new Date(schedule.cutoff).toISOString(),
      deadlineBound:r.deadlineBound===r.deadline?new Date(schedule.cutoff).toISOString():r.deadlineBound};
  }
  const expired = !funded && r.deadline && Date.parse(r.deadline) <= now;
  if (expired) result.notices.push('考核已到期，待核对实际退出');
  const planning = a.pf.sourceKind === 'plan' && a.hl.sourceKind === 'plan';
  const ttl = positive(r.accountSecs).toNumber() * 1000;
  const ages = positive(r.quoteSecs).toNumber() * 1000;
  const clocks = Object.fromEntries(['pf', 'hl'].map((k) => [k, quoteClock(data[k], now, Math.min(3000,ages))]));
  const quoteOK = k => clocks[k].ok && !data.errors?.[k] && subscriptionHealthy(data,k,now);
  const usable = (k, field) => !a[k].error && (planning || fresh(fieldTime(a[k], field), now, ttl));
  const currencies = result.currencies = currencyMapping(data, fxData, now, ages, r.depegAlertBps ?? rules.depegAlertBps);
  result.inputGaps = [];
  const quotes = ['pf', 'hl']
    .flatMap((k) => [clocks[k].bookAt, clocks[k].markAt])
    .filter(Boolean)
    .map(Date.parse);
  const stamps = planning
    ? []
    : ['pf', 'hl']
        .flatMap((k) =>
          [
            'equity',
            'qty',
            'free',
            'orders',
            'marginMode',
            'otherHold',
            'leverage',
            'liquidation',
            'fee',
            'maxQty',
            'capacity'
          ]
            .filter((field) => specified(a[k][field]) || (field === 'free' && a[k].directionalFree))
            .map((field) => fieldTime(a[k], field))
        )
        .filter(Boolean)
        .map(Date.parse);
  const span = (times) =>
    times.length && times.every(Number.isFinite) ? Math.max(...times) - Math.min(...times) : null;
  result.timing = {
    clocks,
    quoteTTL: Math.min(3000,ages),
    accountTTL: ttl,
    quoteSkew: span(quotes),
    accountSkew: span(stamps),
    quoteLimit: nonnegative(r.quoteSkewMs ?? rules.quoteSkewMs).toNumber(),
    accountLimit: nonnegative(r.accountSkewSecs ?? rules.accountSkewSecs)
      .times(1000)
      .toNumber(),
    quoteAges: Object.fromEntries(['pf', 'hl'].map((k) => [k, clocks[k].bookAge])),
    accountAges: Object.fromEntries(
      ['pf', 'hl'].map((k) => [
        k,
        !planning && fieldTime(a[k], 'equity') ? now - Date.parse(fieldTime(a[k], 'equity')) : null
      ])
    )
  };
  if (result.timing.quoteSkew > result.timing.quoteLimit)
    issues.push('双边盘口或标记时间差超过阈值，行情熔断');
  if (result.timing.accountSkew > result.timing.accountLimit) issues.push('账户快照时间差超过阈值，账户熔断');
  if ((a.pf.sourceKind === 'plan') !== (a.hl.sourceKind === 'plan')) {
    issues.push('账户来源混用，禁止跨模式计算');
    return result;
  }
  result.deadline =
    !funded && r.deadline && Number.isFinite(Date.parse(r.deadline))
      ? new Date(r.deadline).toISOString()
      : null;
  result.stress = stressCoverage(r);
  if (result.stress.fundingScheduleError) {
    issues.push(result.stress.fundingScheduleError);
    result.inputGaps.push({id:'fundingRatesBps',text:result.stress.fundingScheduleError});
  }
  for (const k of ['pf', 'hl']) {
    const name = k === 'pf' ? 'VS' : 'Hype';
    for (const [field, label] of [
      ['equity', '权益'],
      ['qty', '持仓'],
      ['free', '可用保证金']
    ]) {
      const raw = field === 'free' ? (a[k].directionalFree ?? a[k].free) : a[k][field];
      const stamp = fieldTime(a[k], field);
      if (!specified(raw) || !usable(k, field))
        result.inputGaps.push({
          id: k + '-' + field,
          text:
            name +
            ' ' +
            label +
            (a[k].error ? '来源不可用' : !specified(raw) ? '未录入' : !stamp ? '缺少确认时间' : '已过期')
        });
    }
    const q = (result.qty[k] = usable(k, 'qty') ? optional(a[k].qty) : null);
    const leg = currencies.legs?.[k];
    const unit = leg && !(k === 'pf' && data.errors?.spec) ? dec(leg.multiplier).times(leg.pointToLedger.mid) : null;
    result.cash[k] = usable(k, 'equity') ?
      (unit ? equityAt(a[k], q, quoteOK(k) ? data[k]?.mark : null, unit) : optional(a[k].equity)) : null;
    if (unit && q != null && quoteOK(k) && data[k]?.mark)
      result.currentNotional[k] = out(dec(q).abs().times(unit).times(String(data[k].mark)));
  }
  const activeLoss = resolveLossBoundary(stage, result.cash.pf, totalRule, dailyRule);
  result.lossBoundary = activeLoss;
  if (activeLoss.breached || activeLoss.zeroSpace) issues.push(activeLoss.notice);
  else if (activeLoss.caseCode === 'E' && !options.openingCapacity) {
    issues.push(activeLoss.notice);
  }
  const floor = activeLoss.failureDefined
    ? activeLoss.effectiveFloor
    : (activeLoss.caseCode === 'E' && options.openingCapacity && result.cash.pf != null && dec(result.cash.pf).gt(0)
      ? out(dec(result.cash.pf).times('0.60'))
      : null);

  const profitBasis = investmentBasis(r, planning);
  const pendingPassCost = hasValue(r.passCost)
    ? out(nonnegative(String(r.passCost).trim()))
    : (profitBasis != null && result.cash.hl != null ? out(max(0, dec(profitBasis).minus(result.cash.hl))) : '0');
  let target = rawTarget;
  let autoFundedTarget = false;
  let fundedWBounds = null;
  if (funded && options.openingCapacity && result.cash.pf != null && result.cash.hl != null) {
    fundedWBounds = activeLoss.failureDefined
      ? solveFundedWBounds(pendingPassCost, activeLoss.effectiveSpace, result.cash.hl, r.share || '0.8', r.minimumProfit || '0')
      : null;
    if (!specified(target)) {
      autoFundedTarget = true;
      const baseLine = positive(r.baseline || '10000');
      if (fundedWBounds?.feasible && fundedWBounds.candidates.length) {
        const autoW = dec(fundedWBounds.candidates[0]);
        target = out(max(baseLine, dec(result.cash.pf)).plus(autoW));
      } else if (fundedWBounds?.feasible === false) {
        issues.push(fundedWBounds.reason);
      } else {
        issues.push('请填写 Funded 出金目标权益，或补齐 Funded 总止损底线以按真实规则求解 W');
      }
    }
  }
  const protection = options.openingCapacity && profitBasis != null
    ? profitBasis
    : out(nonnegative(r.B).plus(nonnegative(r.outsideCosts ?? '0')));
  if (nonnegative(r.registration ?? '0').gt(protection)) result.notices.push('保护目标低于已支付的报名费');
  // The personal ledger starts with Hype equity. Only the success path adds a projected PF share.
  result.marginHL =
    !a.hl.unsupported && usable('hl', 'free') ? (a.hl.directionalFree ?? optional(a.hl.free)) : null;
  result.protect = result.cash.hl ?? null;
  const p = {
    withdrawal,stage,
    E: result.cash.pf,
    C_hl: result.cash.hl,
    C_external: '0',
    inTransit: '0',
    C_ref: optional(r.ref),
    B: protection,
    floor,
    target,
    baseline: r.baseline,
    share: r.share,
    R: out(nonnegative(r.R_success).plus(nonnegative(r.successBuffer || '0'))),
    g: r.g,
    k: r.k,
    contributions: r.roundIn,
    withdrawals: r.roundOut
  };
  let terminal;
  if (p.E != null && p.C_hl != null && specified(p.floor) && specified(p.target)) {
    result.funding = { ...fundingInterval(p), R_success: r.R_success, R_free: r.R_free };
    result.theoreticalRatio=fundingInterval({...p,B:r.B,R:r.R_success},'0','0');
    result.range = solveBudgetBounds(p);
    if (result.range.min == null) result.range = null; // Terminal events need fresh positions and executable quotes below.
  }
  // Invalidate risk fields independently. Editing a quantity must never renew available collateral.
  a = Object.fromEntries(
    ['pf', 'hl'].map((k) => {
      const leg = { ...a[k] };
      for (const field of [
        'free',
        'leverage',
        'otherHold',
        'orders',
        'marginMode',
        'maxQty',
        'liquidation',
        'capacity',
        'fee'
      ]) {
        if (!usable(k, field)) leg[field] = null;
      }
      if (!usable(k, 'free')) leg.directionalFree = null;
      if (!usable(k, 'leverage') || leg.source !== 'Hype 主网 API') leg.configuredLeverage = null;
      return [k, leg];
    })
  );
  const market = currencies.ok && buildMarket(data, r, a, currencies);
  if(options.openingCapacity && market && !planning) {
    // Report what the recorded account can open at its active setting. A
    // prospective leverage increase does not provide current buying power.
    const active=a.hl.configuredLeverage??a.hl.leverage;
    if(active!=null && market.hl.exchangeMaxLeverage!=null)
      market.hl.exchangeMaxLeverage=validLeverageCap(active)?
        Math.min(Number(active),market.hl.exchangeMaxLeverage):null;
  }
  result.configuredLeverage =
    a.hl.source === 'Hype 主网 API' && usable('hl', 'leverage') ? (a.hl.configuredLeverage ?? null) : null;
  const { pf, hl } = result.qty;
  if (market && quoteOK('pf') && quoteOK('hl') && pf !== null && hl !== null && !dec(pf).isZero()) {
    const v = dec(normalizeExposure(pf, market.pf)),
      h = dec(normalizeExposure(hl, market.hl));
    result.currentH = out(h.abs().div(v.abs()));
    result.sameDirection = h.times(v).gt(0);
  }
  if (!planning && !funded && !r.deadline) result.notices.push('截止时间未录入');
  if (funded && p.C_ref == null) result.notices.push('缺少本轮起点，整轮收益及其比例上限未验证');
  for (const gap of result.inputGaps)
    if (!gap.id.endsWith('-free') || r.mode === 'auto') issues.push(gap.text);
  if (data.errors?.pf || data.errors?.hl || a.pf.error || a.hl.error)
    result.dataState = '接口或账户来源不可用';
  else if (
    result.inputGaps.some((g) => g.text.includes('过期')) ||
    ['pf', 'hl'].some((k) => data[k] && !quoteOK(k))
  )
    result.dataState = '数据过期';
  else if (result.inputGaps.some((g) => !g.id.endsWith('-free') || r.mode === 'auto') || !market)
    result.dataState = '等待数据';
  if (pf === null || hl === null) issues.push('持仓数量未录入，空仓请填 0');
  if (!currencies.ok) {
    result.dataState = currencies.error;
    issues.unshift(currencies.error);
  }
  if (!market) issues.push('等待已核实的双边合约与盘口');
  for (const k of ['pf', 'hl']) {
    if (!quoteOK(k))
      issues.push(
        (k === 'pf' ? 'VS' : 'Hype') +
          (data.errors?.[k]
            ? ' 行情接口断开：' + data.errors[k]
            : ' 行情缺失或过期 · ' +
              [
                !subscriptionHealthy(data,k,now) && '订阅或心跳未就绪',
                !clocks[k].bookOK && '盘口时间',
                !clocks[k].markOK && '标记价或时间',
                !clocks[k].depthOK && '盘口深度无效'
              ]
                .filter(Boolean)
                .join('、'))
      );
    if (a[k].error) issues.push(a[k].error);
    if (result.qty[k] != null && !dec(result.qty[k]).isZero() && !a[k].anchor)
      result.notices.push((k === 'pf' ? 'VS' : 'Hype') + ' 缺少快照标记价，沿用已确认权益');
    if (a[k].otherPositions)
      result.notices.push(
        (k === 'pf' ? 'VS' : 'Hype') + ' 含其他持仓，条件推演固定其余风险敞口，组合保证金未验证'
      );
  }
  if (data.errors?.spec) issues.push(data.errors.spec);
  if (data.errors?.specRisk) issues.unshift(data.errors.specRisk);
  if (market && !market.pf.open) issues.push('VS 合约休市');
  if (a.hl.unsupported) issues.push('Hype 资金池模式未验证');
  if (
    market &&
    !issues.some((v) => /熔断|来源混用/.test(v)) &&
    quoteOK('pf') &&
    quoteOK('hl') &&
    !data.errors?.spec &&
    pf != null &&
    hl != null &&
    p.E != null &&
    p.C_hl != null &&
    !a.hl.unsupported
  ) {
    // The account value already includes the open position. Only the exit execution and fee remain.
    let f;
    try {
      f = estimateFill(out(dec(pf).neg()), market.pf, market.pf.multiplier);
    } catch (e) {
      issues.push(reason(e.message));
      return result;
    }
    const net = f
      ? dec(p.E)
          .plus(
            dec(pf).times(market.pf.multiplier).times(market.pf.fx).times(dec(f.price).minus(market.pf.mark))
          )
          .minus(dec(f.notional).times(market.pf.fx).times(market.pf.rate))
      : dec(p.E);
    result.settlePF = out(net);
    if (funded) result.claim = profitSplit(out(net), r.baseline, r.share, withdrawal).user;
    if (p.C_hl != null && specified(p.floor) && specified(p.target)) {
      const netRange = solveBudgetBounds({ ...p, E: out(net) });
      terminal = netRange.min == null ? reason(netRange.code) : null;
      if (!terminal && result.funding?.lower == null) terminal = 'PF 标记权益已到边界，净结算尚待确认';
    }
  }
  if (terminal) {
    result.range = null;
    result.funding = null;
    result.notices.push(terminal);
    if (r.mode === 'auto') result.dataState = terminal;
  }
  if (r.mode === 'keepPF' && pf !== null && dec(pf).isZero())
    issues.push('PF 已确认空仓，保持 PF 时没有对冲基准');
  if (
    r.mode === 'keepHL' &&
    hl !== null &&
    dec(hl).isZero() &&
    result.range?.min &&
    dec(result.range.min).gt(0)
  )
    result.notices.push('Hype 已确认空仓，固定该仓位不能覆盖失败端资金缺口');
  if (r.mode === 'auto' && expired) result.autoStatus = 'AUTO_DEADLINE_EXIT_REQUIRED';
  else if (
    r.mode === 'auto' &&
    !issues.some((x) => /过期|缺失|未录入|请录入|断开|休市|确认时间|连接失败|熔断|来源混用/.test(x)) &&
    currencies.ok &&
    !terminal &&
    !result.stress.fundingScheduleError
  )
    result.autoStatus = 'AUTO_PARTIAL';
  if(expired && !terminal) {
    result.expiryOutcome={cash:null,reason:issues[0]??'缺少截止时刻双边盘口、标记价或持仓快照'};
    if(!issues.length && market) {
      const q=dec(result.qty.hl), leg=market.hl, fill=fillEvidence(out(q.neg()),leg);
      if(['noTrade','covered'].includes(fill.status)) {
        const net=dec(result.cash.hl).plus(q.isZero()?0:q.times(leg.multiplier).times(leg.fx)
          .times(dec(fill.vwap).minus(leg.mark))).minus(q.isZero()?0:
          q.abs().times(fill.vwap).times(leg.multiplier).times(leg.fx).times(leg.rate));
        if(quotes.length===4 && quotes.every(at=>at===Date.parse(r.deadline)) &&
          ['pf','hl'].every(k=>planning || ['equity','qty'].every(field=>Date.parse(fieldTime(a[k],field))<=Date.parse(r.deadline)))) {
          result.deadlineExit=out(net);
          result.expiryOutcome={cash:out(net),reason:null};
        }
        result.notices.push('按本次可见盘口退出，个人现金约 '+net.toFixed(2)+' U，待实际结算');
      } else result.expiryOutcome.reason='缺少足以全量退出的 Hype 盘口深度';
    }
  }
  if (result.evaluationClose || issues.length || terminal || expired) return result;
  const pos = {};
  const book = {
    withdrawal,mode: 'live_readonly',
    stage,
    status: funded ? 'FUNDED_ACTIVE' : 'CHALLENGE_ACTIVE',
    B: protection,
    baseline: r.baseline,
    share: r.share,
    fundedFloor: funded ? floor : r.fundedFloor,
    challengeFloor: funded ? r.challengeFloor : floor,
    challengeTarget: r.challengeTarget,
    challengeDeadlineAt: r.deadline || null,
    passTrigger: r.passTrigger || 'net_settlement',
    failureTrigger: r.failureTrigger || 'mark_equity',
    external:'0',
    ref: p.C_ref,
    transfers: {},
    payouts: {},
    roundIn: r.roundIn,
    roundOut: r.roundOut,
    positions: pos
  };
  for (const k of ['pf', 'hl']) {
    book[k] = result.cash[k];
    const qty = result.qty[k],
      leg = market[k];
    if (!dec(qty).isZero())
      pos[k] = {
        asset: data.asset,
        venue: k,
        pool: leg.pool,
        qty,
        entry: leg.mark,
        mark: leg.mark,
        multiplier: leg.multiplier,
        fx: leg.fx
      };
    if (a[k].otherPositions) leg.hold = null;
  }
  const sizes =
    r.mode !== 'joint'
      ? []
      : String(r.sizes || '')
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => out(positive(x)));
  const fundedPfCaps = data.spec ? [
    data.spec.fundedInitMarginRatio == null ? null : out(dec('1').div(positive(data.spec.fundedInitMarginRatio))),
    data.spec.maxLeverage, a.pf.maxLeverage, a.pf.leverage
  ].filter(specified) : [];
  const fundedBaseline = specified(r.baseline)
    ? r.baseline
    : (planning && specified(r.planPF) ? r.planPF : '10000');
  const fundedReset = specified(r.resetBaseline)
    ? r.resetBaseline
    : fundedBaseline;
  const fundedRules = {
    accountSize: planning && specified(r.planPF) ? r.planPF : fundedReset,
    baseline: fundedBaseline,
    resetBaseline: fundedReset,
    challengeTarget: r.challengeTarget,
    fundedLossMode: r.fundedLossMode === 'max_loss' ? 'max_loss' : 'floor',
    fundedMaxLoss: r.fundedMaxLoss ?? '',
    fundedFloor: r.fundedFloor,
    fundedDailyMode: r.fundedDailyMode,
    fundedDailyFloor: r.fundedDailyFloor ?? '',
    fundedTarget: r.fundedTarget,
    share: r.share,
    platformShare: r.platformShare,
    minimumProfit: r.minimumProfit || '0',
    withdrawalFee: r.withdrawalFee || '0',
    pfLeverage: fundedPfCaps.length
      ? out(fundedPfCaps.map((v) => positive(String(v))).reduce((x, y) => (x.lte(y) ? x : y)))
      : market.pf.leverage
  };
  const params = {
    openingCapacity:options.openingCapacity===true, mode: r.mode,
    sizes,
    target,
    sort: 'gain',
    profitBasis,
    pendingPassCost,
    passCostInput: hasValue(r.passCost) ? out(nonnegative(String(r.passCost).trim())) : null,
    lossBoundary: activeLoss,
    autoFundedTarget,
    fundedWBounds,
    registration: planning && specified(r.registration) ? out(nonnegative(r.registration)) : null,
    fundedRules,
    directions: [1, -1],
    baseReserve: out(nonnegative(r.R_success)),
    baseRecovery: funded ? protection : out(nonnegative(r.B)),
    successBuffer: out(nonnegative(r.successBuffer || '0')),
    R: p.R,
    g: r.g,
    k: r.k,
    objective: 'size',
    horizon:{holdHours:specified(r.holdHours)?out(positive(r.holdHours)):null,
      dailyUpPct:specified(r.dailyUpPct)?out(nonnegative(r.dailyUpPct)):null,
      twoDayUpPct:specified(r.twoDayUpPct)?out(nonnegative(r.twoDayUpPct)):null,
      twoDayDownPct:specified(r.twoDayDownPct)?out(nonnegative(r.twoDayDownPct)):null,
      dailyDownPct:specified(r.dailyDownPct)?out(nonnegative(r.dailyDownPct)):null},
    challengeStart:result.challengeStart,deadline:result.deadline,
    deadlineMark:
      result.deadline &&
      r.deadlineAsset === data.asset &&
      r.deadlineBound === r.deadline &&
      specified(r.deadlineMark)
        ? out(positive(r.deadlineMark))
        : null,
    movePct: result.deadline && specified(r.movePct) ? out(nonnegative(r.movePct)) : null
  };
  const exam=funded?null:examEnvelope(params.horizon,params.deadline,new Date(now).toISOString());
  if (exam) {
    for (const [direction, label, daily, twoDay] of [
      ['up','上涨','dailyUpPct','twoDayUpPct'], ['down','下跌','dailyDownPct','twoDayDownPct']
    ]) {
      if (exam[direction]!=null) continue;
      if (params.horizon[daily]!=null || params.horizon[twoDay]!=null || exam.expired) {
        const reason=exam.expired?'考核窗口已结束':'考核期限内可达性未知，48 小时'+label+'上限须至少等于 24 小时上限';
        result.issues.push(reason);
        result.inputGaps.push({id:exam.expired?'deadline':twoDay,text:reason});
        return result;
      }
      exam.deriveMoves=true;
    }
    result.deriveMoves=exam.deriveMoves===true;
  }
  const checks = {
    passTrigger: book.passTrigger,
    failureTrigger: book.failureTrigger,
    exam,examEquityFloor:!funded && specified(r.examEquityFloor)?out(nonnegative(r.examEquityFloor)):null,
    exitDelaySeconds:out(nonnegative(r.exitDelaySeconds || '0')),
    currentSnapshot: true,
    hardDepthD: r.hardDepthD === 'required',
    liveLimits: true,
    basisBps: specified(r.adverseBps) ? out(nonnegative(r.adverseBps)) : null,
    basisRate: currencies.hypeToVest?.mid ?? null,
    venueScenarios:Object.fromEntries(venueFields.map(k=>
      [k,specified(r[k])?out(nonnegative(r[k])):null])),
    fullStress: !result.stress.missing.length && !result.stress.zero.length && currencies.hypeToVest?.mid != null,
    pressureInputs:{basis:r.adverseBps,async:r.asyncBps,delay:r.delayBps,jump:r.jumpBps,
      funding:specified(r.fundingDebit) ? r.fundingDebit : result.stress.fundingRatesBps.length ? '0' : r.fundingDebit},
    fundingRatesBps:result.stress.fundingRatesBps,
    asyncBps:specified(r.asyncBps) ? out(nonnegative(r.asyncBps)) : null,
    adverseBps: out(nonnegative(r.adverseBps || '0')),
    minMaintenanceSurplus: out(nonnegative(r.minMaintenanceSurplus || '0')),
    minPriceBuffer: out(nonnegative(r.minBuffer ?? '0')),
    now: new Date(now).toISOString()
  };
  if (result.stress.positive.length || Object.values(checks.venueScenarios).some(v=>v!=null && dec(v).gt(0)) || dec(checks.exitDelaySeconds).gt(0))
    checks.stress = {
      asyncBps: r.asyncBps || '0',
      jumpBps: r.jumpBps || '0',
      basisBps: r.adverseBps || '0',
      delayBps: r.delayBps || '0',
      fundingDebit: r.fundingDebit || '0'
    };
  const fixedScan = ['keepPF', 'keepHL'].includes(r.mode) && (options.deferAuto || options.scanRatios);
  let canScan = r.mode === 'auto' || fixedScan;
  if (canScan) {
    result.leverageStatus = 'LEVERAGE_UNVERIFIED';
    const missing = [];
    if(options.openingCapacity && !planning && !validLeverageCap(a.hl.configuredLeverage??a.hl.leverage))
      missing.push('Hype 当前账户杠杆');
    for (const [key, label] of [
      ['pf', 'VS'],
      ['hl', 'Hype']
    ]) {
      const l = market[key];
      if (!Array.isArray(a[key].orders)) missing.push(label + ' 未成交挂单');
      else if (
        a[key].orders.some((o) => o.conditional || o.reduceOnly) ||
        new Set(a[key].orders.map((o) => dec(o.qty).isNegative())).size > 1
      )
        missing.push(label + ' 条件、只减仓或双向挂单成交顺序');
      else l.pendingQty = out(a[key].orders.reduce((sum, o) => sum.plus(o.qty), dec('0')));
      if (
        dec(result.qty[key]).isZero() &&
        a[key].flatConfirmedAt &&
        fresh(a[key].flatConfirmedAt, now, ttl) &&
        !a[key].otherPositions &&
        a[key].orders?.length === 0 &&
        l.marginMode === 'cross' &&
        l.free != null
      ) {
        // The confirmed empty pool has no position/order IM. An independently
        // lower trading allowance remains a capacity limit, not margin used.
        if (l.hold == null && a[key].source !== 'Hype 主网 API') l.hold = '0';
      }
      if (l.marginMode !== 'cross') missing.push(label + ' 全仓模式（逐仓及未知模式的清算未验证）');
      if (key === 'hl') {
        if (
          l.hold === '0' ||
          (a.hl.flatConfirmedAt && fresh(a.hl.flatConfirmedAt, now, ttl) && !a.hl.otherPositions) ||
          (a.hl.source === 'Hype 主网 API' && !a.hl.otherPositions)
        )
          l.otherMaintenance = '0';
        else if (l.hold != null) missing.push('其他占用对应的全仓维持保证金');
        if (!l.exchangeMaxLeverage || !l.tiers?.length || data.hl.onlyIsolated)
          missing.push('Hype 合约杠杆上限、全仓资格或维持保证金档位');
        if (a.hl.crossPoolVerified === false) missing.push('Hype 独立全仓抵押池权益');
        if (!l.configuredLeverage && !planning)
          result.notices.push('当前 Hype 杠杆设置未知，按交易所合法档位计算条件方案');
      } else if (!l.leverage || !l.tiers?.length) missing.push('VS 初始或维持保证金规则');
      if (l.hold == null) missing.push(label + ' 其他仓位及挂单占用');
      if (l.free == null && !l.directionalFree) missing.push(label + ' 实际可用抵押品');
    }

    if (missing.length) {
      if (!fixedScan) {
        result.autoStatus = 'AUTO_PARTIAL';
        issues.push('资金比例可算，待确认 ' + missing.join('、'));
        return result;
      }
      canScan = false;
      result.notices.push('固定侧比例网格待确认 ' + missing.join('、'));
    }
    result.leverageStatus =
      !planning &&
      result.configuredLeverage &&
      a.hl.crossPoolVerified === true &&
      !a.hl.otherPositions &&
      a.hl.otherHold === '0'
        ? 'ACCOUNT_MODEL'
        : 'LEVERAGE_UNVERIFIED';
    checks.accountVerified =
      result.leverageStatus === 'ACCOUNT_MODEL' &&
      !!market.hl.capacity &&
      a.hl.fee != null &&
      !a.pf.otherPositions;
    if (checks.accountVerified) checks.crossAccount = a.hl;
    if (options.deferAuto && canScan) {
      if (missingPressureRate(checks) && !checks.hardDepthD) {
        issues.push('已配置跨平台压力，等待有效的双边报价币换算汇率');
        return result;
      }
      result.needsSearch = true;
      return result;
    }
  }
  if (options.searchBudget != null) checks.searchBudget = options.searchBudget;
  if (
    options.scanRatios &&
    canScan &&
    market.hl.marginMode === 'cross' &&
    market.hl.tiers?.length &&
    market.pf.tiers?.length
  ) {
    const ctx = scanContext(book, market, { ...params, recoveryBuffer: out(nonnegative(r.recoveryBuffer || '0')) }, checks);
    const separateStress=options.baseObjectives && checks.stress;
    if (separateStress) result.pressureContext=ctx;
    const scan = (result.ratioScan = buildRatioScan(separateStress ? baseContext(ctx) : ctx, { cache: options.marketCache, fixedLot:options.fixedLot, searchDirection:options.compareDirection }));
    if(options.compareDirection || options.openingCapacity) return result;
    // A complete empty risk intersection rules out every nonzero candidate.
    // Existing holdings still need their own path audit even when no new target is admissible.
    if (options.baseObjectives && r.mode==='auto' && exam && scan.complete && scan.sets.legal.count &&
        !scan.sets.risk.count) {
      result.autoStatus=!dec(hl).isZero() && market.hl.currentMarginCredit==null?'AUTO_PARTIAL':'AUTO_INFEASIBLE';
      result.flatHold=dec(pf).isZero() && dec(hl).isZero() && [a.pf,a.hl].every(leg=>leg.orders?.length===0);
      attachHeldCash(result,book,market,p,pf,hl,checks,protection);
      result.issues.push('考核期限和途中风控约束下没有可行仓位');
      return result;
    }
    const feasible = scan.sets.both;
    checks.seeds = [feasible.largest, feasible.min, feasible.max].filter(Boolean).map((point) => ({
      vsTargetQuantity: out(dec(market.pf.step).times(point.i).times(point.sign)),
      hlTargetQuantity: out(dec(market.hl.step).times(point.j).times(-point.sign))
    }));
  }
  if (options.seedTargets?.length) checks.seeds = [...(checks.seeds ?? []), ...options.seedTargets];
  const solverChecks = options.marketCache ? { ...checks, marketCache: options.marketCache } : checks;
  const solverBook = { ...book, B: out(dec(book.B).plus(nonnegative(r.recoveryBuffer || '0'))) };
  let solved =
    r.mode === 'auto'
      ? solveAuto(solverBook, market, params, solverChecks)
      : solve(solverBook, market, params, checks);
  if (r.mode === 'auto' && solved.selected) {
    const size = solved;
    const cash = solveAuto(
      solverBook,
      market,
      { ...params, objective: 'cash' },
      { ...solverChecks, seeds: size.candidates, searchBudget: options.cashSearchBudget ?? 1400 }
    );
    const creditKnown = hl === '0' || market.hl.currentMarginCredit != null;
    result.domain = size.domain;
    result.pressure = size.pressure;
    result.maximum = {
      amount: size.selected.vsNotional,
      candidate: size.selected,
      search: size.coverage,
      complete: size.searchComplete && creditKnown
    };
    result.conservative = {
      candidate: cash.selected,
      search: cash.coverage,
      complete: cash.searchComplete && creditKnown
    };
    result.comparison = comparePlans(size.selected, cash.selected);
    const preference = nonnegative(r.riskPreference ?? '0');
    if (preference.gt(100)) throw Error('风险偏好须在 0 至 100 之间');
    if (preference.gt(0) && cash.selected) {
      params.cashFloor = out(
        dec(size.selected.worstCash).plus(preference.div(100).times(result.comparison.worstGain))
      );
      solved = preference.eq(100)
        ? cash
        : solveAuto(solverBook, market, params, { ...solverChecks, seeds: [cash.selected] });
    }
    result.preference = {
      percent: out(preference),
      floor: params.cashFloor ?? size.selected.worstCash,
      sizeFloor: size.selected.worstCash,
      cashFloor: cash.selected?.worstCash ?? null,
      endpointsComplete: result.maximum.complete && result.conservative.complete,
      objective: preference.eq(100)
        ? 'max_min_cash'
        : preference.isZero()
          ? 'max_pf'
          : 'max_pf_with_cash_floor'
    };
    if (preference.gt(0) && !result.preference.endpointsComplete) solved.searchComplete = false;
    for (const plan of [result.maximum, result.conservative])
      if (plan.candidate) plan.audit = auditCross(market.hl, a.hl, plan.candidate, planning);
  }
  if (r.mode === 'auto') {
    const creditUnknown = hl !== '0' && market.hl.currentMarginCredit == null;
    if (creditUnknown) {
      result.notices.push('现仓占用的可释放初始保证金未经确认，按零释放核算');
      solved.searchComplete = false;
      if (solved.code === 'AUTO_INFEASIBLE') solved.code = 'AUTO_PARTIAL';
    }
    result.autoStatus = solved.code;
    result.domain ??= solved.domain;
    result.search = {
      complete: solved.searchComplete,
      evaluations: solved.evaluations,
      nodes: solved.nodes,
      ...solved.coverage
    };
    if (
      solved.selected?.candidateLeverage &&
      market.hl.configuredLeverage &&
      solved.selected.candidateLeverage !== Number(market.hl.configuredLeverage)
    ) {
      result.leverageStatus = 'LEVERAGE_UNVERIFIED';
      result.notices.push('建议档位与当前设置不同，变更后的实际可开额度须由交易所新快照确认');
    }
    result.top = solved.candidates;
    result.rejections = solved.rejected.map((c) => ({
      pf: c.vsTargetQuantity,
      hl: c.hlTargetQuantity,
      candidate: c,
      why: reason(c.constraints?.find((x) => x.status === 'fail')?.code ?? c.code),
      gaps: (c.constraints ?? []).filter((x) => x.status !== 'pass'),
      check: c.constraints?.find((x) => x.status === 'fail')
    }));
    result.waiting = solved.hold;
    result.pressure ??= solved.pressure;
    if (solved.code === 'AUTO_HOLD' && !solved.selected) result.flatHold = true;
    if (solved.selected) {
      const missing = [];
      if (planning) missing.push('账户资金采用预设规划');
      for (const [side, name] of [
        ['pf', 'PF'],
        ['hl', 'Hype']
      ]) {
        if (!dec(result.qty[side]).isZero() && !a[side].anchor)
          missing.push(name + ' 非空现仓的权益标记价待确认');
      }
      if (result.leverageStatus !== 'ACCOUNT_MODEL') missing.push('实际杠杆设置或调档后可用额度待核实');
      if (result.stress.missing.length || result.stress.zero.length) missing.push(result.stress.label);
      if (specified(r.adverseBps) && checks.basisRate == null) missing.push('基差路径所需的同刻参考汇率');
      if (!market.hl.capacity || a.hl.fee == null) missing.push('Hype 账户实际可开额度或费率待核实');
      if (a.pf.otherPositions || a.hl.otherPositions) missing.push('其他持仓的组合风险待核实');
      if (!funded && !result.deadline) missing.push('考核截止时间待确认');
      if (funded && p.C_ref == null) missing.push('整轮收益基准待确认');
      if (!solved.searchComplete) missing.push('当前偏好的仓位搜索尚未证实最优');
      result.audit = auditCross(market.hl, a.hl, solved.selected, planning);
      if (result.audit.gaps.length) missing.push('清算条件估算 · ' + result.audit.gaps.join('、'));
      result.conservative.unverified = [...missing];
      if (
        result.conservative.candidate?.candidateLeverage &&
        result.conservative.candidate.candidateLeverage !== Number(result.configuredLeverage)
      )
        result.conservative.unverified.push('保守方案所需的账户杠杆或调档后额度待核实');
      result.unverified = missing;
      if (missing.length) result.autoStatus = 'AUTO_PARTIAL';
    }
    if (solved.selected && params.movePct && !funded) {
      const sign = dec(solved.selected.vsTargetQuantity).gt(0) ? 1 : -1;
      const shift = dec(market.pf.mark).times(params.movePct).div(100).times(sign).div(market.pf.factor);
      try {
        result.stressedEquity = out(
          projectSettlementEquity(book, market, 'pf', solved.selected.vsTargetQuantity, out(shift))
        );
      } catch {
        result.notices.push('两日压力价格超出有效范围');
      }
    }
    const bad =
      solved.rejected.find((c) => c.constraints?.some((x) => x.status === 'fail')) ?? solved.rejected[0];
    const check = bad?.constraints?.find((x) => x.status === 'fail');
    if (bad)
      result.eliminated = {
        pf: bad.vsTargetQuantity,
        hl: bad.hlTargetQuantity,
        why: reason(check?.code ?? bad.code),
        check
      };
  }
  result.exactRange = solved.theory;
  const c = solved.selected;
  if (!c) {
    attachHeldCash(result,book,market,p,pf,hl,checks,protection);
    const rejected = solved.rejected.find((x) => x.constraints?.some((t) => t.status === 'fail'));
    const miss = rejected?.constraints.find((x) => x.status === 'fail');
    issues.push(
      reason(solved.code) +
        (miss
          ? ' · ' +
            reason(miss.code) +
            '，实算 ' +
            dec(miss.actual).toFixed(2) +
            ' / 要求 ' +
            dec(miss.required).toFixed(2) +
            '，差 ' +
            dec(miss.shortfall).toFixed(2) +
            ' ' +
            miss.unit
          : '')
    );
    return result;
  }
  if (r.mode !== 'auto' && c.initialMargin?.[1] != null && market.hl.hold != null) {
    c.otherInitialMargin = market.hl.hold;
    c.requiredInitialMargin = out(dec(c.initialMargin[1]).minus(market.hl.hold));
    c.availableAfter = c.constraints.find((x) => x.code === 'hl_FREE_RESERVE')?.actual ?? null;
  }
  result.candidate = c;
  if (dec(c.hlTargetQuantity).eq(0)) result.notices.push('Hype 目标为空仓，PF 保留单边敞口');
  const verified = solved.candidates.filter((x) => x.code === 'FEASIBLE');
  if (verified.length) {
    const ratios = (solved.ratios ?? verified.map((x) => x.actualRatio)).map(dec).sort((a, b) => a.cmp(b));
    result.verified = { min: out(ratios[0]), max: out(ratios.at(-1)), count: new Set(ratios.map(out)).size };
  }
  result.riskMissing = [];
  result.points = verified.length
    ? [...new Set(solved.ratios ?? verified.map((x) => x.actualRatio))]
        .map(dec)
        .sort((a, b) => a.cmp(b))
        .map(out)
    : [];
  result.costs = {};
  for (const [key, label, targetQty, delta] of [
    ['pf', 'VS', c.vsTargetQuantity, c.vsDeltaQuantity],
    ['hl', 'Hype', c.hlTargetQuantity, c.hlDeltaQuantity]
  ]) {
    const l = market[key];
    if (l.marginMode !== 'cross') result.riskMissing.push(label + ' 全仓模式');
    if (!l.leverage && !(key === 'hl' && result.candidate?.candidateLeverage) && !dec(targetQty).isZero())
      result.riskMissing.push(label + ' 当前杠杆');
    if (!l.tiers?.length) result.riskMissing.push(label + ' 维持保证金档位');
    if (l.hold == null) result.riskMissing.push(label + ' 其他占用');
    if (!dec(delta).eq(0) && l.free == null && !l.capacity) result.riskMissing.push(label + ' 可用保证金');
    result.costs[key] = {
      entry: executionDetail(l, delta),
      fail: executionDetail(l, out(dec(targetQty).neg()), c.lines.fail),
      pass: executionDetail(l, out(dec(targetQty).neg()), c.lines.pass)
    };
  }
  result.audit ??= auditCross(market.hl, a.hl, c, planning);
  result.paths = c.paths ?? c.funding?.paths ?? {};
  for (const path of ['fail', 'pass']) {
    if (result.paths[path]) continue;
    const legs = {};
    for (const [side, target, delta] of [
      ['pf', c.vsTargetQuantity, c.vsDeltaQuantity],
      ['hl', c.hlTargetQuantity, c.hlDeltaQuantity]
    ]) {
      const costs = result.costs[side];
      legs[side] = settlementBridge(
        result.cash[side],
        market[side],
        target,
        delta,
        c.lines[path],
        costs.entry,
        costs[path],
        side === 'hl' ? r.k : '0'
      );
    }
    result.paths[path] = legs;
  }
  result.bridge = result.paths.fail.hl;
  result.failVsPrincipal = out(dec(c.failureCash).minus(protection));
  result.passVsPrincipal = out(dec(c.pressureCashAfter).minus(protection));
  result.adjust = {};
  for (const [k, delta] of [
    ['pf', c.vsDeltaQuantity],
    ['hl', c.hlDeltaQuantity]
  ])
    result.adjust[k] = remainingOrder(delta, result.qty[k], a[k].orders);
  if (a.pf.orders?.length && r.mode === 'keepPF') {
    result.adjust.hl = { ...result.adjust.hl, remaining: null, text: 'PF 已有挂单，成交后需重算' };
    result.notices.push('PF 有未成交订单，Hype 目标按当前已成交 PF 测算');
  }
  if (a.hl.orders?.length && r.mode === 'keepHL') {
    result.adjust.pf = { ...result.adjust.pf, remaining: null, text: 'Hype 已有挂单，成交后需重算' };
    result.notices.push('Hype 有未成交订单，VS 目标按当前已成交 Hype 测算');
  }
  if (r.mode === 'auto') {
    result.advice = adjustmentTarget(
      book,
      market,
      params,
      checks,
      c,
      options.priorTarget,
      r.rebalanceSteps ?? '2'
    );
    for (const [i, k] of ['pf', 'hl'].entries()) {
      const delta = out(dec(result.advice.pair[i]).minus(result.qty[k]));
      result.adjust[k] = remainingOrder(delta, result.qty[k], a[k].orders);
    }
    if (result.audit.mathMatches === false) {
      result.advice = null;
      result.adjust = {};
    }
  }
  result.forward = out(dec(c.pressureCashAfter).minus(p.C_hl));
  result.round =
    c.roundGain ??
    (p.C_ref === null
      ? null
      : out(dec(c.pressureCashAfter).minus(p.C_ref).minus(p.contributions).plus(p.withdrawals)));
  return result;
}
