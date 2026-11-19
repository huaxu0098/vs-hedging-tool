import {
  D,
  dec,
  positive,
  nonnegative,
  ratio,
  out,
  max,
  min,
  normalizeExposure,
  estimateFill,
  solveBudgetBounds,
  solveExactBounds,
  profitSplit
} from './math.js';
import { verifyFundingPair } from './funding-formula.js';
import { settlementBridge, sumPostings } from './settlement-ledger.js';
import { balances, markEquity } from './book.js';

const leg = (name, unit, mark, multiplier, step, fee, underlying) => ({
  symbol: name,
  unit,
  mark,
  step,
  minQty: step,
  minNotional: '0',
  fx: '1',
  factor: '1',
  currency: 'U',
  quoteCurrency: 'U',
  settlementCurrency: 'U',
  underlying,
  priceTick: '0.01',
  multiplier,
  type: 'linear',
  mappingVerified: true,
  rate: fee,
  pool: 'standard',
  marginMode: 'cross',
  leverage: '20',
  tiers: [{ from: '0', mmr: '0.025', deduction: '0' }],
  hold: '0',
  open: true,
  asks: [[mark, '1000000']],
  bids: [[mark, '1000000']],
  source: 'simulation_assumption'
});
export const demoMarket = (id = 'unit') => {
  const data = {
    unit: ['标准单位', '单位', '1000', '1', '0.01', '0.001'],
    btc: ['BTC', 'BTC', '100000', '1', '0.00001', '0.00001'],
    eth: ['ETH', 'ETH', '2500', '1', '0.001', '0.001'],
    sol: ['SOL', 'SOL', '160', '1', '0.01', '0.01'],
    xau: ['黄金', '盎司', '2500', '100', '0.0001', '0.001'],
    us100: ['纳指 100', '点', '20000', '5', '0.0001', '0.001']
  }[id];
  if (!data) throw Error('UNSUPPORTED_INSTRUMENT');
  const [name, unit, mark, m, vsStep, hStep] = data;
  return {
    id,
    name,
    unit,
    source: 'simulation_assumption',
    pf: leg(
      'PF-SIM-' + id,
      id === 'xau' ? '手' : id === 'us100' ? '张' : unit,
      mark,
      m,
      vsStep,
      '0.0001',
      id
    ),
    hl: leg('HL-SIM-' + id, unit, mark, '1', hStep, '0.0005', id)
  };
};
const pos = (s, market, v) =>
  Object.values(s.positions).find((p) => p.venue === v && p.asset === market.id && p.pool === market[v].pool);
const value = (l) => positive(l.multiplier).times(positive(l.fx));
const qty = (p) => dec(p?.qty ?? '0');
const sourcePrice = (l, shift) => dec(l.mark).plus(dec(shift).times(l.factor));
function exec(l, delta, shift = '0') {
  const n = dec(delta);
  if (n.isZero()) return { price: l.mark, fee: new D(0), notional: new D(0) };
  const f = estimateFill(delta, l),
    price = positive(out(dec(f.price).plus(dec(shift).times(l.factor)))),
    notional = price.times(n.abs()).times(value(l));
  return { price: out(price), fee: notional.times(ratio(l.rate)), notional };
}
// The displayed costs are components of the settlement calculation, already included in cash.
export function executionDetail(l, delta, shift = '0') {
  const fill = exec(l, delta, shift);
  const n = dec(delta);
  if (n.isZero()) return { fee: '0', impact: '0', price: null };
  const best = sourcePrice({ ...l, mark: (n.gt(0) ? l.asks : l.bids)[0][0] }, shift);
  return {
    fee: out(fill.fee),
    price: fill.price,
    impact: out(dec(fill.price).minus(best).abs().times(n.abs()).times(value(l)))
  };
}

function settlementPaths(profile, market, c) {
  const paths = { fail: {}, pass: {} };
  for (const [venue, cash, target, delta] of [
    ['pf', profile.E, c.vsTargetQuantity, c.vsDeltaQuantity],
    ['hl', profile.C_hl, c.hlTargetQuantity, c.hlDeltaQuantity]
  ]) {
    const leg = market[venue],
      entry = executionDetail(leg, delta);
    for (const [path, shift] of Object.entries(c.lines)) {
      const exit = executionDetail(leg, out(dec(target).neg()), shift);
      paths[path][venue] = settlementBridge(
        cash,
        leg,
        target,
        delta,
        shift,
        entry,
        exit,
        venue === 'hl' ? (profile.k ?? '0') : '0'
      );
    }
  }
  return paths;
}
export function fundingProof(profile, market, c) {
  return verifyFundingPair(profile, market, c, c.paths ?? settlementPaths(profile, market, c));
}

