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
  R: '100',
  g: '0',
  external: '0',
  inTransit: '0',
  roundIn: '0',
  roundOut: '0',
  hlFee: '0.0005',
  pfFee: '0.0001',
  k: '0',
  mode: 'keepPF',
  quoteSecs: '5',
  accountSecs: '300'
};

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
    deduction = dec('0');
  return tiers.map((t) => {
    const from = nonnegative(String(t.lowerBound));
    const rate = dec('0.5').div(positive(String(t.maxLeverage)));
    deduction = deduction.plus(from.times(rate.minus(prior)));
    prior = rate;
    return { from: out(from), mmr: out(rate), deduction: out(deduction), maxLeverage: String(t.maxLeverage) };
  });
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
    const lev = isPF && im ? out(dec('1').div(positive(im))) : optional(ac.leverage);
    market[key] = {
      symbol: q.symbol,
      underlying: asset,
      unit: asset,
      type: 'linear',
      mappingVerified: true,
      multiplier: '1',
      fx: '1',
      factor: isPF ? '1' : fx,
      step,
      minQty: step,
      minNotional: isPF ? '0' : '10',
      mark: out(positive(String(q.mark))),
      open: isPF ? pf.open : true,
      bids: q.levels[0],
      asks: q.levels[1],
      rate: out(nonnegative(String(rate))),
      pool: 'current',
      leverage: lev,
      marginMode: ac.marginMode || null,
      hold: optional(ac.otherHold),
      tiers:
        isPF && spec.maintMarginRatio
          ? [{ from: '0', mmr: spec.maintMarginRatio, deduction: '0' }]
          : isPF
            ? null
            : hlTiers(hl.marginTiers),
      capacity: ac.capacity,
      currentLiquidation: isPF ? null : ac.liquidation,
      directionalFree: ac.directionalFree,
      free: optional(ac.free)
    };
  }
  return market;
}

function equityAt(s, q, px) {
  const eq = optional(s.equity);
  if (eq === null || q === null || !specified(s.anchor) || !px) return eq;
  return out(dec(eq).plus(dec(q).times(dec(String(px)).minus(positive(String(s.anchor))))));
}
function reason(code) {
  return (
    {
      CHALLENGE_FAILED: 'VS 已触及考核失败线',
      FUNDED_FAILED: 'VS 已触及出金户失败线',
      REFERENCE_REACHED: '已到提款参考点，核对可申领金额',
      CHALLENGE_PASS_PENDING_SETTLEMENT: '考核目标已到，待平台确认结算',
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
      const payout = p.stage === 'funded' ? profitSplit(p.target, p.baseline, p.share).user : '0';
      cash.pressureCashAfter = out(dec(cash.cashBeforePayout).plus(payout));
    }
  }
  return { cash, notes };
}

