import { dec, out, estimateFill } from './math.js';
import { preservesCrossExposure } from './solver.js';
import { segments } from './auto.js';

export const unit = (l) => dec(l.multiplier).times(l.fx);
export const position = (book, venue) =>
  dec(Object.values(book.positions).find((p) => p.venue === venue)?.qty ?? '0');

// Zero-shift mark and close equity, using depth notionals directly. No rounded VWAP
// division is needed for the coefficients used to classify integer lot intervals.
function legAt(ctx, venue, sign, i) {
  const l = ctx.market[venue],
    u = unit(l),
    q = dec(l.step).times(sign).times(i);
  const old = position(ctx.book, venue),
    delta = q.minus(old);
  const traded = (n) => dec(estimateFill(out(n), l)?.notional ?? '0').times(u);
  const entry = traded(delta),
    exit = traded(q.neg()),
    rate = dec(l.rate);
  const marked = dec(ctx.book[venue])
    .plus(delta.times(u).times(l.mark))
    .minus(entry.times(delta.cmp(0)))
    .minus(entry.times(rate));
  const settled = marked
    .plus(exit.times(q.cmp(0)))
    .minus(q.times(u).times(l.mark))
    .minus(exit.times(rate));
  return { q, delta, entry, exit, marked, settled, notional: q.abs().times(u).times(l.mark) };
}

function entryChecks(ctx, venue, sign, i, lev) {
  const l = ctx.market[venue],
    v = legAt(ctx, venue, sign, i),
    old = position(ctx.book, venue);
  const side = v.delta.lt(0) ? 1 : 0,
    avail = dec(l.directionalFree?.[side] ?? l.free);
  const order = dec(l.pendingQty ?? '0'),
    oldN = old.abs().times(unit(l)).times(l.mark);
  const free = dec(l.reserve ?? '0'),
    fee = v.entry.times(l.rate),
    hold = dec(l.hold ?? '0');
  const checks = [
    v.marked.times(lev).minus(v.notional).minus(hold.times(lev)),
    v.marked
      .times(l.utilization ?? '1')
      .times(lev)
      .minus(v.notional)
      .minus(hold.times(lev))
  ];
  const reducing = venue==='hl' && preservesCrossExposure(old,v.q,l.configuredLeverage,lev);
  if (reducing) {
    checks[0] = dec('0');
    if (dec(l.utilization ?? '1').eq(1)) checks[1] = dec('0');
  }
  if (!order.isZero()) checks.push(v.delta.times(order.cmp(0)).minus(order.abs()));
  if (!v.delta.isZero()) checks.push(v.delta.abs().minus(l.minQty), v.entry.minus(l.minNotional));
  if (venue === 'pf') {
    checks.push(avail.minus(fee).minus(free).times(lev).minus(v.notional).plus(oldN));
    if (l.capacity && !v.delta.isZero()) checks.push(dec(l.capacity[side]).minus(v.delta.abs()));
  } else {
    const room = avail.plus(l.currentMarginCredit ?? '0'),
      cap = room.minus(free).times(lev).minus(v.notional);
    if (!free.isZero()) {
      checks.push(cap, cap.plus(v.marked.minus(ctx.book.hl).times(lev)),
        v.marked.minus(hold).minus(free).times(lev).minus(v.notional));
    } else if (!reducing) checks.push(cap,cap.plus(v.marked.minus(ctx.book.hl).times(lev)));
    if (l.capacity)
      checks.push(dec(l.capacity[side]).minus(v.delta.abs()));
    if (!v.q.isZero() && !order.isZero() && String(lev) !== l.configuredLeverage) checks.push(dec('-1'));
    if (!v.q.isZero() && !old.isZero() && String(lev) !== l.configuredLeverage) {
      checks.push(room.times(lev).minus(oldN), dec(ctx.book.hl).minus(hold).times(lev).minus(oldN));
      const oldTier = l.tiers.findLast((t) => oldN.gte(t.from));
      if (!order.isZero() || lev > Number(oldTier.maxLeverage)) checks.push(dec('-1'));
    }
  }
  return checks;
}

