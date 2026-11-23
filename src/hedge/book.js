import { D, dec, nonnegative, positive, profitSplit, ratio, out, estimateFill } from './math.js';
export const BOOK_VERSION = 1;
export const iso = (value) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw Error('需要带时区的时间');
  return new Date(value).toISOString();
};
const validId = (v) => {
  if (
    typeof v !== 'string' ||
    !v.length ||
    v.length > 256 ||
    ['__proto__', 'constructor', 'prototype'].includes(v)
  )
    throw Error('无效事件或资金标识');
  return v;
};
const requireThat = (ok, reason) => {
  if (!ok) throw Error(reason);
};
const active = (s) => ['CHALLENGE_ACTIVE', 'FUNDED_ACTIVE'].includes(s.status);
const amountSum = (values) => values.reduce((a, v) => a.plus(dec(v)), new D(0));
export function createBook({
  id,
  time,
  B = '1000',
  purchaseFee = '142.50',
  pf = '10000',
  hl,
  external = '0',
  ref,
  stage = 'challenge',
  deadline,
  hours = '48',
  mode = 'demo',
  profileVersion = 1,
  baseline = '10000',
  share = '0.8',
  withdrawal,
  challengeTarget = '11000',
  challengeFloor = '9400',
  fundedFloor = '9400',
  currency = 'U',
  passTrigger = 'net_settlement',
  failureTrigger = 'net_settlement',
  additionalRules = []
}) {
  validId(id);
  const start = iso(time);
  requireThat(
    ['challenge', 'funded'].includes(stage) && ['demo', 'replay', 'manual', 'live_readonly'].includes(mode),
    'MODE'
  );
  const fee = nonnegative(purchaseFee),
    cash = hl === undefined ? positive(B).minus(fee) : nonnegative(hl);
  requireThat(cash.gte(0), 'INSUFFICIENT_PURCHASE_CASH');
  const until = deadline
    ? iso(deadline)
    : new Date(Date.parse(start) + positive(hours).times(3600000).toNumber()).toISOString();
  requireThat(Date.parse(until) > Date.parse(start), 'INVALID_DEADLINE');
  const s = {
    version: BOOK_VERSION,
    revision: 0,
    mode,
    stage,
    status: stage === 'challenge' ? 'CHALLENGE_ACTIVE' : 'FUNDED_ACTIVE',
    attemptId: id,
    round: 1,
    challengeStartedAt: start,
    challengeDeadlineAt: until,
    deadlineMode: deadline ? 'explicit_timestamp' : 'elapsed_hours',
    exitStatus: null,
    profileVersion,
    passTrigger,
    failureTrigger,
    additionalRules,
    currency,
    baseline: out(positive(baseline)),
    share: out(ratio(share)),
    ...(withdrawal && {withdrawal:{
      reset:out(positive(withdrawal.reset ?? baseline)),platformShare:withdrawal.platformShare,
      minimum:out(nonnegative(withdrawal.minimum ?? '0')),fee:out(nonnegative(withdrawal.fee ?? '0'))}}),
    challengeTarget: out(positive(challengeTarget)),
    challengeFloor: out(nonnegative(challengeFloor)),
    fundedFloor: out(nonnegative(fundedFloor)),
    B: out(positive(B)),
    pf: out(dec(pf)),
    hl: out(cash),
    external: out(nonnegative(external)),
    fees: { pf: '0', hl: '0', registration: stage === 'challenge' && hl === undefined ? out(fee) : '0' },
    realized: { pf: '0', hl: '0' },
    funding: { pf: '0', hl: '0' },
    paid: '0',
    contributions: '0',
    withdrawals: '0',
    roundIn: '0',
    roundOut: '0',
    ref: out(ref === undefined ? cash.plus(external) : dec(ref)),
    refEvent: id + '/start',
    payouts: {},
    transfers: {},
    positions: {},
    events: [],
    seen: {}
  };
  const event = {
    id: s.refEvent,
    type: 'attempt_start',
    source: mode === 'live_readonly' ? 'manual' : mode,
    occurredAt: start,
    receivedAt: start,
    payload: { fee: s.fees.registration, deadline: until }
  };
  record(s, event);
  return s;
}
function record(s, e) {
  const entry = {
    ...e,
    occurredAt: iso(e.occurredAt),
    receivedAt: iso(e.receivedAt),
    attemptId: s.attemptId,
    roundId: s.round,
    ruleProfileVersion: s.profileVersion,
    currency: s.currency,
    venue: e.payload.venue ?? 'external',
    pfEquity: markEquity(s, 'pf'),
    personalEquity: balances(s).total,
    pfBalance: s.pf,
    hlBalance: s.hl,
    external: s.external,
    C_ref: s.ref
  };
  s.events.push(entry);
  s.seen[e.id] = true;
  s.revision++;
}
export function markEquity(s, venue, marks = {}) {
  let total = dec(s[venue]);
  for (const p of Object.values(s.positions))
    if (p.venue === venue) {
      const mark = positive(marks[p.asset] ?? p.mark);
      total = total.plus(dec(p.qty).times(p.multiplier).times(p.fx).times(mark.minus(p.entry)));
    }
  return out(total);
}
export function balances(s, marks = {}) {
  const hl = dec(markEquity(s, 'hl', marks)),
    protect = hl.plus(s.external);
  const inTransit = amountSum(
    Object.values(s.transfers)
      .filter((t) => t.status === 'in_transit')
      .map((t) => t.amount)
  );
  const total = protect.plus(inTransit);
  return {
    hl: out(hl),
    external: s.external,
    inTransit: out(inTransit),
    protect: out(protect),
    total: out(total),
    receivable: out(
      amountSum(
        Object.values(s.payouts)
          .filter((p) => !p.destination)
          .map((p) => p.user)
      )
    ),
    gain: s.ref == null ? null : out(total.minus(s.ref).minus(s.roundIn).plus(s.roundOut))
  };
}
function postFill(s, p) {
  const { venue, asset, pool } = p;
  requireThat(['pf', 'hl'].includes(venue) && validId(asset) && validId(pool), 'INVALID_POSITION');
  requireThat(p.currency === s.currency, 'FX_UNVERIFIED');
  const key = [venue, pool, asset].map(encodeURIComponent).join('/'),
    prev = s.positions[key],
    old = dec(prev?.qty ?? '0'),
    delta = dec(p.qty),
    px = positive(p.price);
  if (delta.isZero()) throw Error('ZERO_FILL');
  const mult = positive(p.multiplier),
    fx = positive(p.fx),
    unit = mult.times(fx),
    target = old.plus(delta),
    entry = dec(prev?.entry ?? p.price);
  if (prev && (!mult.eq(prev.multiplier) || !fx.eq(prev.fx))) throw Error('POSITION_SPEC_CHANGED');
  const fee =
    p.actualFee === undefined ? delta.abs().times(px).times(unit).times(ratio(p.rate)) : dec(p.actualFee);
  const opposed = old.times(delta).lt(0);
  const gross = opposed
    ? D.min(old.abs(), delta.abs())
        .times(old.isPositive() ? 1 : -1)
        .times(px.minus(entry))
        .times(unit)
    : new D(0);
  s[venue] = out(dec(s[venue]).plus(gross).minus(fee));
  s.realized[venue] = out(dec(s.realized[venue]).plus(gross));
  s.fees[venue] = out(dec(s.fees[venue]).plus(fee));
  if (target.isZero()) delete s.positions[key];
  else {
    const avg =
      old.isZero() || old.times(target).lt(0)
        ? px
        : opposed
          ? entry
          : old.times(entry).plus(delta.times(px)).div(target);
    s.positions[key] = {
      venue,
      asset,
      pool,
      currency: p.currency,
      qty: out(target),
      entry: out(avg),
      mark: out(px),
      multiplier: out(mult),
      fx: out(fx),
      rate: out(ratio(p.rate))
    };
  }
  return { gross: out(gross), fee: out(fee), feeToken: p.feeToken ?? s.currency, rebate: p.rebate ?? '0' };
}
function beginRound(s, id) {
  s.round++;
  s.ref = balances(s).total;
  s.refEvent = id;
  s.roundIn = '0';
  s.roundOut = '0';
}
export function applyLedgerEvent(book, e) {
  validId(e.id);
  iso(e.occurredAt);
  iso(e.receivedAt);
  requireThat(e.payload && typeof e.payload === 'object', 'INVALID_EVENT');
  const live = book.mode === 'live_readonly',
    observed = ['api', 'manual'].includes(e.source);
  requireThat(
    live ? observed && e.confirmed === true : ['demo', 'replay', 'manual'].includes(e.source),
    'SOURCE_NOT_CONFIRMED'
  );
  if (e.attemptId && e.attemptId !== book.attemptId) throw Error('ATTEMPT_MISMATCH');
  if (Object.hasOwn(book.seen, e.id)) {
    const prior = book.events.find((record) => record.id === e.id);
    if (
      prior.type !== e.type ||
      prior.occurredAt !== iso(e.occurredAt) ||
      Object.entries(e.payload).some(([k, v]) => JSON.stringify(prior.payload[k]) !== JSON.stringify(v))
    )
      throw Error('CONFLICTING_EVENT');
    return book;
  }
  const p = e.payload,
    s = structuredClone(book);
  if (e.type === 'fill') {
    requireThat(active(s) || p.exit === true, 'ROUND_CLOSED');
    if (s.stage === 'challenge' && Date.parse(e.occurredAt) >= Date.parse(s.challengeDeadlineAt) && !p.exit)
      throw Error('EXIT_REQUIRED');
    if (p.exit) {
      const pos = s.positions[[p.venue, p.pool, p.asset].map(encodeURIComponent).join('/')];
      requireThat(
        pos && dec(pos.qty).times(p.qty).lt(0) && dec(p.qty).abs().lte(dec(pos.qty).abs()),
        'INVALID_EXIT_QUANTITY'
      );
    }
    e = { ...e, payload: { ...p, ...postFill(s, p) } };
  } else if (e.type === 'mark') {
    for (const pos of Object.values(s.positions)) {
      const marks = p.venuePrices?.[pos.venue] ?? p.prices;
      if (marks && Object.hasOwn(marks, pos.asset)) pos.mark = out(positive(marks[pos.asset]));
    }
  } else if (e.type === 'funding') {
    requireThat(['hl', 'pf'].includes(p.venue) && p.currency === s.currency, 'FUNDING_SCOPE');
    const delta = dec(p.amount);
    s[p.venue] = out(dec(s[p.venue]).plus(delta));
    s.funding[p.venue] = out(dec(s.funding[p.venue]).plus(delta));
  } else if (e.type === 'snapshot_edit') {
    requireThat(active(s), 'ROUND_CLOSED');
    for (const venue of ['pf', 'hl'])
      if (p[venue] != null) s[venue] = out(dec(s[venue]).plus(dec(p[venue]).minus(markEquity(s, venue))));
    if (p.external != null) s.external = out(nonnegative(p.external));
  } else if (e.type === 'rebuy') {
    requireThat(
      !Object.keys(s.positions).length &&
        ['CHALLENGE_FAILED', 'FUNDED_FAILED', 'CHALLENGE_TIMEOUT_EXIT'].includes(s.status) &&
        (s.status !== 'CHALLENGE_TIMEOUT_EXIT' || s.exitStatus === 'settled'),
      'SETTLEMENT_REQUIRED'
    );
    validId(p.attemptId);
    requireThat(!s.events.some((x) => x.attemptId === p.attemptId), 'DUPLICATE_ATTEMPT');
    const cost = nonnegative(p.purchaseFee);
    requireThat(dec(s.hl).gte(cost), 'INSUFFICIENT_PURCHASE_CASH');
    s.hl = out(dec(s.hl).minus(cost));
    s.fees.registration = out(dec(s.fees.registration).plus(cost));
    s.pf = '10000';
    delete s.evaluationPassEquity;
    s.attemptId = p.attemptId;
    s.challengeStartedAt = iso(e.occurredAt);
    s.challengeDeadlineAt = iso(p.deadline);
    requireThat(Date.parse(p.deadline) > Date.parse(e.occurredAt), 'INVALID_DEADLINE');
    s.exitStatus = null;
    delete s.exitCash;
    s.stage = 'challenge';
    s.status = 'CHALLENGE_ACTIVE';
    beginRound(s, e.id);
  } else if (e.type === 'distribution') {
    const key = validId(p.payoutId);
    if (Object.hasOwn(s.payouts, key)) return book;
    requireThat(s.status === 'FUNDED_ACTIVE' && !Object.keys(s.positions).length, 'SETTLEMENT_REQUIRED');
    const split = profitSplit(s.pf, s.baseline, s.share, s.withdrawal);
    requireThat(dec(split.net).gt(0), 'NO_ELIGIBLE_PROFIT');
    s.pf = s.withdrawal?.reset ?? s.baseline;
    s.payouts[key] = { ...split, destination: null };
    s.status = 'PAYOUT_PENDING';
    s.pendingPayout = key;
  } else if (e.type === 'receipt') {
    const pay = s.payouts[validId(p.payoutId)];
    requireThat(pay && ['hl', 'external'].includes(p.destination), 'UNKNOWN_PAYOUT');
    if (pay.destination) {
      requireThat(pay.destination === p.destination, 'RECEIPT_CONFLICT');
      return book;
    }
    s[p.destination] = out(dec(s[p.destination]).plus(pay.user));
    s.paid = out(dec(s.paid).plus(pay.user));
    pay.destination = p.destination;
  } else if (e.type === 'transfer_out') {
    const key = validId(p.transferId);
    if (Object.hasOwn(s.transfers, key)) return book;
    requireThat(
      ['hl', 'external'].includes(p.from) && ['hl', 'external'].includes(p.to) && p.from !== p.to,
      'TRANSFER_SCOPE'
    );
    const value = positive(p.amount),
      fee = nonnegative(p.fee ?? '0');
    requireThat(dec(s[p.from]).gte(value.plus(fee)), 'TRANSFER_FUNDS');
    if (p.payoutId) {
      const pay = s.payouts[validId(p.payoutId)];
      requireThat(
        pay?.destination === p.from && !pay.transferId && value.eq(pay.user),
        'PAYOUT_TRANSFER_MISMATCH'
      );
      pay.transferId = key;
    }
    s[p.from] = out(dec(s[p.from]).minus(value).minus(fee));
    s.transfers[key] = { amount: out(value), from: p.from, to: p.to, status: 'in_transit', fee: out(fee) };
  } else if (e.type === 'transfer_in') {
    const t = s.transfers[validId(p.transferId)];
    requireThat(t, 'UNKNOWN_TRANSFER');
    if (t.status === 'received') return book;
    s[t.to] = out(dec(s[t.to]).plus(t.amount));
    t.status = 'received';
  } else if (e.type === 'round_start') {
    const pay = s.payouts[s.pendingPayout],
      t = s.transfers[pay?.transferId];
    requireThat(
      s.status === 'PAYOUT_PENDING' &&
        (pay?.destination === 'hl' || (t?.to === 'hl' && t.status === 'received')),
      'PAYOUT_NOT_IN_HYPE'
    );
    s.status = 'FUNDED_ACTIVE';
    delete s.pendingPayout;
    beginRound(s, e.id);
  } else if (['contribution', 'withdrawal'].includes(e.type)) {
    const value = positive(p.amount),
      dep = e.type === 'contribution';
    requireThat(['hl', 'external'].includes(p.location), 'LOCATION');
    if (!dep) requireThat(dec(s[p.location]).gte(value), 'INSUFFICIENT_FUNDS');
    s[p.location] = out(dec(s[p.location]).plus(dep ? value : value.neg()));
    const tally = dep ? 'contributions' : 'withdrawals',
      round = dep ? 'roundIn' : 'roundOut';
    s[tally] = out(dec(s[tally]).plus(value));
    s[round] = out(dec(s[round]).plus(value));
  } else if (e.type === 'challenge_pass_seen') {
    requireThat(
      s.status === 'CHALLENGE_ACTIVE' &&
        dec(p.equity).plus('1e-30').gte(s.challengeTarget) &&
        Date.parse(e.occurredAt) <= Date.parse(s.challengeDeadlineAt),
      'PASS_NOT_VERIFIED'
    );
    s.evaluationPassEquity = out(dec(p.equity));
    s.status = 'CHALLENGE_PASS_PENDING_SETTLEMENT';
  } else if (e.type === 'challenge_reset') {
    requireThat(
      s.status === 'CHALLENGE_PASS_PENDING_SETTLEMENT' && !Object.keys(s.positions).length,
      'SETTLEMENT_REQUIRED'
    );
    s.stage = 'funded';
    s.pf = '10000';
    s.status = 'FUNDED_ACTIVE';
    beginRound(s, e.id);
  } else if (e.type === 'failure') {
    requireThat(
      active(s) &&
        dec(p.equity)
          .minus('1e-30')
          .lte(s.stage === 'challenge' ? s.challengeFloor : s.fundedFloor),
      'FAILURE_NOT_VERIFIED'
    );
    s.status = s.stage === 'challenge' ? 'CHALLENGE_FAILED' : 'FUNDED_FAILED';
  } else if (e.type === 'liquidation') {
    s.status = 'HYPE_LIQUIDATION';
    s.interrupt = 'hype';
  } else if (e.type === 'deadline') {
    requireThat(
      s.status === 'CHALLENGE_ACTIVE' && Date.parse(e.occurredAt) >= Date.parse(s.challengeDeadlineAt),
      'DEADLINE_NOT_REACHED'
    );
    s.status = 'CHALLENGE_TIMEOUT_EXIT';
    s.exitStatus = live ? 'required' : 'pending_quote';
  } else if (e.type === 'exit_confirmation') {
    requireThat(s.status === 'CHALLENGE_TIMEOUT_EXIT', 'EXIT_STATE');
    s.exitStatus = 'pending_confirmation';
  } else if (e.type === 'exit_settled') {
    requireThat(s.status === 'CHALLENGE_TIMEOUT_EXIT' && !Object.keys(s.positions).length, 'OPEN_POSITIONS');
    s.exitStatus = 'settled';
    s.exitCash = balances(s).total;
  } else throw Error('UNKNOWN_EVENT');
  record(s, e);
  return s;
}
export function advanceClock(book, now, quotes = {}, mode = book.mode, maxAgeMs = 5000) {
  iso(now);
  requireThat(mode === book.mode, 'MODE_MISMATCH');
  if (
    book.stage !== 'challenge' ||
    Date.parse(now) < Date.parse(book.challengeDeadlineAt) ||
    !['CHALLENGE_ACTIVE', 'CHALLENGE_TIMEOUT_EXIT'].includes(book.status) ||
    book.exitStatus === 'settled'
  )
    return book;
  // A read-only deadline is an instruction to the operator, never an observed fill.
  const live = mode === 'live_readonly';
  const ev = (suffix, type, payload = {}) => ({
    id: book.attemptId + '/timeout/' + suffix,
    type,
    payload,
    occurredAt: now,
    receivedAt: now,
    source: live ? 'manual' : mode,
    confirmed: live
  });
  let s = book.status === 'CHALLENGE_ACTIVE' ? applyLedgerEvent(book, ev('due', 'deadline')) : book;
  if (live) return s;
  const positions = Object.values(s.positions);
  const getQuote = (p) => quotes[p.venue + '/' + p.asset] ?? quotes[p.asset];
  if (
    positions.some((p) => {
      const q = getQuote(p);
      const age = Date.parse(now) - Date.parse(q?.asOf);
      return (
        !q ||
        !Number.isFinite(age) ||
        age < 0 ||
        age > maxAgeMs ||
        !q.bid ||
        !q.ask ||
        dec(q.bid).lte(0) ||
        dec(q.bid).gt(q.ask)
      );
    })
  )
    return s;
  let exits;
  try {
    exits = positions.map((p) => {
      const q = getQuote(p);
      const dir = out(dec(p.qty).neg());
      return {
        p: { ...p, rate: q.rate ?? p.rate },
        price: q.bids || q.asks ? estimateFill(dir, q)?.price : dec(p.qty).gt(0) ? q.bid : q.ask
      };
    });
  } catch {
    return s;
  }
  for (const { p, price } of exits) {
    s = applyLedgerEvent(
      s,
      ev('close/' + p.venue + '/' + p.pool + '/' + p.asset, 'fill', {
        ...p,
        qty: out(dec(p.qty).neg()),
        price,
        exit: true
      })
    );
  }
  return applyLedgerEvent(s, ev('settled', 'exit_settled'));
}
export function restoreBook(raw) {
  const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
  requireThat(
    s?.version === BOOK_VERSION &&
      Array.isArray(s.events) &&
      s.events.length === s.revision &&
      s.events.length > 0,
    'INVALID_BOOK'
  );
  for (const k of ['pf', 'hl', 'external', 'B', 'ref', 'paid', 'roundIn', 'roundOut']) dec(s[k]);
  iso(s.challengeStartedAt);
  iso(s.challengeDeadlineAt);
  requireThat(
    s.seen &&
      s.events.every((e) => Object.hasOwn(s.seen, e.id) && iso(e.occurredAt)) &&
      new Set(s.events.map((e) => e.id)).size === s.events.length &&
      s.events.some((e) => e.id === s.refEvent),
    'INVALID_AUDIT'
  );
  balances(s);
  return structuredClone(s);
}