export function calculateCurrent(r, a, data = {}, fxData = {}, now = Date.now()) {
  const issues = [],
    result = { issues, cash: {}, qty: {}, currentNotional: {}, notices: [] };
  const stage = r.stage,
    funded = stage === 'funded',
    target = funded ? r.fundedTarget : r.challengeTarget;
  const floor = funded ? r.fundedFloor : r.challengeFloor;
  const pending = specified(r.receivable) && nonnegative(r.receivable).gt(0);
  if (pending) result.notices.push('有分成待到账 ' + r.receivable + ' U，核对平台回执');
  const expired = !funded && r.deadline && Date.parse(r.deadline) <= now;
  if (expired) result.notices.push('考核已到期，待核对实际退出');
  for (const k of ['pf', 'hl']) {
    const q = (result.qty[k] = optional(a[k].qty));
    result.cash[k] = equityAt(a[k], q, data[k]?.mark);
    if (q != null && data[k]?.mark) result.currentNotional[k] = out(dec(q).abs().times(String(data[k].mark)));
  }
  const protection = out(nonnegative(r.B).plus(nonnegative(r.outsideCosts ?? '0')));
  if (nonnegative(r.registration ?? '0').gt(r.B)) result.notices.push('保护目标低于已支付的报名费');
  const p = {
    stage,
    E: result.cash.pf,
    C_hl: result.cash.hl,
    C_external: r.external,
    inTransit: r.inTransit,
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
    if (!result.range.min) terminal = reason(result.range.code);
  }
  const ages = positive(r.quoteSecs).toNumber() * 1000;
  let fx = null;
  if (specified(r.fx) && fresh(r.fxAt, now, positive(r.accountSecs).toNumber() * 1000))
    fx = out(positive(r.fx));
  else if (fxData.USDC && fxData.USDT && [fxData.USDC, fxData.USDT].every((x) => fresh(x.asOf, now, 60000)))
    fx = out(positive(String(fxData.USDC.rate)).div(positive(String(fxData.USDT.rate))));
  const market = fx && buildMarket(data, r, a, fx);
  const { pf, hl } = result.qty;
  if (market && pf !== null && hl !== null && !dec(pf).isZero()) {
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
  if (!funded && !r.deadline) result.notices.push('截止时间未录入');
  if (funded && p.C_ref == null) result.notices.push('缺少本轮起点，整轮收益及其比例上限未验证');
  if (!p.E || !p.C_hl) issues.push('请录入两边当前权益');
  if (pf === null || hl === null) issues.push('持仓数量未录入，空仓请填 0');
  if (!fx) issues.push('缺少有效 USDC/USDT 折算，可在规则中确认汇率');
  if (!market) issues.push('等待已核实的双边合约与盘口');
  for (const k of ['pf', 'hl']) {
    if (
      !fresh(data[k]?.asOf, now, ages) ||
      (data[k]?.markAt && !fresh(data[k].markAt, now, ages)) ||
      data.errors?.[k]
    )
      issues.push((k === 'pf' ? 'VS' : 'Hype') + ' 行情缺失或过期');
    if (a[k].error) issues.push(a[k].error);
    if (a[k].at && !fresh(a[k].at, now, positive(r.accountSecs).toNumber() * 1000))
      issues.push((k === 'pf' ? 'VS' : 'Hype') + ' 账户快照过期');
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
  if (market && pf != null && p.E != null) {
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
          .plus(dec(pf).times(dec(f.price).minus(market.pf.mark)))
          .minus(dec(f.notional).times(market.pf.rate))
      : dec(p.E);
    result.settlePF = out(net);
    if (funded) result.claim = profitSplit(out(net), r.baseline, r.share).user;
    if (p.C_hl != null) {
      const netRange = solveBudgetBounds({ ...p, E: out(net) });
      terminal = netRange.min == null ? reason(netRange.code) : null;
    }
  }
  if (terminal) result.notices.push(terminal + (result.settlePF == null ? '（仅按快照权益预警）' : ''));
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
    external: r.external,
    ref: p.C_ref,
    transfers: { current: { status: 'in_transit', amount: r.inTransit } },
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
        multiplier: '1',
        fx: '1'
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
  const solved = solve(
    book,
    market,
    { mode: r.mode, sizes, target, sort: 'gain', directions: [1, -1], R: r.R, g: r.g, k: r.k },
    {
      currentSnapshot: true,
      minPriceBuffer: out(nonnegative(r.minBuffer ?? '0')),
      now: new Date(now).toISOString()
    }
  );
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
  const verified = solved.candidates.filter((x) => x.code === 'FEASIBLE');
  if (verified.length) {
    const ratios = verified.map((x) => dec(x.actualRatio)).sort((a, b) => a.cmp(b));
    result.verified = { min: out(ratios[0]), max: out(ratios.at(-1)), count: new Set(ratios.map(out)).size };
  }
  result.riskMissing = [];
  result.points = verified.length
    ? [...new Set(verified.map((x) => x.actualRatio))]
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
    if (!l.leverage) result.riskMissing.push(label + ' 当前杠杆');
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
  result.forward = out(dec(c.pressureCashAfter).minus(p.C_hl).minus(r.external).minus(r.inTransit));
  result.round =
    c.roundGain ??
    (p.C_ref === null
      ? null
      : out(dec(c.pressureCashAfter).minus(p.C_ref).minus(p.contributions).plus(p.withdrawals)));
  return result;
}
