import { planObjectives, recordFromInspection } from './position-plans.js';
import { dec, min, out } from './math.js';
import { modelVersion, bookIdentity } from './trace.js';

// The same immutable publication feeds all target views, including after a reload.
function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

// Reject mismatched cash, coverage and witnesses before any view can publish the frame.
function verifyPressureSummary(row,scan) {
  const summary=row.pressureSummary, {cases,coverage,cashBuffers} = summary;
  const known=cases.filter(c=>c.verified);
  if (new Set(cases.map(c=>c.id)).size!==cases.length || coverage.total!==cases.length ||
      coverage.verified!==known.length || coverage.unverified!==cases.length-known.length ||
      coverage.passed!==known.filter(c=>c.status==='pass').length ||
      coverage.failed!==known.length-coverage.passed ||
      coverage.allSpecifiedPassed!==(coverage.passed===cases.length && summary.status==='pass'))
    throw Error('本帧压力情景的核验计数不一致');
  function buffer(minimum,threshold,endpoint) {
    if (minimum==null) return null;
    const witness=cases.find(c=>c.id===minimum.id);
    if (!witness?.verified || witness[endpoint]?.cash!==minimum.value)
      throw Error('本帧最低现金缺少可对账的情景');
    return out(dec(minimum.value).minus(threshold));
  }
  const successAmounts=known.flatMap(c=>c.success.personalFunds?[c.success.personalFunds.final]:[]).filter(v=>v!=null);
  const witness=summary.successFinal;
  if (successAmounts.length ? !witness || !min(...successAmounts).eq(witness.value) ||
      known.find(c=>c.id===witness.id)?.success.personalFunds?.final!==witness.value : witness!=null)
    throw Error('成功提现后资金与最低情景不一致');
  for (const [name,field] of [['worstFinal','final'],['worstAvailable','before']]) {
    const amounts=known.flatMap(c=>[c.fail,c.success]).map(e=>e.personalFunds?.[field]).filter(v=>v!=null);
    const witness=summary[name];
    const endpoint=known.find(c=>c.id===witness?.id)?.[witness?.endpoint];
    const bothPaths=['fail','success'].every(end=>known.some(c=>c[end].personalFunds?.[field]!=null));
    if (bothPaths ? !witness || endpoint?.personalFunds?.[field]!==witness.value ||
        !min(...amounts).eq(witness.value) : witness!=null) throw Error('个人资金极值与已核价压力情景不一致');
  }
  const fail=buffer(summary.minFailure,scan.ctx.params.baseRecovery ?? scan.ctx.book.B,'fail');
  const success=buffer(summary.minSuccess,scan.ctx.params.baseReserve ?? scan.ctx.params.R,'success');
  const both=fail==null || success==null ? null : out(min(fail,success));
  if (scan.ctx.stage==='challenge' && (summary.M_eval!==both || known.some(c=>[c.fail,c.success].some(e=>
      e.personalFunds && (e.personalFunds.projectedPayout!=='0' || e.personalFunds.final!==e.personalFunds.hype)))))
    throw Error('考核资金混入了 Funded 提现或缓冲不一致');
  if (summary.M_verified!==both || summary.M_full!==(cases.every(c=>c.verified && c.fail.cash!=null && c.success.cash!=null)?both:null) || !cashBuffers || cashBuffers.fail!==fail || cashBuffers.success!==success || cashBuffers.minimum!==both)
    throw Error('目标仓位的最差现金缓冲与本帧资金门槛不一致');
}

