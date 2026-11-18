import { fxIsCurrent } from './feeds.js';
import { analyzeCandidate, DEFAULT_CONFIG, settleLeg } from './decision.js';
import { getLedger, LEDGER_KEY } from './ledger.js';

export const SIM_KEY = 'vs-hype:simulation:v2';
const venues = ['vs', 'hype'];
const finite = Number.isFinite;
const EPS = 1e-7;
const need = (condition, message) => {
  if (!condition) throw new Error(message);
};
const rules = (config) => ({ ...DEFAULT_CONFIG, ...config });
const stamp = (time) => new Date(time).toISOString();

// With two or more positions, every cross position draws on the same
// collateral, even if its own mark is frozen in this candle. Isolated margin
// is unavailable to that pool. Re-evaluate maintenance on every path price.
export function portfolioRisk(s, base, assets, legacyUsed) {
  const positions = s.positions.filter((p) => p.venue === 'hype');
  if (!positions.length || (positions.length === 1 && positions[0].assetId === base.id)) return () => false;
  const legs = positions.map((p) => {
    const a = assets.find((x) => x.id === p.assetId) ?? p.asset,
      leg = a.hype;
    need(
      leg.type === 'linear' &&
        ['cross', 'isolated'].includes(leg.marginMode) &&
        (leg.tiersVerified === true || leg.marginVerified === true) &&
        Array.isArray(leg.tiers) &&
        leg.tiers.length,
      '多品种回放暂停：' + a.ticker + ' 的保证金模式或完整维持档位无法验证'
    );
    let previous;
    for (const tier of leg.tiers) {
      need(
        finite(tier.lowerBound) &&
          tier.lowerBound >= 0 &&
          finite(tier.mmr) &&
          tier.mmr >= 0 &&
          tier.mmr < 1 &&
          finite(tier.deduction) &&
          tier.deduction >= 0 &&
          (previous
            ? tier.lowerBound > previous.lowerBound &&
              tier.mmr >= previous.mmr &&
              Math.abs(tier.deduction - previous.deduction - tier.lowerBound * (tier.mmr - previous.mmr)) <
                1e-5
            : tier.lowerBound === 0 && tier.deduction === 0),
        '多品种回放暂停：' + a.ticker + ' 的维持保证金档位不连续'
      );
      previous = tier;
    }
    return { p, a, leg };
  });
  return (ref) => {
    let crossEquity = s.hypeCash - s.hypeExternal - legacyUsed,
      crossMaintenance = 0,
      hasCross = false;
    for (const { p, a, leg } of legs) {
      const mark = (leg.mark ?? leg.price) + (a.id === base.id ? (ref - base.referencePrice) * leg.ratio : 0);
      const point = p.qty * leg.multiplier * leg.settleUsd,
        notional = Math.abs(point) * mark;
      const tier = leg.tiers.findLast((t) => notional >= t.lowerBound);
      need(
        mark > 0 && tier && (!finite(tier.maxNotional) || notional < tier.maxNotional),
        '多品种回放暂停：标记价超出已验证保证金档位'
      );
      const mm = Math.max(0, notional * tier.mmr - tier.deduction),
        pnl = point * (mark - p.entry);
      if (leg.marginMode === 'isolated') {
        if (p.margin + pnl <= mm) return true;
        crossEquity -= p.margin;
      } else {
        hasCross = true;
        crossEquity += pnl;
        crossMaintenance += mm;
      }
    }
    return hasCross && crossEquity <= crossMaintenance;
  };
}

// Persist only contract, market and risk inputs required to value an open lot.
function contractSnapshot(asset) {
  const pick = (obj, keys) =>
    Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, structuredClone(obj[k])]));
  const copy = pick(asset, [
    'id',
    'ticker',
    'name',
    'unit',
    'priceUnit',
    'benchmark',
    'referencePrice',
    'maxAgeSec',
    'verified',
    'minBuffer',
    'minMatchPct',
    'maxBasisPct',
    'vsProfit',
    'vsLoss',
    'feedMode',
    'mixedSource',
    'sourceIssues'
  ]);
  const keys = [
    'symbol',
    'benchmark',
    'type',
    'quote',
    'settle',
    'quoteUsd',
    'settleUsd',
    'quoteScale',
    'price',
    'asOf',
    'open',
    'ratio',
    'multiplier',
    'tick',
    'spread',
    'minQty',
    'step',
    'qtyUnit',
    'feeRate',
    'leverage',
    'mmr',
    'marginMode',
    'marginSource',
    'tiersVerified',
    'marginVerified',
    'tiers',
    'bid',
    'ask',
    'mark',
    'book',
    'slippageBps',
    'maxLeverage',
    'liqSource',
    'liqPrice',
    'liqQty',
    'liqAsOf',
    'liqEntry',
    'liqCollateral',
    'liqMarginMode',
    'fxAsOf',
    'fxValidUntil'
  ];
  for (const v of venues) copy[v] = pick(asset[v], keys);
  return copy;
}

