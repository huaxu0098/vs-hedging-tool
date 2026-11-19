import { exactRatio, inspectRatio, neighborPoints, ratioBin } from './ratio-scan.js';

const venues = ['pf', 'hl'];
const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

// Keep stale-display storage and worker messages free of per-neighbor ledgers.
const comparisonFields = [
  'sign',
  'i',
  'j',
  'h',
  'pf',
  'hl',
  'pfValue',
  'hypeValue',
  'fail',
  'success',
  'failStop',
  'passStop',
  'initial',
  'imRate',
  'buffer',
  'physical',
  'both',
  'covers', 'coversWithBuffer',
  'survives',
  'shortfall',
  'reserveHeadroom'
];
function positionSummary(row) {
  return Object.fromEntries(comparisonFields.map((field) => [field, row[field]]));
}

export function analyzeRatios(result, rules) {
  const scan = result.ratioScan,
    rep = scan.representative,
    f = result.funding;
  const { market } = scan.ctx;
  const min = scan.sets.both.min;
  let boundary = null;
  if (min) {
    const segment = ratioBin(scan.buckets, min);
    const bin = scan.buckets[segment];
    if (bin?.edgeKey !== 'joint' || bin.both !== scan.sets.both.count)
      throw Error('交集下界与精确分段不一致');
    const row = inspectRatio(scan.ctx, min);
    if (!row.both) throw Error('交集边界见证仓位未通过两端核算');
    boundary = {
      segment,
      count: scan.sets.both.minCount,
      fraction: exactRatio(market, row.pf, row.hl),
      ...positionSummary(row)
    };
  }
  const neighbors = rep
    ? neighborPoints(scan, rep.row).map((point) => {
        const center = point.i === rep.row.i && point.j === rep.row.j;
        return { center, ...positionSummary(center ? rep.row : inspectRatio(scan.ctx, point)) };
      })
    : [];
  return {
    recoveryBuffer: rules.recoveryBuffer || '0',
    riskPreference: rules.riskPreference || '0',
    theory: {
      lower: f.lower,
      upper: f.upper,
      recoveryNeed: f.recoveryNeed,
      spendable: f.spendable,
      loss: f.loss,
      gain: f.gain,
      failCost: f.failCost,
      passCost: f.passCost
    },
    boundary,
    neighbors,
    fixed: scan.ctx.params.mode === 'keepHL' ? 'hl' : 'pf',
    quote: result.currencies.hl.quoteAsset,
    cashFloor: result.preference?.floor
  };
}

// Compare two accepted solver snapshots. Arrival times, stale UI prices and
// formatted percentages never participate in the explanation.
export function ratioChanges(previous, next) {
  if (!previous?.ratioScan?.analysis) return null;
  const older = previous.ratioScan,
    newer = next.ratioScan;
  const a = older.ctx.market,
    b = newer.ctx.market;
  const changes = [];
  for (const [field, label] of Object.entries({
    B: '保护本金',
    C_H: 'Hype 权益',
    C_E: '外部到账资金',
    E: 'PF 权益',
    F: '失败线',
    T: '成功线',
    R: '成功最低留存',
    R_free: '可用抵押品留存',
    failCost: '终点摩擦'
  }))
    if (previous.funding[field] !== next.funding[field]) changes.push(label);
  for (const [keys, label] of [
    [['mark'], '标记价'],
    [['bids', 'asks'], '盘口价格或深度'],
    [['rate'], '成交费率'],
    [['step', 'minQty'], '数量网格'],
    [['multiplier', 'fx', 'factor'], '每单位盈亏敏感度'],
    [['free', 'hold', 'tiers', 'capacity', 'utilization'], '保证金或额度']
  ]) {
    if (venues.some((v) => keys.some((k) => changed(a[v][k], b[v][k])))) changes.push(label);
  }
  if (
    changed(previous.currencies.hypeToVest, next.currencies.hypeToVest) ||
    ['USDC', 'USDT'].some((c) =>
      ['bid', 'ask'].some((k) => previous.currencies.spots[c]?.[k] !== next.currencies.spots[c]?.[k])
    )
  )
    changes.push('参考汇率');
  if (changed(older.ctx.book.positions, newer.ctx.book.positions)) changes.push('已有仓位');
  if (older.analysis.riskPreference !== newer.analysis.riskPreference) changes.push('风险偏好');
  if (older.analysis.recoveryBuffer !== newer.analysis.recoveryBuffer) changes.push('额外回收缓冲');
  if (
    ['stress', 'adverseBps', 'minPriceBuffer', 'minMaintenanceSurplus'].some((k) =>
      changed(older.ctx.checks[k], newer.ctx.checks[k])
    )
  )
    changes.push('压力约束');
  const prior = older.representative?.row,
    current = newer.representative?.row;
  return {
    changes,
    theoryChanged:
      previous.funding.lower !== next.funding.lower || previous.funding.upper !== next.funding.upper,
    previousH: prior?.h,
    hChanged: prior?.h !== current?.h,
    lotsChanged: !!prior && !!current && (prior.i !== current.i || prior.j !== current.j),
    directionChanged: !!prior && !!current && prior.sign !== current.sign,
    intervalChanged: ['protect', 'survive', 'both', 'profit'].some(
      (k) => older.sets[k].min?.h !== newer.sets[k].min?.h || older.sets[k].max?.h !== newer.sets[k].max?.h
    )
  };
}