function finalizeSnapshot(view) {
  const { trace, ratioScan: { plans } } = view;
  if(plans?.collection && plans.collection.snapshotId!==trace.id) throw Error('方案集合与报价、参数版本不一致');
  const byKey = new Map(plans?.rows.map(row => [row.key, row]));
  // Only older on-disk reports need to resolve named objectives.
  const keys = plans?.targetKeys ?? planObjectives.map(([label]) =>
    plans?.rows.find(row => row.labels.includes(label))?.key ?? null);
  const baseTargets = keys.map(key => key == null ? null : byKey.get(key));
  if (baseTargets.length !== planObjectives.length || baseTargets.includes(undefined) ||
      (plans?.eligible > 0 && !plans.pending && !plans.legacy && baseTargets.some(row => !row)))
    throw Error('目标索引与候选快照不一致');
  const pressure=plans?.pressure;
  if (pressure?.row && (pressure.key!==pressure.row.key || !pressure.row.configuredPass ||
      !['feasible','conditional'].includes(pressure.status))) throw Error('流动性压力最大仓位与结算证据不一致');
  const targets=[baseTargets[0],pressure?.row ?? null,baseTargets[1],baseTargets[2],plans?.cashPriority?.row??null];
  const action=plans?.decision?.action;
  if(action) {
    const d=plans.decision, dir=d.directions.find(v=>v.sign===d.adopted);
    const level=dir?.levels.find(v=>v.percent===d.percent);
    if(action.sign!==d.adopted || (d.mode==='move'
      ? !level?.complete || level.requiredPosition.qty!==action.pf || level.choice?.hl!==action.hl
      : dir?.maxFeasiblePosition?.qty!==action.pf || dir?.maxFeasiblePosition?.hl!==action.hl))
      throw Error('采用目标与本帧方向、规模证明不一致');
  }
  for(const search of [pressure,plans?.cashPriority,action && {key:action.key,row:action}]) {
    if(trace.model!==modelVersion || !search?.row) continue;
    if(search.key!==search.row.key || !search.row.configuredPass) throw Error('压力目标与候选证据不一致');
    const summary=search.row.pressureSummary, scan=view.ratioScan;
    const active=summary?.cases?.filter(item=>item.configured) ?? [];
    const capital=dec(scan.ctx.book.B).plus(scan.ctx.params.recoveryBuffer??'0');
    if (summary?.status!=='pass' || !(scan.ctx.hardDepthD?['A','B','C','D']:['A','B','C']).every(id=>active.some(c=>c.id===id)) ||
        active.some(c=>c.status!=='pass' || c.fail.cash==null || dec(c.fail.cash).lt(capital) ||
          c.success.cash==null || dec(c.success.cash).lt(scan.ctx.params.R)))
      throw Error('压力最大仓位未通过本帧资金门槛');
    for (const [name,end] of [['minFailure','fail'],['minSuccess','success']]) {
      const minimum=summary[name];
      const source=active.find(c=>c.id===minimum?.id);
      if (!source || minimum.value!==source[end].cash || active.some(c=>dec(c[end].cash).lt(minimum.value)))
        throw Error('压力资金极值与本帧情景不一致');
    }
  }
  if (trace.model===modelVersion && pressure) {
    const all=pressure.allSpecified;
    if (all?.key!=null && (!pressure.row?.pressureSummary?.coverage?.allSpecifiedPassed || all.key!==pressure.key))
      throw Error('全部指定压力最大值缺少对应候选的完整核验');
  }
  for (const row of new Set([...targets,action].filter(Boolean))) {
    if (trace.model===modelVersion && row.pressureSummary) verifyPressureSummary(row,view.ratioScan);
    if (row.pressureSummary && (row.pressureSummary.key!==row.key || row.pressureSummary.leverage!==row.leverage)) throw Error('压力结果与本帧目标仓位不一致');
    if (dec(row.pf).cmp(0) !== row.sign || (dec(row.hl).cmp(0) && dec(row.hl).cmp(0) !== -row.sign))
      throw Error('双边有符号目标与计算方向不一致');
    for (const end of ['fail','pass']) {
      const path = row.paths?.[end];
      if (!path?.pf || !path.hl) throw Error('目标缺少可达的双边价格路径');
      const isSuccess = end === 'pass';
      for (const side of ['pf','hl']) {
        const leg = path[side], mark = view.prices[side].mark;
        if (side === 'pf' && dec(leg.exitMark).cmp(mark) !== (isSuccess?row.sign:-row.sign))
          throw Error('目标仓位方向与快照价格路径不一致');
        if (trace.model === modelVersion && leg.target == null)
          throw Error('目标价格路径缺少有符号数量');
        if (leg.target != null && (!dec(leg.target).eq(row[side]) || !dec(leg.mark).eq(mark) ||
            dec(leg.markPnl).cmp(0) !== dec(row[side]).cmp(0)*dec(leg.exitMark).cmp(mark)))
          throw Error('目标仓位、起点与快照盈亏不一致');
      }
    }
  }
  if (plans?.focus) {
    const focus = plans.focus, maximum = targets[0];
    if (!maximum || focus.sign !== maximum.sign || focus.i !== maximum.i || focus.j !== maximum.j)
      throw Error('资金流水与最大目标仓位不一致');
    const ledgers = focus.settlementPaths ?? focus.paths;
    for (const end of ['fail','pass']) for (const side of ['pf','hl']) {
      const leg = ledgers[end][side], published = maximum.paths[end][side];
      if (leg.target !== published.target || leg.exitMark !== published.exitMark ||
          leg.settled !== published.finalEquity) throw Error('首页目标流水与对应结算结果不一致');
    }
  }
  const pair = plans?.comparison;
  const automatic = pair && { comparison:pair, rows:[byKey.get(pair.small), byKey.get(pair.large)] };
  if (automatic && automatic.rows.some(row => !row)) throw Error('规模对照与候选快照不一致');
  return freezeTree({
    ...view, snapshotId: trace.id, quoteSnapshotId: trace.marketId ?? null,
    accountSnapshotId: trace.accountsId ?? null, rulesVersion: trace.rulesId ?? null,
    solverVersion: trace.model, calculatedAt: view.finishedAt ?? trace.at, targets,
    scale: { automatic: automatic?.rows.some(row => !row.physical)
      ? {reason:'至少一种规模没有通过保证金与清算约束的杠杆档位'} : automatic ?? null, fixed: plans?.fixed ?? null }
  });
}

