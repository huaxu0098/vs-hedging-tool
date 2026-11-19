import { dec, out, positive } from './math.js';
import { balances, applyLedgerEvent } from './book.js';
import { demoMarket, solve, projectSettlementEquity, validateMargin } from './solver.js';
import { applyTargets, settleBoundary } from './replay.js';
import { defaultChallenge, fundedParameters } from './stage-preview.js';

export const maxQuoteAge = 5000;

export function startPaper(at) {
  const book = defaultChallenge(at).pass.state;
  return { version: 1, startedAt: at, initialCash: book.hl, book, entry: null, end: null };
}

function step(places) {
  if (!Number.isInteger(places) || places < 0 || places > 12) throw Error('缺少合约数量精度');
  return out(dec('10').pow(-places));
}

export function paperMarket(vs, hl, spec, now) {
  if (vs?.symbol !== 'BTC-PERP' || spec?.symbol !== vs.symbol || spec.base !== 'BTC' ||
      spec.quote !== 'USDC' || hl?.symbol !== 'BTC' || hl?.quote?.symbol !== 'BTC' || hl.dex !== '')
    throw Error('等待两边 BTC 永续合约及计价规格');
  if (!vs.open || spec.capitalTradingStatus !== 'TRADING') throw Error('VS 出金户合约休市');
  const market = demoMarket('btc');
  for (const [key, symbol, mark, stamp, depth, places] of [
    ['pf', vs.symbol, vs.mark, vs.asOf, vs.levels, spec.sizeDecimals],
    ['hl', hl.symbol, hl.mark, hl.quote.occurredAt, hl.quote.levels, hl.sizeDecimals]
  ]) {
    const age = now - Date.parse(stamp);
    if (!Number.isFinite(age) || age > maxQuoteAge || age < -1000) throw Error((key === 'pf' ? 'VS' : 'Hype') + ' 报价过期');
    if (!Array.isArray(depth) || depth.length !== 2 || depth.some((side) => !side.length)) throw Error('缺少双边盘口数量');
    const [bids, asks] = depth.map((side) => side.map(([p, q]) => [out(positive(String(p))), out(positive(String(q)))]));
    if (dec(asks[0][0]).lt(bids[0][0]) ||
        bids.some(([p], i) => i && dec(p).gt(bids[i-1][0])) ||
        asks.some(([p], i) => i && dec(p).lt(asks[i-1][0]))) throw Error('盘口价序异常');
    Object.assign(market[key], { symbol, mark: out(positive(String(mark))), bids, asks,
      step: step(places), minQty: step(places), asOf: stamp });
  }
  const fundedIM = positive(spec.fundedInitMarginRatio);
  market.pf.leverage = out(dec('1').div(fundedIM).clamp(1, 20));
  market.hl.leverage = out(positive(String(hl.maxLeverage)).clamp(1, 20));
  return market;
}

export function samplePaper(session, market, at, afterGap = false) {
  if (session.end) return { session };
  const { book } = session;
  if (!session.entry) {
    const result = solve(book, market, fundedParameters, { now: at });
    const c = result.selected;
    if (!c) return { session, message: result.unresolved.join('、') || '当前盘口没有同时满足回本、现金留存和保证金要求的候选，继续空仓观察。' };
    const targets = { pf: c.vsTargetQuantity, hl: c.hlTargetQuantity };
    const opened = applyTargets(book, market, targets, at, 'live-paper/open');
    const legs = Object.values(opened.positions).map(({venue, qty, entry}) => ({
      venue, qty, entry, notional: out(dec(qty).abs().times(entry))
    }));
    return { session: { ...session, book: opened, entry: { at, legs, targets, market,
      failureCash: c.failureCash, beforePayout: c.cashBeforePayout, afterPayout: c.cashAfterPayout,
      payout: c.expectedUserPayout } } };
  }
  const { pf, hl } = session.entry.targets;
  const pfEquity = projectSettlementEquity(book, market, 'pf', pf);
  const cash = projectSettlementEquity(book, market, 'hl', hl).plus(book.external);
  const valuation = { at, pf: out(pfEquity), cash: out(cash) };
  const events = [];
  if (pfEquity.lte(book.fundedFloor)) events.push('failure');
  if (pfEquity.gte(fundedParameters.target)) events.push('pass');
  const maintenance = validateMargin(book, market, 'hl', hl, ['0']).at(-1);
  if (maintenance.status === 'unknown') throw Error('模拟维持保证金无法核算');
  if (maintenance.status === 'fail') events.push('liquidation');
  if (!events.length) return { session, valuation };
  if (afterGap || events.length > 1) {
    return { session: { ...session, end: { type: 'uncertain', at, events, market } } };
  }
  const result = settleBoundary(book, market, events[0], at, 'live-paper/exit');
  let closed = result.state;
  if (events[0] === 'pass') {
    closed = applyLedgerEvent(closed, {
      type: 'receipt', source: closed.mode, id: 'live-paper/first-receipt', occurredAt: at, receivedAt: at,
      payload: { payoutId: closed.pendingPayout, destination: 'external' }
    });
  }
  return { session: { ...session, book: closed, end: { type: events[0], at, market,
    cash: events[0] === 'liquidation' ? null : balances(closed).total, received: closed.paid } } };
}
