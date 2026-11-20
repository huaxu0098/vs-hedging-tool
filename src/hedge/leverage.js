// Hyperliquid cross-margin: position size and collateral determine maintenance and liquidation.
// Only initial margin, switch funding and the exchange's current-setting order capacity vary by setting.
import { dec, out, max, min } from './math.js';
import { constraint, evaluateCandidate, maintenance, preservesCrossExposure } from './solver.js';

export function validLeverageCap(value) {
  if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function evaluateLeverageGrid(book, market, profile, pf, hl, checks, fixedLeverage = null) {
  const leg = market.hl;
  const unit = dec(leg.multiplier).times(leg.fx).times(leg.mark);
  const target = dec(hl);
  const notional = target.abs().times(unit);
  const tier = leg.tiers?.findLast((t) => notional.gte(t.from));
  const upper = Math.min(
    validLeverageCap(leg.exchangeMaxLeverage) ?? 0,
    validLeverageCap(tier?.maxLeverage) ?? 0
  );
  if (!upper || leg.marginMode !== 'cross') throw Error('LEVERAGE_UNVERIFIED');
  if (fixedLeverage != null && (!Number.isInteger(fixedLeverage) || fixedLeverage < 1 ||
      fixedLeverage > upper || target.isZero())) throw Error('LEVERAGE_UNVERIFIED');
  const cap = String(fixedLeverage ?? upper);
  const base = evaluateCandidate(
    book,
    { ...market, hl: { ...leg, leverage: cap, capacity: null } },
    profile,
    pf,
    hl,
    checks
  );
  const initial = base.constraints.find((c) => c.code === 'hl_INITIAL_MARGIN');
  if (!initial || initial.actual == null) return base;
  const other = dec(initial.required).minus(notional.div(cap));
  const old = dec(base.hlCurrentQuantity);
  const oldNotional = old.abs().times(unit);
  const credit = dec(leg.currentMarginCredit ?? '0');
  const delta = dec(base.hlDeltaQuantity);
  const side = delta.lt(0) ? 1 : 0;
  const available = leg.directionalFree?.[side] ?? leg.free;
  // Include fill impact vs mark and the actual delta fee in available collateral.
  const executionCost = max(0, dec(book.hl).minus(initial.actual));
  const moneyRules = [
    'FAILURE_RECOVERY',
    'CASH_BEFORE_PAYOUT',
    'ROUND_GAIN',
    'STRESS_FAILURE',
    'STRESS_RESERVE',
    'STRESS_GAIN'
  ];
  const common = base.constraints
    .filter((c) => !checks.scanRiskOnly || !moneyRules.includes(c.code))
    .filter(
      (c) =>
        ![
          'hl_INITIAL_MARGIN',
          'hl_AVAILABLE',
          'hl_FREE_RESERVE',
          'hl_UTILIZATION',
          'hl_TIER_LEVERAGE'
        ].includes(c.code)
    );

  const path = common
    .filter((c) => c.equity != null && c.code !== 'pf_MAINTENANCE_PATH')
    .reduce((a, c) => (!a || dec(c.actual).lt(a.actual) ? c : a), null);
  if (!target.isZero() && path)
    common.push(
      constraint(
        'hl_STRESS_SURPLUS',
        path.actual,
        checks.minMaintenanceSurplus ?? '0',
        'U',
        '全路径最低维持余量'
      )
    );
  const commonFailure = common.find((c) => c.status === 'fail') ?? common.find((c) => c.status === 'unknown');
  const hasStress = [checks.adverseBps, ...Object.values(checks.stress ?? {})].some((v) =>
    dec(String(v || '0')).gt(0)
  );
  const basePath = common.find((c) => c.code === 'hl_MAINTENANCE_PATH');
  const funding = {
    scenario: hasStress ? 'configured_stress' : 'base',
    baseEquity: basePath?.equity ?? null,
    baseMaintenance: basePath?.maintenance ?? null,
    baseSurplus: basePath?.actual ?? null,
    maintenanceMargin: out(maintenance(leg, notional)),
    stressedSurplus: hasStress ? (path?.actual ?? null) : null,
    stressedEquity: hasStress ? (path?.equity ?? null) : null,
    stressedMaintenance: hasStress ? (path?.maintenance ?? null) : null,
    exchangeMaxLeverage: upper,
    contractMaxLeverage: Number(leg.exchangeMaxLeverage),
    effectiveLeverage: dec(book.hl).gt(0) ? out(notional.div(book.hl)) : null
  };
  const rows = [];
  let best = null;
  // Zero target closes the position and needs no leverage setting.
  const first = fixedLeverage ?? (target.isZero() ? 0 : 1);
  const last = fixedLeverage ?? (target.isZero() ? 0 : upper);
  for (let n = first; n <= last; n++) {
    const lev = String(n || upper);
    const margin = target.isZero() ? dec('0') : notional.div(lev);
    const total = margin.plus(other);
    const extra = [
      constraint('hl_INITIAL_MARGIN', initial.actual, out(total), 'U', '全仓档位'),
      constraint(
        'hl_UTILIZATION',
        out(dec(initial.actual).times(leg.utilization ?? '1')),
        out(total),
        'U',
        '账户上限'
      )
    ];
    const reducing = preservesCrossExposure(old,target,leg.configuredLeverage,lev);
    if (reducing) {
      extra[0].status = 'pass';
      extra[0].requiredForTrade = false;
      if (dec(leg.utilization ?? '1').eq(1)) extra[1].status = 'pass';
    }
    if (available != null) {
      const headroom=min(dec(initial.actual).minus(total),
        dec(available).plus(credit).minus(margin).minus(executionCost));
      const free=reducing ? max(0,headroom) : headroom;
      extra.push(constraint('hl_FREE_RESERVE', out(free), leg.reserve ?? '0', 'U', '账户可用抵押品'));
      // If the exchange setting must change first, the current open position must also fit it.
      if (n && leg.configuredLeverage !== lev && !old.isZero())
        extra.push(
          constraint(
            'hl_SWITCH_MARGIN',
            out(min(dec(available).plus(credit),dec(book.hl).minus(other))),
            out(oldNotional.div(lev)),
            'U',
            '调档前现仓'
          )
        );
    } else extra.push(constraint('hl_AVAILABLE', null, '0', 'U', 'missing'));
    if (leg.capacity && (n <= Number(leg.configuredLeverage) || !n))
      extra.push(
        constraint(
          'hl_AVAILABLE',
          leg.capacity[side],
          out(delta.abs()),
          leg.unit,
          '当前账户设置下的交易所额度'
        )
      );
    if (n && !old.isZero() && leg.configuredLeverage !== lev) {
      const oldTier = leg.tiers.findLast((t) => oldNotional.gte(t.from));
      extra.push(constraint('hl_SWITCH_TIER', String(oldTier.maxLeverage), lev, '倍', '调档前现仓风险档位'));
    }
    if (!target.isZero() && leg.pendingQty && !dec(leg.pendingQty).isZero() && leg.configuredLeverage !== lev)
      extra.push(constraint('hl_ORDER_LEVERAGE', null, '0', 'U', '现有挂单调档后占用未知'));
    const failed =
      commonFailure?.status === 'fail'
        ? commonFailure
        : (extra.find((c) => c.status === 'fail') ??
          commonFailure ??
          extra.find((c) => c.status === 'unknown'));
    const row = {
      leverage: n || null,
      initial: out(margin),
      marginUsed: out(total),
      postEntryEquity: initial.actual,
      freeAfter: available == null ? null : out(max(0,extra.find(c => c.code === 'hl_FREE_RESERVE').actual)),
      freeFloor: leg.reserve ?? '0',
      successEquity: base.hlBeforePayout,
      maintenance: funding.maintenanceMargin,
      liquidation: base.liqMark,
      scenario: funding.scenario,
      baseEquity: funding.baseEquity,
      stressedEquity: funding.stressedEquity,
      surplus: funding.stressedSurplus ?? funding.baseSurplus,
      buffer: base.priceBuffer,
      status: failed?.status ?? 'pass',
      reason: failed?.code ?? null,
      constraint: failed ?? null
    };
    rows.push(row);
    const rank = { pass: 0, unknown: 1, fail: 2 };
    // Rows share the same cross pool, net exposure, fees and maintenance schedule.
    // Ascending enumeration makes the first passing setting the least leverage required.
    // An openable lot can still fail later on the path. Its diagnostic margin
    // uses the lowest entry-admissible setting, even when all exit paths fail.
    const entryOK = extra.every((c) => c.status === 'pass');
    if (
      !best ||
      rank[row.status] < rank[best.row.status] ||
      (checks.scanRiskOnly && row.status === best.row.status && entryOK && !best.entryOK)
    )
      best = { row, extra, margin, entryOK };
  }
  const constraints = [...common, ...best.extra];
  const code = constraints.some((c) => c.status === 'fail')
    ? 'REJECTED'
    : constraints.some((c) => c.status === 'unknown')
      ? 'MARGIN_UNVERIFIED'
      : 'FEASIBLE';
  return {
    ...base,
    ...funding,
    code,
    constraints,
    leverageGrid: rows,
    candidateLeverage: best.row.leverage,
    requiredInitialMargin: best.row.initial,
    otherInitialMargin: out(other),
    availableAfter: best.row.freeAfter,
    roundGain:
      code === 'FEASIBLE' && book.ref != null
        ? out(dec(base.pressureCashAfter).minus(book.ref).minus(book.roundIn).plus(book.roundOut))
        : null,
    initialMargin: [base.initialMargin[0], out(other.plus(best.margin))],
    cashAfterPayout: code === 'FEASIBLE' ? base.pressureCashAfter : null
  };
}