// A ready worker result can be presented as current only for the same atomic
// publication and the same observed book/mark clocks. The scheduler separately
// compares the complete depth, account inputs and economic rules before commit.
export function publicationState(result,snapshot,market,blocked=false) {
  if (blocked) return 'paused';
  const state=result.frameState ?? 'paused';
  if (state!=='ready') return state;
  const trace=result.trace;
  if (!result.ratioScan || !snapshot || !trace ||
      trace.id!==snapshot.snapshotId || trace.marketId!==snapshot.quoteSnapshotId ||
      trace.accountsId!==snapshot.accountSnapshotId || trace.rulesId!==snapshot.rulesVersion ||
      trace.model!==modelVersion || trace.model!==snapshot.solverVersion || result.finishedAt!==snapshot.calculatedAt) return 'updating';
  if (snapshot.bookIdentity !== bookIdentity(market)) return 'updating';
  return 'ready';
}

export function createSolutionSnapshot(result, previous) {
  const scan = result.baseScan ?? result.ratioScan;
  const { inputs, ...trace } = result.trace;
  if (trace.model!==modelVersion) throw Error('求解器版本已变更，本帧仅可作为历史记录');
  if (![trace.id,trace.marketId,trace.accountsId,trace.rulesId,trace.model,trace.at].every(Boolean))
    throw Error('计算快照缺少行情、账户或规则版本');
  const { sets, buckets, representative, analysis, complete } = scan;
  const { book, params, market } = scan.ctx;
  const prior=previous?.ratioScan.plans?.decision?previous.ratioScan.plans.decision.action:previous?.targets?.[1];
  const view = {
    solverRunId:result.solverRunId ?? trace.id,
    solveCause:result.solveCause,
    previousSolve:previous?{id:previous.snapshotId,at:previous.trace.at,balance:previous.ratioScan?.plans?.pressure?.continuousBalance,
      best:prior?.pressureSummary?.M_verified!=null?{h:prior.notionalRatio??out(dec(prior.hypeValue).div(prior.pfValue)),pf:prior.pf,hl:prior.hl,pfValue:prior.pfValue,hypeValue:prior.hypeValue,leverage:prior.leverage,M:prior.pressureSummary.M_verified}:null}:null,
    bookIdentity: bookIdentity(result.calculationMarket),
    prices: Object.fromEntries(
      ['pf', 'hl'].map((side) => {
        const q = result.calculationMarket[side],
          c = result.currencies[side];
        return [
          side,
          {
            mark: q.mark,
            bid: q.levels?.[0]?.[0]?.[0],
            ask: q.levels?.[1]?.[0]?.[0],
            bookAt: q.bookAt ?? q.asOf,
            asOf: q.asOf,
            markAt: q.markAt,
            base: c.baseAsset,
            quote: c.quoteAsset,
            settle: c.settleAsset
          }
        ];
      })
    ),
    trace,
    finishedAt: result.finishedAt,
    stress: result.stress,
    autoStatus: result.autoStatus,
    ratioScan: {
      sets,
      recoveryFloor: scan.recoveryFloor,
      buckets,
      representative,
      analysis,
      plans: scan.plans && { collection:scan.plans.collection,decision:scan.plans.decision,checkpoints:scan.plans.checkpoints, ratioCheckpoints:scan.plans.ratioCheckpoints, cashPriority:scan.plans.cashPriority, pressure:scan.plans.pressure, focus:scan.plans.focus, targetKeys: scan.plans.targetKeys, rows: scan.plans.rows, comparison:scan.plans.comparison, fixed:scan.plans.fixed, eligible: scan.plans.eligible, pending: scan.plans.pending, pfQuote: scan.plans.pfQuote, hlQuote: scan.plans.hlQuote },
      complete,
      ctx: {
        stage:book.stage, deriveMoves:scan.ctx.checks?.exam?.deriveMoves===true, hardDepthD: scan.ctx.checks?.hardDepthD===true,
        book: { B: book.B, share:book.share, platformShare:book.withdrawal?.platformShare },
        params: {
          R: params.R, baseReserve: params.baseReserve, baseRecovery:params.baseRecovery, successBuffer: params.successBuffer, recoveryBuffer: params.recoveryBuffer,
          target: params.target,horizon:params.horizon,deadline:params.deadline,
          profitBasis: params.profitBasis
        },
        market: { pf: { unit: market.pf.unit, step:market.pf.step }, hl: { unit: market.hl.unit, step:market.hl.step } }
      }
    }
  };
  return finalizeSnapshot(view);
}