export function createSimulation(input = {}, now = Date.now()) {
  const c = rules(input);
  need(
    [c.initialCapital, c.registrationFee, c.vsStart].every(finite) &&
      c.registrationFee >= 0 &&
      c.initialCapital >= c.registrationFee &&
      c.vsStart > 0,
    '本金、报名费或 VS 初始余额无效'
  );
  const s = {
    version: 2,
    revision: 0,
    initialCapital: c.initialCapital,
    stage: 'challenge',
    status: 'active',
    day: 1,
    cycle: 1,
    vsBalance: c.vsStart,
    hypeCash: c.initialCapital - c.registrationFee,
    fees: { vs: 0, hype: 0, registration: c.registrationFee },
    realized: { vs: 0, hype: 0 },
    received: 0,
    externalUnrecovered: 0,
    vsExternal: 0,
    hypeExternal: 0,
    positions: [],
    history: []
  };
  append(s, '购买考核号', { fee: c.registrationFee, venue: 'personal' }, [], now);
  return s;
}

function validate(s) {
  need(
    s?.version === 2 &&
      ['challenge', 'funded'].includes(s.stage) &&
      ['active', 'failed', 'withdrawn', 'abandoned', 'liquidated'].includes(s.status) &&
      ['vsBalance', 'hypeCash', 'received', 'initialCapital', 'vsExternal', 'hypeExternal'].every((k) =>
        finite(s[k])
      ) &&
      Number.isInteger(s.day) &&
      s.day > 0 &&
      Number.isInteger(s.cycle) &&
      s.cycle > 0 &&
      Number.isInteger(s.revision) &&
      s.revision >= 0 &&
      Array.isArray(s.positions) &&
      Array.isArray(s.history) &&
      s.history.length > 0 &&
      ['vs', 'hype', 'registration'].every((k) => finite(s.fees?.[k]) && s.fees[k] >= 0) &&
      venues.every((k) => finite(s.realized?.[k])),
    '模拟账本格式或金额无效'
  );
  const ids = new Set();
  for (const p of s.positions) {
    const key = p.assetId + '/' + p.venue;
    need(
      !ids.has(key) &&
        venues.includes(p.venue) &&
        finite(p.qty) &&
        p.qty !== 0 &&
        p.asset?.id === p.assetId &&
        finite(p.entry) &&
        p.entry > 0 &&
        finite(p.margin) &&
        p.margin >= 0 &&
        finite(p.asset[p.venue]?.price) &&
        p.asset[p.venue]?.multiplier > 0 &&
        p.asset[p.venue]?.settleUsd > 0,
      '持仓记录格式无效'
    );
    ids.add(key);
  }
  need(
    s.history.every(
      (e) =>
        typeof e.label === 'string' &&
        finite(Date.parse(e.time)) &&
        [e.vsBalance, e.hypeCash, e.vsEquity, e.hypeEquity, e.vsUsed, e.hypeUsed, e.fee, e.gross].every(
          finite
        )
    ),
    '流水记录格式无效'
  );
  return s;
}

export function getSimulation(config = {}) {
  const raw = globalThis.localStorage.getItem(SIM_KEY);
  return raw === null ? createSimulation(config) : validate(JSON.parse(raw));
}

function getAsset(p, assets) {
  return assets.find((a) => a.id === p.assetId) || p.asset;
}

export function accountView(s, assets = [], config = {}, legacyUsed = 0) {
  const a = {
    stage: s.stage,
    status: s.status,
    externalUnrecovered: s.externalUnrecovered ?? 0,
    vsBalance: s.vsBalance,
    hypeCash: s.hypeCash,
    vsUsed: s.vsExternal,
    hypeUsed: s.hypeExternal + legacyUsed,
    vsEquity: s.vsBalance,
    hypeEquity: s.hypeCash,
    positions: [],
    initialCapital: s.initialCapital,
    registrationPaid: s.fees.registration,
    totalFees: s.fees.vs + s.fees.hype,
    received: s.received
  };
  for (const p of s.positions) {
    const asset = getAsset(p, assets);
    const leg = asset[p.venue];
    const mark = leg.mark ?? leg.price;
    const unrealized = p.qty * (mark - p.entry) * leg.multiplier * leg.settleUsd;
    a[p.venue + 'Equity'] += unrealized;
    a[p.venue + 'Used'] += p.margin;
    a.positions.push({ ...p, asset, mark, unrealized });
  }
  for (const v of venues) a[v + 'Free'] = a[v + 'Equity'] - a[v + 'Used'];
  return a;
}

