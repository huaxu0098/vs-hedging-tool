// Only the standard venues and settlement conventions whose specifications we can identify.
export const vestTerms = 'https://docs.vest.exchange/overview/traders/perpetual-contract-specifications';
export const vestApiDocs = 'https://docs.vest.exchange/vest-api';
export const vestExchangeInfoUrl = 'https://api-gateway.hz.vestmarkets.com/v3/exchangeInfo';
export const hypeTerms = 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications';
const nativeCrypto = new Set(['BTC', 'ETH', 'SOL']);
const field = (raw, key, documented) => (Object.hasOwn(raw, key) ? raw[key] : documented);

const REQUIRED_VEST_API_FIELDS = [
  'symbol',
  'base',
  'quote',
  'sizeDecimals',
  'priceDecimals',
  'initMarginRatio',
  'maintMarginRatio',
  'takerFee'
];

export function vestContract(raw = {}, exchangeMeta = null) {
  const base = raw.baseAsset || raw.base || null;
  const quote = raw.quoteAsset || raw.quote || null;
  const collateralDecimals = exchangeMeta?.collateralDecimals ?? raw.collateralDecimals ?? null;
  const collateralDecimalsOk = collateralDecimals == null || Number(collateralDecimals) === 6;
  const documented =
    raw.asset === 'crypto' &&
    nativeCrypto.has(base) &&
    raw.symbol === base + '-PERP' &&
    !raw.isInverse &&
    raw.isolated !== true &&
    collateralDecimalsOk &&
    (!raw.productType || raw.productType === 'perpetual') &&
    (!raw.payoffType || raw.payoffType === 'linear');

  // Quote currency and settlement/collateral currency are verified independently — NEVER copy quote into settlement!
  const explicitSettleField = Object.hasOwn(raw, 'settleAsset')
    ? 'settleAsset'
    : Object.hasOwn(raw, 'settlementCurrency')
      ? 'settlementCurrency'
      : Object.hasOwn(raw, 'collateralCurrency')
        ? 'collateralCurrency'
        : null;
  const settle = explicitSettleField ? raw[explicitSettleField] : documented ? 'USDC' : null;

  const missingApiFields = REQUIRED_VEST_API_FIELDS.filter((k) => {
    if (k === 'base') return !base;
    if (k === 'quote') return !quote;
    return raw[k] == null || raw[k] === '';
  });

  const evidence = {
    baseAsset: base ? (raw.baseAsset ? 'exchangeInfo.baseAsset' : 'exchangeInfo.base') : null,
    quoteAsset: quote ? (raw.quoteAsset ? 'exchangeInfo.quoteAsset' : 'exchangeInfo.quote') : null,
    settleAsset: settle
      ? explicitSettleField
        ? 'exchangeInfo.' + explicitSettleField
        : 'Vest 官方永续结算规格 (USDC 保证金线性 1:1 · ' +
          vestTerms +
          (collateralDecimals === 6 ? ' · exchange.collateralDecimals=6' : '') +
          ')'
      : null,
    contractMultiplier:
      raw.contractMultiplier != null
        ? 'exchangeInfo.contractMultiplier'
        : documented
          ? 'Vest 官方线性 1:1 规格'
          : null,
    sizeDecimals: raw.sizeDecimals != null ? 'exchangeInfo.sizeDecimals' : null,
    priceDecimals: raw.priceDecimals != null ? 'exchangeInfo.priceDecimals' : null,
    initMarginRatio: raw.initMarginRatio != null ? 'exchangeInfo.initMarginRatio' : null,
    capitalInitMarginRatio: raw.capitalInitMarginRatio != null ? 'exchangeInfo.capitalInitMarginRatio' : null,
    fundedInitMarginRatio: raw.fundedInitMarginRatio != null ? 'exchangeInfo.fundedInitMarginRatio' : null,
    maintMarginRatio: raw.maintMarginRatio != null ? 'exchangeInfo.maintMarginRatio' : null,
    takerFee: raw.takerFee != null ? 'exchangeInfo.takerFee' : null
  };
  const specVersion =
    raw.specVersion ??
    (raw.listedAt ? 'vest-v3-' + raw.listedAt : 'vest-v3') +
      (collateralDecimals != null ? '-cd' + collateralDecimals : '');
  const obtainedAt = raw.obtainedAt ?? exchangeMeta?.obtainedAt ?? null;

  return {
    evidence,
    missingApiFields,
    specSource: vestExchangeInfoUrl,
    docSources: [vestTerms, vestApiDocs],
    specVersion,
    obtainedAt,
    metadataConflict: !!(
      (raw.baseAsset && raw.base && raw.baseAsset !== raw.base) ||
      (raw.quoteAsset && raw.quote && raw.quoteAsset !== raw.quote) ||
      (collateralDecimals != null && Number(collateralDecimals) !== 6 && settle === 'USDC')
    ),
    productType: field(raw, 'productType', 'perpetual'),
    payoffType: field(raw, 'payoffType', raw.isInverse ? 'inverse' : 'linear'),
    symbol: raw.symbol,
    baseAsset: base,
    quoteAsset: quote,
    quoteCurrency: quote,
    settleAsset: settle,
    settlementCurrency: settle,
    collateralCurrency: settle,
    collateralDecimals: collateralDecimals != null ? Number(collateralDecimals) : null,
    sizeDecimals: raw.sizeDecimals ?? null,
    priceDecimals: raw.priceDecimals ?? null,
    initMarginRatio: raw.initMarginRatio ?? null,
    capitalInitMarginRatio: raw.capitalInitMarginRatio ?? null,
    fundedInitMarginRatio: raw.fundedInitMarginRatio ?? null,
    maintMarginRatio: raw.maintMarginRatio ?? null,
    takerFee: raw.takerFee ?? null,
    makerFee: raw.makerFee ?? null,
    isolated: raw.isolated ?? false,
    contractMultiplier: field(raw, 'contractMultiplier', documented ? '1' : null),
    quantityUnit: field(raw, 'quantityUnit', documented ? base : null),
    settlement: field(
      raw,
      'settlement',
      Boolean(quote && settle && quote === settle && (documented || raw.payoffType === 'linear')) ? 'linear' : null
    ),
    source: 'Vest v3 exchangeInfo (' + specVersion + ') · 结算与合约单位见 ' + vestTerms + ' & ' + vestApiDocs
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
