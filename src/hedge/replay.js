import { D, dec, positive, nonnegative, out } from './math.js';
import { createBook, applyLedgerEvent, advanceClock, iso, balances, markEquity } from './book.js';
import {
  demoMarket,
  projectSettlementEquity,
  solveBoundaryPrices,
  liquidationMark,
  validateMargin
} from './solver.js';

export function atPrice(m, shift, hlExtra = '0') {
  const result = structuredClone(m);
  for (const v of ['pf', 'hl']) {
    const l = result[v],
      move = dec(shift)
        .times(l.factor)
        .plus(v === 'hl' ? hlExtra : '0');
    const px = (p) => out(positive(out(dec(p).plus(move))));
    l.mark = px(l.mark);
    for (const side of ['bids', 'asks']) l[side] = l[side].map(([price, size]) => [px(price), size]);
  }
  return result;
}
const ev = (s, at, id, type, payload = {}) => ({
  id: s.attemptId + '/' + id,
  type,
  payload,
  occurredAt: at,
  receivedAt: at,
  source: s.mode
});
const targetQty = (s, m, v) =>
  Object.values(s.positions).find((p) => p.asset === m.id && p.venue === v && p.pool === m[v].pool)?.qty ??
  '0';
import { estimateFill } from './math.js';
export function applyTargets(s, m, targets, at, id) {
  if (!['demo', 'replay', 'manual'].includes(s.mode)) throw Error('READ_ONLY');
  for (const v of ['pf', 'hl']) {
    const l = m[v],
      delta = dec(targets[v]).minus(targetQty(s, m, v));
    if (delta.isZero()) continue;
    const f = estimateFill(out(delta), l);
    s = applyLedgerEvent(
      s,
      ev(s, at, id + '/' + v, 'fill', {
        asset: m.id,
        venue: v,
        pool: l.pool,
        currency: s.currency,
        qty: out(delta),
        price: f.price,
        rate: l.rate,
        multiplier: l.multiplier,
        fx: l.fx
      })
    );
  }
  return s;
}
export function settlePositions(s, markets, at, id) {
  if (s.mode === 'live_readonly') throw Error('READ_ONLY');
  for (const p of Object.values(s.positions)) {
    const l = markets[p.asset]?.[p.venue];
    if (!l) throw Error('缺少其他持仓的退出报价');
    const delta = out(dec(p.qty).neg()),
      f = estimateFill(delta, l);
    s = applyLedgerEvent(
      s,
      ev(s, at, id + '/' + p.venue + '/' + p.pool + '/' + p.asset, 'fill', {
        ...p,
        qty: delta,
        price: f.price,
        rate: l.rate,
        exit: true
      })
    );
  }
  return s;
}
export function settleBoundary(s, m, name, at, id, catalog = {}) {
  if (s.mode === 'live_readonly') return { state: s, event: 'CONFIRMATION_REQUIRED' };
  const q = targetQty(s, m, 'pf');
  const equity = out(
    projectSettlementEquity(s, m, 'pf', q, '0', name === 'failure' ? s.failureTrigger : s.passTrigger, {
      ...catalog,
      [m.id]: m
    })
  );
  if (name === 'liquidation') {
    s = applyLedgerEvent(
      s,
      ev(s, at, id + '/mark', 'mark', {
        venuePrices: { pf: { [m.id]: m.pf.mark }, hl: { [m.id]: m.hl.mark } }
      })
    );
    s = applyLedgerEvent(s, ev(s, at, id, 'liquidation'));
    return { event: 'HYPE_LIQUIDATION', state: s, cash: null, remaining: Object.values(s.positions) };
  }
  const challenge = s.stage === 'challenge';
  if (name === 'pass' && challenge)
    s = applyLedgerEvent(s, ev(s, at, id + '/seen', 'challenge_pass_seen', { equity }));
  s = settlePositions(s, { ...catalog, [m.id]: m }, at, id + '/close');
  if (name === 'failure') s = applyLedgerEvent(s, ev(s, at, id, 'failure', { equity }));
  else if (challenge) s = applyLedgerEvent(s, ev(s, at, id, 'challenge_reset'));
  else s = applyLedgerEvent(s, ev(s, at, id, 'distribution', { payoutId: id }));
  return { event: s.status, state: s, cash: balances(s).total };
}
export function parseReplayCSV(text, asset) {
  const lines = text
    .trim()
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  const cols = lines.shift().trim().split(',');
  if (!['time', 'asset', 'open', 'high', 'low', 'close'].every((k) => cols.includes(k)))
    throw Error('CSV 表头无效');
  let last = -Infinity;
  const bars = [];
  for (const line of lines) {
    const cells = line.split(','),
      r = Object.fromEntries(cols.map((k, i) => [k, cells[i]?.trim()]));
    if (r.asset !== asset) continue;
    const t = Date.parse(iso(r.time));
    if (
      t <= last ||
      positive(r.low).gt(D.min(positive(r.close), positive(r.open))) ||
      positive(r.high).lt(D.max(r.close, r.open))
    )
      throw Error('CSV 时间或 OHLC 区间无效');
    last = t;
    bars.push({ ...r, time: iso(r.time) });
  }
  if (!bars.length) throw Error('没有当前标的的 K 线');
  return bars;
}
export function advanceReplay(s, m, bar, opts = {}) {
  if (!['demo', 'replay', 'manual'].includes(s.mode)) throw Error('READ_ONLY');
  if (
    !['CHALLENGE_ACTIVE', 'FUNDED_ACTIVE', 'CHALLENGE_TIMEOUT_EXIT'].includes(s.status) ||
    s.exitStatus === 'settled'
  )
    return { state: s, market: m, event: s.status, stop: true };
  const at = iso(bar.time),
    due = s.stage === 'challenge' && Date.parse(at) >= Date.parse(s.challengeDeadlineAt);
  const tag = 'bar/' + at;
  if (due && (Date.parse(at) > Date.parse(s.challengeDeadlineAt) || bar.stale)) {
    const next = advanceClock(s, s.challengeDeadlineAt, {}, s.mode);
    return { state: next, market: m, event: 'PENDING_EXIT_QUOTE', cash: null, stop: true };
  }
  if (bar.stale) return { state: s, market: m, event: 'STALE_QUOTE', cash: null, stop: true };
  const q = targetQty(s, m, 'pf'),
    shift = (price) => out(positive(price).minus(m.pf.mark).div(m.pf.factor));
  const axes = dec(q).eq(0)
    ? {}
    : solveBoundaryPrices(
        s,
        m,
        q,
        s.stage === 'challenge' ? s.challengeTarget : (opts.target ?? '10100'),
        s.stage === 'challenge' ? s.challengeFloor : s.fundedFloor,
        s.passTrigger,
        s.failureTrigger,
        opts.catalog
      );
  const thresholds = Object.entries(axes).map(([name, x]) => ({
    name: name === 'fail' ? 'failure' : name,
    px: dec(m.pf.mark).plus(dec(x).times(m.pf.factor))
  }));
  const h = targetQty(s, m, 'hl');
  if (!dec(h).isZero()) {
    const verified =
      opts.liq != null ||
      validateMargin(s, m, 'hl', h, ['0'], opts.catalog).every((c) => c.status !== 'unknown');
    if (!verified) return { state: s, market: m, event: 'MARGIN_UNVERIFIED', cash: null, stop: true };
    const liq = opts.liq ?? liquidationMark(s, m, h, opts.catalog);
    if (liq != null)
      thresholds.push({
        name: 'liquidation',
        px: dec(m.pf.mark).plus(positive(liq).minus(m.hl.mark).div(m.hl.factor).times(m.pf.factor))
      });
  }
  function settle(name, price) {
    const market = atPrice(m, shift(price));
    return { ...settleBoundary(s, market, name, at, tag + '/' + name, opts.catalog), market, stop: true };
  }
  const open = positive(bar.open),
    high = positive(bar.high),
    low = positive(bar.low),
    close = positive(bar.close);
  if (low.gt(D.min(open, close)) || high.lt(D.max(open, close))) throw Error('INVALID_OHLC');
  const current = dec(m.pf.mark);
  const between = (points, a, b) => points.filter((p) => p.px.gte(D.min(a, b)) && p.px.lte(D.max(a, b)));
  const gap = between(thresholds, current, open);
  let hits = gap.map((p) => ({ name: p.name, price: out(open) }));
  if (!hits.length)
    for (const first of [high, low]) {
      let prev = open;
      for (const next of [first, first === high ? low : high, close]) {
        const crossed = between(thresholds, prev, next).sort((a, b) =>
          a.px.minus(prev).abs().cmp(b.px.minus(prev).abs())
        );
        if (crossed.length) {
          for (const p of crossed.filter((p) => p.px.eq(crossed[0].px)))
            hits.push({ name: p.name, price: out(p.px) });
          break;
        }
        prev = next;
      }
    }
  hits = Array.from(new Map(hits.map((p) => [p.name, p])).values());
  if (hits.length) {
    const alternatives = hits.map((p) => settle(p.name, p.price));
    if (due && hits.some((h) => dec(h.price).eq(close)))
      alternatives.push({ event: 'DEADLINE_AT_BOUNDARY', cash: null });
    if (alternatives.length === 1) return alternatives[0];
    return {
      state: s,
      market: m,
      stop: true,
      event: 'AMBIGUOUS_EVENT_ORDER',
      alternatives,
      worst: alternatives.some((r) => r.cash == null) ? null : out(D.min(...alternatives.map((r) => r.cash)))
    };
  }
  const market = atPrice(m, shift(bar.close));
  let state = applyLedgerEvent(
    s,
    ev(s, at, tag + '/mark', 'mark', {
      venuePrices: { pf: { [m.id]: market.pf.mark }, hl: { [m.id]: market.hl.mark } }
    })
  );
  if (bar.funding)
    state = applyLedgerEvent(
      state,
      ev(s, at, tag + '/funding', 'funding', { amount: bar.funding, venue: 'hl', currency: s.currency })
    );
  if (due) {
    const quotes = {};
    for (const v of ['pf', 'hl']) {
      const l = market[v];
      quotes[v + '/' + m.id] = { asOf: at, bid: l.bids[0][0], ask: l.asks[0][0], bids: l.bids, asks: l.asks };
    }
    state = advanceClock(state, at, quotes, state.mode);
    return {
      state,
      market,
      event: state.exitStatus === 'settled' ? 'TIMED_OUT_CLOSED' : 'PENDING_EXIT_QUOTE',
      cash: state.exitCash ?? null,
      stop: true
    };
  }
  return { state, market, event: 'MARK', cash: balances(state).total, stop: false };
}
export const scenarioNames = {
  failure: '考核失败',
  pass: '考核通过',
  payout: 'Funded 分配及到账',
  fundedFail: 'Funded 失败',
  timeout: '两日平价到期',
  recovery: '回撤后恢复',
  liquidation: 'Hype 先清算',
  gap: '跳价',
  stale: '单边行情过期',
  ambiguous: '同柱歧义'
};
export function replayFixture(kind, id = 'unit', market = null, time = '2026-01-01T00:00:00.000Z') {
  if (!Object.hasOwn(scenarioNames, kind)) throw Error('UNKNOWN_FIXTURE');
  const m = market ?? demoMarket(id),
    funded = ['payout', 'fundedFail', 'recovery'].includes(kind);
  let s = createBook({ id: 'replay-' + kind, mode: 'replay', stage: funded ? 'funded' : 'challenge', time });
  const lots = (n, l) =>
    out(dec(n).div(dec(l.mark).times(l.multiplier).times(l.fx)).div(l.step).trunc().times(l.step));
  const q = lots('10000', m.pf),
    h = lots(['pass', 'ambiguous'].includes(kind) ? '-1500' : '-2000', m.hl);
  s = applyTargets(s, m, { pf: q, hl: h }, time, 'entry');
  const patterns = {
    failure: ['0.935'],
    pass: ['1.21'],
    payout: ['1.012'],
    fundedFail: ['0.79'],
    timeout: ['1', '1'],
    recovery: ['0.90', '0.98'],
    liquidation: ['1.08'],
    gap: ['0.90'],
    stale: ['1'],
    ambiguous: ['1']
  };
  let prev = m.pf.mark;
  const bars = patterns[kind].map((k, i) => {
    const close = out(dec(m.pf.mark).times(k)),
      open = kind === 'gap' ? close : prev;
    prev = close;
    return {
      time: new Date(Date.parse(time) + (i + 1) * (kind === 'timeout' ? 86400000 : 60000)).toISOString(),
      asset: id,
      open,
      close,
      high: kind === 'ambiguous' ? out(dec(m.pf.mark).times('1.25')) : out(D.max(open, close)),
      low: kind === 'ambiguous' ? out(dec(m.pf.mark).times('0.92')) : out(D.min(open, close)),
      stale: kind === 'stale'
    };
  });
  return {
    initial: s,
    market: m,
    bars,
    options: {
      target: '10100',
      ...(kind === 'liquidation' ? { liq: out(dec(m.pf.mark).times('1.04')) } : {})
    },
    kind
  };
}
export function seekReplay(f, index) {
  let result = { state: f.initial, market: f.market, event: 'START', stop: false },
    steps = [];
  for (const bar of f.bars.slice(0, index)) {
    if (result.stop) break;
    result = advanceReplay(result.state, result.market, bar, f.options);
    steps.push(result);
  }
  if (f.kind === 'payout' && index > f.bars.length && result.state.status === 'PAYOUT_PENDING') {
    const s = result.state;
    const state = applyLedgerEvent(
      s,
      ev(s, f.bars.at(-1).time, 'fixture-receipt', 'receipt', {
        payoutId: s.pendingPayout,
        destination: 'hl'
      })
    );
    result = { ...result, state, cash: balances(state).total, event: 'PAYOUT_RECEIVED' };
    steps.push(result);
  }
  return { ...result, steps };
}
