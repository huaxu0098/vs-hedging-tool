export const MAINNET = 'https://api.hyperliquid.xyz/info';
export const TESTNET = 'https://api.hyperliquid-testnet.xyz/info';
const finite = (v) => v !== null && v !== '' && Number.isFinite(Number(v));
const positive = (v) => finite(v) && Number(v) > 0;
const num = (v) => (finite(v) ? Number(v) : null);

export function documentedQuote(symbol, dex) {
  if (dex) return null;
  if (['BTC', 'ETH', 'SOL'].includes(symbol)) return 'USDT';
  if (['PURR', 'HYPE'].includes(symbol)) return 'USDC';
  return null;
}

export function parseEndpoint(input) {
  const url = new URL(input);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.pathname.endsWith('/info')
  ) {
    throw new Error('Endpoint 需为 HTTPS 或本机 HTTP 的 /info 地址。');
  }
  return url.href;
}

function riskTable(meta, spec) {
  const id = spec.marginTableId;
  let rows = meta.marginTables?.find(([key]) => key === id)?.[1]?.marginTiers;
  if (!rows && Number.isInteger(id) && id > 0 && id < 50) rows = [{ lowerBound: 0, maxLeverage: id }];
  if (!Array.isArray(rows) || !rows.length) return null;
  let deduction = 0;
  const tiers = [];
  for (const row of rows) {
    const lower = num(row.lowerBound),
      lev = num(row.maxLeverage);
    if (lower == null || !(lev >= 1) || lower < 0) return null;
    const rate = 1 / (2 * lev),
      last = tiers.at(-1);
    if (last) {
      if (lower <= last.lowerBound || rate < last.mmr) return null;
      deduction += lower * (rate - last.mmr);
      last.maxNotional = lower;
    } else if (lower !== 0) return null;
    tiers.push({ lowerBound: lower, maxNotional: null, maxLeverage: lev, mmr: rate, deduction });
  }
  return tiers;
}

function levels(side, bids) {
  if (!Array.isArray(side)) throw new Error('Hype 盘口结构无效。');
  const data = side.slice(0, 5).map((level) => [num(level.px), num(level.sz)]);
  if (
    !data.length ||
    data.some(
      ([px, sz], i) => !(px > 0 && sz > 0) || (i && (bids ? px >= data[i - 1][0] : px <= data[i - 1][0]))
    )
  )
    throw new Error('Hype 五档盘口为空或价格顺序无效。');
  return data;
}

function getAccount(state, symbol) {
  const s = state?.marginSummary;
  if (
    ![s?.accountValue, s?.totalMarginUsed, state?.withdrawable, state?.time].every(finite) ||
    !Array.isArray(state.assetPositions)
  )
    throw new Error('Hype 账户响应缺少净值、保证金或时间。');
  const positions = state.assetPositions.map(({ position: p }) => {
    if (!p || !p.coin || ![p.szi, p.entryPx, p.unrealizedPnl, p.marginUsed].every(finite)) {
      throw new Error('Hype 账户持仓资料不完整。');
    }
    return {
      symbol: p.coin,
      qty: num(p.szi),
      entry: num(p.entryPx),
      upnl: num(p.unrealizedPnl),
      marginUsed: num(p.marginUsed),
      marginMode: p.leverage?.type,
      leverage: num(p.leverage?.value),
      liqPrice: num(p.liquidationPx)
    };
  });
  const equity = num(s.accountValue);
  return {
    equity,
    cash: equity - positions.reduce((sum, p) => sum + p.upnl, 0),
    free: num(state.withdrawable),
    used: num(s.totalMarginUsed),
    positions,
    position: positions.find((p) => p.symbol === symbol) ?? null,
    asOf: new Date(Number(state.time)).toISOString()
  };
}

