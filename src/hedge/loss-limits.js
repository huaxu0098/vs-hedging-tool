// R11 / P0 loss-limit resolution: Total loss limit is mandatory (never "none");
// Daily loss limit is optional per account ("provided" | "none" | "missing").
// Numeric 0 is a valid value and must never be coerced to empty or "none".
import { dec, out, max, nonnegative } from './math.js';

export const hasValue = (v) => v != null && String(v).trim() !== '';

export function parseTotalLoss(rawFloor) {
  if (!hasValue(rawFloor)) return { state: 'missing', floor: null };
  try {
    return { state: 'provided', floor: out(nonnegative(String(rawFloor).trim())) };
  } catch (e) {
    return { state: 'invalid', floor: null, error: '总止损底线无效：' + e.message };
  }
}

export function parseDailyLoss(mode, rawFloor) {
  const m = String(mode ?? '').trim();
  if (m === 'none') return { state: 'none', floor: null };
  if (m === 'provided') {
    if (!hasValue(rawFloor)) return { state: 'missing', floor: null, reason: '已选有日止损，但未填写当日日止损底线' };
    try {
      return { state: 'provided', floor: out(nonnegative(String(rawFloor).trim())) };
    } catch (e) {
      return { state: 'invalid', floor: null, error: '日止损底线无效：' + e.message };
    }
  }
  return { state: 'missing', floor: null, reason: '日止损适用状态尚未确认' };
}

// Compute Funded fixed total stop-loss floor L = S - D (fixed equity floor; NEVER moves with profit or claims):
// - mode 'floor': explicit fixed floor L (if blank -> missing, never fabricated).
// - mode 'max_loss': derived from account original size S minus max allowed drawdown D (L = S - D).
// - Legacy 'exam_target' is disabled as a default path (Silver/Gold Funded drawdown equals account max drawdown, NOT eval profit target).
export function resolveFundedTotalRule(r, fundedStartRaw) {
  const mode = r.fundedLossMode || 'floor';
  const startRaw = fundedStartRaw ?? r.resetBaseline ?? r.baseline ?? r.planPF;
  if (mode === 'exam_target') {
    const parsedFloor = parseTotalLoss(r.fundedFloor);
    if (parsedFloor.state === 'provided') {
      return { ...parsedFloor, fixedFloor: parsedFloor.floor, derivedFrom: 'floor', sourceLabel: '固定止损底线 L（已停用按考核目标推算）' };
    }
    return {
      state: 'missing',
      floor: null,
      reason: '禁止按考核盈利目标推算 Funded 最大回撤；请按公式 L = S − D 填写固定止损底线或最大允许回撤 D'
    };
  }
  if (mode === 'max_loss') {
    if (!hasValue(r.fundedMaxLoss)) return { state: 'missing', floor: null, reason: '请填写 Funded 最大允许回撤额 D' };
    if (!hasValue(startRaw)) return { state: 'missing', floor: null, reason: '缺少 Funded 账户原始规模 S，无法计算 L = S − D' };
    try {
      const start = nonnegative(String(startRaw));
      const lossAmt = nonnegative(String(r.fundedMaxLoss).trim());
      const floor = start.minus(lossAmt);
      if (floor.lt(0)) return { state: 'invalid', floor: null, error: 'Funded 最大允许回撤额 D 超过账户原始规模 S' };
      return {
        state: 'provided',
        floor: out(floor),
        fixedFloor: out(floor),
        accountSize: out(start),
        allowedLoss: out(lossAmt),
        derivedFrom: 'max_loss',
        sourceLabel: '固定底线 L = S − D（' + out(start) + ' − ' + out(lossAmt) + '）'
      };
    } catch (e) {
      return { state: 'invalid', floor: null, error: 'Funded 最大允许回撤额 D 无效：' + e.message };
    }
  }
  const parsed = parseTotalLoss(r.fundedFloor);
  if (parsed.state === 'provided') {
    let allowedLoss = null;
    try {
      if (hasValue(startRaw)) allowedLoss = out(dec(String(startRaw)).minus(parsed.floor));
    } catch {}
    return {
      ...parsed,
      fixedFloor: parsed.floor,
      accountSize: hasValue(startRaw) ? out(dec(String(startRaw))) : null,
      allowedLoss,
      derivedFrom: 'floor',
      sourceLabel: '固定权益止损底线 L'
    };
  }
  return parsed;
}

