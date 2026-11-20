import { adjustmentAfterOrders } from './order-adjustment.js';
import { sumPostings, settlementBridge, settlementTolerance, checkSignedPath, checkPFBoundary } from './settlement-ledger.js';
import { executionDetail, profileInputs } from './solver.js';
import { dec, out, fillEvidence, min } from './math.js';
import { exactRatio, adjacentScale, inspectRatio, ratioSlice, scalesPerBlock, lastLotAtRatio } from './ratio-scan.js';

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

// Index 0 covers the whole grid; segment n uses index n+1. Both aggregates
// and drilldown share exact strict/inclusive limits on the unrounded lot ratio.
export function segmentPage(scan, segment, kind, requestedPage, size = 5) {
  if (!['both','legal'].includes(kind) || !Number.isSafeInteger(size) || size < 1)
    throw Error('无效的仓位分段查询');
  const bin = segment == null ? null : scan.buckets[segment];
  if (segment != null && !bin) throw Error('仓位分段不存在');
  const total = bin ? bin[kind] : scan.sets[kind].count;
  const pages = Math.ceil(total / size);
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), pages || 1);
  const points = [];
  let skip = (page - 1) * size;
  const lower = bin && segment > 0 ? scan.buckets[segment-1].throughLots : null;
  for (const block of scan.pageIndex[bin ? segment+1 : 0]) {
    if (skip >= block[kind]) { skip -= block[kind]; continue; }
    for (let i=block.first; i<block.first+scalesPerBlock; i++) {
      const minJ = lower ? lastLotAtRatio(lower,i)+1 : 0;
      const maxJ = bin?.throughLots ? lastLotAtRatio(bin.throughLots,i) : Infinity;
      for (const [a,b] of ratioSlice(scan,block.sign,i,kind)) {
        const lo = Math.max(a,minJ), hi = Math.min(b,maxJ);
        if (hi < lo) continue;
        if (skip > hi-lo) { skip -= hi-lo+1; continue; }
        for (let j=lo+skip; j<=hi; j++) {
          points.push({sign:block.sign,i,j});
          if (points.length === size) return {page,pages,total,points};
        }
        skip = 0;
      }
    }
  }
  return {page,pages,total,points};
}

function execution(leg) {
  if (!leg) return null;
  return { delta: leg.adjustment, price: dec(leg.adjustment).isZero() ? null : leg.entryPrice };
}

function adjustment(ledger, pending) {
  if (!ledger) return null;
  const current = out(dec(ledger.target).minus(ledger.adjustment));
  return { current, pending:pending ?? null, ...adjustmentAfterOrders(ledger.adjustment, pending) };
}

function settleHypeAt(leg, entry, shift, extraDebit) {
  const exit=executionDetail(leg,out(dec(entry.target).neg()),shift);
  return settlementBridge(entry.start,leg,entry.target,entry.adjustment,shift,
    {price:entry.entryPrice,fee:entry.entryFee,impact:entry.entrySlippage},exit,
    sumPostings([entry.friction,extraDebit]));
}

// Use the candidate's two signed settlement ledgers. Only the Hype exit is
// repriced under a Hype shock; PF still closes at its own rule boundary.
function reachableLedgers(ctx, row, key) {
  const path = row.paths?.[key];
  if (!path?.pf || !path.hl || (key === 'fail' ? row.failStop : row.passStop)) return null;
  const pf = path.pf, leg = ctx.market.hl;
  let hl = path.hl;
  if (row.stress) {
    if (!leg.factor || !row.lines) return null; // A legacy saved report may lack the native book.
    const shift = out(dec(row.lines[key]).plus(dec(row.stress.priceShock).div(leg.factor)));
    hl = settleHypeAt(leg,hl,shift,sumPostings([row.stress.delayDebit,row.stress.fundingDebit]));
  }
  return {pf, hl};
}

