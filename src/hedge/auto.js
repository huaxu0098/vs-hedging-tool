// Legal lots are divided at every entry/exit depth breakpoint. Between breakpoints
// settlement at today's mark is affine in lots; the boundary shift is A/lots + B.
// Those bounds let us exclude whole rectangles without assuming a hedge ratio.
import { D, dec, positive, nonnegative, out, min, max, profitSplit } from './math.js';
import { evaluateLeverageGrid } from './leverage.js';
import { executionDetail, projectSettlementEquity, profileInputs } from './solver.js';

const slack = dec('1e-28'); // Round bounds outwards; final admission always uses the exact candidate.
const units = (l) => positive(l.multiplier).times(l.fx);
const ordinal = (n) => {
  const i = n.toNumber();
  if (!Number.isSafeInteger(i)) throw Error('数量网格超出精确索引范围');
  return i;
};
const lerp = (a, b, i) =>
  a.i === b.i
    ? a.base
    : a.base.plus(
        b.base
          .minus(a.base)
          .times(i - a.i)
          .div(b.i - a.i)
      );

function segments(book, market, v, sign, old, applyCaps = true) {
  const l = market[v],
    step = positive(l.step),
    unit = units(l),
    nominal = unit.times(l.mark);
  const held = dec(old).times(sign),
    cuts = [held];
  let entry = new D(0),
    exit = new D(0);
  for (const [, sz] of sign > 0 ? l.asks : l.bids) {
    entry = entry.plus(sz);
    cuts.push(held.plus(entry));
  }
  for (const [, sz] of sign > 0 ? l.bids : l.asks) {
    exit = exit.plus(sz);
    cuts.push(exit, held.minus(exit));
  }
  let ceiling = min(exit, held.plus(entry));
  const credit = l.currentMarginCredit;
  const free = l.directionalFree ? max(...l.directionalFree.map(dec)) : l.free;
  if (applyCaps && free != null && l.leverage)
    ceiling = min(
      ceiling,
      credit != null
        ? max(
            0,
            dec(free)
              .plus(credit)
              .minus(l.reserve ?? '0')
          )
            .times(l.leverage)
            .div(nominal)
        : held.abs().plus(
            max(0, dec(free).minus(l.reserve ?? '0'))
              .times(l.leverage)
              .div(nominal)
          )
    );
  if (applyCaps && l.maxQty != null) ceiling = min(ceiling, l.maxQty);
  if (applyCaps && l.capacity && credit == null)
    ceiling = min(ceiling, max(held, held.plus(l.capacity[sign > 0 ? 0 : 1])));
  const lo = ordinal(max(v === 'pf' ? 1 : 0, held.minus(exit).div(step).ceil())),
    hi = ordinal(ceiling.div(step).floor());
  if (hi < lo) return [];
  const starts = new Set([lo, hi + 1]);
  for (const c of cuts) {
    if (c.lt(step.times(lo)) || c.gt(step.times(hi))) continue;
    const i = ordinal(c.div(step).floor()) + 1;
    if (i <= hi) starts.add(i);
  }
  if (held.gte(0) && held.mod(step).eq(0) && held.div(step).gte(lo) && held.div(step).lte(hi))
    starts.add(ordinal(held.div(step)));
  const point = (i) => ({
    i,
    base: projectSettlementEquity(book, market, v, out(step.times(i).times(sign)))
  });
  const sorted = [...starts].sort((a, b) => a - b),
    result = [];
  for (let j = 1; j < sorted.length; j++) {
    let lo = sorted[j - 1],
      hi = sorted[j] - 1;
    if (applyCaps && l.leverage) {
      const gaps = (i) => {
        const q = step.times(i).times(sign),
          delta = q.minus(old),
          // The final Hype check debits actual fill cost versus the mark. Zero is a safe lower bound here.
          fee = credit != null ? '0' : executionDetail(l, out(delta)).fee;
        const im = step.times(i).times(nominal).div(l.leverage),
          previous = credit != null ? dec(credit) : dec(old).abs().times(nominal).div(l.leverage);
        const avail = l.directionalFree?.[delta.lt(0) ? 1 : 0] ?? l.free;
        const marked = projectSettlementEquity(book, market, v, out(q), '0', 'mark_equity');
        return [
          marked
            .times(l.utilization ?? '1')
            .minus(im)
            .minus(l.hold ?? '0'),
          avail == null
            ? null
            : dec(avail)
                .minus(im)
                .plus(previous)
                .minus(fee)
                .minus(l.reserve ?? '0')
        ];
      };
      for (const k of [0, 1]) {
        const left = gaps(lo)[k],
          right = gaps(hi)[k];
        if (left == null || right == null) continue;
        const range = clip(lo, hi, left, right);
        if (!range) {
          hi = lo - 1;
          break;
        }
        [lo, hi] = range;
      }
      if (hi < lo) continue;
    }
    const a = point(lo),
      b = point(hi);
    result.push({
      a,
      b,
      slope: step.times(sign).minus(step.times(l.rate)).times(unit).times(l.factor),
      sign,
      step
    });
  }
  return result;
}
function shiftAt(seg, i, target) {
  return dec(target)
    .minus(lerp(seg.a, seg.b, i))
    .div(seg.slope.times(i));
}
// Clip an integer interval by an affine cash inequality. Positive slack also
// admits near-boundary lots, which are subsequently rechecked by evaluateCandidate.
function clip(low, high, left, right) {
  left = left.plus(slack);
  right = right.plus(slack);
  if (left.lt(0) && right.lt(0)) return null;
  if (left.gte(0) && right.gte(0)) return [low, high];
  const cross = dec(String(low)).minus(left.times(high - low).div(right.minus(left)));
  return left.lt(0)
    ? [Math.max(low, ordinal(cross.floor())), high]
    : [low, Math.min(high, ordinal(cross.ceil()))];
}

