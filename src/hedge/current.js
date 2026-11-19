import {
  dec,
  out,
  positive,
  nonnegative,
  profitSplit,
  solveBudgetBounds,
  normalizeExposure,
  estimateFill
} from './math.js';
import { validLeverageCap } from './leverage.js';
import { solveAuto } from './auto.js';
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
export const rules = {
  stage: 'challenge',
  challengeFloor: '9400',
  challengeTarget: '12000',
  fundedFloor: '8000',
  fundedTarget: '10100',
  baseline: '10000',
  share: '0.8',
  B: '500',
  registration: '91',
  outsideCosts: '0',
  minBuffer: '0',
  minMaintenanceSurplus: '0',
  R: '100',
  g: '0',
  external: '0',
  inTransit: '0',
  roundIn: '0',
  roundOut: '0',
  hlFee: '0.0005',
  pfFee: '0.0001',
  k: '0',
  mode: 'auto',
  objective: 'size',
  pfUtil: '100',
  hlUtil: '100',
  externalCurrency: 'USDC',
  adverseBps: '',
  jumpBps: '',
  delayBps: '',
  fundingDebit: '',
  quoteSecs: '5',
  accountSecs: '300'
};

export const stressFields = {
  adverseBps: '基差及汇率',
  jumpBps: '跳价',
  delayBps: '调仓延迟',
  fundingDebit: '资金费'
};
export function stressCoverage(r) {
  const missing = [],
    zero = [],
    positive = [];
  for (const [field, label] of Object.entries(stressFields)) {
    if (!specified(r[field])) missing.push(label);
    else (nonnegative(r[field]).isZero() ? zero : positive).push(label);
  }
  const label = missing.length ? '压力未配置：' + missing.join('、') : '';
  const zeros = zero.length ? '零压力假设：' + zero.join('、') : '';
  return {
    missing,
    zero,
    positive,
    label: [label, zeros].filter(Boolean).join('；') || '四项非零压力参数已设置'
  };
}