function endpoint(ctx, row, key, pair, profile) {
  if (!pair) return null;
  const {pf, hl} = pair;
  // Legacy on-disk reports have no market/depth inputs and are historical only.
  const compact = (ledger,side) => {
    let evidence;
    if (profile) {
      const spec=ctx.market[side], sign=side==='pf' ? row.sign : -row.sign;
      const lots=side==='pf' ? row.i : row.j;
      const target=out(dec(spec.step).times(lots).times(sign));
      const current=Object.values(ctx.book.positions).find(p=>p.asset===ctx.market.id &&
        p.venue===side && p.pool===spec.pool)?.qty ?? '0';
      const delta=out(dec(target).minus(current));
      const shift=out(dec(row.lines[key]).plus(side==='hl' && row.stress
        ? dec(row.stress.priceShock).div(spec.factor) : '0'));
      if (!dec(row[side]).eq(target)) throw Error('仓位方向与数量网格不一致');
      evidence=checkSignedPath(ledger,spec,target,delta,side==='pf' ? profile.E : profile.C_hl,shift);
      const fill=executionDetail(spec,out(dec(target).neg()),shift);
      const entry=executionDetail(spec,delta);
      if (fill.price!==ledger.exitPrice || entry.price!==ledger.entryPrice)
        throw Error('候选成交方向与盘口均价不一致');
      if (side==='pf') {
        const success=key==='pass', trigger=success?ctx.checks.passTrigger:ctx.checks.failureTrigger;
        const threshold=success ? profile.target : profile.floor;
        checkPFBoundary(ledger,target,key,threshold,trigger);
      }
    }
    return { ...evidence, exitMark:ledger.exitMark, exitPrice:ledger.exitPrice,
      fees:sumPostings([ledger.entryFee, ledger.exitFee]),
      slippage:sumPostings([ledger.entrySlippage, ledger.exitSlippage]),
      executionCost:out(dec(ledger.entryFill).plus(ledger.exitFill).neg()) };
  };
  const expected = key === 'fail'
    ? (ctx.book.external == null ? null : sumPostings([hl.settled, ctx.book.external])) : hl.settled;
  if (expected != null && dec(expected).minus(key === 'fail' ? row.fail : row.success).abs().gt(settlementTolerance))
    throw Error('候选触线路径与现金账本不一致');
  return { pf:compact(pf,'pf'), hl:compact(hl,'hl'), hypeNet:out(dec(hl.settled).minus(hl.start)) };
}

// Value each mapped exit independently using the same signed entry and the
// snapshot's translated close book. A prefix before a delayed fill has no exit.
function pathEvidence(ctx,row,key) {
  const cases=row.pathAudit?.[key], ledgers=row.paths?.[key];
  if (!cases || !ledgers) return cases;
  const leg=ctx.market.hl, pf=ledgers.pf, hl=ledgers.hl;
  return Object.fromEntries(Object.entries(cases).map(([name,test])=>{
    if (test.shift == null || test.status!=='pass' || test.proof?.continuous!==true ||
        (cases.base.pfStatus && cases.base.pfStatus!=='pass') || row.verification.initial!=='pass' ||
        cases.beforeFill?.status==='fail' && name==='delayedFill') return [name,test];
    const nativeMove=out(dec(test.shift).times(leg.factor));
    const fill=fillEvidence(out(dec(hl.target).neg()),leg,nativeMove);
    if (!['covered','noTrade'].includes(fill.status)) return [name,{...test,settlementIssue:'平仓深度未验证'}];
    const ledger=settleHypeAt(leg,hl,test.shift,test.debit??'0');
    return [name,{...test, settlement:{pfMark:pf.exitMark,hlMark:ledger.exitMark,pfFill:pf.exitPrice,hlFill:ledger.exitPrice,
      pfNet:out(dec(pf.settled).minus(pf.start)),hlNet:out(dec(ledger.settled).minus(ledger.start)),
      hype:ledger.settled,personal:sumPostings([ledger.settled,ctx.book.external]),exitDepth:fill}}];
  }));
}
function orderEvidence(ctx,row,key) {
  const ledgers=row.paths?.[key];
  if (!ledgers || !ctx.market.pf.bids || !row.lines) return null;
  const fills={};
  for (const side of ['pf','hl']) {
    const leg=ctx.market[side], ledger=ledgers[side];
    const native=dec(row.lines[key]).times(leg.factor).plus(side==='hl' ? row.stress?.priceShock??'0' : '0');
    fills[side]={entry:fillEvidence(ledger.adjustment,leg),exit:fillEvidence(out(dec(ledger.target).neg()),leg,out(native))};
  }
  return fills;
}
function costs(path) {
  return path && {fees:sumPostings([path.pf.fees, path.hl.fees]),
    slippage:sumPostings([path.pf.slippage, path.hl.slippage])};
}
// One scalar evaluation supplies every displayed field for one exact tuple.
// Even a legal quantity can reach liquidation before a requested cash endpoint.
export function planRecord(scan, point) {
  return recordFromInspection(scan.ctx, inspectRatio(scan.ctx, point, {includePathAudit:true}));
}