// Implements R11 Section 4 Cases A through G.
export function resolveLossBoundary(stage, equityRaw, totalRule, dailyRule) {
  const stageLabel = stage === 'funded' ? 'Funded' : '考核';
  const equity = hasValue(equityRaw) ? dec(String(equityRaw)) : null;
  const totalProvided = totalRule.state === 'provided' && totalRule.floor != null;
  const dailyProvided = dailyRule.state === 'provided' && dailyRule.floor != null;
  const dailyNone = dailyRule.state === 'none';

  const totalSpace = equity != null && totalProvided ? out(equity.minus(totalRule.floor)) : null;
  const dailySpace = equity != null && dailyProvided ? out(equity.minus(dailyRule.floor)) : null;

  let effectiveFloor = null;
  let bindingSource = null;
  if (totalProvided && dailyProvided) {
    const cmp = dec(dailyRule.floor).cmp(totalRule.floor);
    effectiveFloor = cmp > 0 ? dailyRule.floor : totalRule.floor;
    bindingSource = cmp > 0 ? 'daily' : cmp < 0 ? 'total' : 'both_equal';
  } else if (totalProvided) {
    effectiveFloor = totalRule.floor;
    bindingSource = 'total';
  } else if (dailyProvided) {
    effectiveFloor = dailyRule.floor;
    bindingSource = 'daily';
  }

  const effectiveSpace = equity != null && effectiveFloor != null ? out(equity.minus(effectiveFloor)) : null;
  const breached = effectiveSpace != null && dec(effectiveSpace).lt(0);
  const zeroSpace = effectiveSpace != null && dec(effectiveSpace).isZero();

  let caseCode;
  let notice;
  if (breached) {
    caseCode = 'G';
    notice = stageLabel + '当前权益已低于有效止损底线（' + effectiveFloor + ' U，已越界），不输出新开仓方案';
  } else if (zeroSpace) {
    caseCode = 'F';
    notice = stageLabel + '当前无新增亏损空间（有效剩余空间 0 U，底线 ' + effectiveFloor + ' U）';
  } else if (totalProvided && dailyNone) {
    caseCode = 'A';
    notice = stageLabel + '无日止损，按总止损底线 ' + totalRule.floor + ' U（剩余空间 ' + (totalSpace ?? '—') + ' U）';
  } else if (totalProvided && dailyProvided) {
    caseCode = 'B';
    notice = bindingSource === 'daily'
      ? stageLabel + '日止损 ' + dailyRule.floor + ' U（剩 ' + dailySpace + ' U）早于总止损 ' + totalRule.floor + ' U（剩 ' + totalSpace + ' U），按日止损先触发'
      : bindingSource === 'both_equal'
        ? stageLabel + '总止损与日止损底线均为 ' + totalRule.floor + ' U'
        : stageLabel + '总止损 ' + totalRule.floor + ' U（剩 ' + totalSpace + ' U）早于日止损 ' + dailyRule.floor + ' U（剩 ' + dailySpace + ' U），按总止损先触发';
  } else if (totalProvided && !dailyNone) {
    caseCode = 'C';
    notice = stageLabel + '已按总止损底线 ' + totalRule.floor + ' U 测算，但日止损配置未填（不能排除更早日线触发）';
  } else if (!totalProvided && dailyProvided) {
    caseCode = 'D';
    notice = stageLabel + '已按日止损底线 ' + dailyRule.floor + ' U 测算，但必需的总止损未填写（不能确认最早失败边界）';
  } else {
    caseCode = 'E';
    notice = stageLabel + '缺少必需的总止损数据，失败触发价与回本结果暂无法计算（保留其他可算结果）';
  }

  return {
    stage,
    totalRule,
    dailyRule,
    effectiveFloor,
    effectiveSpace,
    totalSpace,
    dailySpace,
    bindingSource,
    caseCode,
    failureDefined: effectiveFloor != null && !breached && !zeroSpace,
    failureComplete: caseCode === 'A' || caseCode === 'B',
    breached,
    zeroSpace,
    notice
  };
}