function append(s, label, detail, assets, time) {
  const a = accountView(s, assets);
  s.history.push({
    sequence: s.history.length + 1,
    time: stamp(time),
    day: s.day,
    cycle: s.cycle,
    stage: s.stage,
    label,
    venue: '',
    assetId: '',
    qty: 0,
    price: 0,
    gross: 0,
    fee: 0,
    ...detail,
    vsBalance: s.vsBalance,
    hypeCash: s.hypeCash,
    vsEquity: a.vsEquity,
    hypeEquity: a.hypeEquity,
    vsUsed: a.vsUsed,
    hypeUsed: a.hypeUsed,
    status: s.status
  });
}

export function firstPayout(balance, config = {}) {
  const c = rules(config);
  return Math.max(balance - c.vsStart, 0) * c.payoutShare;
}

function applyFill(s, venue, asset, leg, assets, time) {
  if (leg.tradeQty === 0) return;
  const held = s.positions.find((p) => p.assetId === asset.id && p.venue === venue);
  const target = leg.targetQty;
  need(
    [leg.tradeQty, target, leg.entryPrice, leg.realized, leg.tradeFee, leg.margin].every(finite) &&
      leg.entryPrice > 0 &&
      leg.tradeFee >= 0 &&
      leg.margin >= 0,
    '成交明细不完整'
  );
  const sameSide = held && target * held.qty > 0;
  const label = !held
    ? '开仓'
    : target === 0
      ? '平仓'
      : !sameSide
        ? '反向调仓'
        : Math.abs(target) > Math.abs(held.qty)
          ? '加仓'
          : '减仓';
  const cashKey = venue === 'vs' ? 'vsBalance' : 'hypeCash';
  s[cashKey] += leg.realized - leg.tradeFee;
  s.realized[venue] += leg.realized;
  s.fees[venue] += leg.tradeFee;
  s.positions = s.positions.filter((p) => p !== held);
  if (target) {
    need(finite(leg.avgEntry) && leg.avgEntry > 0, '新仓均价无效');
    s.positions.push({
      assetId: asset.id,
      venue,
      qty: target,
      entry: leg.avgEntry,
      margin: leg.margin,
      asset: contractSnapshot(asset),
      openedAt: sameSide ? held.openedAt : stamp(time)
    });
  }
  append(
    s,
    label,
    {
      venue,
      assetId: asset.id,
      qty: leg.tradeQty,
      price: leg.entryPrice,
      gross: leg.realized,
      fee: leg.tradeFee
    },
    assets,
    time
  );
}

export function verifyQuotes(a, now) {
  need(a && a.verified && finite(a.referencePrice) && a.referencePrice > 0, '标的映射或参考价无效');
  need(
    a.feedMode !== 'frozen' && !a.sourceIssues?.length,
    '行情来源不可用：' + (a.sourceIssues?.join('、') || '行情已冻结')
  );
  for (const v of venues) {
    const leg = a[v],
      label = (a.ticker || a.id) + ' ' + v;
    need(leg?.open === true && leg.type === 'linear', label + ' 休市或合约类型不支持');
    need(
      leg.benchmark === a.benchmark &&
        finite(leg.ratio) &&
        leg.ratio > 0 &&
        finite(leg.multiplier) &&
        leg.multiplier > 0 &&
        finite(leg.quoteUsd) &&
        leg.quoteUsd > 0 &&
        finite(leg.settleUsd) &&
        leg.settleUsd > 0 &&
        Math.abs((leg.quoteUsd * leg.ratio) / (leg.quoteScale ?? 1) - 1) < 0.000100000002,
      label + ' 基准、报价单位或汇率无法验证'
    );
    need(fxIsCurrent(leg, a.maxAgeSec, now), label + ' 换算汇率过期或时间不可验证');
    const ts = typeof leg.asOf === 'number' ? leg.asOf : Date.parse(leg.asOf);
    need(
      finite(ts) && ts <= now && finite(a.maxAgeSec) && now - ts <= a.maxAgeSec * 1000,
      label + ' 报价过期或时间不可验证'
    );
    const mark = leg.mark ?? leg.price,
      spread = leg.spread ?? 0;
    need(finite(mark) && mark > 0 && finite(spread) && spread >= 0, label + ' 标记价格或点差无效');
    const explicit =
      a.feedMode === 'live' ||
      (a.mixedSource && v === 'vs') ||
      leg.bid != null ||
      leg.ask != null ||
      leg.book != null;
    const bid = leg.book?.bids?.[0]?.[0] ?? leg.bid ?? (explicit ? NaN : mark - spread / 2);
    const ask = leg.book?.asks?.[0]?.[0] ?? leg.ask ?? (explicit ? NaN : mark + spread / 2);
    need(finite(bid) && bid > 0 && finite(ask) && ask >= bid, label + ' 缺少有效买一／卖一');
  }
}