export async function readHype({
  endpoint = MAINNET,
  symbol,
  dex = '',
  address = '',
  signal,
  proxyBase,
  fetchImpl = fetch
}) {
  endpoint = parseEndpoint(endpoint);
  if (
    typeof symbol !== 'string' ||
    !/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(symbol) ||
    (symbol.includes(':') ? symbol.split(':')[0] !== dex : !!dex)
  ) {
    throw new Error('Hype 未挂牌/需手动输入报价。请填写精确合约代码和对应 DEX。');
  }
  if (address && !/^0x[a-fA-F0-9]{40}$/.test(address))
    throw new Error('公开地址需为 0x 加 40 位十六进制字符。');
  const timeout = AbortSignal.timeout(4500);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const network = endpoint === MAINNET ? 'mainnet' : endpoint === TESTNET ? 'testnet' : null;
  const api = async (body) => {
    const proxied = proxyBase && network;
    const response = await fetchImpl(proxied ? new URL('/api/hype-info', proxyBase).href : endpoint, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxied ? { network, request: body } : body),
      signal: deadline
    });
    if (!response.ok) throw new Error('Hype 接口 HTTP ' + response.status);
    return response.json();
  };
  const started = Date.now();
  let metaResp, bookResp, accountResp;
  try {
    const replies = await Promise.allSettled([
      api({ type: 'metaAndAssetCtxs', ...(dex && { dex }) }),
      api({ type: 'l2Book', coin: symbol }),
      address ? api({ type: 'clearinghouseState', user: address, ...(dex && { dex }) }) : null
    ]);
    if (replies[0].status === 'fulfilled') {
      const universe = replies[0].value?.[0]?.universe;
      if (Array.isArray(universe) && !universe.some((item) => item.name === symbol && !item.isDelisted)) {
        throw Error('Hype 未挂牌/需手动输入报价。');
      }
    }
    const failed = replies.find((reply) => reply.status === 'rejected');
    if (failed) throw failed.reason;
    [metaResp, bookResp, accountResp] = replies.map((reply) => reply.value);
  } catch (error) {
    if (timeout.aborted || error.name === 'TimeoutError') throw new Error('Hype API 超时，报价过期。');
    throw error;
  }
  const received = Date.now();
  const [meta, ctxs] = Array.isArray(metaResp) ? metaResp : [];
  const idx = meta?.universe?.findIndex((item) => item.name === symbol);
  if (idx == null || idx < 0 || meta.universe[idx].isDelisted)
    throw new Error('Hype 未挂牌/需手动输入报价。');
  const spec = meta.universe[idx],
    ctx = ctxs?.[idx];
  if (
    !ctx ||
    !positive(ctx.markPx) ||
    !positive(ctx.oraclePx) ||
    !finite(ctx.funding) ||
    !Number.isInteger(spec.szDecimals) ||
    spec.szDecimals < 0 ||
    spec.szDecimals > 6 ||
    !positive(spec.maxLeverage)
  ) {
    throw new Error('Hype 合约精度、标记价、资金费或杠杆资料不完整。');
  }
  if (bookResp?.coin !== symbol || !positive(bookResp.time))
    throw new Error('Hype 盘口代码或交易所时间无效。');
  const bids = levels(bookResp.levels?.[0], true),
    asks = levels(bookResp.levels?.[1], false);
  const bid = bids[0][0],
    ask = asks[0][0],
    price = (ask + bid) / 2;
  if (ask < bid) throw new Error('Hype 盘口交叉。');
  const tiers = riskTable(meta, spec);
  const account = accountResp ? getAccount(accountResp, symbol) : null,
    pos = account?.position;
  let settleCurrency = meta.collateralToken === 0 ? 'USDC' : null;
  if (!settleCurrency && Number.isInteger(meta.collateralToken)) {
    const spot = await api({ type: 'spotMeta' });
    settleCurrency = spot?.tokens?.find((token) => token.index === meta.collateralToken)?.name ?? null;
  }
  const tick = 10 ** Math.min(0, Math.max(Math.floor(Math.log10(price)) - 4, spec.szDecimals - 6));
  return {
    symbol,
    dex,
    source: 'Hype /info',
    sourceKind: 'live',
    bid,
    ask,
    price,
    spread: ask - bid,
    mark: num(ctx.markPx),
    oracle: num(ctx.oraclePx),
    fundingRate: num(ctx.funding),
    fundingIntervalHours: 1,
    open: true,
    asOf: new Date(Number(bookResp.time)).toISOString(),
    receivedAt: new Date(received).toISOString(),
    contextReceivedAt: new Date(received).toISOString(),
    latencyMs: received - started,
    book: { bids, asks },
    tiers,
    tiersVerified: !!tiers,
    marginVerified: !!tiers,
    mmr: tiers?.[0]?.mmr ?? null,
    maxLeverage: spec.maxLeverage,
    marginMode:
      pos?.marginMode ??
      (spec.onlyIsolated || ['strictIsolated', 'noCross'].includes(spec.marginMode) ? 'isolated' : undefined),
    settleCurrency,
    collateralToken: meta.collateralToken,
    szDecimals: spec.szDecimals,
    step: 10 ** -spec.szDecimals,
    tick,
    documentedQuote: documentedQuote(symbol, dex),
    minNotional: 10,
    minNotionalSource: 'Hyperliquid MinTradeNtl',
    account: account ? { ...account, currency: settleCurrency, source: 'clearinghouseState' } : null,
    liqSource: pos?.liqPrice ? 'api' : null,
    liqPrice: pos?.liqPrice ?? null,
    liqQty: pos?.qty ?? null,
    liqEntry: pos?.entry ?? null,
    liqAsOf: pos ? account.asOf : null,
    liqMarginMode: pos?.marginMode ?? null
  };
}

