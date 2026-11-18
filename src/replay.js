import { analyzeCandidate, DEFAULT_CONFIG, settleLeg } from './decision.js';
import {
  accountView,
  applySimulation,
  createSimulation,
  portfolioRisk,
  verifyQuotes,
  assetsWith,
  atReference,
  heldCandidate,
  valueAt
} from './simulation.js';

const valid = Number.isFinite;
const requireThat = (test, text) => {
  if (!test) throw new Error(text);
};

export function parseCandles(input, assets) {
  const lines = String(input)
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/);
  const header =
    lines
      .shift()
      ?.trim()
      .toLowerCase()
      .split(',')
      .map((s) => s.trim()) || [];
  const required = ['time', 'asset', 'open', 'high', 'low', 'close'];
  requireThat(
    required.every((k) => header.includes(k)),
    'K 线 CSV 表头须包含 time,asset,open,high,low,close'
  );
  requireThat(lines.length > 0 && lines.length <= 100000, 'K 线行数应为 1 至 100000');
  const ids = new Map(
    assets.flatMap((a) => [
      [a.id.toLowerCase(), a.id],
      [a.ticker.toLowerCase(), a.id]
    ])
  );
  const seen = new Set();
  let previous = -Infinity;
  return lines.map((line, i) => {
    const fields = line
      .trim()
      .split(',')
      .map((s) => s.trim());
    const row = Object.fromEntries(header.map((key, j) => [key, fields[j]]));
    const where = '第 ' + (i + 2) + ' 行';
    const assetId = ids.get(row.asset?.toLowerCase());
    const ts = /^\d{13}$/.test(row.time) ? Number(row.time) : Date.parse(row.time);
    requireThat(
      assetId && valid(ts) && ts >= previous && !seen.has(ts + '/' + assetId),
      where + '的标的、时间顺序或重复时间无效'
    );
    seen.add(ts + '/' + assetId);
    previous = ts;
    const [open, high, low, close] = ['open', 'high', 'low', 'close'].map((k) => Number(row[k]));
    requireThat(
      [open, high, low, close].every((x) => valid(x) && x > 0) &&
        high >= Math.max(open, low, close) &&
        low <= Math.min(open, close),
      where + '的 OHLC 区间无效'
    );
    return { assetId, ts, open, high, low, close };
  });
}

function contextAt(base, assets, price, config, now) {
  const asset = atReference(base, price, now);
  return { asset, assets: assetsWith(assets, asset), config, now };
}

function finalResult(s, event, price, base, assets, config, now) {
  const ctx = contextAt(base, assets, price, config, now);
  const next = applySimulation(
    s,
    { type: 'event', event },
    { ...ctx, liquidationVerified: event === 'liquidation' }
  );
  return {
    event,
    price,
    state: next,
    asset: ctx.asset,
    cash: next.hypeCash,
    stage: next.stage,
    status: next.status
  };
}

function worst(results) {
  const rank = { liquidation: 0, failure: 1, success: 2, none: 3 };
  return [...results].sort((a, b) => a.cash - b.cash || rank[a.event] - rank[b.event])[0];
}