// A whole API snapshot has one timestamp. Manual values retain individual confirmation times.
export function fieldTime(account, field) {
  const key = field + 'At';
  return Object.hasOwn(account, key) ? account[key] : (account.origins?.[field]?.at ?? account.at);
}
export function remainingOrder(delta, current, orders) {
  if (!Array.isArray(orders)) return { text: '未确认挂单，待核对', remaining: null };
  const d = dec(delta);
  if (!orders.length) return { text: '已确认无挂单', remaining: out(d) };
  const sizes = orders.map((o) => dec(o.qty));
  const projected = out(sizes.reduce((s, x) => s.plus(x), dec(current)));
  if (orders.some((o, i) => o.conditional || o.reduceOnly || sizes[i].times(d).lte(0))) {
    return { text: '存在条件、减仓或方向冲突挂单，先核对', remaining: null, projected };
  }
  const rest = sizes.reduce((s, x) => s.minus(x), d);
  return {
    text: rest.times(d).lt(0) ? '原挂单已超过目标，先核对' : '若同向挂单全部成交',
    remaining: rest.times(d).lt(0) ? null : out(rest),
    projected
  };
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

function buildMarket(data, r, a, fx) {
  const { pf, hl, spec, asset } = data;
  if (
    !pf ||
    !hl ||
    !spec ||
    !['BTC', 'ETH', 'SOL'].includes(asset) ||
    spec.base !== asset ||
    spec.symbol !== asset + '-PERP' ||
    pf.symbol !== spec.symbol ||
    hl.symbol !== asset ||
    spec.quote !== 'USDC' ||
    [spec, hl].some((l) => l.payoffType != null && l.payoffType !== 'linear') ||
    hl.collateralToken !== 0
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
    const lev =
      isPF && im
        ? out(dec('1').div(positive(im)))
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
      unit: asset,
      type: 'linear',
      mappingVerified: true,
      multiplier: out(positive(String((isPF ? spec : hl).contractMultiplier ?? '1'))),
      fx: out(positive(String((isPF ? spec : hl).settlementToUSDC ?? '1'))),
      factor: isPF ? '1' : fx,
      step,
      minQty: out(positive(String((isPF ? spec : hl).minQty ?? step))),
      minNotional: out(nonnegative(String((isPF ? spec : hl).minNotional ?? (isPF ? '0' : '10')))),
      mark: out(positive(String(q.mark))),
      open: isPF ? pf.open : true,
      bids: q.levels[0],
      asks: q.levels[1],
      rate: out(nonnegative(String(rate))),
      pool: 'current',
      leverage: lev,
      configuredLeverage: isPF
        ? null
        : validLeverageCap(ac.configuredLeverage)
          ? String(ac.configuredLeverage)
          : null,
      exchangeMaxLeverage: isPF ? null : validLeverageCap(hl.maxLeverage),
      currentMarginCredit:
        !isPF && ac.currentMarginCredit != null ? out(nonnegative(ac.currentMarginCredit)) : null,
      marginMode: ac.marginMode || null,
      hold: optional(ac.otherHold),
      tiers:
        isPF && spec.maintMarginRatio
          ? [{ from: '0', mmr: spec.maintMarginRatio, deduction: '0' }]
          : isPF
            ? null
            : hlTiers(hl.marginTiers),
      utilization: out(utilization),
      reserve: isPF ? '0' : r.R,
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
      hl_STRESS_SURPLUS: 'Hype 压力后最低维持保证金余量',
      hl_ORDER_LEVERAGE: '挂单在新档位的资金占用待确认',
      hl_SWITCH_TIER: '变更杠杆前的原仓档位上限',
      hl_SWITCH_MARGIN: '变更杠杆时原仓初始保证金',
      LEVERAGE_UNVERIFIED: '杠杆与清算模型未验证',
      NO_PAYOUT_TARGET: '提款参考点须高于分成基线',
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
function heldOutcomes(book, market, p, pf, hl) {
  if (dec(pf).isZero()) return null;
  const lines = solveBoundaryPrices(book, market, pf, p.target, p.floor);
  const notes = [];
  const cash = {};
  for (const [key, shift] of Object.entries(lines)) {
    const label = key === 'fail' ? '失败线' : '成功线';
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
    const settled = projectSettlementEquity(book, market, 'hl', hl, shift).plus(book.external).minus(p.k);
    if (key === 'fail') cash.failureCash = out(settled);
    else {
      cash.cashBeforePayout = out(settled.plus(p.inTransit));
      cash.hlBeforePayout = out(settled.minus(book.external));
      const payout = p.stage === 'funded' ? profitSplit(p.target, p.baseline, p.share).user : '0';
      cash.pressureCashAfter = out(dec(cash.cashBeforePayout).plus(payout));
    }
  }
  return { cash, notes };
}

export function calculateCurrent(r, a, data = {}, fxData = {}, now = Date.now(), options = {}) {
  const issues = [],
    result = {
      issues,
      cash: {},
      qty: {},
      currentNotional: {},
      notices: [],
      leverageStatus: r.mode === 'auto' ? 'LEVERAGE_UNVERIFIED' : null,
      autoStatus: r.mode === 'auto' ? 'AUTO_DATA_BLOCKED' : null
    };
  const stage = r.stage,
    funded = stage === 'funded',
    target = funded ? r.fundedTarget : r.challengeTarget;
  const floor = funded ? r.fundedFloor : r.challengeFloor;
  const pending = specified(r.receivable) && nonnegative(r.receivable).gt(0);
  if (pending) result.notices.push('有分成待到账 ' + r.receivable + ' U，核对平台回执');
  const expired = !funded && r.deadline && Date.parse(r.deadline) <= now;
  if (expired) result.notices.push('考核已到期，待核对实际退出');
  const planning = a.pf.sourceKind === 'plan' && a.hl.sourceKind === 'plan';
  const ttl = positive(r.accountSecs).toNumber() * 1000;
  const ages = positive(r.quoteSecs).toNumber() * 1000;
  const quoteOK = (k) =>
    fresh(data[k]?.asOf, now, ages) &&
    (!data[k]?.markAt || fresh(data[k].markAt, now, ages)) &&
    !data.errors?.[k];
  const usable = (k, field) => !a[k].error && (planning || fresh(fieldTime(a[k], field), now, ttl));
  result.inputGaps = [];
  result.stress = stressCoverage(r);
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
    const spec = k === 'pf' ? data.spec : data.hl;
    const unit = positive(String(spec?.contractMultiplier ?? '1')).times(
      positive(String(spec?.settlementToUSDC ?? '1'))
    );
    result.cash[k] = usable(k, 'equity') ? equityAt(a[k], q, quoteOK(k) ? data[k]?.mark : null, unit) : null;
    if (q != null && quoteOK(k) && data[k]?.mark)
      result.currentNotional[k] = out(dec(q).abs().times(unit).times(String(data[k].mark)));
  }
  const protection = out(nonnegative(r.B).plus(nonnegative(r.outsideCosts ?? '0')));
  if (nonnegative(r.registration ?? '0').gt(r.B)) result.notices.push('保护目标低于已支付的报名费');
  // Only funds marked received and owned can enter personal recovery, at a verified USDC valuation.
  const currency = r.externalCurrency ?? 'USDC',
    externalAmount = nonnegative(r.external || '0');
  let conversion = currency === 'USDC' ? '1' : null;
  if (
    currency !== 'USDC' &&
    specified(r.externalFx) &&
    fresh(r.externalFxAt, now, Number(r.accountSecs) * 1000)
  )
    conversion = out(positive(r.externalFx));
  if (
    !conversion &&
    ['USD', 'USDT'].includes(currency) &&
    fresh(fxData.USDC?.asOf, now, 60000) &&
    (currency === 'USD' || fresh(fxData.USDT?.asOf, now, 60000))
  )
    conversion = out(
      positive(String(currency === 'USD' ? '1' : fxData.USDT.rate)).div(positive(String(fxData.USDC.rate)))
    );
  const externalFresh = planning || externalAmount.isZero() || fresh(r.externalAt, now, ttl);
  const external = conversion && externalFresh ? out(externalAmount.times(conversion)) : '0';
  if (!externalFresh) issues.push('外部已到账金额缺少当前确认，请核对资金来源');

  result.externalValue = external;
  result.externalRate = conversion;
  result.externalSource = !conversion
    ? '缺少有效估值'
    : currency === 'USDC'
      ? 'USDC 本币'
      : specified(r.externalFx) && fresh(r.externalFxAt, now, Number(r.accountSecs) * 1000)
        ? '手工估值 ' + r.externalFxAt
        : '公开现货汇率 ' +
          [fxData.USDC?.asOf, currency === 'USDT' ? fxData.USDT?.asOf : null].filter(Boolean).join(' / ');
  result.marginHL =
    !a.hl.unsupported && usable('hl', 'free') ? (a.hl.directionalFree ?? optional(a.hl.free)) : null;
  result.protect = result.cash.hl == null || !externalFresh ? null : out(dec(result.cash.hl).plus(external));
  if (!conversion && !externalAmount.isZero())
    result.notices.push('外部资金 ' + externalAmount + ' ' + currency + ' 估值未确认，暂未计入保护资金');
  const p = {
    stage,
    E: result.cash.pf,
    C_hl: result.cash.hl,
    C_external: external,
    inTransit: '0',
    C_ref: optional(r.ref),
    B: protection,
    floor,
    target,
    baseline: r.baseline,
    share: r.share,
    R: r.R,
    g: r.g,
    k: r.k,
    contributions: r.roundIn,
    withdrawals: r.roundOut
  };
  let terminal;
  if (p.E != null && p.C_hl != null) {
    result.range = solveBudgetBounds(p);
    if (result.range.min == null) result.range = null; // Terminal events need fresh positions and executable quotes below.
  }
  let fx = null;
  if (specified(r.fx) && fresh(r.fxAt, now, positive(r.accountSecs).toNumber() * 1000))
    fx = out(positive(r.fx));
  else if (fxData.USDC && fxData.USDT && [fxData.USDC, fxData.USDT].every((x) => fresh(x.asOf, now, 60000)))
    fx = out(positive(String(fxData.USDC.rate)).div(positive(String(fxData.USDT.rate))));
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
      return [k, leg];
    })
  );
  const market = fx && buildMarket(data, r, a, fx);
  result.configuredLeverage =
    a.hl.source === 'Hype 主网 API' && usable('hl', 'leverage') ? (a.hl.configuredLeverage ?? null) : null;
  const { pf, hl } = result.qty;
  if (market && quoteOK('pf') && quoteOK('hl') && pf !== null && hl !== null && !dec(pf).isZero()) {
    const v = dec(normalizeExposure(pf, market.pf)),
      h = dec(normalizeExposure(hl, market.hl));
    result.currentH = out(h.abs().div(v.abs()));
    result.sameDirection = h.times(v).gt(0);
    const leg = market.hl;
    if (
      !a.hl.otherPositions &&
      leg.leverage &&
      leg.hold != null &&
      result.cash.hl != null &&
      leg.marginMode === 'cross'
    ) {
      const qtyCap = dec(result.cash.hl).minus(leg.hold).div(positive(leg.mark)).times(leg.leverage);
      result.marginMax = out(dec(normalizeExposure(out(qtyCap), leg)).div(v.abs()));
    }
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
  if (!fx) issues.push('缺少有效 USDC/USDT 折算，可在规则中确认汇率');
  if (!market) issues.push('等待已核实的双边合约与盘口');
  for (const k of ['pf', 'hl']) {
    if (
      !fresh(data[k]?.asOf, now, ages) ||
      (data[k]?.markAt && !fresh(data[k].markAt, now, ages)) ||
      data.errors?.[k]
    )
      issues.push(
        (k === 'pf' ? 'VS' : 'Hype') +
          (data.errors?.[k] ? ' 行情接口断开：' + data.errors[k] : ' 行情缺失或过期')
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
  if (market && !market.pf.open) issues.push('VS 合约休市');
  if (a.hl.unsupported) issues.push('Hype 资金池模式未验证');
  if (
    market &&
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
      f = estimateFill(out(dec(pf).neg()), market.pf);
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
    if (funded) result.claim = profitSplit(out(net), r.baseline, r.share).user;
    if (p.C_hl != null) {
      const netRange = solveBudgetBounds({ ...p, E: out(net) });
      terminal = netRange.min == null ? reason(netRange.code) : null;
    }
  }
  if (terminal) {
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
    !issues.some((x) => /过期|缺失|未录入|请录入|断开|休市|确认时间|连接失败/.test(x)) &&
    !terminal &&
    !pending
  )
    result.autoStatus = 'AUTO_PARTIAL';
  if (expired && !issues.length && market) {
    const q = result.qty.hl,
      l = market.hl,
      f = estimateFill(out(dec(q).neg()), l);
    const net = dec(result.cash.hl)
      .plus(f ? dec(q).times(l.multiplier).times(l.fx).times(dec(f.price).minus(l.mark)) : 0)
      .minus(f ? dec(f.notional).times(l.fx).times(l.rate) : 0);
    result.deadlineExit = out(net.plus(external));
    result.notices.push('按本次可见盘口退出，个人现金约 ' + net.plus(external).toFixed(2) + ' U，待实际结算');
  }
  if (issues.length || terminal || expired || pending) return result;
  const pos = {};
  const book = {
    mode: 'live_readonly',
    stage,
    status: funded ? 'FUNDED_ACTIVE' : 'CHALLENGE_ACTIVE',
    B: protection,
    baseline: r.baseline,
    share: r.share,
    fundedFloor: r.fundedFloor,
    challengeFloor: r.challengeFloor,
    challengeTarget: r.challengeTarget,
    challengeDeadlineAt: r.deadline || null,
    passTrigger: 'net_settlement',
    failureTrigger: 'net_settlement',
    external: external,
    ref: p.C_ref,
    transfers: { current: { status: 'in_transit', amount: '0' } },
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
  const params = {
    mode: r.mode,
    sizes,
    target,
    sort: 'gain',
    directions: [1, -1],
    R: r.R,
    g: r.g,
    k: r.k,
    objective: 'size',
    movePct: specified(r.movePct) ? out(nonnegative(r.movePct)) : null
  };
  const checks = {
    currentSnapshot: true,
    liveLimits: true,
    adverseBps: out(nonnegative(r.adverseBps || '0')),
    minMaintenanceSurplus: out(nonnegative(r.minMaintenanceSurplus || '0')),
    minPriceBuffer: out(nonnegative(r.minBuffer ?? '0')),
    now: new Date(now).toISOString()
  };
  if ([r.jumpBps, r.delayBps, r.fundingDebit].some((x) => nonnegative(x || '0').gt(0)))
    checks.stress = {
      jumpBps: r.jumpBps || '0',
      basisBps: r.adverseBps || '0',
      delayBps: r.delayBps || '0',
      fundingDebit: r.fundingDebit || '0'
    };
  if (r.mode === 'auto') {
    result.leverageStatus = 'LEVERAGE_UNVERIFIED';
    const missing = [];
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
        const locked = dec(result.cash[key]).minus(l.free);
        if (l.hold == null || locked.gt(l.hold)) l.hold = out(locked.gt(0) ? locked : dec('0'));
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
      result.autoStatus = 'AUTO_PARTIAL';
      issues.push('资金比例可算，待确认 ' + missing.join('、'));
      return result;
    }
    result.leverageStatus =
      !planning && market.hl.configuredLeverage && !a.hl.otherPositions && a.hl.otherHold === '0'
        ? 'ACCOUNT_MODEL'
        : 'LEVERAGE_UNVERIFIED';
    if (options.deferAuto) {
      result.needsSearch = true;
      return result;
    }
  }
  const solved =
    r.mode === 'auto' ? solveAuto(book, market, params, checks) : solve(book, market, params, checks);
  if (r.mode === 'auto') {
    const creditUnknown = hl !== '0' && market.hl.currentMarginCredit == null;
    if (creditUnknown) {
      result.notices.push('现仓占用的可释放初始保证金未经确认，按零释放核算');
      solved.searchComplete = false;
      if (solved.code === 'AUTO_INFEASIBLE') solved.code = 'AUTO_PARTIAL';
    }
    result.autoStatus = solved.code;
    result.search = { complete: solved.searchComplete, evaluations: solved.evaluations, nodes: solved.nodes };
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
      check: c.constraints?.find((x) => x.status === 'fail')
    }));
    result.waiting = solved.hold;
    result.pressure = solved.pressure;
    result.maximum = {
      amount: solved.selected?.vsNotional,
      complete: solved.searchComplete,
      candidate: solved.selected
    };

    if (solved.code === 'AUTO_HOLD' && !solved.selected) result.flatHold = true;
    if (!planning && !funded && !r.deadline && solved.selected) {
      result.autoStatus = 'AUTO_PARTIAL';
      result.notices.push('仓位按考核仍有效计算，实际截止时间待确认');
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
    try {
      const held = heldOutcomes(book, market, p, pf, hl);
      if (held) {
        result.heldCash = held.cash;
        result.notices.push('以下现金按现有已成交仓位、保持不动计算', ...held.notes);
        if (held.cash.failureCash != null)
          result.failVsPrincipal = out(dec(held.cash.failureCash).minus(protection));
        if (held.cash.pressureCashAfter != null)
          result.passVsPrincipal = out(dec(held.cash.pressureCashAfter).minus(protection));
      }
    } catch (e) {
      result.notices.push('现仓终点无法核算 · ' + reason(e.message));
    }
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
  result.forward = out(dec(c.pressureCashAfter).minus(p.C_hl).minus(external));
  result.round =
    c.roundGain ??
    (p.C_ref === null
      ? null
      : out(dec(c.pressureCashAfter).minus(p.C_ref).minus(p.contributions).plus(p.withdrawals)));
  return result;
}
