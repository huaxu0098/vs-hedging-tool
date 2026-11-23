import { venueFields } from './venue-scenarios.js';
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

// Spot observations required by cash, settlement or a non-quanto price path.
// A USD-denominated conversion uses the USDC/USD book as its denominator.
export function requiredSpotAssets(pf, hl, rules) {
  const assets = new Set();
  const convert = (from, to) => {
    if (!from || !to || from === to) return;
    for (const asset of [from, to]) if (asset !== 'USD') assets.add(asset);
  };
  for (const c of [pf, hl]) {
    convert(c?.settleAsset, 'USDC');
    if (c?.settlement === 'linear') convert(c.quoteAsset, 'USDC');
  }
  const priceStress = Number(rules.adverseBps)>0 || venueFields.some(key => Number(rules[key]) > 0);
  if (hl?.settlement === 'linear' || priceStress) convert(pf?.quoteAsset, hl?.quoteAsset);
  return assets;
}

function verifiedLeg(side, c, data, rates, now, ttl) {
  const venue = side === 'pf' ? 'VS' : 'Hype';
  if (c?.metadataConflict) throw Error('CONTRACT_METADATA_UNVERIFIED · ' + venue + ' 官方规格字段相互冲突');
  if (!c || !known.has(c.quoteAsset) || !known.has(c.settleAsset)) {
    const missing = [];
    if (!c) {
      if (side === 'pf' && data?.errors?.spec) missing.push(data.errors.spec);
      else if (side === 'pf' && data?.specStatus === 'loading') missing.push('正在读取 Vest exchangeInfo 合约规格');
      else missing.push('缺少合约规格响应');
    } else {
      if (!known.has(c.quoteAsset)) missing.push('quote(报价币)');
      if (!known.has(c.settleAsset)) missing.push('settlement(结算/保证金币)');
      if (Array.isArray(c.missingApiFields)) {
        for (const f of c.missingApiFields) if (!missing.includes(f)) missing.push(f);
      }
    }
    throw Error(
      'QUOTE_CURRENCY_UNVERIFIED · ' +
        venue +
        ' 报价币或结算币未核实' +
        (missing.length ? '（缺失或异常：' + missing.join('、') + '）' : '')
    );
  }
  if (
    (c.productType && c.productType !== 'perpetual') ||
    (c.payoffType && c.payoffType !== 'linear') ||
    !c.baseAsset ||
    c.baseAsset !== data.asset ||
    c.symbol !== data[side]?.symbol ||
    ![c.baseAsset, 'contract'].includes(c.quantityUnit) ||
    !c.contractMultiplier ||
    !dec(String(c.contractMultiplier)).gt(0) ||
    !['linear', 'quanto-1:1'].includes(c.settlement) ||
    !c.source
  )
    throw Error('CONTRACT_UNVERIFIED · ' + venue + ' 标的、数量单位、乘数或每点结算规则未核实');
  if (
    side === 'hl' &&
    c.standardCryptoPerp &&
    (c.quoteAsset !== 'USDT' || c.settleAsset !== 'USDC' || c.settlement !== 'quanto-1:1')
  )
    throw Error('CONTRACT_METADATA_UNVERIFIED · 标准永续合约计价或结算规则冲突');
  const settleToLedger = conversionBook(c.settleAsset, 'USDC', rates, now, ttl);
  const pointToLedger =
    c.settlement === 'quanto-1:1' ? settleToLedger : conversionBook(c.quoteAsset, 'USDC', rates, now, ttl);
  return { pointToLedger, settleToLedger, multiplier: String(c.contractMultiplier) };
}
export function currencyMapping(data, rates, now, ttl, alertBps = '50') {
  const pf = data.spec?.contract,
    hl = data.hl?.contract;
  const result = { pf, hl, legs: {}, ledger: 'USDC', spots: {}, warnings: [], alertBps, ok: false };
  try {
    const threshold = nonnegative(String(alertBps));
    const legErrors = [];
    for (const [side, c] of [
      ['pf', pf],
      ['hl', hl]
    ]) {
      try {
        result.legs[side] = verifiedLeg(side, c, data, rates, now, ttl);
      } catch (error) {
        legErrors.push(error);
      }
    }
    if (legErrors.length) throw legErrors[0];
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
    // This observation is independent of settlement and executable prices.
    try {
      result.hypeToVest = rate(hl.quoteAsset, pf.quoteAsset);
    } catch (error) {
      result.referenceError = error.message;
    }
    // The BTC stress path moves both native prices by the same number of points.
    // The contract pays its native point PnL in USDC. The optional spot observation cannot rescale this path or its cash flows.
    result.nativeMovePerVestPoint =
      hl.settlement === 'quanto-1:1' ? '1' : rate(pf.quoteAsset, hl.quoteAsset).mid;
    result.ok = true;
  } catch (e) {
    result.error =
      /^(QUOTE_CURRENCY_UNVERIFIED|CONTRACT_UNVERIFIED|CONTRACT_METADATA_UNVERIFIED|FX_STALE|FX_UNVERIFIED)/.test(
        e.message
      )
        ? e.message
        : 'FX_UNVERIFIED · 币种路径、汇率或合约数值无效';
  }
  return result;
}