function verifyPositionSources(s, assets, time) {
  const checked = new Set();
  for (const p of s.positions) {
    const a = getAsset(p, assets),
      orig = p.asset;
    need(
      (orig.feedMode !== 'live' || a.feedMode === 'live') &&
        (!orig.mixedSource || a.mixedSource || a.feedMode === 'live') &&
        a[p.venue].symbol === orig[p.venue].symbol &&
        a[p.venue].multiplier === orig[p.venue].multiplier &&
        a[p.venue].settle === orig[p.venue].settle &&
        a[p.venue].quote === orig[p.venue].quote,
      '现有持仓缺少相同来源与规格的可成交报价，请恢复其行情'
    );
    if (!checked.has(a.id)) {
      verifyQuotes(a, time);
      checked.add(a.id);
    }
  }
}

function currentHypeBreach(s, assets, config, time, legacy) {
  const hype = s.positions.filter((p) => p.venue === 'hype');
  if (!hype.length) return false;
  const first = getAsset(hype[0], assets);
  if (hype.length > 1) return portfolioRisk(s, first, assets, legacy)(first.referencePrice);
  // Isolate the cross/isolated calculation even if the VS leg has already been
  // closed. The reference cannot change in this instantaneous check.
  const leg = first.hype;
  if (leg.tiers?.length && (leg.tiersVerified || leg.marginVerified)) {
    const placeholder = { ...first, id: null };
    return portfolioRisk(s, placeholder, assets, legacy)(first.referencePrice);
  }
  const candidate = heldCandidate(s, first, assets, config, time, legacy);
  need(finite(candidate.liq), '现有 Hype 仓位的强平状态无法验证');
  return hype[0].qty < 0 ? first.referencePrice >= candidate.liq : first.referencePrice <= candidate.liq;
}

function closeHeld(s, assets, config, time, assetId) {
  for (const p of [...s.positions]) {
    if (assetId && p.assetId !== assetId) continue;
    const asset = getAsset(p, assets);
    need(asset[p.venue].open !== false, asset.ticker + ' 市场休市，无法模拟平仓');
    const timestamp = asset[p.venue].asOf;
    const age = time - (typeof timestamp === 'number' ? timestamp : Date.parse(timestamp));
    need(
      finite(age) && age >= 0 && age <= asset.maxAgeSec * 1000,
      asset.ticker + ' 的平仓报价过期或时间不可验证'
    );
    const fill = settleLeg(asset, p.venue, p.qty, p.entry, asset.referencePrice, config);
    need(fill.ok, fill.reasons?.join('、') || '平仓价格不可验证');
    applyFill(
      s,
      p.venue,
      asset,
      {
        targetQty: 0,
        tradeQty: -p.qty,
        entryPrice: fill.exitPrice,
        tradeFee: fill.fee,
        realized: fill.gross,
        margin: 0
      },
      assets,
      time
    );
  }
}

export function valueAt(s, assets, config) {
  const account = accountView(s, assets, config);
  const values = { vs: s.vsBalance, hype: s.hypeCash };
  for (const p of s.positions) {
    const asset = getAsset(p, assets);
    const fill = settleLeg(asset, p.venue, p.qty, p.entry, asset.referencePrice, config);
    need(fill.ok && finite(fill.net), fill.reasons?.join('、') || '无法计算可结算净值');
    values[p.venue] += fill.net;
  }
  return {
    ...account,
    vsSettled: values.vs,
    hypeSettled: values.hype,
    vsTrigger: config.triggerMode === 'mark' ? account.vsEquity : values.vs
  };
}