export function feedIssues(snap, now = Date.now()) {
  if (!snap) return [];
  if (snap.mode === 'offline' && !positive(snap.vs?.bid)) {
    if (!snap.vs?.account) return [];
    const age = now - Date.parse(snap.vs.account.asOf);
    return Number.isFinite(age) && age >= 0 && age <= snap.maxAgeMs ? [] : ['VS 账户数据过期或时间未知。'];
  }
  const mixed = snap.mode === 'offline';
  const issues = mixed ? [] : [...(snap.errors ?? [])];
  if (snap.frozen) issues.push('实时行情已冻结。');
  if (!snap.mappingVerified) issues.push('尚未确认当前 VS 与 Hype 合约、标的及报价映射。');
  for (const [name, leg] of mixed
    ? [['VS', snap.vs]]
    : [
        ['VS', snap.vs],
        ['Hype', snap.hype]
      ]) {
    if (!leg || !positive(leg.bid) || !positive(leg.ask) || !positive(leg.mark)) {
      issues.push(name + ' 缺少买一、卖一或标记价。');
      continue;
    }
    if (leg.open !== true) issues.push(name + ' 未确认开市。');
    const age = now - Date.parse(leg.asOf);
    if (!Number.isFinite(age) || age > snap.maxAgeMs || age < 0) issues.push(name + ' 报价过期或时间异常。');
  }
  if (snap.vs?.account && Object.keys(snap.vs.account).length) {
    const age = now - Date.parse(snap.vs.account.asOf);
    if (!Number.isFinite(age) || age > snap.maxAgeMs || age < 0) issues.push('VS 账户数据过期或时间未知。');
  }
  if (!mixed && snap.addressConfigured) {
    const age = now - Date.parse(snap.hype?.account?.asOf);
    if (!Number.isFinite(age) || age > snap.maxAgeMs || age < 0)
      issues.push('公开地址账户数据过期或未取得。');
  }
  return [...new Set(issues)];
}

