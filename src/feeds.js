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
  const captureIssues = [snap.vsAutoIssue, snap.vsAutoAccountIssue, snap.vsAutoSpecIssue].filter(Boolean);
  if (snap.mode === 'offline' && !positive(snap.vs?.bid)) {
    if (!snap.vs?.account) return captureIssues;
    const age = now - Date.parse(snap.vs.account.asOf);
    if (!Number.isFinite(age) || age < 0 || age > snap.maxAgeMs)
      captureIssues.push('VS 账户数据过期或时间未知。');
    return captureIssues;
  }
  const mixed = snap.mode === 'offline';
  const issues = [...captureIssues, ...(mixed ? [] : (snap.errors ?? []))];
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

function readUsdRate(snap, venue, field, currency, now) {
  if (currency === 'USD') return { currency, quote: 'USD', rate: 1, source: '美元本币' };
  if (typeof currency !== 'string' || !/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(currency)) return null;
  const limit = snap.fxMaxAgeMs ?? snap.maxAgeMs;
  if (!(Number.isFinite(limit) && limit > 0)) return null;
  let record;
  if (snap.fxMode === 'auto') {
    const item = Object.hasOwn(snap.usdRates ?? {}, currency) ? snap.usdRates[currency] : null;
    if (
      !item ||
      item.currency !== currency ||
      item.quote !== 'USD' ||
      typeof item.source !== 'string' ||
      !item.source.trim() ||
      ![item.bid, item.ask, item.rate].every((n) => Number.isFinite(n) && n > 0) ||
      item.bid > item.ask ||
      item.rate < item.bid ||
      item.rate > item.ask
    )
      return null;
    record = {
      currency,
      quote: 'USD',
      bid: item.bid,
      ask: item.ask,
      rate: item.rate,
      asOf: item.asOf,
      source: item.source
    };
  } else if (snap.fxMode === 'manual' || snap.fxMode === undefined) {
    const item = snap.fx?.[venue];
    const bound = item?.[field + 'Currency'];
    // Pre-FX-mode saved snapshots had no currency labels and were already
    // scoped to a venue/configuration. New manual confirmations must be bound.
    if (!item || ((snap.fxMode === 'manual' || bound !== undefined) && bound !== currency)) return null;
    const rate = item[field + 'Usd'];
    if (!Number.isFinite(rate) || rate <= 0) return null;
    record = { currency, quote: 'USD', rate, asOf: item.asOf, source: '用户确认' };
  } else return null;
  const time = typeof record.asOf === 'number' ? record.asOf : Date.parse(record.asOf);
  if (!Number.isFinite(time) || time <= 0 || time > now || now - time > limit) return null;
  return { ...record, asOf: new Date(time).toISOString(), validUntil: time + limit };
}

// Venue price and collateral FX can expire independently. Frozen offline
// templates have no observed FX clock; captured conversions retain one.
export function fxIsCurrent(leg, maxAgeSec, now) {
  if (leg.fxAsOf == null && leg.fxValidUntil == null) return true;
  const stamp = typeof leg.fxAsOf === 'number' ? leg.fxAsOf : Date.parse(leg.fxAsOf);
  const expiry = leg.fxValidUntil ?? stamp + maxAgeSec * 1000;
  return Number.isFinite(stamp) && Number.isFinite(expiry) && stamp <= now && now <= expiry;
}

function valueLegFx(asset, snap, venue, leg, now, issues) {
  const details = {};
  for (const kind of ['quote', 'settle']) {
    const result = readUsdRate(snap, venue, kind, leg[kind], now);
    details[kind] = result;
    leg[kind + 'Usd'] = result?.rate ?? null;
    if (!result)
      issues.push(
        (venue === 'vs' ? 'VS' : 'Hype') +
          ' 的 ' +
          (leg[kind] || '未知币种') +
          (snap.fxMode === 'auto'
            ? ' 自动 USD 汇率缺失、过期或不可验证。'
            : ' 汇率缺少匹配币种的新鲜手工确认。')
      );
  }
  const observed = Object.values(details)
    .filter((r) => r?.asOf)
    .sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  leg.fxDetails = details;
  leg.fxAsOf = observed[0]?.asOf ?? null;
  leg.fxValidUntil = observed.length ? Math.min(...observed.map((r) => r.validUntil)) : null;
  leg.fxSource =
    [...new Set(observed.map((r) => r.source))].join(' / ') ||
    (details.quote && details.settle ? '美元本币' : null);
  if (snap.fxMode !== undefined) {
    const configured = asset[venue],
      scale = configured.quoteScale ?? 1;
    const priorRate = configured.quote === 'USD' ? 1 : configured.quoteUsd;
    // The stored mapping is calibrated in its original quote currency. Preserve
    // its physical scale (e.g. troy ounces per gram); only the currency factor floats.
    const calibration = configured.ratio * priorRate;
    const mappedNow =
      leg.quote === configured.quote && details.quote && configured.ratio * details.quote.rate;
    const validScale = (value) =>
      Number.isFinite(value) && value > 0 && positive(scale) && Math.abs(value / scale - 1) <= 0.000100000001;
    if (validScale(calibration)) leg.ratio = details.quote ? calibration / details.quote.rate : null;
    else if (positive(priorRate) || !validScale(mappedNow)) {
      leg.ratio = null;
      issues.push((venue === 'vs' ? 'VS' : 'Hype') + ' 原合约报价比例与标的单位未验证，无法套用实时汇率。');
    }
  }
}