// OHLC establishes an extremum range. In a continuous segment, only the nearest
// crossed boundary can fire. Both possible orderings of the two extrema are tested.
export function stepCandle(s, candle, sourceAssets, input = {}, legacyUsed = 0) {
  for (const a of sourceAssets.filter(
    (a) => a.id === candle.assetId || s.positions.some((p) => p.assetId === a.id)
  )) {
    if (a.feedMode === 'live' || a.mixedSource || a.sourceIssues?.length || a.feedMode === 'frozen')
      verifyQuotes(a, Date.now());
  }
  const assets = sourceAssets.map((a) => atReference(a, a.referencePrice, candle.ts));
  const config = { ...DEFAULT_CONFIG, ...input };
  const base = assets.find((a) => a.id === candle.assetId);
  requireThat(base, '缺少 K 线品种配置');
  const time = candle.ts;
  const initial = contextAt(base, assets, base.referencePrice, config, time);
  const held = s.positions.some((p) => p.assetId === base.id);
  if (s.status !== 'active') return { event: 'stopped', state: s, terminal: true };
  const closeCtx = contextAt(base, assets, candle.close, config, time);
  const finish = () => ({
    event: 'none',
    state: applySimulation(s, { type: 'mark', label: held ? 'K 线收盘计值' : 'K 线空仓等待' }, closeCtx),
    asset: closeCtx.asset,
    terminal: false
  });
  const alsoAtRisk = portfolioRisk(s, base, assets, legacyUsed);
  if (!held) {
    if (!alsoAtRisk(base.referencePrice)) return finish();
    return {
      ...finalResult(s, 'liquidation', base.referencePrice, base, assets, config, time),
      terminal: true
    };
  }
  const candidate = heldCandidate(s, initial.asset, initial.assets, config, time, legacyUsed);
  requireThat(valid(candidate.liq) && candidate.liq > 0, 'Hype 强平边界无法验证，回放已暂停');
  const hp = s.positions.find((p) => p.assetId === base.id && p.venue === 'hype');
  const fail = s.stage === 'challenge' ? config.challengeFail : config.fundedFail;
  const target = s.stage === 'challenge' ? config.challengeTarget : config.payoutTarget;
  const flags = (price) => {
    const ctx = contextAt(base, assets, price, config, time);
    const account = valueAt(s, ctx.assets, config);
    return {
      failure: account.vsTrigger <= fail + 1e-7,
      success: account.vsTrigger >= target - 1e-7,
      liquidation: alsoAtRisk(price) || (hp.qty > 0 ? price <= candidate.liq : price >= candidate.liq)
    };
  };
  function firstOnPath(prices) {
    let prev = prices[0];
    const openEvents = Object.entries(flags(prev))
      .filter(([, on]) => on)
      .map(([e]) => e);
    if (openEvents.length) return openEvents.map((e) => finalResult(s, e, prev, base, assets, config, time));
    for (const end of prices.slice(1)) {
      const ends = Object.entries(flags(end))
        .filter(([, on]) => on)
        .map(([e]) => e);
      if (ends.length) {
        const crossed = ends
          .map((event) => {
            let lo = 0,
              hi = 1;
            for (let j = 0; j < 48; j++) {
              const mid = (lo + hi) / 2;
              if (flags(prev + (end - prev) * mid)[event]) hi = mid;
              else lo = mid;
            }
            return { event, alpha: hi, price: prev + (end - prev) * hi };
          })
          .sort((a, b) => a.alpha - b.alpha);
        return crossed
          .filter((x) => Math.abs(x.alpha - crossed[0].alpha) < 1e-10)
          .map((x) => finalResult(s, x.event, x.price, base, assets, config, time));
      }
      prev = end;
    }
    return [];
  }
  const options = [
    ...firstOnPath([candle.open, candle.high, candle.low, candle.close]),
    ...firstOnPath([candle.open, candle.low, candle.high, candle.close])
  ];
  if (!options.length) return finish();
  const distinct = [...new Map(options.map((o) => [o.event, o])).values()];
  if (distinct.length > 1)
    return {
      event: 'uncertain',
      terminal: true,
      state: s,
      alternatives: distinct,
      worst: worst(distinct),
      reason: '触线顺序不确定，已停止回放。最坏分支单列，尚未记入模拟账本。'
    };
  return { ...distinct[0], terminal: true };
}

export function runReplay(state, candles, originalAssets, config = {}, legacyUsed = 0) {
  let assets = [...originalAssets];
  const steps = [];
  let current = state;
  for (const candle of candles) {
    const step = stepCandle(current, candle, assets, config, legacyUsed);
    steps.push(step);
    current = step.state;
    if (step.asset) assets = assetsWith(assets, step.asset);
    if (step.terminal) break;
  }
  return { state: current, steps, last: steps.at(-1), assets };
}