export function toMarketAsset(asset, snap, now = Date.now()) {
  const mixed = snap?.mode === 'offline' && positive(snap.vs?.bid);
  if (!snap || (snap.mode === 'offline' && !mixed))
    return { ...asset, feedMode: 'offline', sourceIssues: feedIssues(snap, now) };
  const sourceIssues = feedIssues(snap, now);
  if (snap.assetId !== asset.id) sourceIssues.push('当前品种与行情快照不一致。');
  const vs = {
    ...asset.vs,
    price: null,
    open: false,
    bid: null,
    ask: null,
    mark: null,
    book: null,
    asOf: null,
    ...(snap.vs ?? {})
  };
  const hype = mixed
    ? { ...asset.hype, source: '离线模拟' }
    : {
        ...asset.hype,
        price: null,
        open: false,
        bid: null,
        ask: null,
        mark: null,
        book: null,
        asOf: null,
        liqPrice: null,
        liqAsOf: null,
        tiers: null,
        tiersVerified: false,
        marginVerified: false,
        mmr: null,
        ...(snap.hype ?? {})
      };
  if (!mixed) hype.marginMode = snap.hype?.marginMode ?? snap.marginMode;
  if (snap.hype && !mixed) {
    hype.quote = snap.quoteCurrency || snap.hype.documentedQuote || null;
    if (!hype.quote || (snap.hype.documentedQuote && hype.quote !== snap.hype.documentedQuote)) {
      sourceIssues.push('Hype 实际报价币尚未确认，或与已知合约规格不符。');
    }
    hype.minNotional = Math.max(snap.hype.minNotional, asset.hype.minNotional ?? 0);
    const currentLeverage = snap.hype.account?.position?.leverage;
    if (positive(currentLeverage)) hype.leverage = currentLeverage;
    if (snap.hype.documentedQuote && asset.hype.multiplier !== 1)
      sourceIssues.push('Hype 原生加密合约每单位乘数为 1，请核对合约规格。');
    if (snap.hype.settleCurrency !== asset.hype.settle)
      sourceIssues.push('Hype 的 API 抵押币种与当前结算币设置不一致。');
    if (hype.leverage > snap.hype.maxLeverage) sourceIssues.push('Hype 设定杠杆超过此合约 API 上限。');
    hype.minQty = snap.hype.step;
  }
  if (!mixed && asset.hype.liqSource === 'manual' && snap.scopeId && asset.hype.liqScopeId === snap.scopeId) {
    for (const key of [
      'liqSource',
      'liqPrice',
      'liqAsOf',
      'liqQty',
      'liqEntry',
      'liqCollateral',
      'liqMarginMode'
    ]) {
      hype[key] = asset.hype[key];
    }
  }
  for (const [key, leg] of mixed
    ? [['vs', vs]]
    : [
        ['vs', vs],
        ['hype', hype]
      ]) {
    for (const [currency, rate] of [
      ['quote', 'quoteUsd'],
      ['settle', 'settleUsd']
    ]) {
      if (leg[currency] === 'USD') {
        leg[rate] = 1;
        continue;
      }
      const fx = snap.fx?.[key];
      const age = now - Date.parse(fx?.asOf);
      if (!positive(fx?.[rate]) || !Number.isFinite(age) || age > snap.maxAgeMs || age < 0) {
        sourceIssues.push(
          (key === 'vs' ? 'VS' : 'Hype') + ' 的 ' + leg[currency] + ' 汇率缺少新鲜的手工确认。'
        );
        leg[rate] = null;
      } else {
        leg[rate] = fx[rate];
        leg.fxAsOf = fx.asOf;
        leg.fxSource = '用户确认';
      }
    }
  }
  if (!mixed && snap.hype) {
    const fx = hype.settleUsd,
      raw = snap.hype.account;
    hype.account = null;
    if (positive(fx)) {
      // The API reports collateral-currency amounts. Quantity, entry, and liquidation prices retain venue units.
      if (raw && raw.currency === hype.settle) {
        const positions = raw.positions.map((p) => ({
          ...p,
          upnl: p.upnl * fx,
          marginUsed: p.marginUsed * fx
        }));
        hype.account = {
          ...raw,
          cash: raw.cash * fx,
          equity: raw.equity * fx,
          free: raw.free * fx,
          used: raw.used * fx,
          positions,
          position: positions.find((p) => p.symbol === hype.symbol) ?? null,
          currency: 'USD',
          sourceCurrency: raw.currency,
          fxRate: fx,
          fxAsOf: hype.fxAsOf,
          source: 'clearinghouseState × 已确认结算币汇率'
        };
      }
      if (raw && !hype.account) sourceIssues.push('账户抵押币与本合约的结算币不一致。');
      if (Array.isArray(snap.hype.tiers))
        hype.tiers = snap.hype.tiers.map((t) => ({
          ...t,
          lowerBound: t.lowerBound * fx,
          maxNotional: t.maxNotional === null ? null : t.maxNotional * fx,
          deduction: t.deduction * fx
        }));
    }
  }
  if (!mixed && snap.hype && !hype.marginVerified && !(hype.liqPrice > 0))
    sourceIssues.push('Hype 强平参数缺失，无法验证。');
  const ref = positive(vs.mark) && positive(vs.ratio) ? vs.mark / vs.ratio : null;
  return {
    ...asset,
    referencePrice: ref,
    feedMode: snap.mode,
    mixedSource: !!mixed,
    sourceIssues,
    verified: !!asset.verified && snap.mappingVerified && !sourceIssues.length,
    maxAgeSec: mixed ? asset.maxAgeSec : snap.maxAgeMs / 1000,
    vs,
    hype
  };
}