// Within a side, depth, tier and delta-sign segment each entry inequality is affine.
// The union of feasible leverage settings is taken before crossing the two venues.
function clipStatic(lo, hi, left, right) {
  let from = lo,
    to = hi;
  for (let k = 0; k < left.length; k++) {
    const a = left[k],
      b = right[k];
    if (a.lt(0) && b.lt(0)) return null;
    if (a.lt(0) !== b.lt(0)) {
      const numerator = a.neg().times(hi - lo),
        denominator = b.minus(a);
      const crossing = numerator.div(denominator).plus(lo);
      if (a.lt(0)) from = Math.max(from, crossing.ceil().toNumber());
      else to = Math.min(to, crossing.floor().toNumber());
    }
  }
  return from <= to ? [from, to] : null;
}
export function legalSegments(ctx, venue, sign) {
  const l = ctx.market[venue],
    old = position(ctx.book, venue),
    step = dec(l.step);
  if (!old.mod(step).isZero()) return [];
  const ss = segments(ctx.book, ctx.market, venue, sign, out(old));
  const split = [
    0,
    old.times(sign).div(step).toNumber(),
    ...l.tiers.map((t) => dec(t.from).div(unit(l).times(l.mark).times(step)).floor().toNumber())
  ];
  const result = [];
  for (const s of ss) {
    const cuts = new Set([s.a.i, s.b.i + 1]);
    for (const knot of split) for (const n of [knot, knot + 1]) if (n > s.a.i && n <= s.b.i) cuts.add(n);
    const starts = [...cuts].sort((a, b) => a - b);
    for (let z = 1; z < starts.length; z++) {
      const lo = starts[z - 1],
        hi = starts[z] - 1,
        base = legAt(ctx, venue, sign, lo),
        tail = lo === hi ? base : legAt(ctx, venue, sign, lo + 1);
      const tier = l.tiers.findLast((t) => base.notional.gte(t.from));
      const cap =
        venue === 'pf'
          ? Number(l.leverage)
          : Math.min(Number(l.exchangeMaxLeverage), Number(tier.maxLeverage));
      // At a fixed size every unchanged-setting restriction is identical and IM
      // decreases with leverage. Among changed settings the highest legal one suffices.
      const levels = new Set([cap]);
      if (venue === 'hl' && !old.isZero())
        levels.add(
          Math.min(
            cap,
            Number(l.tiers.findLast((t) => old.abs().times(unit(l)).times(l.mark).gte(t.from)).maxLeverage)
          )
        );
      if (venue === 'hl' && Number(l.configuredLeverage) > 0 && Number(l.configuredLeverage) <= cap)
        levels.add(Number(l.configuredLeverage));
      const intervals = [],
        marginBands = [];
      // Lowest individually admissible setting is the solver's tie-break for identical risk.
      if (venue === 'hl') {
        let uncovered = [[lo, hi]];
        for (let lev = 1; lev <= cap && uncovered.length; lev++) {
          const v = clipStatic(
            lo,
            hi,
            entryChecks(ctx, venue, sign, lo, lev),
            entryChecks(ctx, venue, sign, hi, lev)
          );
          if (!v) continue;
          const remaining = [];
          for (const [a, b] of uncovered) {
            const from = Math.max(a, v[0]),
              to = Math.min(b, v[1]);
            if (from > to) {
              remaining.push([a, b]);
              continue;
            }
            marginBands.push({ from, to, lev });
            if (a < from) remaining.push([a, from - 1]);
            if (to < b) remaining.push([to + 1, b]);
          }
          uncovered = remaining;
        }
      }
      for (const n of levels) {
        const v = clipStatic(
          lo,
          hi,
          entryChecks(ctx, venue, sign, lo, n),
          entryChecks(ctx, venue, sign, hi, n)
        );
        if (v) intervals.push(v);
      }
      intervals.sort((a, b) => a[0] - b[0]);
      const union = [];
      for (const v of intervals) {
        const last = union.at(-1);
        if (last && v[0] <= last[1] + 1) last[1] = Math.max(last[1], v[1]);
        else union.push(v);
      }
      const line = (key) => {
        const m = tail[key].minus(base[key]);
        return [base[key].minus(m.times(lo)), m];
      };
      for (const [from, to] of union)
        result.push({
          lo: from,
          hi: to,
          sign,
          marginBands,
          marked: line('marked'),
          settled: line('settled'),
          entry: line('entry'),
          exit: line('exit'),
          absDelta: [
            base.delta.abs().minus(tail.delta.abs().minus(base.delta.abs()).times(lo)),
            tail.delta.abs().minus(base.delta.abs())
          ],
          step,
          slope: s.slope
        });
    }
  }
  return result;
}
