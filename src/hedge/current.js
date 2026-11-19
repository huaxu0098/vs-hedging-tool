import { scanContext, buildRatioScan, ratioSlice, inspectRatio } from './ratio-scan.js';
import {
  dec,
  out,
  positive,
  nonnegative,
  profitSplit,
  fundingInterval,
  solveBudgetBounds,
  normalizeExposure,
  estimateFill
} from './math.js';
import { validLeverageCap } from './leverage.js';
import { auditCross } from './cross-check.js';
import { adjustmentTarget, comparePlans } from './optimization.js';
import { settlementBridge, sumPostings } from './settlement-ledger.js';
import { solveAuto } from './auto.js';
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
  challengeTarget: '12000',
  fundedFloor: '8000',
  fundedTarget: '10100',
  baseline: '10000',
  share: '0.8',
  B: '500',
  investedCapital: '',
  registration: '91',
  outsideCosts: '0',
  minBuffer: '0',
  minMaintenanceSurplus: '0',
  R_success: '100',
  R_free: '0',
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
  quoteSkewMs: '3000',
  accountSkewSecs: '120',
  rebalanceSteps: '2',
  riskPreference: '0',
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
    cash.externalReceived = book.external;
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
    const settled = dec(sumPostings([legs.hl.settled, book.external]));
    bridges[key] = legs;
    if (key === 'fail') {
      cash.failureCash = out(settled);
      cash.failureHypeCash = legs.hl.settled;
      cash.bridge = { ...legs.hl, external: book.external };
    } else {
      cash.cashBeforePayout = out(settled.plus(p.inTransit));
      cash.hlBeforePayout = legs.hl.settled;
      const payout = p.stage === 'funded' ? profitSplit(p.target, p.baseline, p.share).user : '0';
      cash.expectedUserPayout = payout;
      cash.pressureCashAfter = out(dec(cash.cashBeforePayout).plus(payout));
    }
  }
  return { cash, notes };
}

