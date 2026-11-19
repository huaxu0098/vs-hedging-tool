// Explicit contract evidence for offline numerical tests only.
export function unitContract(symbol, quoteAsset = 'USDC', settleAsset = quoteAsset) {
  return {
    symbol,
    baseAsset: 'BTC',
    quoteAsset,
    settleAsset,
    contractMultiplier: '1',
    quantityUnit: 'BTC',
    settlement: 'linear',
    source: 'numerical test specification'
  };
}
export function usdQuote(currency, bid, ask, asOf) {
  return { currency, quote: 'USD', bid, ask, asOf, source: 'test order book' };
}