// Project a direct path and settle all positions. No rows are written to browser storage.
export function previewScenario(s, kind, options) {
  const { asset, assets, now = Date.now() } = options;
  const config = { ...DEFAULT_CONFIG, ...options.config };
  let state = s;
  for (const a of assets.filter((a) => a.id === asset.id || s.positions.some((p) => p.assetId === a.id))) {
    verifyQuotes(a, now);
  }
  if (options.order)
    state = applySimulation(s, { type: 'target', order: options.order }, { ...options, now });
  if (kind === 'close') {
    const price = options.closePrice ?? asset.referencePrice;
    const ctx = contextAt(asset, assets, price, config, now);
    const result = stepCandle(
      state,
      {
        assetId: asset.id,
        ts: now,
        open: asset.referencePrice,
        close: price,
        high: Math.max(price, asset.referencePrice),
        low: Math.min(price, asset.referencePrice)
      },
      assets,
      config,
      options.legacyUsed
    );
    if (result.terminal) return result;
    return {
      event: 'day',
      state: applySimulation(result.state, { type: 'day' }, ctx),
      asset: ctx.asset,
      terminal: true
    };
  }
  const c = heldCandidate(state, asset, assets, config, now, options.legacyUsed);
  const expected = kind === 'success' ? c.pass : c.fail;
  requireThat(valid(expected) && expected > 0, '该方向没有可验证的目标触线价格');
  const sign = state.positions.find((p) => p.assetId === asset.id && p.venue === 'vs').qty > 0 ? 1 : -1;
  // Include the first executable price beyond a strict failure edge.
  const to =
    expected +
    (kind === 'failure' ? -sign : sign) *
      Math.max((asset.vs.tick / asset.vs.ratio) * 1e-6, Math.abs(expected) * 1e-12);
  const start = asset.referencePrice;
  const r = stepCandle(
    state,
    {
      assetId: asset.id,
      ts: now,
      open: start,
      high: Math.max(start, to),
      low: Math.min(start, to),
      close: to
    },
    assets,
    config,
    options.legacyUsed
  );
  requireThat(r.event !== 'none', '到达候选价格后未满足可结算触线条件');
  return r;
}

export function compareRounds(s, asset, assets, input, order, now = Date.now(), legacyUsed = 0) {
  const config = { ...DEFAULT_CONFIG, ...input };
  const once = {
    vs: { fee: 0, gross: 0, spread: 0, slippage: 0 },
    hype: { fee: 0, gross: 0, spread: 0, slippage: 0 }
  };
  if (s.positions.length) {
    for (const p of s.positions) {
      const a = assets.find((x) => x.id === p.assetId) || p.asset;
      const exit = settleLeg(a, p.venue, p.qty, p.entry, a.referencePrice, config);
      requireThat(exit.ok, '无法验证已有仓位的共同平仓起点');
      const row = once[p.venue];
      row.fee += exit.fee;
      row.gross += exit.gross;
      row.spread += exit.spreadCost;
      row.slippage += exit.slippageCost;
    }
    s = applySimulation(s, { type: 'day' }, { asset, assets, config, now, legacyUsed });
  }
  const start = accountView(s, assets, config, legacyUsed);
  const first = analyzeCandidate(asset, start, config, order, now);
  const friction = {};
  for (const venue of ['vs', 'hype']) {
    const p = first[venue];
    requireThat(p && valid(p.targetQty) && valid(p.tradeFee), '当前候选缺少可复算的整手成交');
    const closed = settleLeg(asset, venue, p.targetQty, p.avgEntry, asset.referencePrice, config);
    requireThat(closed.ok, '平仓费用无法验证');
    friction[venue] = Math.max(0, p.tradeFee - closed.net);
  }
  const at = (n) => {
    const temp = { ...s, vsBalance: s.vsBalance - n * friction.vs, hypeCash: s.hypeCash - n * friction.hype };
    const a = accountView(temp, assets, config, legacyUsed);
    const r = analyzeCandidate(asset, a, config, order, now);
    return {
      n,
      vs: temp.vsBalance,
      hype: temp.hypeCash,
      vsCost: n * friction.vs,
      hypeCost: n * friction.hype,
      ok: r.ok,
      reason: r.reasons?.map((x) => (typeof x === 'string' ? x : x.message)).join('、')
    };
  };
  let firstUnsafe = null;
  if (!at(0).ok) firstUnsafe = 0;
  else if (friction.vs > 0 || friction.hype > 0) {
    let upper = 1;
    while (upper < Number.MAX_SAFE_INTEGER / 2 && at(upper).ok) upper *= 2;
    if (!at(upper).ok) {
      let lower = 0;
      while (upper - lower > 1) {
        const mid = Math.floor((upper + lower) / 2);
        if (at(mid).ok) lower = mid;
        else upper = mid;
      }
      firstUnsafe = upper;
    }
  }
  return {
    firstUnsafe,
    friction,
    once,
    start,
    rows: [1, 2, 3, 5].map(at),
    wait: s.hypeCash,
    stop: s.hypeCash,
    rebuy: s.hypeCash - config.registrationFee
  };
}

