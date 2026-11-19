import { sumPostings } from './settlement-ledger.js';
import { executionDetail } from './solver.js';
import { dec, out } from './math.js';
import { exactRatio, inspectRatio, ratioSlice } from './ratio-scan.js';

export const pointKey = ({sign, i, j}) => [sign, i, j].join('/');

// The cursor is the next real lot tuple, independent of rounded display percentages.
function scaleIndex(scan) {
  return [1, -1].map(sign => {
    const intervals = scan.cells.filter(c => c.sign === sign).flatMap(c => c.legalScales);
    const runs = [];
    for (const [lo, hi] of intervals.sort((a, b) => a[0] - b[0])) {
      const last = runs.at(-1);
      if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
      else runs.push([lo, hi]);
    }
    return { sign, runs };
  });
}

export function pagePoints(scan, index, start, limit = 5) {
  const rows = [];
  for (const { sign, runs } of index) {
    if (start?.sign === -1 && sign === 1) continue;
    const from = start?.sign === sign ? start : null;
    for (const [first, last] of runs) {
      for (let i = Math.max(first, from?.i ?? first); i <= last; i++) {
        for (const [lo, hi] of ratioSlice(scan, sign, i)) {
          for (let j = Math.max(lo, from?.i === i ? from.j : lo); j <= hi; j++) {
            const point = { sign, i, j };
            if (rows.length === limit) return { rows, next: point };
            rows.push(point);
          }
        }
      }
    }
  }
  return { rows, next: null };
}

function execution(leg) {
  if (!leg) return null;
  return { delta: leg.adjustment, price: dec(leg.adjustment).isZero() ? null : leg.entryPrice };
}

function costs(path, row, endpoint, leg) {
  if (!path?.pf || !path.hl) return null;
  let exit = path.hl;
  if (row.stress?.priceShock && !dec(row.stress.priceShock).isZero()) {
    if (!row.lines || !leg.factor) return null;
    const shift = dec(row.lines[endpoint]).plus(dec(row.stress.priceShock).div(leg.factor));
    const fill = executionDetail(leg, out(dec(row.hl).neg()), out(shift));
    exit = { exitFee: fill.fee, exitSlippage: fill.impact };
  }
  const total = (a, b) => out(dec(path.pf[a]).plus(path.pf[b]).plus(path.hl[a]).plus(exit[b]));
  return { fees: total('entryFee', 'exitFee'), slippage: total('entrySlippage', 'exitSlippage') };
}

// One scalar evaluation supplies every displayed field for one exact tuple.
// Even a legal quantity can reach liquidation before a requested cash endpoint.
export function planRecord(scan, point) {
  return recordFromInspection(scan.ctx, inspectRatio(scan.ctx, point));
}

export function recordFromInspection(ctx, row) {
  const { sign, i, j } = row;
  return {
    sign, i, j, key: pointKey(row), h: row.h,
    fraction: ctx.market.pf.factor ? exactRatio(ctx.market, row.pf, row.hl) : null,
    pf: row.pf, hl: row.hl, pfValue: row.pfValue, hypeValue: row.hypeValue,
    pfFill: execution(row.paths?.fail.pf), hlFill: execution(row.paths?.fail.hl),
    fail: row.failStop ? null : row.fail,
    failHype: row.failStop ? null : ctx.book.external != null
      ? sumPostings([row.fail, dec(ctx.book.external).neg()])
      : row.stress ? null : row.paths?.fail.hl.settled ?? null,
    failDelta: row.failStop ? null : row.failureVsProtection,
    success: row.passStop ? null : row.success,
    successDelta: row.passStop ? null : out(dec(row.successPersonal).minus(ctx.book.B)),
    failStop: row.failStop, passStop: row.passStop,
    failCost: row.failStop ? null : costs(row.paths?.fail, row, 'fail', ctx.market.hl),
    passCost: row.passStop ? null : costs(row.paths?.pass, row, 'pass', ctx.market.hl),
    initial: row.initial, marginRate: row.imRate, liquidation: row.liquidation, distance: row.buffer, distanceRate: row.bufferRate,
    surplus: row.surplus, physical: row.physical, covers: row.covers, survives: row.survives,
    both: row.both, profitable: row.profitable,
    reason: row.physical ? null : (row.reason?.label ?? row.reason?.code ?? '途经保证金约束')
  };
}

// Demonstrate size dependence with two verified grid members at exactly the
// same nonzero fraction. A 2:1 scaling of both legs imposes no hedge ratio.
function scalePair(scan, index, featured) {
  for (const {sign,i,j} of featured) {
    if (!j) continue;
    for (const factor of [0.5, 2]) {
      const n = i * factor, m = j * factor;
      if (Number.isSafeInteger(n) && Number.isSafeInteger(m) &&
          ratioSlice(scan, sign, n).some(([lo, hi]) => lo <= m && m <= hi))
        return [{sign,i,j}, {sign,i:n,j:m}];
    }
  }
  for (const { sign, runs } of index) {
    for (const [first, last] of runs) {
      for (const i of new Set([first, Math.floor(last / 2), Math.ceil((first + last) / 4)])) {
        if (i < first || i > last) continue;
        const double = ratioSlice(scan, sign, i * 2);
        for (const [lo,hi] of ratioSlice(scan, sign, i)) {
          for (const [a,b] of double) {
            const low = Math.max(1, lo, Math.ceil(a/2)), high = Math.min(hi, Math.floor(b/2));
            if (low <= high) {
              const j = high;
              return [{sign,i,j}, {sign,i:i*2,j:j*2}];
            }
          }
        }
      }
    }
  }
  return [];
}

export function buildPlanReport(scan, pending = false) {
  const eligible = scan.sets.eligible ?? scan.sets.both;
  const points = new Map();
  function add(point, label) {
    if (!point) return;
    const key = pointKey(point);
    if (!points.has(key)) points.set(key, {sign:point.sign, i:point.i, j:point.j, labels:[]});
    points.get(key).labels.push(label);
  }
  const chosen = scan.representative;
  const primary = chosen && chosen.objective !== 'diagnostic' && chosen.row.i === eligible.largest?.i
    ? chosen.row : eligible.largest;
  if (!pending) {
    add(primary, '最大 PF 仓位');
    add(eligible.range?.witnesses.failure[1], '失败回收优先');
    add(eligible.range?.witnesses.success[1], '成功留存优先');
  }
  const index = scaleIndex(scan);
  const featured = [...points.values()];
  const examples = scalePair(scan, index, featured);
  for (const point of examples) add(point, '同 h 规模对照');
  if (!points.size)
    for (const point of pagePoints(scan, index, null, 3).rows) add(point, '合法规模');
  const rows = [...points.values()].map(({labels,...point}) => {
    const row = planRecord(scan, point);
    if (labels.some(l => l.endsWith('优先') || l === '最大 PF 仓位') &&
        (!row.both || row.failStop || row.passStop ||
          dec(row.failDelta).lt(scan.ctx.params.recoveryBuffer ?? '0')))
      throw Error('优先方案与失败保护、成功留存或清算校验不一致');
    return { ...row, labels };
  });
  const fractions = new Map();
  for (const row of rows) {
    const group = fractions.get(row.fraction) ?? [];
    group.push(row);
    fractions.set(row.fraction, group);
  }
  return { index, rows: [...fractions.values()].flat(), pending, eligible: pending ? 0 : eligible.count };
}