export function atReference(asset, ref, time = Date.now()) {
  need(finite(ref) && ref > 0, '情景价格必须为正数');
  const a = structuredClone(asset);
  for (const venue of venues) {
    const leg = a[venue];
    const move = (ref - a.referencePrice) * leg.ratio;
    leg.price += move;
    need(leg.price > 0, '映射后的本地价格无效');
    for (const k of ['bid', 'ask', 'mark', 'markPrice', 'bestBid', 'bestAsk'])
      if (finite(leg[k])) leg[k] += move;
    for (const side of ['bids', 'asks']) {
      for (const levels of new Set([leg[side], leg.book?.[side], leg.depth?.[side]])) {
        if (!Array.isArray(levels)) continue;
        for (const level of levels) {
          if (Array.isArray(level)) level[0] = Number(level[0]) + move;
          else if (finite(Number(level.px))) level.px = Number(level.px) + move;
          else if (finite(Number(level.price))) level.price = Number(level.price) + move;
        }
      }
    }
    leg.asOf = stamp(time);
  }
  a.referencePrice = ref;
  return a;
}

export function assetsWith(assets, asset) {
  return [asset, ...assets.filter((a) => a.id !== asset.id)];
}

export function heldCandidate(s, asset, assets, config, now = Date.now(), legacyUsed = 0) {
  const held = s.positions.filter((p) => p.assetId === asset.id);
  const qty = Object.fromEntries(venues.map((v) => [v, held.find((p) => p.venue === v)?.qty ?? 0]));
  need(qty.vs !== 0 && qty.hype !== 0 && qty.vs * qty.hype < 0, '该品种需要两侧反向持仓才能回放触线');
  const account = accountView(s, assets, config, legacyUsed);
  return analyzeCandidate(
    asset,
    account,
    config,
    {
      vsLong: qty.vs > 0,
      targetQty: qty,
      vsUsd: Math.abs(qty.vs) * asset.vs.price * asset.vs.multiplier * asset.vs.settleUsd,
      hypeUsd: Math.abs(qty.hype) * asset.hype.price * asset.hype.multiplier * asset.hype.settleUsd
    },
    now
  );
}

function adopt(s, provided, assets, config, time, legacyUsed) {
  need(!s.positions.length, '请先结清本地模拟持仓，再导入看板起点');
  need(
    provided &&
      ['challenge', 'funded'].includes(provided.stage) &&
      finite(provided.vsBalance) &&
      finite(provided.hypeCash) &&
      Array.isArray(provided.positions),
    '看板缺少阶段、账面余额或持仓'
  );
  const positions = provided.positions
    .filter((p) => p.qty !== 0)
    .map((p) => {
      const asset = assets.find((a) => a.id === p.assetId);
      need(
        asset &&
          venues.includes(p.venue) &&
          finite(p.qty) &&
          finite(p.entry) &&
          p.entry > 0 &&
          finite(p.margin) &&
          p.margin >= 0,
        '看板持仓缺少品种、均价或保证金，无法接管'
      );
      const info = Object.fromEntries(
        ['marginMode', 'maintenance', 'maintenanceMargin', 'liqPrice', 'mmr']
          .filter((k) => p[k] !== undefined)
          .map((k) => [k, p[k]])
      );
      return {
        ...info,
        assetId: asset.id,
        venue: p.venue,
        qty: p.qty,
        entry: p.entry,
        margin: p.margin,
        asset: contractSnapshot(asset),
        openedAt: stamp(time)
      };
    });
  s.vsBalance = provided.vsBalance;
  s.hypeCash = provided.hypeCash;
  need(
    finite(provided.externalUnrecovered ?? 0) && (provided.externalUnrecovered ?? 0) >= 0,
    '外部历史成本无效'
  );
  s.externalUnrecovered = provided.externalUnrecovered ?? 0;
  s.stage = provided.stage;
  s.status = 'active';
  s.positions = positions;
  s.vsExternal = s.hypeExternal = 0;
  const a = accountView(s, assets, config, legacyUsed);
  for (const v of venues) {
    const equity = provided[v + 'Equity'];
    need(
      !finite(equity) || Math.abs(equity - a[v + 'Equity']) <= Math.max(0.01, Math.abs(equity) * 1e-5),
      '看板净值与可解释持仓不一致，须先补全持仓或校正均价'
    );
    const declared = Math.max(
      provided[v + 'Used'] || 0,
      finite(provided[v + 'Free']) ? a[v + 'Equity'] - provided[v + 'Free'] : 0
    );
    s[v + 'External'] = Math.max(0, declared - a[v + 'Used']);
  }
  verifyPositionSources(s, assets, time);
  append(s, '从看板建立模拟起点', {}, assets, time);
}

