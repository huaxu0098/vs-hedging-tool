// Private simulation specifications. Contract codes and FX rates describe these fixtures only.
const specifications = [
  {
    id: 'btc',
    ticker: 'BTC',
    name: '比特币',
    unit: 'BTC',
    priceUnit: '美元/币',
    price: 100000,
    vs: ['BTC', 1, 0.00001, 0.5, 2],
    hype: ['BTC', 1, 0.00001, 0.1, 1],
    buffer: 1000
  },
  {
    id: 'eth',
    ticker: 'ETH',
    name: '以太坊',
    unit: 'ETH',
    priceUnit: '美元/币',
    price: 2500,
    vs: ['ETH', 1, 0.001, 0.1, 0.4],
    hype: ['ETH', 1, 0.001, 0.01, 0.1],
    buffer: 25
  },
  {
    id: 'sol',
    ticker: 'SOL',
    name: '索拉纳',
    unit: 'SOL',
    priceUnit: '美元/币',
    price: 160,
    vs: ['SOL', 1, 0.01, 0.01, 0.04],
    hype: ['SOL', 1, 0.01, 0.01, 0.02],
    buffer: 1.6
  },
  {
    id: 'xau',
    ticker: 'XAU',
    name: '黄金',
    unit: '盎司',
    priceUnit: '美元/盎司',
    price: 2500,
    vs: ['手', 100, 0.0001, 0.1, 0.4],
    hype: ['盎司', 1, 0.001, 0.01, 0.1],
    buffer: 25
  },
  {
    id: 'us100',
    ticker: 'US100',
    name: '纳指 100',
    unit: '点',
    priceUnit: '点',
    price: 20000,
    vs: ['手', 5, 0.0001, 0.25, 1],
    hype: ['张', 1, 0.0001, 0.1, 0.4],
    buffer: 200
  }
];

function createLeg(spec, venue, benchmark, asOf) {
  const [qtyUnit, multiplier, step, tick, spread] = spec[venue];
  const isVS = venue === 'vs';
  return {
    symbol: isVS ? 'VS-SIM-' + spec.ticker : spec.ticker + '-SIM-HYPE',
    benchmark,
    type: 'linear',
    quote: 'USD',
    settle: isVS ? 'USD' : 'USDC',
    quoteUsd: 1,
    settleUsd: 1,
    quoteScale: 1,
    price: spec.price,
    asOf,
    open: true,
    ratio: 1,
    multiplier,
    tick,
    spread,
    minQty: step,
    step,
    qtyUnit,
    feeRate: isVS ? 0.0001 : 0.0005,
    leverage: 10,
    mmr: 0.005,
    marginMode: isVS ? 'isolated' : 'cross',
    marginSource: '模拟假设',
    tiersVerified: true,
    tiers: [{ lowerBound: 0, mmr: 0.005, deduction: 0, maxLeverage: 100 }]
  };
}

export function createTemplates(now = Date.now()) {
  const asOf = new Date(now).toISOString();
  return specifications.map((spec) => {
    const benchmark = 'SIM-' + spec.ticker + '-USD';
    return {
      id: spec.id,
      ticker: spec.ticker,
      name: spec.name,
      unit: spec.unit,
      priceUnit: spec.priceUnit,
      benchmark,
      referencePrice: spec.price,
      maxAgeSec: 900,
      verified: true,
      minBuffer: spec.buffer,
      minMatchPct: 95,
      maxBasisPct: 1,
      vsProfit: 60,
      vsLoss: 60,
      vs: createLeg(spec, 'vs', benchmark, asOf),
      hype: createLeg(spec, 'hype', benchmark, asOf)
    };
  });
}
