import { dec, out, positive, nonnegative } from './math.js';

const known = new Set(['USD', 'USDC', 'USDT']);
const identity = { bid: '1', ask: '1', mid: '1' };

function usdBook(asset, rates, now, ttl) {
  if (asset === 'USD') return identity;
  const q = rates[asset],
    age = now - Date.parse(q?.asOf);
  if (!q || q.currency !== asset || q.quote !== 'USD' || !q.source)
    throw Error('FX_UNVERIFIED · 缺少 USD_per_' + asset + ' 有方向的现货盘口');
  if (!Number.isFinite(age) || age < 0 || age > ttl)
    throw Error('FX_STALE · USD_per_' + asset + ' 盘口过期或源时间无效');
  const bid = positive(String(q.bid)),
    ask = positive(String(q.ask));
  if (ask.lt(bid)) throw Error('FX_UNVERIFIED · ' + asset + ' 汇率倒挂');
  return { bid: out(bid), ask: out(ask), mid: out(bid.plus(ask).div(2)), source: q.source, asOf: q.asOf };
}

// Rates are always named and used as units of "to" received per one "from".
export function conversionBook(from, to, rates, now, ttl) {
  if (!known.has(from) || !known.has(to)) throw Error('QUOTE_CURRENCY_UNVERIFIED · 报价或结算币未核实');
  const name = to + '_per_' + from;
  if (from === to) return { name, from, to, ...identity };
  const a = usdBook(from, rates, now, ttl),
    b = usdBook(to, rates, now, ttl);
  return {
    name,
    from,
    to,
    bid: out(dec(a.bid).div(b.ask)),
    ask: out(dec(a.ask).div(b.bid)),
    mid: out(dec(a.mid).div(b.mid))
  };
}

export function currencyMapping(data, rates, now, ttl, alertBps = '50') {
  const pf = data.spec?.contract,
    hl = data.hl?.contract;
  const result = { pf, hl, ledger: 'USDC', spots: {}, warnings: [], alertBps, ok: false };
  try {
    const threshold = nonnegative(String(alertBps));
    for (const [venue, c] of [
      ['VS', pf],
      ['Hype', hl]
    ]) {
      if (!c || !known.has(c.quoteAsset) || !known.has(c.settleAsset))
        throw Error('QUOTE_CURRENCY_UNVERIFIED · ' + venue + ' 报价币或结算币未核实');
      if (
        (c.productType && c.productType !== 'perpetual') ||
        (c.payoffType && c.payoffType !== 'linear') ||
        !c.baseAsset ||
        c.baseAsset !== data.asset ||
        c.symbol !== (venue === 'VS' ? data.pf : data.hl)?.symbol ||
        ![c.baseAsset, 'contract'].includes(c.quantityUnit) ||
        !c.contractMultiplier ||
        !dec(String(c.contractMultiplier)).gt(0) ||
        !['linear', 'quanto-1:1'].includes(c.settlement) ||
        !c.source
      )
        throw Error('CONTRACT_UNVERIFIED · ' + venue + ' 标的、数量单位、乘数或每点结算规则未核实');
    }
    if (hl.standardCryptoPerp && (hl.quoteAsset !== 'USDT' || hl.settleAsset !== 'USDC' || hl.settlement !== 'quanto-1:1'))
      throw Error('CONTRACT_METADATA_UNVERIFIED · 标准永续合约计价或结算规则冲突');
    for (const asset of new Set([pf.quoteAsset, hl.quoteAsset, pf.settleAsset, hl.settleAsset, 'USDC'])) {
      if (asset === 'USD') continue;
      try {
        const book = usdBook(asset, rates, now, ttl);
        const deviationBps = out(dec(book.mid).minus(1).times(10000));
        const alert = !dec(deviationBps).isZero() && dec(deviationBps).abs().gte(threshold);
        result.spots[asset] = { ...book, deviationBps, alert };
        if (alert) result.warnings.push(asset + ' 脱锚 · 美元偏离 ' + deviationBps + ' bp');
      } catch (e) {
        result.spots[asset] = { error: e.message };
      }
    }
    const rate = (from, to) => conversionBook(from, to, rates, now, ttl);
    result.hypeToVest = rate(hl.quoteAsset, pf.quoteAsset);
    // The BTC stress path moves both native prices by the same number of points.
    // The contract pays its native point PnL in USDC. Spot FX prices the reference
    // spread only; it cannot rescale this price path or the resulting cash flows.
    result.nativeMovePerVestPoint = hl.settlement === 'quanto-1:1' ? '1' : rate(pf.quoteAsset, hl.quoteAsset).mid;
    result.legs = {};
    for (const [side, c] of [
      ['pf', pf],
      ['hl', hl]
    ]) {
      const settleToLedger = rate(c.settleAsset, 'USDC');
      // A conventional linear payoff is denominated in quote. A fixed quanto
      // pays one settlement unit per price point without converting the quote.
      const pointToLedger = c.settlement === 'quanto-1:1' ? settleToLedger : rate(c.quoteAsset, 'USDC');
      result.legs[side] = { pointToLedger, settleToLedger, multiplier: String(c.contractMultiplier) };
    }
    result.ok = true;
  } catch (e) {
    result.error = /^(QUOTE_CURRENCY_UNVERIFIED|CONTRACT_UNVERIFIED|CONTRACT_METADATA_UNVERIFIED|FX_STALE|FX_UNVERIFIED)/.test(e.message)
      ? e.message
      : 'FX_UNVERIFIED · 币种路径、汇率或合约数值无效';
  }
  return result;
}

export function comparePriceBooks(pf, hl, map) {
  const q = map.hypeToVest,
    norm = dec(String(hl.mark)).times(q.mid);
  const diff = norm.minus(pf.mark);
  // PF long / Hype short enters at PF ask and Hype bid. The opposite
  // sides close it. Both spreads use the Hype minus Vest sign convention.
  return {
    raw: q.from === q.to ? out(dec(String(hl.mark)).minus(pf.mark)) : null,
    normalized: out(norm),
    diff: out(diff),
    fraction: out(diff.div(pf.mark)),
    sellHypeBuyVest: out(dec(hl.levels[0][0][0]).times(q.bid).minus(pf.levels[1][0][0])),
    buyHypeSellVest: out(dec(hl.levels[1][0][0]).times(q.ask).minus(pf.levels[0][0][0]))
  };
}