function similar(a, b) {
  if (!a || !b) return true;
  if (
    a.stage !== b.stage ||
    (a.externalUnrecovered ?? 0) !== (b.externalUnrecovered ?? 0) ||
    a.positions?.length !== b.positions.length
  )
    return false;
  if (
    ['vsBalance', 'hypeCash', 'vsUsed', 'hypeUsed', 'vsFree', 'hypeFree'].some(
      (k) => finite(a[k]) && Math.abs(a[k] - b[k]) > 0.01
    )
  )
    return false;
  return a.positions.every((p) =>
    b.positions.some(
      (q) =>
        q.assetId === p.assetId &&
        q.venue === p.venue &&
        Math.abs(q.qty - p.qty) < 1e-9 &&
        Math.abs(q.entry - p.entry) < 1e-5
    )
  );
}

function receivePayout(s, assets, config, time) {
  const paid = firstPayout(s.vsBalance, config);
  need(paid > 0, '可结算余额未超过出金本金，首次提款额为零');
  s.received += paid;
  s.hypeCash += paid;
  s.vsBalance -= paid;
  s.status = 'withdrawn';
  append(s, '首次出金到账，本轮结束', { venue: 'personal', receipt: paid }, assets, time);
}

export function applySimulation(input, action, context = {}) {
  need(
    !input.observation || context.resolvingObservation || context.observationBranch,
    '已有未结算触线观察，不能跨越该事件继续推演'
  );
  const s = structuredClone(input);
  delete s.observation;
  const config = rules(context.config);
  const time = context.now ?? Date.now();
  const asset = context.asset;
  const assets = context.assets || (asset ? [asset] : []);
  const legacy = context.legacyUsed || 0;
  const type = action.type;
  if (s.positions.length && !['adopt', 'rebuy'].includes(type)) {
    verifyPositionSources(s, assets, time);
    if (!context.observationBranch && (type !== 'event' || action.event !== 'liquidation')) {
      const crossed = currentHypeBreach(s, assets, config, time, legacy);
      need(!crossed, 'Hype 已触及强平线，不能在之后的终点结算成功或继续交易');
    }
  }
  if (type === 'adopt') adopt(s, action.account, assets, config, time, legacy);
  else if (type === 'rebuy') {
    need(!s.positions.length, '重新买号前请先结清所有持仓');
    need(s.hypeCash - legacy - s.hypeExternal >= config.registrationFee, '个人可用现金不足以重新支付报名费');
    s.hypeCash -= config.registrationFee;
    s.fees.registration += config.registrationFee;
    s.vsBalance = config.vsStart;
    s.vsExternal = 0;
    s.cycle++;
    s.stage = 'challenge';
    s.status = 'active';
    append(s, '重新购买考核号', { venue: 'personal', fee: config.registrationFee }, assets, time);
  } else {
    need(s.status === 'active', '该模拟周期已结束');
    if (type === 'target') {
      const account = accountView(s, assets, config, legacy);
      need(similar(context.viewAccount, account), '看板与模拟账本不一致，请先以当前看板建立模拟起点');
      const r = analyzeCandidate(asset, account, config, action.order, time);
      need(
        r.ok,
        r.reasons?.map((x) => (typeof x === 'string' ? x : x.message)).join('、') ||
          '目标仓位未通过资金及风控验算'
      );
      for (const venue of venues) applyFill(s, venue, asset, r[venue], assets, time);
    } else if (type === 'mark') {
      for (const p of s.positions) p.asset = contractSnapshot(getAsset(p, assets));
      append(s, action.label || '按收盘价计值', {}, assets, time);
    } else if (type === 'withdraw') {
      need(s.stage === 'funded', '考核阶段不可提款');
      const v = valueAt(s, assets, config);
      need(firstPayout(v.vsSettled, config) > EPS, '可结算余额未超过出金本金，可提款额为零');
      closeHeld(s, assets, config, time);
      receivePayout(s, assets, config, time);
    } else if (type === 'close' || type === 'day' || type === 'abandon' || type === 'settle-now') {
      const v = valueAt(s, assets, config);
      const fail = s.stage === 'challenge' ? config.challengeFail : config.fundedFail;
      const target = s.stage === 'challenge' ? config.challengeTarget : config.payoutTarget;
      const triggered =
        v.vsTrigger <= fail + EPS ? 'failure' : v.vsTrigger >= target - EPS ? 'success' : null;
      if (triggered) return applySimulation(s, { type: 'event', event: triggered }, context);
      need(type !== 'settle-now', '当前可验证净值处于两条规则线之间');
      closeHeld(s, assets, config, time, type === 'close' ? asset?.id : undefined);
      if (type === 'day') {
        append(s, '日内未到线平仓／结转', {}, assets, time);
        s.day++;
      }
      if (type === 'abandon') {
        s.status = 'abandoned';
        append(s, '明确放弃本轮账户', {}, assets, time);
      }
    } else if (type === 'event') {
      const v = valueAt(s, assets, config);
      const target = s.stage === 'challenge' ? config.challengeTarget : config.payoutTarget;
      const fail = s.stage === 'challenge' ? config.challengeFail : config.fundedFail;
      const evt = action.event;
      if (evt === 'success') need(v.vsTrigger >= target - EPS, '可验证净值尚未达到目标线');
      else if (evt === 'failure') need(v.vsTrigger <= fail + EPS, '可验证净值尚未到达失败线');
      else need(evt === 'liquidation' && context.liquidationVerified === true, '无法验证强平事件');
      closeHeld(s, assets, config, time);
      if (evt === 'liquidation') {
        s.status = 'liquidated';
        append(s, 'Hype 触及强平线，终止推演', {}, assets, time);
      } else if (evt === 'failure') {
        s.status = 'failed';
        append(s, s.stage === 'challenge' ? '考核失败' : '出金号爆号', {}, assets, time);
      } else if (s.stage === 'challenge') {
        append(s, '考核达标，遗留仓位已结算', {}, assets, time);
        s.vsBalance = config.vsStart;
        s.vsExternal = 0;
        s.stage = 'funded';
        append(s, '取得出金号，VS 重置', {}, assets, time);
      } else {
        receivePayout(s, assets, config, time);
      }
    } else throw new Error('未知的模拟操作');
  }
  s.revision++;
  return validate(s);
}