export const DEMOS = {
  challengeFail: '考核失败',
  challengePass: '考核通过',
  payout: '首次出金到账',
  fundedFail: '出金号爆号',
  day: '日内未到线平仓',
  ambiguous: '同柱触线顺序不确定'
};

// Each demo explicitly seeds an existing synthetic position near the selected
// account boundary. These are playback fixtures, never recommended allocations.
export function makeDemo(kind, original, input = {}, now = Date.now()) {
  const c = { ...DEFAULT_CONFIG, ...input };
  requireThat(Object.hasOwn(DEMOS, kind), '无效的回放示例');
  const asset = atReference(original, original.referencePrice, now);
  const settled = kind === 'payout' || kind === 'fundedFail';
  const p = asset.referencePrice;
  const isFail = kind === 'challengeFail' || kind === 'fundedFail';
  const target = settled ? c.payoutTarget : c.challengeTarget;
  const fail = settled ? c.fundedFail : c.challengeFail;
  const balance =
    kind === 'ambiguous'
      ? (target + fail) / 2
      : kind === 'day'
        ? c.vsStart
        : isFail
          ? fail + 20
          : target - 20;
  const seed = createSimulation(c, now);
  const positions = ['vs', 'hype'].map((venue) => {
    const leg = asset[venue],
      nominal = venue === 'vs' ? 20000 : 1000;
    const size = Math.floor(nominal / (leg.price * leg.multiplier * leg.settleUsd * leg.step)) * leg.step;
    requireThat(size >= leg.minQty, '此品种的最小下单量过大，不适用内置示例');
    return {
      assetId: asset.id,
      venue,
      qty: venue === 'vs' ? size : -size,
      entry: leg.mark ?? leg.price,
      margin: (size * leg.price * leg.multiplier * leg.settleUsd) / leg.leverage
    };
  });
  const state = applySimulation(
    seed,
    {
      type: 'adopt',
      account: {
        stage: settled ? 'funded' : 'challenge',
        vsBalance: balance,
        hypeCash: seed.hypeCash,
        positions
      }
    },
    { asset, assets: [asset], config: c, now }
  );
  const amount = kind === 'ambiguous' ? Math.abs(target - fail) / 20000 / 2 + 0.015 : 0.01;
  const high = p * (1 + (kind === 'day' ? 0.0001 : isFail ? 0.00002 : amount));
  const low = p * (1 - (kind === 'day' ? 0.0001 : isFail || kind === 'ambiguous' ? amount : 0.00002));
  const candles = [
    { assetId: asset.id, ts: now + 1000, open: p, high: p, low: p, close: p },
    { assetId: asset.id, ts: now + 2000, open: p, high, low, close: p }
  ];
  return { state, assets: [asset], candles, kind };
}