export function recordFromInspection(ctx, row, pairs = {fail:reachableLedgers(ctx,row,'fail'),pass:reachableLedgers(ctx,row,'pass')}) {
  const { sign, i, j } = row;
  const pathAudit={fail:pathEvidence(ctx,row,'fail'),pass:pathEvidence(ctx,row,'pass')};
  const profile = ctx.book.positions ? profileInputs(ctx.book,ctx.params,ctx.market) : null;
  const paths = {fail:endpoint(ctx,row,'fail',pairs.fail,profile),pass:endpoint(ctx,row,'pass',pairs.pass,profile)};
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
    successPersonal: row.passStop ? null : row.successPersonal,
    successDelta: row.passStop ? null : out(dec(row.successPersonal).minus(ctx.book.B)),
    failStop: row.failStop, passStop: row.passStop,
    pathAudit, verification:row.verification,
    depth:{fail:orderEvidence(ctx,row,'fail'),pass:orderEvidence(ctx,row,'pass')},
    coverage: ctx.checks?.fullStress && row.crossChecked &&
      Object.values(pathAudit).every(group=>group?.basisWiden && group?.basisNarrow &&
        Object.values(group).every(test=>test.status==='pass' && test.proof?.continuous &&
          (test.shift==null || test.settlement!=null))) ? 'verified' : 'conditional',
    minimumInitialHeadroom: Object.values(pathAudit).flatMap(group=>Object.values(group??{}))
      .flatMap(test=>test.checkpoints??[]).reduce((low,p)=>low==null?p.initialHeadroom:out(min(low,p.initialHeadroom)),null),
    minimumHeadroom: Object.values(pathAudit).flatMap(group=>Object.values(group??{}))
      .map(test=>test.lowestFree?.free).filter(v=>v!=null)
      .reduce((low,v)=>low==null?v:out(min(low,v)),null),
    paths, failCost:costs(paths.fail), passCost:costs(paths.pass),
    adjustments:{pf:adjustment(row.paths?.fail.pf, ctx.market.pf.pendingQty),
      hl:adjustment(row.paths?.fail.hl, ctx.market.hl.pendingQty)},
    leverage: row.lev == null ? null : String(row.lev),
    maintenance: row.maintenance ?? null, free: row.free ?? null, otherInitial: row.otherInitial ?? null,
    baseSurplus: row.baseSurplus ?? null, stressSurplus: row.stressSurplus ?? null,
    successHeadroom: row.passStop ? null : row.reserveHeadroom,
    initial: row.initial, marginRate: row.imRate, liquidation: row.liquidation, distance: row.buffer, distanceRate: row.bufferRate,
    surplus: row.surplus, physical: row.physical, covers: row.covers, coversWithBuffer: row.coversWithBuffer, survives: row.survives,
    both: row.both, profitable: ctx.params.externalPriced !== false && row.profitable,
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

export const planObjectives = [
  ['最大 PF 仓位', '最大 PF 目标仓位'],
  ['失败回收优先', '失败端回收缓冲优先'],
  ['成功留存优先', '成功端现金留存优先']
];

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
  const targets = pending ? [null, null, null] : [
    primary, eligible.range?.witnesses.failure[1], eligible.range?.witnesses.successHype[1]
  ];
  const targetKeys = targets.map((point, i) => {
    add(point, planObjectives[i][0]);
    return point ? pointKey(point) : null;
  });
  const index = scaleIndex(scan);
  const featured = [...points.values()];
  // Prefer a genuine smaller target at the maximum's exact exposure ratio.
  // Preserve the existing half-size comparison when it is on the legal grid.
  let smaller = null;
  if (!pending && primary) {
    const {sign,i,j} = primary;
    if (i % 2 === 0 && j % 2 === 0 && ratioSlice(scan,sign,i/2).some(([a,b]) => a <= j/2 && j/2 <= b))
      smaller = {sign, i:i/2, j:j/2};
    else smaller = adjacentScale(scan,primary,-1);
  }
  const examples = smaller ? [primary, smaller] : scalePair(scan, index, featured);
  for (const point of examples) add(point, '同 h 规模对照');
  if (!points.size)
    for (const point of pagePoints(scan, index, null, 3).rows) add(point, '合法规模');
  const levelsByPoint = new Map();
  let focus = null;
  const rows = [...points.values()].map(({labels,...point}) => {
    const compare = labels.includes('同 h 规模对照');
    const inspected = inspectRatio(scan.ctx, point, {includeLeverageGrid:compare, includePathAudit:true});
    const pairs = {fail:reachableLedgers(scan.ctx,inspected,'fail'),pass:reachableLedgers(scan.ctx,inspected,'pass')};
    const row = recordFromInspection(scan.ctx, inspected, pairs);
    if (row.key === targetKeys[0]) {
      const {pathAudit,leverageGrid,...ledgerRow} = inspected;
      focus = inspected.stress ? {...ledgerRow,settlementPaths:pairs} : ledgerRow;
    }
    if (compare) levelsByPoint.set(row.key, inspected.leverageGrid);
    if (labels.some(l => l.endsWith('优先') || l === '最大 PF 仓位') &&
        (!ratioSlice(scan,row.sign,row.i,'eligible').some(([lo,hi]) => lo <= row.j && row.j <= hi) ||
          !row.both || row.failStop || row.passStop ||
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
  const comparison = scaleComparison(rows);
  const fixed = comparison ? fixedScaleComparison(scan.ctx, rows, comparison, levelsByPoint) : null;
  return { index, targetKeys, focus, rows: [...fractions.values()].flat(), comparison, fixed, pending, eligible: pending ? 0 : eligible.count };
}

// Select a mutually admissible setting, then price both complete positions at that setting.
function fixedScaleComparison(ctx, rows, pair, levelsByPoint) {
  const keys = [pair.small, pair.large];
  const grids = keys.map(key => levelsByPoint.get(key).filter(row => row.status === 'pass' && row.leverage));
  const small = grids[0].find(row => grids[1].some(other => other.leverage === row.leverage));
  if (!small) return { reason:'两种规模没有同时通过保证金及清算校验的共同杠杆档位' };
  const fixed = keys.map(key => {
    const { sign, i, j, labels } = rows.find(row => row.key === key);
    const evaluated = inspectRatio(ctx, {sign, i, j}, {fixedLeverage:small.leverage,includePathAudit:true});
    return { ...recordFromInspection(ctx, evaluated), labels };
  });
  return { leverage:String(small.leverage), rows:fixed, comparison:scaleComparison(fixed) };
}

// Pair actual evaluations from the same frame, direction and exact exposure
// fraction. Null path/clearing values propagate to the corresponding change.
export function scaleComparison(rows) {
  const pair = rows.filter(row => row.labels?.includes('同 h 规模对照')).sort((a,b) => a.i-b.i);
  if (pair.length !== 2) return null;
  const [small, large] = pair;
  if (!small.fraction || small.fraction !== large.fraction || small.sign !== large.sign || small.i === large.i)
    return null;
  const delta = {};
  for (const key of ['pf','pfValue','hl','hypeValue','initial','marginRate','fail','failDelta','success','distance','leverage','maintenance','free','otherInitial','liquidation','baseSurplus','stressSurplus']) {
    if (small[key] == null || large[key] == null) { delta[key] = null; continue; }
    const value = row => key === 'pf' || key === 'hl' ? dec(row[key]).abs() : dec(row[key]);
    delta[key] = out(value(large).minus(value(small)));
  }
  return {small:small.key, large:large.key, fraction:small.fraction, delta};
}