// Exact mathematical bounds for Funded withdrawal W under dual strictly-positive profit:
//   Failure > 0: r_F * D_F - C > 0  =>  r_F > C / D_F
//   Payout  > 0: (a - r_F) * W - C > 0  =>  r_F < a - C / W
//   Pre-payout survival: H_1 - r_F * W > 0  =>  r_F < H_1 / W
// No arbitrary W constants are invented; candidates come strictly from (W_min, W_max_cash).
export function solveFundedWBounds(passCostRaw, lossSpaceRaw, realCashRaw, shareRaw, minProfitRaw = '0') {
  if (passCostRaw == null || lossSpaceRaw == null || realCashRaw == null) {
    return { feasible: null, code: 'INCOMPLETE_INPUTS', candidates: [] };
  }
  const C = dec(passCostRaw);
  const D = dec(lossSpaceRaw);
  const H = dec(realCashRaw);
  const a = dec(shareRaw);
  const minW = nonnegative(minProfitRaw || '0');
  if (D.lte(0)) return { feasible: false, code: 'NONPOSITIVE_LOSS_SPACE', candidates: [], reason: 'Funded 有效亏损空间不大于 0' };
  if (a.lte(0)) return { feasible: false, code: 'NONPOSITIVE_SHARE', candidates: [], reason: '个人分成比例须大于 0' };
  if (C.lte(0)) {
    return {
      feasible: true,
      code: 'ALREADY_RECOVERED',
      wMin: out(minW),
      wMaxCash: null,
      cashShortfall: '0',
      candidates: minW.gt(0) ? [out(minW)] : []
    };
  }
  const maxFundedReturn = a.times(D);
  const stopMinRatio = C.div(D);
  const claimMaxRatio = a;
  if (maxFundedReturn.lte(C)) {
    const gap = C.minus(maxFundedReturn);
    return {
      feasible: false,
      ratioWindowFeasible: false,
      inverted: true,
      code: 'LOSS_SPACE_TOO_SMALL',
      maxFundedReturn: out(maxFundedReturn),
      passCost: out(C),
      stopMinRatio: out(stopMinRatio),
      claimMaxRatio: out(claimMaxRatio),
      wMin: null,
      wMaxCash: H.gt(0) ? out(H.times(D).div(C)) : '0',
      hNeededMin: null,
      cashShortfall: out(gap),
      candidates: [],
      limitCondition:
        '止损回本要求比例 h ≥ ' +
        stopMinRatio.times(100).toFixed(2) +
        '%（C/D = ' +
        C.toFixed(2) +
        '/' +
        D.toFixed(0) +
        '），领取回本要求 h < ' +
        claimMaxRatio.times(100).toFixed(2) +
        '%（分成 s），两者无交集；且 C（' +
        C.toFixed(2) +
        ' U）≥ s×D（' +
        maxFundedReturn.toFixed(2) +
        ' U），单轮双端回本无解',
      reason:
        '单轮双端回本无解：止损覆盖需 h ≥ ' +
        stopMinRatio.times(100).toFixed(2) +
        '%，领取盈利需 h < ' +
        claimMaxRatio.times(100).toFixed(2) +
        '%（s×D = ' +
        maxFundedReturn.toFixed(2) +
        ' U ≤ C = ' +
        C.toFixed(2) +
        ' U，差 ' +
        gap.toFixed(2) +
        ' U）'
    };
  }
  const denom = maxFundedReturn.minus(C);
  const wMin = C.times(D).div(denom);
  const wMaxCash = H.gt(0) ? H.times(D).div(C) : dec('0');
  const hNeededMin = C.times(C).div(denom);
  const floorW = max(wMin, minW);
  const sampleRatio =
    dec('0.7').gt(stopMinRatio.plus('0.005')) && dec('0.7').lt(claimMaxRatio.minus('0.005'))
      ? dec('0.7')
      : stopMinRatio.plus(claimMaxRatio).div(2);
  const sampleRatioWMin = C.div(claimMaxRatio.minus(sampleRatio));
  if (wMaxCash.lte(floorW)) {
    const neededAtFloor = floorW.times(C).div(D);
    const needed = max(hNeededMin, neededAtFloor);
    const cashShortfall = max(dec('0'), needed.minus(H));
    const wGap = max(dec('0'), floorW.minus(wMaxCash));
    return {
      feasible: false,
      ratioWindowFeasible: true,
      inverted: true,
      code: 'INSUFFICIENT_REAL_CASH',
      stopMinRatio: out(stopMinRatio),
      claimMaxRatio: out(claimMaxRatio),
      sampleRatio: out(sampleRatio),
      sampleRatioWMin: out(sampleRatioWMin),
      wMin: out(wMin),
      floorW: out(floorW),
      wMaxCash: out(wMaxCash),
      wGap: out(wGap),
      hNeededMin: out(needed),
      cashShortfall: out(cashShortfall),
      candidates: [],
      limitCondition:
        '理论比例区间 h ∈ (' +
        stopMinRatio.times(100).toFixed(2) +
        '%, ' +
        claimMaxRatio.times(100).toFixed(2) +
        '%) 存在（如 h=' +
        sampleRatio.times(100).toFixed(0) +
        '% 时需 W > ' +
        sampleRatioWMin.toFixed(2) +
        ' U，双端盈利最低要求 W > ' +
        floorW.toFixed(2) +
        ' U），但当前资金支持最高 W ≤ ' +
        wMaxCash.toFixed(2) +
        ' U，两者缺口 ' +
        wGap.toFixed(2) +
        ' U（下限高于上限，无可行区间）；达到双端盈利最低需实盘 ' +
        needed.toFixed(2) +
        ' U（当前 ' +
        H.toFixed(2) +
        ' U，缺口 ' +
        cashShortfall.toFixed(2) +
        ' U）',
      reason:
        '无双端盈利解：理论比例区间 h ∈ (' +
        stopMinRatio.times(100).toFixed(2) +
        '%, ' +
        claimMaxRatio.times(100).toFixed(2) +
        '%) 存在，但双端盈利需出金 W > ' +
        floorW.toFixed(2) +
        ' U（h=' +
        sampleRatio.times(100).toFixed(0) +
        '% 时需 W > ' +
        sampleRatioWMin.toFixed(2) +
        ' U），取得分成前实盘至少需 ' +
        needed.toFixed(2) +
        ' U（当前 ' +
        H.toFixed(2) +
        ' U，缺口 ' +
        cashShortfall.toFixed(2) +
        ' U）'
    };
  }
  // Build concise high-signal candidate W values spanning (floorW, wMaxCash) including ratio-seeded W > C/(s-h) + fee buffers
  const geoMid = floorW.times(wMaxCash).sqrt();
  const arithMid = floorW.plus(wMaxCash).div(2);
  const span = wMaxCash.minus(floorW);
  const rawW = [
    sampleRatioWMin.times('1.15'),
    arithMid,
    geoMid,
    sampleRatioWMin.times('1.06'),
    floorW.plus(span.times('0.82'))
  ];
  const candidates = [
    ...new Set(
      rawW
        .filter((w) => w.gt(floorW) && w.lt(wMaxCash))
        .map((w) => out(w.toDecimalPlaces(2)))
    )
  ].slice(0, 4);
  return {
    feasible: true,
    ratioWindowFeasible: true,
    inverted: false,
    code: 'FEASIBLE_WINDOW',
    stopMinRatio: out(stopMinRatio),
    claimMaxRatio: out(claimMaxRatio),
    sampleRatio: out(sampleRatio),
    sampleRatioWMin: out(sampleRatioWMin),
    wMin: out(wMin),
    floorW: out(floorW),
    wMaxCash: out(wMaxCash),
    hNeededMin: out(hNeededMin),
    cashShortfall: '0',
    candidates,
    scopeNote:
      '无费理论比例区间 h ∈ (' +
      stopMinRatio.times(100).toFixed(2) +
      '%, ' +
      claimMaxRatio.times(100).toFixed(2) +
      '%)，h=' +
      sampleRatio.times(100).toFixed(0) +
      '% 时理论起点 W > ' +
      sampleRatioWMin.toFixed(2) +
      ' U（实际扣除双边费用并通过完整保证金路径）'
  };
}