function usdAccount(raw, rate, rowRate, issues, venue) {
  if (!raw || !rate) return null;
  const account = { ...raw };
  const clocks = [rate];
  const scale = (obj, fields, fx) => {
    for (const key of fields)
      if (Object.hasOwn(obj, key) && Number.isFinite(obj[key])) obj[key] = fx ? obj[key] * fx.rate : null;
  };
  scale(account, ['cash', 'balance', 'equity', 'free', 'used'], rate);
  if (Array.isArray(raw.positions)) {
    account.positions = raw.positions.map((p) => {
      const next = { ...p };
      const fx = p.currency === undefined || p.currency === rate.currency ? rate : rowRate(p.currency);
      if (!fx)
        issues.push(venue + ' 持仓 ' + (p.symbol ?? p.assetId ?? '') + ' 金额币种缺少已验证的 USD 汇率。');
      else clocks.push(fx);
      scale(
        next,
        ['upnl', 'unrealized', 'margin', 'marginUsed', 'maintenance', 'maintenanceMargin', 'closeFee'],
        fx
      );
      if (p.currency !== undefined) {
        next.currency = fx ? 'USD' : null;
        next.sourceCurrency = p.currency;
      }
      return next;
    });
    if (Object.hasOwn(raw, 'position'))
      account.position = account.positions.find((p) => p.symbol === raw.position?.symbol) ?? null;
  }
  const observations = clocks.filter((fx) => fx.asOf).sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  return {
    ...account,
    currency: 'USD',
    sourceCurrency: rate.currency,
    fxRate: rate.rate,
    fxAsOf: observations[0]?.asOf ?? null,
    fxValidUntil: observations.length ? Math.min(...observations.map((f) => f.validUntil)) : null,
    fxSource: rate.source
  };
}

function valueVSAccount(snap, leg, now, issues) {
  const raw = snap.vs?.account;
  if (!raw) return null;
  // Manual fields historically mean USD-equivalent and must not be converted
  // again just because the contract quotes or settles in another currency.
  const read = (currency) => {
    const kind = currency === leg.settle ? 'settle' : currency === leg.quote ? 'quote' : 'account';
    return readUsdRate(snap, 'vs', kind, currency, now);
  };
  const rate = read(raw.currency === undefined ? 'USD' : raw.currency);
  if (!rate) issues.push('VS 账户币种缺少已验证的 USD 汇率。');
  return usdAccount(raw, rate, read, issues, 'VS');
}

export function toMarketAsset(asset, snap, now = Date.now(), useExternalAccounts = true) {
  if (snap && !useExternalAccounts) {
    // The desk still needs fresh venue quotes and exchange margin rules when
    // the simulated ledger supplies balances. Ignore the unused account clock.
    snap = {
      ...snap,
      vsAutoAccountIssue: '',
      addressConfigured: false,
      vs: snap.vs && { ...snap.vs, account: null }
    };
  }
  const mixed = snap?.mode === 'offline' && positive(snap.vs?.bid);
  if (!snap || (snap.mode === 'offline' && !mixed)) {
    const sourceIssues = feedIssues(snap, now);
    const vs = snap?.vs?.account
      ? { ...asset.vs, account: valueVSAccount(snap, asset.vs, now, sourceIssues) }
      : asset.vs;
    return { ...asset, vs, feedMode: 'offline', sourceIssues };
  }
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
  // Feed observations describe prices, not a replacement contract specification.
  // Vest's official venue uses cross margin for perpetual contracts.
  if (snap.vs?.source === 'Vest 公开行情' || snap.vs?.account?.accountContext) vs.marginMode = 'cross';
  vs.quote = asset.vs.quote;
  const officialAccount = snap.vs?.account?.accountContext &&
    ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'].includes(snap.vs.symbol);
  vs.settle = officialAccount ? 'USDC' : asset.vs.settle;
  if (officialAccount && snap.vestContract?.symbol === snap.vs.symbol) vs.quote = snap.vestContract.quote;
  vs.quoteScale = asset.vs.quoteScale;
  vs.ratio = asset.vs.ratio;
  hype.settle = asset.hype.settle;
  if (snap.vs?.source === 'Vest 公开行情') {
    const meta = snap.vestContract;
    if (
      snap.assetId === asset.id &&
      meta &&
      typeof meta.symbol === 'string' &&
      meta.symbol === snap.vs.symbol &&
      typeof meta.quote === 'string' &&
      /^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(meta.quote)
    ) {
      vs.quote = meta.quote;
    } else if (snap.fxMode !== undefined || meta) {
      vs.quote = null;
      sourceIssues.push('Vest 公开行情与合约元数据的精确代码或报价币未核实。');
    }
  }
  valueLegFx(asset, snap, 'vs', vs, now, sourceIssues);
  vs.account = valueVSAccount(snap, vs, now, sourceIssues);
  if (!mixed) valueLegFx(asset, snap, 'hype', hype, now, sourceIssues);
  if (!mixed && snap.hype) {
    const fx = hype.settleUsd,
      raw = useExternalAccounts ? snap.hype.account : null;
    hype.account = null;
    if (positive(fx)) {
      // The API reports collateral-currency amounts. Prices and quantities retain venue units.
      if (raw && raw.currency === hype.settle) {
        hype.account = usdAccount(
          raw,
          hype.fxDetails.settle,
          (currency) =>
            readUsdRate(snap, 'hype', currency === hype.quote ? 'quote' : 'account', currency, now),
          sourceIssues,
          'Hype'
        );
        hype.account.source = 'clearinghouseState × ' + hype.fxDetails.settle.source;
      }
      if (raw && !hype.account) sourceIssues.push('账户抵押币与本合约的结算币不一致。');
      if (Array.isArray(snap.hype.tiers))
        hype.tiers = snap.hype.tiers.map((t) => ({
          ...t,
          lowerBound: t.lowerBound * fx,
          maxNotional: t.maxNotional == null ? null : t.maxNotional * fx,
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
