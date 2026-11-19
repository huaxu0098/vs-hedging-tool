// Only the standard venues and settlement conventions whose specifications we can identify.
export const vestTerms = 'https://docs.vestmarkets.com/platform/perpetual-contract-specifications';
export const hypeTerms = 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications';
const nativeCrypto = new Set(['BTC', 'ETH', 'SOL']);
const field = (raw, key, documented) => (Object.hasOwn(raw, key) ? raw[key] : documented);

export function vestContract(raw) {
  const documented =
    raw.asset === 'crypto' && nativeCrypto.has(raw.base) && raw.symbol === raw.base + '-PERP';
  const quote = field(raw, 'quoteAsset', raw.quote);
  const settle = field(raw, 'settleAsset', documented ? 'USDC' : null);
  return {
    productType: field(raw, 'productType', 'perpetual'),
    payoffType: field(raw, 'payoffType', raw.isInverse ? 'inverse' : 'linear'),
    symbol: raw.symbol,
    baseAsset: field(raw, 'baseAsset', raw.base),
    quoteAsset: quote,
    settleAsset: settle,
    contractMultiplier: field(raw, 'contractMultiplier', documented ? '1' : null),
    quantityUnit: field(raw, 'quantityUnit', documented ? raw.base : null),
    settlement: field(
      raw,
      'settlement',
      quote && quote === settle && (documented || raw.payoffType === 'linear') ? 'linear' : null
    ),
    source: 'Vest v3 exchangeInfo · 结算与合约单位见 ' + vestTerms
  };
}

export function hypeContract(raw, dex, collateralToken) {
  // collateralToken identifies the margin currency, not the market's quote currency.
  const documented = dex === '' && collateralToken === 0 && nativeCrypto.has(raw.name);
  const quote = field(raw, 'quoteAsset', field(raw, 'quote', documented ? 'USDT' : null));
  return {
    standardCryptoPerp: documented,
    productType: field(raw, 'productType', 'perpetual'),
    payoffType: field(raw, 'payoffType', raw.isInverse ? 'inverse' : 'linear'),
    symbol: raw.name,
    baseAsset: field(raw, 'baseAsset', field(raw, 'base', documented ? raw.name : null)),
    quoteAsset: quote,
    settleAsset: field(raw, 'settleAsset', field(raw, 'settlementAsset', documented ? 'USDC' : null)),
    contractMultiplier: field(raw, 'contractMultiplier', documented ? '1' : null),
    quantityUnit: field(raw, 'quantityUnit', documented ? raw.name : null),
    settlement: field(
      raw,
      'settlement',
      documented && quote === 'USDT' ? 'quanto-1:1' : documented && quote === 'USDC' ? 'linear' : null
    ),
    source:
      'Hyperliquid metaAndAssetCtxs · ' +
      (Object.hasOwn(raw, 'quoteAsset') || Object.hasOwn(raw, 'quote')
        ? '报价币来自元数据'
        : '计价与每点结算来自官方规格') +
      ' · ' +
      hypeTerms
  };
}
