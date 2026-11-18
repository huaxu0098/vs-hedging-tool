import { fxIsCurrent } from './feeds.js';
import { createTemplates } from './assets.js';
import { DEFAULT_CONFIG } from './decision.js';

export const WORKSPACE_KEY = 'vs-hype:workspace:v2';
const OLD_ASSETS = 'vs-hype:assets:v1';
export function readWorkspace() {
  const raw = localStorage.getItem(WORKSPACE_KEY);
  if (raw !== null) {
    const state = JSON.parse(raw);
    if (
      state.version !== 2 ||
      !Array.isArray(state.assets) ||
      !state.assets.length ||
      !state.config ||
      state.assets.some((a) => !a.id || !a.vs || !a.hype)
    )
      throw Error('本地工作台配置格式有误，已停止计算。');
    return state;
  }
  const templates = createTemplates(),
    old = localStorage.getItem(OLD_ASSETS);
  // Custom inputs and prior timestamps remain intact. v1 did not attest risk tiers.
  const assets =
    old === null
      ? templates
      : JSON.parse(old).map((item) => {
          const sample = templates.find((a) => a.id === item.id);
          return {
            ...item,
            priceUnit: sample && item.priceUnit === '美元' ? sample.priceUnit : item.priceUnit,
            vs: { ...item.vs, marginMode: 'isolated' },
            hype: {
              ...item.hype,
              marginMode: 'cross',
              tiersVerified: false,
              tiers: [],
              marginSource: '由旧版导入，待核实'
            }
          };
        });
  if (!assets.length) throw Error('原有品种配置为空，无法迁移。');
  const state = {
    version: 2,
    assets,
    config: { ...DEFAULT_CONFIG, targets: [10500, 11000, 11500] },
    manual: null
  };
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(state));
  return state;
}
export async function updateWorkspace(change) {
  if (!navigator.locks) throw Error('需要能锁定本地存储的浏览器。');
  return navigator.locks.request(WORKSPACE_KEY, () => {
    const state = readWorkspace();
    change(state);
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(state));
    return state;
  });
}
export function dashboardAccount(local, manual, snapshot, asset, assets, legacyHeld = 0) {
  const account = structuredClone(manual ?? local),
    issues = [];
  // Imported balances do not know about locks still outstanding in the old simulator.
  if (manual) {
    account.hypeUsed += legacyHeld;
    account.hypeFree -= legacyHeld;
  }
  const active = snapshot && snapshot.mode !== 'offline';
  for (const venue of ['vs', 'hype']) {
    const source =
      snapshot && (active || venue === 'vs')
        ? venue === 'hype'
          ? (asset.hype.account ?? null)
          : Object.hasOwn(asset.vs, 'account')
            ? asset.vs.account
            : snapshot?.fxMode === undefined &&
                (!snapshot?.vs?.account?.currency || snapshot.vs.account.currency === 'USD')
              ? snapshot?.vs?.account
              : null
        : null;
    if (!source) {
      if (snapshot?.[venue]?.account && (active || venue === 'vs'))
        issues.push((venue === 'vs' ? 'VS' : 'Hype') + ' 账户尚无可靠的美元估值。');
      continue;
    }
    if (venue === 'vs' && source.stage) account.stage = source.stage;
    const equity = source.equity,
      positions = source.positions;
    const complete = Array.isArray(positions);
    const floating =
      complete && positions.every((p) => Number.isFinite(p.upnl))
        ? positions.reduce((sum, p) => sum + p.upnl, 0)
        : null;
    const balance =
      source.balance ??
      source.cash ??
      (Number.isFinite(equity) && Number.isFinite(floating) ? equity - floating : null);
    const merged = [
      [venue === 'vs' ? 'vsBalance' : 'hypeCash', balance],
      [venue + 'Equity', equity],
      [venue + 'Used', source.used],
      [venue + 'Free', source.free]
    ];
    for (const [key, val] of merged) {
      if (Number.isFinite(val)) account[key] = val;
      else issues.push((venue === 'vs' ? 'VS' : 'Hype') + ' 账户快照缺少 ' + key + '，请补全账户快照。');
    }
    if (!complete) issues.push(venue + ' 账户未提供完整持仓列表。');
    else {
      account.positions = account.positions.filter((p) => p.venue !== venue);
      for (const p of positions) {
        if (p.qty === 0) continue;
        const matchesCurrent =
          p.symbol && [snapshot?.[venue]?.symbol, asset[venue].symbol].includes(p.symbol);
        const sameSource = (a) => a.feedMode === 'live' || (venue === 'vs' && a.mixedSource);
        // An imported external wallet can contain other markets. Only attach
        // corroborated live specs; an offline template cannot price its liquidation.
        const candidates = assets.filter(
          (a) =>
            (!active || sameSource(a)) &&
            (!p.assetId || p.assetId === a.id) &&
            (!p.symbol || p.symbol === a[venue].symbol)
        );
        const matched = matchesCurrent && (!p.assetId || p.assetId === asset.id);
        const spec = matched
          ? asset
          : candidates.length === 1 && (p.symbol || p.assetId)
            ? candidates[0]
            : undefined;
        if (p.assetId === asset.id && !spec && p.symbol) issues.push(venue + ' 持仓代码与当前合约不一致。');
        const id = spec?.id ?? (p.assetId === asset.id ? null : p.assetId) ?? 'external:' + String(p.symbol);
        account.positions.push({
          ...p,
          assetId: id,
          venue,
          margin: p.margin ?? p.marginUsed,
          unrealized: p.upnl,
          asset: spec
        });
      }
    }
    if (venue === 'hype') {
      account.hypeFree -= legacyHeld;
      account.hypeUsed += legacyHeld;
    }
  }
  for (const v of ['vs', 'hype']) {
    const positions = account.positions.filter((p) => p.venue === v);
    const value = (p) => {
      if (Number.isFinite(p.upnl ?? p.unrealized)) return p.upnl ?? p.unrealized;
      const a = p.assetId === asset.id ? asset : assets.find((x) => x.id === p.assetId);
      const leg = a?.[v];
      return leg ? p.qty * leg.multiplier * leg.settleUsd * ((leg.mark ?? leg.price) - p.entry) : NaN;
    };
    const expected =
      account[v === 'vs' ? 'vsBalance' : 'hypeCash'] + positions.reduce((sum, p) => sum + value(p), 0);
    if (
      !Number.isFinite(expected) ||
      !Number.isFinite(account[v + 'Equity']) ||
      Math.abs(expected - account[v + 'Equity']) > Math.max(0.05, Math.abs(expected) * 1e-5)
    ) {
      issues.push(v + ' 净值与已结算余额、完整持仓浮盈不一致，请核对快照。');
    }
  }
  return { account, issues };
}