// Read only by the renderer. The worker always starts from current inputs.
// Retain the last complete public-facing report, without order books, wallet
// payloads, the full lot grid, or any executable adjustment advice.
export function displayHistory(storage) {
  let previousKey, previous;
  function key(scope, version = modelVersion) {
    return 'vs-hype:display-history:' + version + ':' + scope;
  }
  return {
    read(scope) {
      if (scope === previousKey) return previous;
      previousKey = scope;
      previous = null;
      try {
        const versions=[modelVersion,'AUTO-0.21.27','AUTO-0.21.26','AUTO-0.21.25','AUTO-0.21.24','AUTO-0.21.23','AUTO-0.21.22','AUTO-0.21.21','AUTO-0.21.20','AUTO-0.21.19','AUTO-0.21.18','AUTO-0.21.16','AUTO-0.21.15','AUTO-0.21.14','AUTO-0.21.13','AUTO-0.21.12','AUTO-0.21.11','AUTO-0.21.10','AUTO-0.21.9','AUTO-0.21.8','AUTO-0.21.7','AUTO-0.21.6','AUTO-0.21.5','AUTO-0.21.4','AUTO-0.21.3','AUTO-0.21.2','AUTO-0.21.1'];
        let stored;
        for (const version of versions) {
          stored=storage.getItem(key(scope,version));
          if (stored!=null) break;
        }
        const saved=stored?JSON.parse(stored):null;
        if (
          saved?.scope === scope &&
          versions.includes(saved.view?.trace?.model) &&
          saved.view.ratioScan?.complete &&
          Array.isArray(saved.view.ratioScan.buckets) &&
          saved.view.ratioScan.ctx?.market?.pf &&
          saved.view.ratioScan.sets?.legal
        ) {
          const scan = saved.view.ratioScan;
          // Older reports kept the buffered subset separately. Preserve their
          // prices and actual cash rows while restoring only qualified members.
          const buffer = scan.analysis?.recoveryBuffer ?? scan.representative?.buffer ?? '0';
          if (scan.recoveryFloor == null && dec(buffer).gt(0)) {
            scan.recoveryFloor = out(dec(scan.ctx.book.B).plus(buffer));
            scan.sets.both = scan.sets.eligible ?? {count:0, min:null, max:null};
            for (const bin of scan.buckets) {
              bin.both = bin.eligible ?? 0;
              bin.ranges.both = bin.ranges.eligible ?? null;
            }
            scan.historicalIntersection = true;
            scan.analysis = null;
            for (const row of [scan.representative?.row, ...(scan.plans?.rows ?? [])].filter(Boolean)) {
              row.coversWithBuffer = row.fail != null && dec(row.fail).gte(scan.recoveryFloor);
              row.both = row.both && row.coversWithBuffer;
            }
          }
          // Historical all-left-open bins cannot be reclassified from extrema.
          // Keep their cash and target rows, and wait for a live grid to repopulate bins.
          if (scan.buckets.some(bin => !['below','joint','above','all'].includes(bin.edgeKey))) {
            scan.buckets = [];
            if (scan.analysis) scan.analysis.boundary = null;
          }
          if (!scan.plans && scan.representative?.row) {
            const row = recordFromInspection(scan.ctx, scan.representative.row);
            scan.plans = { legacy: true, rows: [{ ...row, labels: ['上次计算仓位'] }],
              pfQuote: saved.view.prices?.pf?.quote, hlQuote: saved.view.prices?.hl?.quote };
          }
          previous = finalizeSnapshot(saved.view);
        }
      } catch {
        /* No readable local display snapshot. */
      }
      return previous;
    },
    record(scope, snapshot) {
      if (!snapshot.ratioScan?.complete) return;
      previousKey = scope;
      previous = snapshot;
      // Rebuild references to the canonical rows on restore instead of serializing duplicate candidates.
      const { targets, scale, ...view } = snapshot;
      try {
        storage.setItem(key(scope), JSON.stringify({ scope, view }));
      } catch {
        /* Memory remains available. */
      }
    }
  };
}