// Observations are independent of transactions. Recording a breached mark
// never creates a fill or realizes P&L. Confirmation uses the original quote.
function recordObservations(s, context) {
  if (s.status !== 'active' || !s.positions.length) return null;
  const prior = readObservation(s);
  const time = context.now ?? Date.now(),
    config = rules(context.config),
    assets = context.assets;
  const legacy = context.legacyUsed ?? getLedger().used;
  verifyPositionSources(s, assets, time);
  const trigger = valueAt(s, assets, config).vsTrigger,
    events = [];
  if (trigger >= (s.stage === 'challenge' ? config.challengeTarget : config.payoutTarget) - EPS)
    events.push('success');
  if (trigger <= (s.stage === 'challenge' ? config.challengeFail : config.fundedFail) + EPS)
    events.push('failure');
  if (currentHypeBreach(s, assets, config, time, legacy)) events.push('liquidation');
  if (!events.length && !prior) return null;
  const dates = Object.fromEntries(
    venues.map((v) => {
      const times = s.positions
        .filter((p) => p.venue === v)
        .map((p) => getAsset(p, assets)[v].asOf)
        .map((t) => (typeof t === 'number' ? t : Date.parse(t)));
      return [v, times.length ? Math.min(...times) : time];
    })
  );
  const proofs = prior ? [...prior.proofs] : [];
  const known = new Set(proofs.map((proof) => proof.event));
  for (const event of events) {
    if (known.has(event)) continue;
    const which = event === 'liquidation' ? 'hype' : 'vs';
    const quotes = s.positions
      .filter((p) => p.venue === which)
      .map((p) => getAsset(p, assets)[which].asOf)
      .map((t) => (typeof t === 'number' ? t : Date.parse(t)));
    const from = quotes.length ? Math.min(...quotes) : time,
      to = quotes.length ? Math.max(...quotes) : time;
    // A new disjoint later observation cannot displace the first recorded one.
    if (
      prior?.proofs.length &&
      prior.proofs.every((p) => p.guards[which] >= p.to) &&
      from > Math.max(...prior.proofs.map((x) => x.to))
    )
      continue;
    const markets = s.positions
      .map((p) => getAsset(p, assets))
      .filter((a, i, all) => all.findIndex((x) => x.id === a.id) === i)
      .map(contractSnapshot);
    const proof = {
      event,
      time,
      from,
      to,
      guards: dates,
      assets: markets,
      config: pickRules(config),
      legacy
    };
    const result = applySimulation(
      s,
      { type: 'event', event },
      {
        assets: markets,
        config,
        now: time,
        legacyUsed: legacy,
        liquidationVerified: event === 'liquidation',
        observationBranch: true
      }
    );
    proofs.push({ ...proof, cash: result.hypeCash, stage: result.stage, status: result.status });
  }
  if (!proofs.length) return null;
  const first = proofs[0],
    other = first.event === 'liquidation' ? 'vs' : 'hype';
  const pending = proofs.length === 1 && Math.max(first.guards[other], dates[other]) < first.to;
  if (proofs.length === prior?.count && pending === prior.pending) return prior;
  if (proofs.length === 1 && !pending)
    proofs[0] = {
      ...first,
      guards: { ...first.guards, [other]: Math.max(first.guards[other], dates[other]) }
    };
  const record = { revision: s.revision, proofs, count: proofs.length, pending };
  localStorage.setItem(SIM_KEY, JSON.stringify({ ...s, observation: record }));
  return record;
}

