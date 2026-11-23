import {dec,out,min,nonnegative,positive} from './math.js';

// Bounds are maximum excursions from the starting mark, not closing returns.
export function reachability(changePct, assumptions, deadline, at) {
  const hold = assumptions?.holdHours;
  const remaining = deadline == null ? null : Math.max(0,(Date.parse(deadline)-Date.parse(at))/3600000);
  const move = dec(changePct);
  const down = move.lt(0);
  const first = down ? assumptions?.dailyDownPct : assumptions?.dailyUpPct;
  const second = down ? assumptions?.twoDayDownPct : assumptions?.twoDayUpPct;
  return ['24','48'].map(window => {
    const limits = [dec(window)];
    if (hold) limits.push(positive(hold));
    if (remaining != null) limits.push(nonnegative(String(remaining)));
    const effective = min(...limits);
    let bound = null;
    if (first==null && second==null) bound = null;
    else if (effective.isZero()) bound = dec('0');
    else if (effective.lte(24) && first != null) bound = nonnegative(first).times(effective).div(24);
    else if (window==='48' && first==null && second!=null) bound = nonnegative(second).times(effective).div(48);
    else if (effective.gt(24) && second != null && (first==null || nonnegative(second).gte(first))) {
      if (effective.eq(48)) bound = nonnegative(second);
      else if (first != null)
        bound = nonnegative(first).plus(nonnegative(second).minus(first).times(effective.minus(24)).div(24));
    }
    if (down && bound != null) bound = min(100,bound);
    return {window,effective:out(effective),bound:bound==null?null:out(bound),
      status:bound==null?'unknown':bound.gte(move.abs())?'within':'outside'};
  });
}

// A shorter configured window can prove a move within the deadline. Never
// extrapolate beyond the longest configured 48-hour scenario.
export function examEnvelope(horizon, deadline, now, delaySeconds='0') {
  const at=Date.parse(now);
  const holdEnd=horizon?.holdHours==null?Infinity:at+Number(horizon.holdHours)*3600000;
  const until=Math.min(Date.parse(deadline),holdEnd)-Number(delaySeconds)*1000;
  if(!Number.isFinite(at) || !Number.isFinite(until) || until<=at)
    return {up:null,down:null,expired:Number.isFinite(until) && until<=at};
  const bound=sign=>{
    const first=sign==='1'?horizon?.dailyUpPct:horizon?.dailyDownPct;
    const second=sign==='1'?horizon?.twoDayUpPct:horizon?.twoDayDownPct;
    if (first!=null && second!=null && dec(second).lt(first)) return null;
    const windows=reachability(sign,horizon,new Date(until).toISOString(),now);
    const values=windows.map(w=>w.bound).filter(x=>x!=null);
    return values.length?out(values.map(dec).reduce((a,b)=>a.gte(b)?a:b)):null;
  };
  return {up:bound('1'),down:bound('-1'),expired:false};
}
export function examMove(envelope, start, mark) {
  const percent=dec(mark).minus(start).times(100).div(start);
  const limit=percent.lt(0)?envelope.down:envelope.up;
  return {percent:out(percent),limit,status:envelope.expired?'fail':limit==null?'unknown':
    percent.abs().lte(limit)?'pass':'fail'};
}

// A completed solve can cross a window boundary while waiting for publication.
export function targetsWithinExam(result, timestamp) {
  const scan=result.baseScan ?? result.ratioScan;
  if (!scan?.ctx?.checks?.exam) return true;
  const {ctx,plans}=scan;
  const at=new Date(timestamp).toISOString();
  const envelope=examEnvelope(ctx.params.horizon,ctx.params.deadline,at);
  const derive=ctx.checks.exam.deriveMoves===true;
  if (envelope.expired || (!derive && (envelope.up==null || envelope.down==null))) return false;
  if (!plans) return true;
  const start=ctx.market.pf.mark;
  const within=(mark,window)=>{
    if (mark==null || window.expired) return false;
    const proof=examMove(window,start,mark);
    return proof.status==='pass' || derive && proof.status==='unknown';
  };
  const selected=new Set(plans.targetKeys);
  for (const row of plans.rows) {
    if (!selected.has(row.key)) continue;
    if (!['fail','pass'].every(end=>within(row.paths[end].pf.exitMark,envelope))) return false;
  }
  const delayed=examEnvelope(ctx.params.horizon,ctx.params.deadline,at,ctx.checks.exitDelaySeconds);
  for(const [kind,window] of [['normal',envelope],['delayed',delayed]]) {
    if(plans.collection?.timeBounds?.[kind]?.some(mark=>!within(mark,window))) return false;
  }
  for (const row of [plans.pressure?.row,plans.cashPriority?.row,plans.decision?.action]) {
    for (const scenario of row?.pressureSummary?.cases ?? []) {
      if (!scenario.configured) continue;
      const window=['vestFirst','hypeFirst'].includes(scenario.id)?delayed:envelope;
      for(const end of [scenario.fail,scenario.success]) {
        const mark=end.venue?.pfEnd ?? end.mathMarks?.trigger ?? end.prices?.pf?.mark;
        if (!within(mark,window)) return false;
      }
    }
  }
  return true;
}