export function compareAuto(a, b) {
  const pairs = [
    [a.vsNotional, b.vsNotional],
    [a.worstCash, b.worstCash]
  ];
  for (const [x, y] of pairs) {
    const cmp = dec(y).cmp(x);
    if (cmp) return cmp;
  }
  // A verified long with no positive liquidation root survives down to price zero.

  const buffer = (c) =>
    dec(c.stressPriceBuffer ?? c.priceBuffer ?? (dec(c.hlTargetQuantity).gt(0) ? c.pressureMark : '0'));
  const margin = (c) => c.initialMargin.reduce((n, x) => n.plus(x), new D(0));
  const turns = (c) => Number(c.vsDeltaQuantity !== '0') + Number(c.hlDeltaQuantity !== '0');
  return (
    buffer(b).cmp(buffer(a)) ||
    (a.candidateLeverage ?? 0) - (b.candidateLeverage ?? 0) ||
    margin(a).cmp(margin(b)) ||
    turns(a) - turns(b)
  );
}

export function compareConservative(a, b) {
  return dec(b.worstCash).cmp(a.worstCash) || dec(a.vsNotional).cmp(b.vsNotional) || compareAuto(a, b);
}

function requiredAtMove(book, m, p, old, sign, percent) {
  const l = m.pf,
    step = positive(l.step),
    unit = units(l),
    move = dec(l.mark).times(percent).div(100).times(sign);
  const exit = dec((sign > 0 ? l.bids : l.asks)[0][0]).plus(move);
  if (exit.lte(0)) return { amount: null, source: '压力价无效' };
  let best = null;
  for (const seg of segments(book, m, 'pf', sign, old, false)) {
    const gap = (i) =>
      lerp(seg.a, seg.b, i)
        .plus(seg.slope.times(i).times(move.div(l.factor)))
        .minus(p.target);
    const range = clip(seg.a.i, seg.b.i, gap(seg.a.i), gap(seg.b.i));
    if (!range) continue;
    for (let i = range[0]; i <= Math.min(range[0] + 2, range[1]); i++) {
      if (gap(i).lt(0)) continue;
      const q = out(step.times(sign).times(i));
      try {
        if (projectSettlementEquity(book, m, 'pf', q, out(move.div(l.factor))).lt(p.target)) continue;
        const n = step.times(i).times(unit).times(l.mark);
        if (best == null || n.lt(best)) best = out(n);
      } catch {
        /* price unavailable at that level */
      }
      break;
    }
  }
  if (best != null) return { amount: best, source: '五档成交价及步长' };
  // Depth exhausted. The best bid/ask gives an optimistic lower bound only.
  const marked = dec(p.E),
    current = dec(old);
  const gap = (n) => {
    const q = n.times(sign),
      delta = q.minus(current),
      entry = dec((delta.gt(0) ? l.asks : l.bids)[0][0]);
    return marked
      .plus(delta.times(unit).times(dec(l.mark).minus(entry)))
      .minus(delta.abs().times(unit).times(entry).times(l.rate))
      .plus(q.times(unit).times(exit.minus(l.mark)))
      .minus(n.times(unit).times(exit).times(l.rate))
      .minus(p.target);
  };
  const turn = max(0, current.times(sign)),
    knots = [new D(0), turn, turn.plus(step)];
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1],
      b = knots[i],
      y = gap(a),
      z = gap(b);
    if (y.lt(0) && z.gt(y)) {
      const root = a.minus(y.times(b.minus(a)).div(z.minus(y)));
      if (i === knots.length - 1 || root.lte(b))
        return {
          amount: out(root.div(step).ceil().times(step).times(unit).times(l.mark)),
          source: '买卖一档乐观下界，五档深度不足'
        };
    }
  }
  return { amount: null, source: '扣费后该压力幅度不能覆盖目标差额' };
}