// An old R was entered as a success-path reserve. The new collateral floor is independent.
export function splitReserves(saved = {}) {
  const { R, scanEndpoint: obsoletePath, ...rest } = saved;
  return { ...rest, R_success: rest.R_success ?? R ?? rules.R_success, R_free: rest.R_free ?? rules.R_free };
}
export function calculateCurrent(r, a, data = {}, fxData = {}, now = Date.now(), options = {}) {
  r = splitReserves(r);
  const result = computeCurrent(r, a, data, fxData, now, options);
  if (result.ratioScan) attachRepresentative(result, r);
  result.missingFields = [];
  const add = (id, label) => {
    if (!result.missingFields.some((x) => x.label === label)) result.missingFields.push({ id, label });
  };
  if (result.autoStatus === 'AUTO_PARTIAL' || result.autoStatus === 'AUTO_DATA_BLOCKED') {
    for (const gap of result.inputGaps ?? []) add(gap.id, gap.text);
    for (const [field, label] of Object.entries(stressFields))
      if (!specified(r[field]) || dec(r[field]).isZero())
        add(field, label + (!specified(r[field]) ? '未配置' : '采用零压力假设'));
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
  if (!result.needsSearch) result.trace = calculationTrace(r, a, data, fxData, now, options);
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
    if (ratioSlice(scan, sign, i, 'both').some(([lo, hi]) => lo <= j && j <= hi)) {
      point = { i, j, sign };
      group = 'both';
      objective = result.preference?.objective ?? 'fixed';
    }
  }
  if (!point) {
    group = ['both', 'protect', 'survive', 'risk'].find((k) => scan.sets[k].count);
    if (!group) return;
    point = scan.sets[group].largest;
    objective = 'diagnostic';
  }
  const row = inspectRatio(scan.ctx, point);
  if (!row.physical || (group === 'both' && !row.both)) throw Error('自动代表方案与网格风控结果不一致');
  const segment = scan.buckets.findIndex(
    ({ throughLots: end }) => !end || BigInt(point.j) * BigInt(end.i) <= BigInt(end.j) * BigInt(point.i)
  );
  const segmentRange = scan.buckets[segment]?.range;
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
      leverageStatus: r.mode === 'auto' ? 'LEVERAGE_UNVERIFIED' : null,
      autoStatus: r.mode === 'auto' ? 'AUTO_DATA_BLOCKED' : null
    };
  const stage = r.stage,
    funded = stage === 'funded',
    target = funded ? r.fundedTarget : r.challengeTarget;
  const floor = funded ? r.fundedFloor : r.challengeFloor;
  const pending = funded && specified(r.receivable) && nonnegative(r.receivable).gt(0);
  if (pending) result.notices.push('有分成待到账 ' + r.receivable + ' U，核对平台回执');
  const expired = !funded && r.deadline && Date.parse(r.deadline) <= now;
  if (expired) result.notices.push('考核已到期，待核对实际退出');
  const planning = a.pf.sourceKind === 'plan' && a.hl.sourceKind === 'plan';
  const ttl = positive(r.accountSecs).toNumber() * 1000;
  const ages = positive(r.quoteSecs).toNumber() * 1000;
  const clocks = Object.fromEntries(['pf', 'hl'].map((k) => [k, quoteClock(data[k], now, ages)]));
  const quoteOK = (k) => clocks[k].ok && !data.errors?.[k];
  const usable = (k, field) => !a[k].error && (planning || fresh(fieldTime(a[k], field), now, ttl));
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
    quoteTTL: ages,
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
    R: r.R_success,
    g: r.g,
    k: r.k,
    contributions: r.roundIn,
    withdrawals: r.roundOut
  };
  let terminal;
  if (p.E != null && p.C_hl != null) {
    result.funding = { ...fundingInterval(p), R_success: r.R_success, R_free: r.R_free };
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
      if (!usable(k, 'leverage') || leg.source !== 'Hype 主网 API') leg.configuredLeverage = null;
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
    if (!quoteOK(k))
      issues.push(
        (k === 'pf' ? 'VS' : 'Hype') +
          (data.errors?.[k]
            ? ' 行情接口断开：' + data.errors[k]
            : ' 行情缺失或过期 · ' +
              [
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
    if (funded) result.claim = profitSplit(out(net), r.baseline, r.share).user;
    if (p.C_hl != null) {
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
    !terminal &&
    !pending
  )
    result.autoStatus = 'AUTO_PARTIAL';
  if (expired && !issues.length && market) {
    const q = result.qty.hl,
      l = market.hl,
      f = estimateFill(out(dec(q).neg()), l, l.multiplier);
    const net = dec(result.cash.hl)
      .plus(f ? dec(q).times(l.multiplier).times(l.fx).times(dec(f.price).minus(l.mark)) : 0)
      .minus(f ? dec(f.notional).times(l.fx).times(l.rate) : 0);
    if (
      quotes.length === 4 &&
      quotes.every((at) => at === Date.parse(r.deadline)) &&
      ['pf', 'hl'].every(
        (k) =>
          planning ||
          ['equity', 'qty'].every((field) => Date.parse(fieldTime(a[k], field)) <= Date.parse(r.deadline))
      )
    ) {
      result.deadlineExit = out(net.plus(external));
    }
    result.notices.push('按本次可见盘口退出，个人现金约 ' + net.plus(external).toFixed(2) + ' U，待实际结算');
  }
  const receiptEntered = !planning && funded && specified(r.receivedPayout);
  const receiptSource = r.receiptSource === 'hl' ? 'hl' : 'external';
  const receiptBalance =
    receiptSource === 'hl' ? result.cash.hl : conversion && externalFresh ? external : null;
  const receipt =
    receiptEntered &&
    Date.parse(r.receivedPayoutAt) <= now &&
    receiptBalance != null &&
    nonnegative(r.receivedPayout).lte(receiptBalance)
      ? out(nonnegative(r.receivedPayout))
      : null;
  result.receipt =
    receipt == null
      ? null
      : {
          amount: receipt,
          at: r.receivedPayoutAt,
          source: receiptSource,
          cash: result.protect,
          net:
            result.protect == null || !specified(r.investedCapital)
              ? null
              : out(
                  dec(result.protect)
                    .minus(r.investedCapital)
                    .minus(r.outsideCosts ?? '0')
                )
        };
  if (receiptEntered && receipt == null) issues.push('请核对实际分成回执时间和收款账户快照');
  if (receipt != null && dec(receipt).gt(0)) {
    result.notices.push('首笔分成到账，本轮结束。到账金额已计入收款账户。');
    if (r.mode === 'auto') result.autoStatus = 'AUTO_CYCLE_SETTLED';
    return result;
  }
  if (issues.length || terminal || expired) return result;
  if (pending && (r.mode !== 'auto' || (!options.scanRatios && !options.deferAuto))) return result;
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
    profitBasis: specified(planning ? r.planCapital : r.investedCapital)
      ? out(
          nonnegative(planning ? r.planCapital : r.investedCapital).plus(nonnegative(r.outsideCosts ?? '0'))
        )
      : null,
    directions: [1, -1],
    R: r.R_success,
    g: r.g,
    k: r.k,
    objective: 'size',
    externalPriced: !!conversion || externalAmount.isZero(),
    pendingPayout: funded && specified(r.receivable) ? out(nonnegative(r.receivable)) : null,
    receivedPayout: receipt,
    deadlineMark:
      result.deadline &&
      r.deadlineAsset === data.asset &&
      r.deadlineBound === r.deadline &&
      specified(r.deadlineMark)
        ? out(positive(r.deadlineMark))
        : null,
    movePct: result.deadline && specified(r.movePct) ? out(nonnegative(r.movePct)) : null
  };
  const checks = {
    currentSnapshot: true,
    liveLimits: true,
    adverseBps: out(nonnegative(r.adverseBps || '0')),
    minMaintenanceSurplus: out(nonnegative(r.minMaintenanceSurplus || '0')),
    minPriceBuffer: out(nonnegative(r.minBuffer ?? '0')),
    now: new Date(now).toISOString()
  };
  if ([r.adverseBps, r.jumpBps, r.delayBps, r.fundingDebit].some((x) => nonnegative(x || '0').gt(0)))
    checks.stress = {
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
    if (options.deferAuto && canScan) {
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
    const ctx = scanContext(book, market, params, checks);
    const scan = (result.ratioScan = buildRatioScan(ctx));
    const feasible = scan.sets.both;
    checks.seeds = [feasible.largest, feasible.min, feasible.max].filter(Boolean).map((point) => ({
      vsTargetQuantity: out(dec(market.pf.step).times(point.i).times(point.sign)),
      hlTargetQuantity: out(dec(market.hl.step).times(point.j).times(-point.sign))
    }));
  }
  if (pending) {
    result.autoStatus = 'AUTO_PAYOUT_PENDING';
    return result;
  }
  const solverBook = { ...book, B: out(dec(book.B).plus(nonnegative(r.recoveryBuffer || '0'))) };
  let solved =
    r.mode === 'auto'
      ? solveAuto(solverBook, market, params, checks)
      : solve(solverBook, market, params, checks);
  if (r.mode === 'auto' && solved.selected) {
    const size = solved;
    const cash = solveAuto(
      solverBook,
      market,
      { ...params, objective: 'cash' },
      { ...checks, seeds: size.candidates, searchBudget: options.cashSearchBudget ?? 1400 }
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
        : solveAuto(solverBook, market, params, { ...checks, seeds: [cash.selected] });
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
    try {
      const held = heldOutcomes(book, market, p, pf, hl);
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
  result.bridge = { ...result.paths.fail.hl, external: c.externalReceived };
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
  result.forward = out(dec(c.pressureCashAfter).minus(p.C_hl).minus(external));
  result.round =
    c.roundGain ??
    (p.C_ref === null
      ? null
      : out(dec(c.pressureCashAfter).minus(p.C_ref).minus(p.contributions).plus(p.withdrawals)));
  return result;
}