// A simulated fill retains its contract and market origin. Switching tabs or
// editing a contract cannot revalue yesterday's position with an unrelated feed.
export function resolveHeldMarket(candidate, heldAsset, now = Date.now()) {
  if (!heldAsset) return candidate;
  const family = (a) =>
    a.feedMode === 'live' || a.feedMode === 'frozen' ? 'live' : a.mixedSource ? 'mixed' : 'offline';
  const signature = (a) =>
    ['vs', 'hype'].map((v) => [
      a[v].symbol,
      a[v].benchmark,
      a[v].type,
      a[v].quote,
      a[v].settle,
      a[v].multiplier,
      family(a) === 'live' || (family(a) === 'mixed' && v === 'vs')
        ? Number((a[v].ratio * a[v].quoteUsd).toPrecision(12))
        : a[v].ratio,
      a[v].quoteScale ?? 1,
      a[v].qtyUnit
    ]);
  let asset = candidate;
  const reasons = [...(candidate.sourceIssues ?? [])];
  if (
    family(candidate) !== family(heldAsset) ||
    JSON.stringify(signature(candidate)) !== JSON.stringify(signature(heldAsset))
  ) {
    asset = heldAsset;
    reasons.push(candidate.ticker + ' 已有仓位的行情来源或合约规格与当前设置不同。请切回原来源并刷新。');
  }
  for (const leg of [asset.vs, asset.hype]) {
    if (!fxIsCurrent(leg, asset.maxAgeSec, now))
      reasons.push(asset.ticker + ' 已有仓位的 USD 换算汇率过期，须更新后才能估值。');
    const t = typeof leg.asOf === 'number' ? leg.asOf : Date.parse(leg.asOf);
    if (!Number.isFinite(t) || t > now || now - t > asset.maxAgeSec * 1000)
      reasons.push(asset.ticker + ' 已有仓位的报价过期，须更新后才能估值。');
  }
  return { ...asset, sourceIssues: [...new Set(reasons)] };
}

export function strategyBackup(state) {
  return { kind: 'vs-hype-settings', version: 1, rules: state.config, assets: state.assets };
}
export function loadStrategyBackup(destination, text) {
  const bundle = JSON.parse(text);
  if (
    bundle.kind !== 'vs-hype-settings' ||
    bundle.version !== 1 ||
    !Array.isArray(bundle.assets) ||
    !bundle.assets.length ||
    !bundle.rules ||
    typeof bundle.rules !== 'object'
  )
    throw Error('文件不是本工具导出的品种与规则。');
  const ids = new Set();
  for (const asset of bundle.assets) {
    if (
      !asset ||
      ['id', 'ticker', 'name', 'benchmark', 'priceUnit'].some(
        (k) => typeof asset[k] !== 'string' || !asset[k].trim()
      ) ||
      ids.has(asset.id) ||
      !Number.isFinite(asset.referencePrice) ||
      asset.referencePrice <= 0
    )
      throw Error('配置含重复或缺失的品种标识。');
    ids.add(asset.id);
    for (const v of ['vs', 'hype']) {
      const leg = asset[v];
      if (
        !leg ||
        typeof leg.symbol !== 'string' ||
        !['linear', 'nonlinear', 'inverse', 'other'].includes(leg.type) ||
        ![leg.step, leg.minQty, leg.tick, leg.multiplier].every((n) => Number.isFinite(n) && n > 0)
      )
        throw Error('合约代码、乘数或下单规则无效。');
      delete leg.liqScopeId;
    }
  }
  const rules = { ...DEFAULT_CONFIG, ...bundle.rules };
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (typeof value === 'number' && !Number.isFinite(rules[key])) throw Error('规则数值无效。');
  }
  if (!Array.isArray(rules.targets) || rules.targets.some((n) => !Number.isFinite(n)))
    throw Error('出金对比目标格式无效。');
  destination.config = rules;
  for (const asset of bundle.assets) {
    const index = destination.assets.findIndex((a) => a.id === asset.id);
    if (index === -1) destination.assets.push(asset);
    else destination.assets[index] = asset;
  }
}