export function projectSettlementEquity(
  book,
  market,
  v,
  target,
  shift = '0',
  trigger = 'net_settlement',
  catalog = { [market.id]: market }
) {
  const l = market[v],
    p = pos(book, market, v),
    old = qty(p),
    q = dec(target),
    mark = sourcePrice(l, shift);
  if (mark.lte(0)) throw Error('INVALID_PRICE_ENDPOINT');
  const delta = q.minus(old),
    entry = exec(l, out(delta)),
    unit = value(l);
  // Current marked equity plus mark-to-fill improvement on the delta, fees,
  // future movement of the new total and, if settling, execution of its exit.
  const marks = Object.fromEntries(
    Object.values(catalog)
      .filter((m) => m[v])
      .map((m) => [m.id, m[v].mark])
  );
  let marked = dec(markEquity(book, v, marks))
    .plus(delta.times(unit).times(dec(l.mark).minus(entry.price)))
    .minus(entry.fee)
    .plus(q.times(unit).times(mark.minus(l.mark)));
  if (trigger === 'mark_equity') return marked;
  if (trigger !== 'net_settlement') throw Error('UNKNOWN_TRIGGER');
  for (const other of Object.values(book.positions)) {
    if (other.venue !== v || other === p) continue;
    const spec = catalog[other.asset]?.[v];
    if (!spec || spec.pool !== other.pool) throw Error('缺少其他持仓的结算规格');
    const trade = exec(spec, out(dec(other.qty).neg()));
    marked = marked
      .plus(dec(other.qty).times(value(spec)).times(dec(trade.price).minus(spec.mark)))
      .minus(trade.fee);
  }
  const close = exec(l, out(q.neg()), shift);
  return marked.plus(q.times(unit).times(dec(close.price).minus(mark))).minus(close.fee);
}
export function solveBoundaryPrices(
  s,
  m,
  q,
  target,
  floor,
  passTrigger = 'net_settlement',
  failureTrigger = 'net_settlement',
  catalog = { [m.id]: m }
) {
  const size = dec(q);
  if (size.isZero()) return { code: 'HOLD' };
  const price = (line, trigger) => {
    const l = m.pf,
      start = projectSettlementEquity(s, m, 'pf', q, '0', trigger, catalog);
    const slope = size
      .minus(trigger === 'net_settlement' ? size.abs().times(l.rate) : 0)
      .times(value(l))
      .times(l.factor);
    if (slope.eq(0)) throw Error('INVALID_PRICE_ENDPOINT');
    const shift = dec(line).minus(start).div(slope);
    if (sourcePrice(l, out(shift)).lte(0) || sourcePrice(m.hl, out(shift)).lte(0))
      throw Error('INVALID_PRICE_ENDPOINT');
    return out(shift);
  };
  return { pass: price(target, passTrigger), fail: price(floor, failureTrigger) };
}
export const constraint = (code, actual, required, unit, source = 'simulation_assumption') => ({
  code,
  status: actual === null ? 'unknown' : dec(actual).gte(required) ? 'pass' : 'fail',
  actual,
  required,
  shortfall: actual === null ? null : out(max(0, dec(required).minus(actual))),
  unit,
  source
});
export function maintenance(l, nominal) {
  if (!Array.isArray(l.tiers) || !l.tiers.length) return null;
  let prev = null,
    chosen = null;
  for (const tier of l.tiers) {
    const threshold = nonnegative(tier.from);
    if (prev && threshold.lte(prev)) throw Error('MARGIN_UNVERIFIED');
    if (!prev && !threshold.eq(0)) return null;
    prev = threshold;
    if (nominal.gte(threshold)) chosen = tier;
  }
  return chosen ? max(0, nominal.times(ratio(chosen.mmr)).minus(nonnegative(chosen.deduction))) : null;
}
export function validateMargin(s, m, v, q, shifts, catalog = { [m.id]: m }, funding = '0') {
  const l = m[v],
    unknown = () => [constraint('MARGIN_UNVERIFIED', null, '0', 'U', 'missing')];
  if (!l.leverage || !l.tiers?.length || l.hold == null || l.marginMode !== 'cross' || !l.pool)
    return unknown();
  let otherInitial = nonnegative(l.hold),
    otherMaint = nonnegative(l.otherMaintenance ?? l.hold);
  for (const p of Object.values(s.positions)) {
    if (p.venue !== v || (p.asset === m.id && p.pool === l.pool)) continue;
    const other = catalog[p.asset]?.[v];
    if (!other || p.pool !== l.pool || other.marginMode !== 'cross') return unknown();
    const n = qty(p).abs().times(value(other)).times(other.mark),
      mm = maintenance(other, n);
    if (!other.leverage || mm === null) return unknown();
    otherInitial = otherInitial.plus(n.div(positive(other.leverage)));
    otherMaint = otherMaint.plus(mm);
  }
  const nominal = dec(q).abs().times(value(l)),
    initial = otherInitial.plus(nominal.times(l.mark).div(positive(l.leverage)));
  const checks = [
    constraint(
      v + '_INITIAL_MARGIN',
      out(projectSettlementEquity(s, m, v, q, '0', 'mark_equity')),
      out(initial),
      'U'
    )
  ];
  const points = new Set(shifts);
  if (nominal.gt(0))
    for (const tier of l.tiers) {
      const knot = dec(tier.from).div(nominal).minus(l.mark).div(l.factor);
      if (knot.gt(D.min(...shifts)) && knot.lt(D.max(...shifts))) points.add(out(knot));
    }
  let worst = null,
    worstEquity = null,
    worstMaintenance = null;
  for (const shift of points) {
    const mark = sourcePrice(l, shift);
    if (mark.lte(0)) throw Error('INVALID_PRICE_ENDPOINT');
    const mm = maintenance(l, nominal.times(mark));
    if (mm === null) return unknown();
    const excess = projectSettlementEquity(s, m, v, q, shift, 'mark_equity')
      .minus(otherMaint)
      .minus(mm)
      .minus(funding);
    if (worst === null || excess.lt(worst)) {
      worst = excess;
      worstMaintenance = mm.plus(otherMaint);
      worstEquity = excess.plus(worstMaintenance);
    }
  }
  const path = constraint(v + '_MAINTENANCE_PATH', out(worst), '0', 'U');
  path.equity = out(worstEquity);
  path.maintenance = out(worstMaintenance);
  if (!dec(q).isZero() && worst.lte('1e-36')) path.status = 'fail';
  return [...checks, path];
}
// Each segment has constant sensitivity and a linear maintenance requirement.
export function liquidationMark(s, m, q, catalog = { [m.id]: m }, debit = '0') {
  const l = m.hl,
    qty = dec(q);
  if (qty.isZero() || l.marginMode !== 'cross' || !l.tiers?.length || l.hold == null) return null;
  let other = nonnegative(l.otherMaintenance ?? l.hold);
  for (const p of Object.values(s.positions).filter((p) => p.venue === 'hl' && p.asset !== m.id)) {
    const spec = catalog[p.asset]?.hl;
    if (!spec || p.pool !== l.pool || spec.marginMode !== 'cross') return null;
    const mm = maintenance(spec, dec(p.qty).abs().times(value(spec)).times(spec.mark));
    if (mm == null) return null;
    other = other.plus(mm);
  }
  const signed = qty.times(value(l)),
    size = signed.abs(),
    mark = positive(l.mark),
    equity = projectSettlementEquity(s, m, 'hl', q, '0', 'mark_equity').minus(debit);
  const currentMaintenance = maintenance(l, size.times(mark));
  if (currentMaintenance === null) return null;
  if (equity.minus(other).lte(currentMaintenance)) return out(mark);
  const roots = [];
  for (const [i, t] of l.tiers.entries()) {
    const slope = signed.minus(size.times(t.mmr));
    if (slope.isZero()) continue;
    const x = signed.times(mark).plus(other).minus(equity).minus(t.deduction).div(slope),
      nominal = x.times(size);
    if (
      x.gt(0) &&
      x.minus(mark).times(signed).lte(0) &&
      nominal.gte(t.from) &&
      (!l.tiers[i + 1] || nominal.lt(l.tiers[i + 1].from))
    )
      roots.push(x);
  }
  return roots.length ? out(roots.sort((a, b) => a.minus(mark).abs().cmp(b.minus(mark).abs()))[0]) : null;
}
export function pathStress(s, m, q, lines, stress, catalog) {
  const mark = positive(m.hl.mark),
    atPass = dec(lines.pass),
    direction = dec(q).gt(0) ? -1 : 1;
  const jump = mark.times(nonnegative(stress.jumpBps)).div(10000).div(m.hl.factor).times(direction);
  const basis = mark.times(nonnegative(stress.basisBps)).div(10000).div(m.hl.factor).times(direction);
  const extraFees = nonnegative(stress.fundingDebit);
  const shocks = [
    ['跳价', out(atPass.plus(jump)), '0'],
    ['基差扩大', out(atPass.plus(basis)), '0'],
    ['资金费', out(atPass), out(extraFees)]
  ];
  const results = shocks.map(([name, shift, fee]) => ({
    ...validateMargin(s, m, 'hl', q, ['0', shift], catalog, fee).at(-1),
    name
  }));
  // During a delayed hedge fill only the pre-existing Hype position is present.
  const old = out(qty(pos(s, m, 'hl'))),
    delay = mark.times(nonnegative(stress.delayBps)).div(10000).div(m.hl.factor);
  const directions = [out(delay), out(delay.neg())];
  results.push({
    ...validateMargin(s, m, 'hl', old, ['0', ...directions], catalog).at(-1),
    name: 'Hype 成交延迟（原仓）'
  });
  // Completing an adverse delayed fill locks in a worse entry on the delta.
  const delayCost = dec(q).minus(old).abs().times(value(m.hl)).times(delay).times(m.hl.factor);
  results.push({
    ...validateMargin(s, m, 'hl', q, ['0', lines.pass, lines.fail], catalog, out(delayCost)).at(-1),
    name: '延迟后按压力价补齐'
  });
  return results;
}
export function evaluateCandidate(s, m, p, pfQty, hlQty, options = {}) {
  const v = dec(pfQty),
    h = dec(hlQty),
    vs = dec(normalizeExposure(pfQty, m.pf)),
    hs = dec(normalizeExposure(hlQty, m.hl));
  if (v.eq(0)) return { code: 'HOLD', actualRatio: null };
  if (vs.times(hs).gt(0)) throw Error('WRONG_DIRECTION');
  const constraints = [];
  for (const [venue, n] of [
    ['pf', v],
    ['hl', h]
  ]) {
    const l = m[venue],
      delta = n.minus(qty(pos(s, m, venue)));
    if (!l.open) throw Error('MARKET_CLOSED');
    if (!n.abs().mod(positive(l.step)).eq(0) || !delta.abs().mod(l.step).eq(0)) throw Error('INVALID_STEP');
    if (options.liveLimits && l.pendingQty && !dec(l.pendingQty).eq(0)) {
      const pending = dec(l.pendingQty);
      constraints.push(
        constraint(
          venue + '_PENDING',
          out(delta.times(pending.gt(0) ? 1 : -1)),
          out(pending.abs()),
          l.unit,
          '确认挂单'
        )
      );
    }
    if (!delta.eq(0)) {
      if (l.leverage && n.abs().gt(qty(pos(s, m, venue)).abs())) {
        const nominal = n.abs().times(value(l)).times(l.mark);
        const tier = l.tiers?.findLast((t) => nominal.gte(t.from));
        if (tier?.maxLeverage)
          constraints.push(constraint(venue + '_TIER_LEVERAGE', tier.maxLeverage, l.leverage, '倍'));
      }
      if (options.currentSnapshot && l.free == null && !l.directionalFree && !Array.isArray(l.capacity))
        constraints.push(constraint(venue + '_AVAILABLE', null, '0', 'U', 'missing'));
      if (Array.isArray(l.capacity)) {
        constraints.push(
          constraint(venue + '_AVAILABLE', l.capacity[delta.gt(0) ? 0 : 1], out(delta.abs()), l.unit)
        );
      }
      const available = l.directionalFree?.[delta.gt(0) ? 0 : 1] ?? l.free;
      if (available != null && l.leverage) {
        const marginChange = n
          .abs()
          .minus(qty(pos(s, m, venue)).abs())
          .times(value(l))
          .times(l.mark)
          .div(positive(l.leverage));
        const needed = max(0, marginChange.plus(exec(l, out(delta)).fee));
        constraints.push(constraint(venue + '_AVAILABLE', available, out(needed), 'U'));
      }
      constraints.push(
        constraint(venue + '_MIN_QTY', out(delta.abs()), l.minQty, l.unit),
        constraint(venue + '_MIN_NOTIONAL', out(exec(l, out(delta)).notional), l.minNotional, 'U')
      );
    }
  }
  const lines = solveBoundaryPrices(
    s,
    m,
    pfQty,
    p.target,
    p.floor,
    options.passTrigger,
    options.failureTrigger,
    options.catalog
  );
  if (dec(lines.pass).times(v).lte(0) || dec(lines.fail).times(v).gte(0))
    throw Error('CANDIDATE_ALREADY_AT_BOUNDARY');
  const paths =
    options.currentSnapshot && Object.values(s.positions).every((x) => x.asset === m.id)
      ? settlementPaths(p, m, {
          lines,
          vsTargetQuantity: pfQty,
          hlTargetQuantity: hlQty,
          vsDeltaQuantity: out(v.minus(qty(pos(s, m, 'pf')))),
          hlDeltaQuantity: out(h.minus(qty(pos(s, m, 'hl'))))
        })
      : null;
  const personal = balances(s, { [m.id]: m.hl.mark });
  const payout =
    p.stage === 'funded'
      ? profitSplit(
          out(projectSettlementEquity(s, m, 'pf', pfQty, lines.pass, 'net_settlement', options.catalog)),
          p.baseline,
          p.share
        ).user
      : '0';
  const extra = options.currentSnapshot ? nonnegative(p.k) : new D(0);
  const failureHypeCash =
    paths?.fail.hl.settled ??
    out(
      projectSettlementEquity(s, m, 'hl', hlQty, lines.fail, 'net_settlement', options.catalog).minus(extra)
    );
  const successHypeCash =
    paths?.pass.hl.settled ??
    out(
      projectSettlementEquity(s, m, 'hl', hlQty, lines.pass, 'net_settlement', options.catalog).minus(extra)
    );
  const protect = dec(sumPostings([failureHypeCash, s.external])),
    before = dec(sumPostings([successHypeCash, s.external, personal.inTransit])),
    after = before.plus(payout),
    round = s.ref == null ? null : after.minus(s.ref).minus(s.roundIn).plus(s.roundOut);
  constraints.push(
    constraint('FAILURE_RECOVERY', out(protect), p.B, 'U'),
    constraint('CASH_BEFORE_PAYOUT', successHypeCash, p.R, 'U')
  );
  if (p.stage === 'funded' && round !== null)
    constraints.push(constraint('ROUND_GAIN', out(round), p.g, 'U'));
  for (const [venue, q] of [
    ['pf', pfQty],
    ['hl', hlQty]
  ])
    constraints.push(...validateMargin(s, m, venue, q, ['0', lines.pass, lines.fail], options.catalog));
  if (options.liveLimits) {
    for (const [venue, size] of [
      ['pf', v],
      ['hl', h]
    ]) {
      const l = m[venue],
        old = qty(pos(s, m, venue)),
        delta = size.minus(old);
      if (l.maxQty != null)
        constraints.push(constraint(venue + '_POSITION_LIMIT', l.maxQty, out(size.abs()), l.unit));
      const margin = constraints.find((c) => c.code === venue + '_INITIAL_MARGIN');
      if (margin && l.utilization != null)
        constraints.push(
          constraint(
            venue + '_UTILIZATION',
            out(dec(margin.actual).times(l.utilization)),
            margin.required,
            'U'
          )
        );
      if (l.leverage && l.reserve != null) {
        const free = l.directionalFree?.[delta.lt(0) ? 1 : 0] ?? l.free;
        const change = size.abs().minus(old.abs()).times(value(l)).times(l.mark).div(l.leverage);
        constraints.push(
          constraint(
            venue + '_FREE_RESERVE',
            free == null
              ? null
              : out(
                  dec(free)
                    .minus(change)
                    .minus(exec(l, out(delta)).fee)
                ),
            l.reserve,
            'U'
          )
        );
      }
    }
  }
  const stressBps = max(nonnegative(options.adverseBps ?? '0'), nonnegative(options.stress?.jumpBps ?? '0'));
  const shock = stressBps
    .times(m.hl.mark)
    .div(10000)
    .div(m.hl.factor)
    .times(h.gt(0) ? -1 : 1);
  const scenarioCash = [];
  let endpointStress = null;
  const delayDebit = h
    .minus(qty(pos(s, m, 'hl')))
    .abs()
    .times(value(m.hl))
    .times(m.hl.mark)
    .times(nonnegative(options.stress?.delayBps ?? '0'))
    .div(10000);
  const extraDebit = delayDebit.plus(h.isZero() ? 0 : nonnegative(options.stress?.fundingDebit ?? '0'));
  if ((!shock.isZero() && !h.isZero()) || !extraDebit.isZero()) {
    const atBoundary = (shift) =>
      projectSettlementEquity(
        s,
        m,
        'hl',
        hlQty,
        out(dec(shift).plus(shock)),
        'net_settlement',
        options.catalog
      )
        .minus(extra)
        .minus(extraDebit);
    const downside = atBoundary(lines.fail).plus(s.external),
      survive = atBoundary(lines.pass),
      end = survive.plus(s.external).plus(payout);
    constraints.push(
      constraint('STRESS_FAILURE', out(downside), p.B, 'U'),
      constraint('STRESS_RESERVE', out(survive), p.R, 'U')
    );
    if (p.stage === 'funded' && s.ref != null)
      constraints.push(
        constraint('STRESS_GAIN', out(end.minus(s.ref).minus(s.roundIn).plus(s.roundOut)), p.g, 'U')
      );
    const stressPass = dec(lines.pass).plus(shock);
    const extraBuffer = nonnegative(options.minPriceBuffer ?? '0')
      .div(m.hl.factor)
      .times(h.gt(0) ? -1 : 1);
    const shifts = [
      '0',
      out(dec(lines.fail).plus(shock)),
      out(stressPass),
      out(stressPass.plus(extraBuffer))
    ];
    constraints.push({
      ...validateMargin(s, m, 'hl', hlQty, shifts, options.catalog, out(extraDebit)).at(-1),
      code: 'STRESS_MAINTENANCE'
    });
    endpointStress = {
      failureCash: out(downside),
      successHypeCash: out(survive),
      priceShock: out(shock.times(m.hl.factor)),
      delayDebit: out(delayDebit),
      fundingDebit: out(extraDebit.minus(delayDebit))
    };
    scenarioCash.push(out(downside), out(survive.plus(s.external)));
  }
  const stress = options.stress
    ? pathStress(
        s,
        m,
        hlQty,
        lines,
        h.isZero() ? { ...options.stress, fundingDebit: '0' } : options.stress,
        options.catalog
      )
    : [];
  constraints.push(...stress);
  const modelLiq = liquidationMark(s, m, hlQty, options.catalog);
  const pressureMark = sourcePrice(m.hl, lines.pass);
  const stressMark = sourcePrice(m.hl, out(dec(lines.pass).plus(shock)));
  const stressLiq = extraDebit.isZero()
    ? modelLiq
    : liquidationMark(s, m, hlQty, options.catalog, out(extraDebit));
  const currentRef = h.eq(qty(pos(s, m, 'hl'))) && !h.eq(0) ? m.hl.currentLiquidation : null;
  const useReference =
    currentRef != null && (modelLiq == null || dec(currentRef).minus(modelLiq).times(h).gte(0));
  const liq = useReference ? currentRef : modelLiq;
  if (currentRef != null) {
    const distance = min(
      ...[
        '0',
        lines.pass,
        lines.fail,
        out(dec(lines.fail).plus(shock)),
        out(dec(lines.pass).plus(shock))
      ].map((shift) =>
        sourcePrice(m.hl, shift)
          .minus(currentRef)
          .times(h.gt(0) ? 1 : -1)
      )
    );
    const refCheck = constraint(
      'hl_REFERENCE_LIQ',
      out(distance),
      options.minPriceBuffer ?? '0',
      '价格单位',
      'platform'
    );
    if (distance.lte(0)) refCheck.status = 'fail';
    constraints.push(refCheck);
  }
  const stressRoot =
    currentRef != null && (stressLiq == null || dec(currentRef).minus(stressLiq).times(h).gte(0))
      ? currentRef
      : stressLiq;
  const stressBuffer = stressRoot == null ? null : out(stressMark.minus(stressRoot).times(h.gt(0) ? 1 : -1));
  const priceBuffer = liq === null ? null : out(pressureMark.minus(liq).times(h.gt(0) ? 1 : -1));
  if (options.minPriceBuffer && nonnegative(options.minPriceBuffer).gt(0) && !h.eq(0)) {
    // Validate the entire extra adverse price move, including a possible tier change.
    const adverse = pressureMark.minus(dec(options.minPriceBuffer).times(h.gt(0) ? 1 : -1));
    if (adverse.gt(0)) {
      const shift = out(adverse.minus(m.hl.mark).div(m.hl.factor));
      constraints.push({
        ...validateMargin(s, m, 'hl', hlQty, ['0', lines.pass, shift], options.catalog).at(-1),
        code: 'hl_PRICE_BUFFER'
      });
    } else if (h.gt(0)) {
      constraints.push(constraint('hl_PRICE_BUFFER', priceBuffer, options.minPriceBuffer, '价格单位'));
    }
  }
  if (options.currentSnapshot)
    for (const check of constraints)
      if (check.source === 'simulation_assumption') check.source = '当前快照、行情及已设规则';
  const checks = constraints.map((c) => c.status),
    code = checks.includes('unknown')
      ? 'MARGIN_UNVERIFIED'
      : checks.includes('fail')
        ? 'REJECTED'
        : 'FEASIBLE';
  return {
    code,
    stress,
    scenarioCash,
    endpointStress,
    worstAvailableCash: out(min(protect, dec(successHypeCash).plus(s.external), ...scenarioCash)),
    paths,
    failureHypeCash,
    externalReceived: out(dec(s.external)),
    hlBeforePayout: successHypeCash,
    modelLiq,
    liqMark: liq,
    liqSource: useReference ? '当前仓平台参考' : '全仓档位测算',
    pressureMark: out(pressureMark),
    stressLiqMark: stressRoot,
    stressPressureMark: out(stressMark),
    stressPriceBuffer: stressBuffer,
    priceBuffer,
    targetEquity: p.target,
    expectedUserPayout: payout,
    vsTargetQuantity: pfQty,
    hlTargetQuantity: hlQty,
    vsCurrentQuantity: out(qty(pos(s, m, 'pf'))),
    hlCurrentQuantity: out(qty(pos(s, m, 'hl'))),
    vsDeltaQuantity: out(v.minus(qty(pos(s, m, 'pf')))),
    hlDeltaQuantity: out(h.minus(qty(pos(s, m, 'hl')))),
    actualRatio: out(hs.abs().div(vs.abs())),
    remainingExposure: out(vs.plus(hs)),
    vsNotional: out(v.abs().times(value(m.pf)).times(m.pf.mark)),
    hlNotional: out(h.abs().times(value(m.hl)).times(m.hl.mark)),
    failureCash: out(protect),
    cashBeforePayout: out(before),
    cashAfterPayout: code === 'FEASIBLE' ? out(after) : null,
    roundGain: code === 'FEASIBLE' && round !== null ? out(round) : null,
    pressureCashAfter: out(after),
    lines,
    constraints,
    initialMargin: constraints.filter((c) => c.code.endsWith('INITIAL_MARGIN')).map((c) => c.required),
    buffer: constraints.find((c) => c.code === 'hl_MAINTENANCE_PATH')?.actual
  };
}
export function profileInputs(s, params, m) {
  const b = balances(s, { [m.id]: m.hl.mark });
  return {
    stage: s.stage,
    E: markEquity(s, 'pf', { [m.id]: m.pf.mark }),
    C_hl: b.hl,
    C_external: s.external,
    inTransit: b.inTransit,
    C_ref: s.ref,
    B: s.B,
    floor: s.stage === 'challenge' ? s.challengeFloor : s.fundedFloor,
    target: s.stage === 'challenge' ? s.challengeTarget : params.target,
    baseline: s.baseline,
    share: s.share,
    R: params.R,
    g: params.g,
    k: params.k,
    contributions: s.roundIn,
    withdrawals: s.roundOut
  };
}
function gridPoints(raw, step) {
  const x = dec(raw).abs().div(positive(step));
  return [out(x.floor().times(step)), out(x.ceil().times(step))];
}
// Price shifts at the cash constraints give inverse PF size boundaries when the Hype leg is fixed.
function currentPFSizes(s, m, p, mode, theory, options) {
  const l = m.pf,
    unit = value(l).times(l.mark),
    step = positive(l.step);
  const old = qty(pos(s, m, 'pf')),
    h = qty(pos(s, m, 'hl'));
  const anchors = new Set();
  const add = (q) => {
    if (q.gt(0)) anchors.add(out(q.times(unit)));
  };
  add(old.abs());
  const fixed = mode === 'keepHL';
  const shifts = [];
  if (!h.eq(0)) {
    const base = projectSettlementEquity(s, m, 'hl', out(h), '0', 'net_settlement', options.catalog);
    const slope = h.minus(h.abs().times(m.hl.rate)).times(value(m.hl)).times(m.hl.factor);
    const failure = dec(p.B).minus(s.external).plus(p.k);
    const success = dec(p.R).plus(p.k);
    const bounds = [
      [failure, p.floor],
      [success, p.target]
    ];
    if (p.stage === 'funded' && s.ref != null)
      bounds.push([
        dec(s.ref)
          .plus(p.g)
          .plus(p.k)
          .plus(s.roundIn)
          .minus(s.roundOut)
          .minus(s.external)
          .minus(p.inTransit)
          .minus(profitSplit(p.target, p.baseline, p.share).user),
        p.target
      ]);
    for (const [cash, equity] of bounds) shifts.push([cash.minus(base).div(slope), equity]);
    if (fixed) {
      const liq = liquidationMark(s, m, out(h), options.catalog);
      if (liq) {
        const safeMark = dec(liq).plus(dec(options.minPriceBuffer ?? '0').times(h.gt(0) ? 1 : -1));
        shifts.push([safeMark.minus(m.hl.mark).div(m.hl.factor), p.target]);
      }
    }
    for (const hBound of [theory.min, theory.max]) {
      if (hBound && dec(hBound).gt(0))
        add(
          dec(normalizeExposure(out(h), m.hl))
            .abs()
            .div(hBound)
            .div(normalizeExposure('1', l))
        );
    }
  }
  for (const direction of fixed && !h.eq(0) ? [h.gt(0) ? -1 : 1] : [1, -1]) {
    const buy = direction > 0 ? l.asks : l.bids,
      sell = direction > 0 ? l.bids : l.asks;
    const oldSigned = old.times(direction),
      knots = [new D(0), oldSigned];
    let entryDepth = new D(0),
      exitDepth = new D(0);
    for (const [, n] of buy) {
      entryDepth = entryDepth.plus(n);
      knots.push(oldSigned.plus(entryDepth));
    }
    for (const [, n] of sell) {
      exitDepth = exitDepth.plus(n);
      knots.push(exitDepth, oldSigned.minus(exitDepth));
    }
    const lo = max(step, oldSigned.minus(exitDepth));
    let hi = min(exitDepth, oldSigned.plus(entryDepth));
    if (l.leverage)
      hi = min(
        hi,
        max(0, dec(p.E).minus(l.hold ?? 0))
          .times(l.leverage)
          .div(unit)
      );
    if (hi.lt(lo)) continue;
    add(lo);
    add(hi);
    if (!fixed) {
      // Cover executable prices from the smallest positive-boundary trade to observed depth.
      const start = min(hi, max(lo, dec(p.target).minus(p.floor).abs().div(unit)));
      add(start);
      for (let i = 1; i < 5; i++) add(start.times(hi.div(start).pow(dec(String(i)).div(5))));
      continue;
    }
    const points = [...new Set([lo, hi, ...knots].filter((q) => q.gte(lo) && q.lte(hi)).map(out))]
      .map(dec)
      .sort((a, b) => a.cmp(b));
    for (const x of points) add(x);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      for (const [shift, line] of shifts) {
        if (sourcePrice(l, out(shift)).lte(0)) continue;
        const gap = (q) =>
          projectSettlementEquity(
            s,
            m,
            'pf',
            out(q.times(direction)),
            out(shift),
            'net_settlement',
            options.catalog
          ).minus(line);
        try {
          const ga = gap(a),
            gb = gap(b);
          if (ga.times(gb).lte(0) && !ga.eq(gb)) {
            const root = a.minus(ga.times(b.minus(a)).div(gb.minus(ga)));
            add(root);
            add(root.minus(step));
            add(root.plus(step));
          }
        } catch (e) {
          if (!['INVALID_PRICE_ENDPOINT', 'INSUFFICIENT_DEPTH', '数值必须大于零'].includes(e.message))
            throw e;
        }
      }
    }
  }
  return [...anchors];
}
export function solve(s, m, params, options = {}) {
  const p = profileInputs(s, params, m),
    oldQty = out(qty(pos(s, m, 'pf'))),
    passMode = options.passTrigger ?? s.passTrigger ?? 'net_settlement',
    failMode = options.failureTrigger ?? s.failureTrigger ?? 'net_settlement';
  options = { ...options, passTrigger: passMode, failureTrigger: failMode };
  const triggerEquity = out(projectSettlementEquity(s, m, 'pf', oldQty, '0', passMode, options.catalog)),
    failureEquity = projectSettlementEquity(s, m, 'pf', oldQty, '0', failMode, options.catalog);
  const budgetInput = { ...p, E: triggerEquity },
    theory = solveBudgetBounds(budgetInput),
    warnings = [],
    rejected = [],
    candidates = [];
  const result = {
    stateVersion: s.revision,
    ruleProfileVersion: s.profileVersion,
    snapshotIds: [...(options.snapshotIds ?? [])],
    model: 'event_simulation',
    theory,
    status: 'unverified',
    selected: null,
    candidates,
    rejected,
    hold: { code: 'HOLD', actualRatio: null },
    feasibleIntervals: [],
    searchComplete: false,
    unresolved: warnings
  };
  if (
    !['CHALLENGE_ACTIVE', 'FUNDED_ACTIVE'].includes(s.status) ||
    (s.stage === 'challenge' &&
      Date.parse(options.now ?? s.challengeStartedAt) >= Date.parse(s.challengeDeadlineAt))
  )
    return {
      ...result,
      status: 'terminal',
      code: s.status === 'CHALLENGE_ACTIVE' ? 'EXIT_REQUIRED' : s.status
    };
  if (failureEquity.lte(p.floor))
    return {
      ...result,
      status: 'terminal',
      code: s.stage === 'challenge' ? 'CHALLENGE_FAILED' : 'FUNDED_FAILED'
    };
  if (!theory.min && !(s.stage === 'funded' && params.targets?.some((t) => dec(t).gt(triggerEquity))))
    return { ...result, status: 'terminal', code: theory.code };
  if (s.additionalRules?.length)
    return {
      ...result,
      code: 'UNVERIFIED',
      unresolved: ['另有平台限制需独立核实：' + s.additionalRules.map((r) => r.name ?? r).join('、')]
    };
  if (
    m.pf.underlying !== m.hl.underlying ||
    m.pf.mappingVerified !== true ||
    m.hl.mappingVerified !== true ||
    m.pf.type !== 'linear' ||
    m.hl.type !== 'linear'
  )
    return { ...result, code: 'UNVERIFIED', unresolved: ['不支持该合约类型或双边标的映射未确认'] };
  if (options.issues?.length || (s.mode === 'live_readonly' && !options.currentSnapshot))
    return {
      ...result,
      code: 'UNVERIFIED',
      unresolved: options.issues?.length ? options.issues : ['真实账户规则、币种换算和候选保证金须独立核实']
    };
  const targets =
    s.stage === 'challenge'
      ? [s.challengeTarget]
      : [...new Set(params.targets?.length ? params.targets : [p.target])];
  result.targets = targets;
  const fixedHL = params.mode === 'keepHL';
  const oldH = qty(pos(s, m, 'hl'));
  const automatic = fixedHL || (options.currentSnapshot && params.mode === 'joint' && !params.sizes?.length);
  const pfSizes = automatic
    ? currentPFSizes(s, m, p, params.mode, theory, options)
    : params.mode === 'keepPF'
      ? [out(dec(oldQty).abs().times(value(m.pf)).times(m.pf.mark))]
      : params.mode === 'fixedPF'
        ? [params.pfSize]
        : params.sizes?.length
          ? params.sizes
          : [params.pfSize];
  let allEnumerated = !automatic,
    terminalReasons = [];
  for (const target of targets)
    for (const size of pfSizes)
      for (const dir of params.mode === 'keepPF'
        ? [dec(oldQty).lt(0) ? -1 : 1]
        : fixedHL && !oldH.eq(0)
          ? [oldH.gt(0) ? -1 : 1]
          : (params.directions ?? [1, -1])) {
        if (![1, -1].includes(dir)) throw Error('INVALID_DIRECTION');
        const pp = { ...p, target },
          range = solveBudgetBounds({ ...budgetInput, target });
        if (!range.min) {
          terminalReasons.push(range.code);
          continue;
        }
        if (nonnegative(size).eq(0)) continue;
        const pfGrid =
          params.mode === 'keepPF'
            ? [out(dec(oldQty).abs())]
            : gridPoints(out(dec(size).div(value(m.pf).times(m.pf.mark))), m.pf.step);
        for (const raw of new Set(pfGrid)) {
          if (dec(raw).isZero()) continue;
          const v = out(dec(raw).times(dir)),
            scale = dec(normalizeExposure(v, m.pf))
              .abs()
              .div(dec(normalizeExposure('1', m.hl)));
          const hs = new Set(),
            n = dec(raw).times(value(m.pf)).times(m.pf.mark);
          const exact = solveExactBounds(pp, {
            N: out(n),
            direction: dir,
            fV: m.pf.rate,
            fH: m.hl.rate,
            basis: 'flat_before_entry'
          });
          const maxQty = m.hl.leverage
            ? max(0, dec(p.C_hl).times(positive(m.hl.leverage)).div(value(m.hl).times(m.hl.mark)))
            : null;
          const cap = maxQty?.div(m.hl.step).floor();
          const step = positive(m.hl.step);
          if (fixedHL) hs.add(out(oldH.abs()));
          else if (params.mode === 'fixedHL')
            gridPoints(out(nonnegative(params.hlSize).div(value(m.hl).times(m.hl.mark))), m.hl.step).forEach(
              (x) => hs.add(x)
            );
          else if (cap && cap.lte(120)) {
            for (let i = 0; i <= cap.toNumber(); i++) hs.add(out(step.times(i)));
          } else {
            allEnumerated = false;
            const anchors = [
              new D(0),
              qty(pos(s, m, 'hl')).abs(),
              ...[range.min, range.max, exact.min, exact.max]
                .filter((x) => x != null)
                .map((x) => max(0, dec(x)).times(scale))
            ];
            if (maxQty) anchors.push(maxQty);
            // Costs are affine between changes of side and depth. Interpolate the
            // actual endpoint gaps to find the nearest legal lots for legacy holdings.
            try {
              const lines = solveBoundaryPrices(
                s,
                m,
                v,
                target,
                p.floor,
                options.passTrigger,
                options.failureTrigger,
                options.catalog
              );
              const breaks = new Set(['0', out(qty(pos(s, m, 'hl')).abs()), ...anchors.map(out)]);
              for (const side of ['bids', 'asks']) {
                let depth = new D(0);
                for (const [, sz] of m.hl[side] ?? []) {
                  depth = depth.plus(sz);
                  breaks.add(out(depth));
                  breaks.add(
                    out(
                      qty(pos(s, m, 'hl'))
                        .abs()
                        .plus(depth)
                    )
                  );
                  breaks.add(
                    out(
                      max(
                        0,
                        qty(pos(s, m, 'hl'))
                          .abs()
                          .minus(depth)
                      )
                    )
                  );
                }
              }
              const ordered = [...breaks]
                .map(dec)
                .filter((x) => !maxQty || x.lte(maxQty))
                .sort((a, b) => a.cmp(b));
              for (let i = 1; i < ordered.length; i++)
                for (const [shift, requirement] of [
                  [
                    lines.fail,
                    dec(p.B)
                      .minus(s.external)
                      .plus(options.currentSnapshot ? p.k : 0)
                  ],
                  [lines.pass, dec(p.R).plus(options.currentSnapshot ? p.k : 0)],
                  ...(s.ref == null || pp.stage !== 'funded'
                    ? []
                    : [
                        [
                          lines.pass,
                          dec(s.ref)
                            .plus(options.currentSnapshot ? p.k : 0)
                            .plus(p.g)
                            .minus(pp.stage === 'funded' ? profitSplit(target, p.baseline, p.share).user : 0)
                            .minus(s.external)
                            .minus(p.inTransit)
                            .plus(s.roundIn)
                            .minus(s.roundOut)
                        ]
                      ])
                ]) {
                  const [a, b] = ordered.slice(i - 1, i + 1);
                  const va = projectSettlementEquity(
                      s,
                      m,
                      'hl',
                      out(a.times(-dir)),
                      shift,
                      'net_settlement',
                      options.catalog
                    ).minus(requirement),
                    vb = projectSettlementEquity(
                      s,
                      m,
                      'hl',
                      out(b.times(-dir)),
                      shift,
                      'net_settlement',
                      options.catalog
                    ).minus(requirement);
                  if (!va.eq(vb) && va.times(vb).lte(0))
                    anchors.push(a.minus(va.times(b.minus(a)).div(vb.minus(va))));
                }
            } catch {
              /* Each candidate below independently reports unavailable endpoints or depth. */
            }
            for (const a of anchors)
              for (const q of gridPoints(out(a), m.hl.step))
                for (const off of [-1, 0, 1])
                  if (dec(q).plus(step.times(off)).gte(0)) hs.add(out(dec(q).plus(step.times(off))));
          }
          for (const q of hs) {
            if (maxQty && dec(q).gt(maxQty) && params.mode !== 'fixedHL' && !fixedHL) continue;
            try {
              const r = evaluateCandidate(s, m, pp, v, out(dec(q).times(-dir)), options);
              r.theoreticalRatio = exact.min ?? range.min;
              if (
                r.code === 'FEASIBLE' ||
                (options.currentSnapshot &&
                  r.code === 'MARGIN_UNVERIFIED' &&
                  r.constraints.every((c) => c.status !== 'fail'))
              )
                candidates.push(r);
              else rejected.push(r);
            } catch (e) {
              if (e.message === 'LEDGER_MISMATCH') throw e;
              rejected.push({
                code: e.message,
                targetEquity: target,
                vsTargetQuantity: v,
                hlTargetQuantity: out(dec(q).times(-dir))
              });
            }
          }
        }
      }
  const score = (r) =>
    params.sort === 'worst'
      ? min(dec(r.failureCash), dec(r.cashAfterPayout))
      : params.sort === 'margin'
        ? amountMargin(r).neg()
        : params.sort === 'buffer'
          ? dec(r.buffer)
          : dec(r.roundGain ?? r.pressureCashAfter);
  function amountMargin(r) {
    return dec(r.initialMargin[1]);
  }
  candidates.sort(
    (a, b) =>
      Number(b.code === 'FEASIBLE') - Number(a.code === 'FEASIBLE') ||
      score(b).cmp(score(a)) ||
      dec(a.hlNotional).cmp(b.hlNotional)
  );
  result.searchComplete = allEnumerated;
  result.feasibleIntervals = [...new Set(candidates.map((r) => r.actualRatio))].map((h) => ({
    min: h,
    max: h
  }));
  if (candidates.length)
    return {
      ...result,
      status: candidates[0].code === 'FEASIBLE' ? 'feasible' : 'conditional',
      code: candidates[0].code,
      selected: candidates[0]
    };
  if (
    rejected.some(
      (r) =>
        r.code === 'MARGIN_UNVERIFIED' &&
        (!options.currentSnapshot || r.constraints?.every((c) => c.status !== 'fail'))
    )
  )
    return { ...result, code: 'MARGIN_UNVERIFIED', unresolved: ['保证金参数或资金池未验证'] };
  if (pfSizes.every((x) => dec(x).eq(0))) return { ...result, status: 'hold', code: 'HOLD' };
  return {
    ...result,
    status: 'infeasible',
    code: terminalReasons[0] ?? (allEnumerated ? 'NO_DISCRETE_MATCH' : 'NO_MATCH_IN_SEARCH')
  };
}