export function solveAuto(book, m, params, options = {}) {
  if (!m.hl.exchangeMaxLeverage || !m.hl.tiers?.length || m.hl.marginMode !== 'cross')
    return { code: 'LEVERAGE_UNVERIFIED', candidates: [], rejected: [], searchComplete: false, pressure: {} };
  // An optimistic grid bound. Candidate admission still checks the tier at the actual rounded notional.
  m = {
    ...m,
    hl: {
      ...m.hl,
      leverage: String(m.hl.exchangeMaxLeverage),
      currentMarginCredit: m.hl.currentMarginCredit ?? '0'
    }
  };
  const cashFirst = params.objective === 'cash';
  const limit = cashFirst ? 1 : 5;
  const p = profileInputs(book, params, m),
    old = (v) =>
      Object.values(book.positions).find((x) => x.asset === m.id && x.venue === v && x.pool === m[v].pool)
        ?.qty ?? '0';
  const candidates = [],
    rejected = [],
    ratios = new Set(),
    seen = new Set(),
    current = [old('pf'), old('hl')];
  let best = null,
    evaluations = 0,
    nodes = 0,
    complete = true,
    unknown = false;
  const budget = options.searchBudget ?? 3500,
    payout = p.stage === 'funded' ? profitSplit(p.target, p.baseline, p.share).user : '0';
  const failNeed = dec(p.B).plus(p.k).minus(book.external);
  const passNeed = max(
    dec(p.R).plus(p.k),
    p.stage === 'funded' && book.ref != null
      ? dec(book.ref)
          .plus(p.g)
          .plus(book.roundIn)
          .minus(book.roundOut)
          .minus(book.external)
          .minus(payout)
          .plus(p.k)
      : '0'
  );
  const remember = (pf, hl) => {
    const id = pf + '/' + hl;
    if (seen.has(id)) return;
    seen.add(id);
    evaluations++;
    try {
      const c = evaluateLeverageGrid(book, m, p, pf, hl, options);
      if (c.code !== 'FEASIBLE') {
        if (
          c.constraints?.some((t) => t.status === 'unknown') &&
          !c.constraints.some((t) => t.status === 'fail')
        )
          unknown = true;
        if (rejected.length < 8 && c.constraints?.some((t) => t.status === 'fail')) rejected.push(c);
        return;
      }
      c.worstCash = out(min(c.failureCash, c.pressureCashAfter, ...(c.scenarioCash ?? [])));
      ratios.add(c.actualRatio);
      candidates.push(c);
      candidates.sort(cashFirst ? compareConservative : compareAuto);
      candidates.length = Math.min(candidates.length, limit);
      best = candidates[0];
    } catch (e) {
      if (['MARGIN_UNVERIFIED', 'LEVERAGE_UNVERIFIED'].includes(e.message)) unknown = true;
      if (!rejected.length) rejected.push({ code: e.message, vsTargetQuantity: pf, hlTargetQuantity: hl });
    }
  };
  const adverseMove = max(options.adverseBps || '0', options.stress?.jumpBps || '0')
    .times(m.hl.mark)
    .div(10000)
    .div(m.hl.factor);
  const delayPerLot = units(m.hl)
    .times(m.hl.mark)
    .times(options.stress?.delayBps || '0')
    .div(10000);
  const branches = [];
  for (const sign of [1, -1]) {
    const pp = segments(book, m, 'pf', sign, current[0]),
      hh = segments(book, m, 'hl', -sign, current[1]);
    for (const seg of pp) {
      branches.push({ seg, hh, lo: seg.a.i, hi: seg.b.i });
    }
  }
  // Probe actual grids before pruning to retain a concrete rejected trade and a useful incumbent.
  for (const seed of options.seeds ?? []) remember(seed.vsTargetQuantity, seed.hlTargetQuantity);
  if (!dec(current[0]).eq(0) && dec(current[0]).times(current[1]).lte(0)) remember(...current);
  for (const { seg, hh, hi } of branches) {
    if (hh.length)
      remember(out(seg.step.times(seg.sign).times(hi)), out(hh[0].step.times(hh[0].sign).times(hh[0].a.i)));
  }
  while (branches.length) {
    branches.sort(cashFirst ? (a, b) => b.lo - a.lo : (a, b) => a.hi - b.hi);
    const { seg, hh, lo, hi } = branches.pop();
    if (
      !cashFirst &&
      candidates.length === limit &&
      seg.step.times(hi).lt(dec(candidates.at(-1).vsTargetQuantity).abs())
    )
      continue;
    if (++nodes > budget || evaluations >= budget) {
      complete = false;
      break;
    }
    // A range whose most favourable boundary still crosses zero contains no executable path.
    const invalidBoundary = [p.floor, p.target].some((target) => {
      const upper = max(shiftAt(seg, lo, target), shiftAt(seg, hi, target));
      return [m.pf, m.hl].some((leg) => upper.times(leg.factor).plus(leg.mark).lte(0));
    });
    if (invalidBoundary) continue;
    const favorable = (target) => {
      const a = shiftAt(seg, lo, target),
        b = shiftAt(seg, hi, target);
      return seg.sign > 0 ? min(a, b) : max(a, b);
    };
    const fail = favorable(p.floor),
      pass = favorable(p.target);
    // In one depth segment PF settlement is A + B*i. A convex combination of the
    // two boundary prices at weights with weighted target A cancels the 1/i term.
    // This bound keeps success and failure on the SAME PF quantity as the grid is split.
    const intercept = lerp(seg.a, seg.b, 0);
    const passWeight = intercept.minus(p.floor).div(dec(p.target).minus(p.floor));
    const coupledShift =
      passWeight.gt(0) && passWeight.lt(1)
        ? intercept.minus(lerp(seg.a, seg.b, lo)).div(seg.slope.times(lo))
        : null;
    let possible = false;
    for (const h of hh) {
      const cash = (i, shift) => lerp(h.a, h.b, i).plus(h.slope.times(i).times(shift));
      let range = [h.a.i, h.b.i];
      // Bound the most favorable outcome possible inside this rectangle, including the
      // least delay cost on the interval. Exact path and margin checks still run on each survivor.
      const firstQty = h.step.times(h.a.i).times(h.sign),
        lastQty = h.step.times(h.b.i).times(h.sign);
      const minDelta = max(
        0,
        min(firstQty, lastQty).minus(current[1]),
        dec(current[1]).minus(max(firstQty, lastQty))
      );
      const debitFloor = minDelta
        .times(delayPerLot)
        .plus(h.a.i > 0 ? options.stress?.fundingDebit || '0' : '0');
      const offset = adverseMove.times(-h.sign);
      let minFailure = failNeed,
        minSuccess = passNeed;
      if (cashFirst && best) {
        const cashFloor = dec(best.worstCash).minus(book.external).plus(p.k);
        minFailure = max(minFailure, cashFloor);
        minSuccess = max(minSuccess, cashFloor.minus(payout));
      }
      for (const [shift, need] of [
        [fail.plus(offset), minFailure.plus(debitFloor)],
        [pass.plus(offset), minSuccess.plus(debitFloor)]
      ]) {
        const [a, b] = range;
        range = clip(a, b, cash(a, shift).minus(need), cash(b, shift).minus(need));
        if (!range) break;
      }
      if (range && coupledShift != null) {
        const need = minFailure.plus(passWeight.times(minSuccess.minus(minFailure))).plus(debitFloor);
        const shift = coupledShift.plus(offset);
        const [a, b] = range;
        range = clip(a, b, cash(a, shift).minus(need), cash(b, shift).minus(need));
      }
      if (!range) continue;
      possible = true;
      if (lo !== hi) break;
      const pf = out(seg.step.times(lo).times(seg.sign));
      const visit = (i) => remember(pf, out(h.step.times(i).times(h.sign)));
      const [first, last] = range;
      const diff = (i) => cash(i, fail).minus(cash(i, pass)).minus(payout);
      const da = diff(first),
        db = diff(last);
      const peak =
        da.times(db).lte(0) && !da.eq(db)
          ? ordinal(
              dec(String(first))
                .minus(da.times(last - first).div(db.minus(da)))
                .floor()
            )
          : first;
      for (const anchor of new Set([first, last, peak, peak + 1])) {
        if (anchor >= first && anchor <= last && evaluations < budget) visit(anchor);
      }
      for (let i = first; i <= last; i++) {
        const cutoff = candidates.at(-1);
        if (
          candidates.length === limit &&
          (cashFirst || dec(pf).abs().eq(dec(cutoff.vsTargetQuantity).abs()))
        ) {
          let possible = [i, last];
          for (const [shift, credit] of [
            [fail, '0'],
            [pass, payout]
          ]) {
            const [a, b] = possible,
              need = dec(cutoff.worstCash).minus(book.external).plus(p.k).minus(credit);
            possible = clip(a, b, cash(a, shift).minus(need), cash(b, shift).minus(need));
            if (!possible) break;
          }
          if (!possible) break;
          i = possible[0];
        }
        if (evaluations >= budget) {
          complete = false;
          break;
        }
        visit(i);
      }
      if (!complete) break;
    }
    if (!complete) break;
    if (lo < hi && possible) {
      const mid = Math.floor(lo + (hi - lo) / 2);
      branches.push({ seg, hh, lo, hi: mid }, { seg, hh, lo: mid + 1, hi });
    }
  }
  if (!rejected.some((c) => c.constraints?.some((x) => x.status === 'fail'))) {
    // One additional legal step beyond visible exit depth is an auditable rejected trade.
    const l = m.pf,
      available = l.bids.reduce((sum, row) => sum.plus(row[1]), new D(0));
    const required = available.div(l.step).floor().plus(1).times(l.step);
    rejected.push({
      vsTargetQuantity: out(required),
      hlTargetQuantity: '0',
      constraints: [
        {
          code: 'INSUFFICIENT_DEPTH',
          status: 'fail',
          actual: out(available),
          required: out(required),
          shortfall: out(required.minus(available)),
          unit: l.unit,
          source: '五档买盘'
        }
      ]
    });
  }
  const unchanged =
    best &&
    current[0] === best.vsTargetQuantity &&
    current[1] === best.hlTargetQuantity &&
    (!best.candidateLeverage || String(best.candidateLeverage) === m.hl.configuredLeverage);
  complete = complete && !unknown;
  const pressure = {};
  if (!cashFirst && params.movePct && p.stage === 'challenge')
    for (const sign of [1, -1]) pressure[sign] = requiredAtMove(book, m, p, current[0], sign, params.movePct);
  let hold = { vsTargetQuantity: '0', hlTargetQuantity: '0', code: 'HOLD' };
  try {
    const cash = projectSettlementEquity(book, m, 'hl', '0');
    const deltaFees = ['pf', 'hl'].map((v, i) => executionDetail(m[v], out(dec(current[i]).neg())).fee);
    hold = { ...hold, personalCash: out(cash.plus(book.external)), hlCash: out(cash), deltaFees };
  } catch (e) {
    hold.reason = e.message;
  }
  const holdEligible =
    current.every((x) => dec(x).isZero()) &&
    hold.personalCash != null &&
    dec(hold.personalCash).gte(p.B) &&
    dec(hold.hlCash).gte(p.R);
  // A passing quantity grid proves the base calculations. A verified AUTO verdict
  // also needs the account's actual setting and every requested stress input.
  const stressVerified = ['basisBps', 'jumpBps', 'delayBps', 'fundingDebit'].every((key) =>
    nonnegative(options.stress?.[key] || '0').gt(0)
  );
  const conditionsVerified =
    options.accountVerified === true &&
    stressVerified &&
    (!best?.candidateLeverage || best.candidateLeverage === Number(m.hl.configuredLeverage));
  return {
    selected: best,
    candidates,
    rejected,
    ratios: [...ratios],
    pressure,
    evaluations,
    nodes,
    searchComplete: complete,
    hold,
    code:
      best && (!complete || !conditionsVerified)
        ? 'AUTO_PARTIAL'
        : best
          ? unchanged
            ? 'AUTO_HOLD'
            : 'AUTO_FEASIBLE'
          : complete
            ? holdEligible
              ? 'AUTO_HOLD'
              : 'AUTO_INFEASIBLE'
            : 'AUTO_PARTIAL'
  };
}