export function checkRecordedBeforeWrite(s, context) {
  if (!s.positions.length || s.status !== 'active') return;
  need(!recordObservations(s, context), '已观察到触线，请按首次已记录报价结算');
}

export async function observeSimulationRisk(context) {
  const current = getSimulation(context.config);
  if (!current.positions.length || current.status !== 'active') return null;
  need(globalThis.navigator?.locks?.request, '浏览器无法安全记录触线状态');
  return navigator.locks.request(LEDGER_KEY, () =>
    recordObservations(getSimulation(context.config), context)
  );
}

function pickRules(config) {
  return Object.fromEntries(Object.keys(DEFAULT_CONFIG).map((k) => [k, config[k]]));
}

export function readObservation(s) {
  return s.observation ?? null;
}

export async function transactSimulation(transform, config, allowObserved = false) {
  need(globalThis.navigator?.locks?.request, '浏览器不支持安全的排他记账');
  return navigator.locks.request(LEDGER_KEY, { mode: 'exclusive' }, () => {
    const old = getSimulation(config);
    need(allowObserved || !readObservation(old), '已有先发生的触线观察，请先查看并结算首个已记录触线');
    const next = transform(old, getLedger().used);
    validate(next);
    localStorage.setItem(SIM_KEY, JSON.stringify(next));
    return next;
  });
}

export function actSimulation(action, context = {}) {
  if (action.type === 'observed-event') {
    return transactSimulation(
      (s) => {
        const record = readObservation(s);
        need(record?.revision === s.revision, '没有当前持仓的触线快照');
        need(
          record.proofs.length === 1 && !record.pending,
          '触线顺序不确定或另一侧报价尚未追平，不可写入单一结局'
        );
        const proof = record.proofs[0];
        return applySimulation(
          s,
          { type: 'event', event: proof.event },
          {
            assets: proof.assets,
            config: proof.config,
            now: proof.time,
            legacyUsed: proof.legacy,
            liquidationVerified: proof.event === 'liquidation',
            resolvingObservation: true
          }
        );
      },
      context.config,
      true
    );
  }
  return transactSimulation((s, legacyUsed) => {
    const locked = { ...context, legacyUsed, now: Date.now() };
    checkRecordedBeforeWrite(s, locked);
    return applySimulation(s, action, locked);
  }, context.config);
}

export function restoreSimulation(raw, expectedRevision, config) {
  const imported = validate(JSON.parse(raw));
  return transactSimulation(
    (s, legacyUsed) => {
      need(s.revision === expectedRevision, '账本在恢复前已变化，请重新确认');
      const a = accountView(imported, [], config, legacyUsed);
      need(!legacyUsed || a.hypeFree >= -EPS, '旧版冻结占用与导入状态冲突');
      const next = structuredClone(imported);
      next.revision = s.revision + 1;
      for (const p of next.positions) p.asset = contractSnapshot(p.asset);
      if (next.observation) {
        need(
          next.observation.revision === imported.revision &&
            Array.isArray(next.observation.proofs) &&
            next.observation.proofs.length > 0,
          '备份的未结算触线观察无效'
        );
        next.observation.revision = next.revision;
        for (const q of next.observation.proofs) q.assets = q.assets.map(contractSnapshot);
      }
      return next;
    },
    config,
    true
  );
}

export function historyCsv(sim) {
  const keys = [
    'sequence',
    'time',
    'day',
    'cycle',
    'stage',
    'label',
    'venue',
    'assetId',
    'qty',
    'price',
    'gross',
    'fee',
    'receipt',
    'vsBalance',
    'hypeCash',
    'vsEquity',
    'hypeEquity',
    'vsUsed',
    'hypeUsed',
    'status'
  ];
  const quote = (v) => {
    let text = String(v ?? '');
    if (typeof v === 'string' && /^[=+@\-\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [keys.join(','), ...sim.history.map((e) => keys.map((k) => quote(e[k])).join(','))].join('\r\n');
}
