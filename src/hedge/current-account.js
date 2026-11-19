import { dec, out, nonnegative, positive } from './math.js';
import { readAccount, accountMode } from './adapters.js';

export async function accountSnapshot(user, asset, query) {
  if (!/^0x[0-9a-f]{40}$/i.test(user)) throw Error('请填写有效的 Hype 公开地址');
  const types = [
    'clearinghouseState',
    'frontendOpenOrders',
    'userAbstraction',
    'activeAssetData',
    'userFees'
  ];
  const data = await Promise.allSettled(
    types.map((type) => query({ type, user, ...(type === 'activeAssetData' ? { coin: asset } : {}) }))
  );
  if (data[0].status !== 'fulfilled') throw Error('Hype 账户查询失败');
  const result = (i) => (data[i].status === 'fulfilled' ? data[i].value : undefined);
  const receivedAt = new Date().toISOString();
  const account = readAccount(result(0), { user, dex: '', token: 'USDC', receivedAt });
  if (!account.occurredAt) throw Error('Hype 账户快照缺少来源时间');
  const pos = account.positions.find((p) => p.symbol === asset);
  const orders = result(1);
  const mapped = Array.isArray(orders)
    ? orders
        .filter((o) => o.coin === asset)
        .map((o) => {
          if (!['A', 'B'].includes(o.side) || o.oid == null) throw Error('挂单结构未识别');
          return {
            id: String(o.oid),
            qty: out(positive(o.sz).times(o.side === 'A' ? -1 : 1)),
            conditional: !!o.isTrigger,
            reduceOnly: !!o.reduceOnly,
            price: o.limitPx
          };
        })
    : null;
  const cap = result(3);
  const validCap = cap?.user?.toLowerCase() === user.toLowerCase() && cap.coin === asset;
  const mode = result(2) ?? '未知';
  const unsupported = accountMode(mode) !== 'standard';
  const marginMode = validCap ? cap.leverage?.type : pos?.leverage?.type;
  const qty = pos?.qty ?? '0';
  const anchor =
    pos && !dec(qty).isZero() && pos.entry ? out(dec(pos.entry).plus(dec(pos.pnl).div(qty))) : null;
  return {
    source: 'Hype 主网 API',
    at: account.occurredAt,
    receivedAt,
    equity: unsupported ? null : account.equity,
    rawEquity: account.equity,
    qty,
    anchor,
    orders: mapped,
    mode,
    unsupported,
    marginMode,
    otherPositions: account.positions.some((p) => p.symbol !== asset && !dec(p.qty).isZero()),
    otherHold:
      !unsupported &&
      account.positions.every((p) => p.symbol === asset || dec(p.qty).isZero()) &&
      Array.isArray(orders) &&
      !orders.length
        ? '0'
        : null,
    liquidation: pos?.liquidation ?? null,
    directionalFree:
      validCap && Array.isArray(cap.availableToTrade) && cap.availableToTrade.length === 2
        ? cap.availableToTrade.map((x) => out(nonnegative(x)))
        : null,
    leverage: validCap ? String(cap.leverage?.value ?? '') : null,
    capacity: validCap ? cap.maxTradeSzs : null,
    fee: result(4)?.userCrossRate ? out(nonnegative(result(4).userCrossRate)) : null,
    used: account.used,
    withdrawable: account.withdrawable
  };
}

export function manualAccount(state, asset, side) {
  const leg = state.assets[asset]?.[side] ?? {},
    shared = state.shared[side];
  const equity = shared ? shared.equity : leg.equity;
  const equityAt = (shared ? shared.at : leg.equityAt) ?? null;
  const equitySource = shared
    ? (shared.source ?? state.assets[shared.asset]?.[side]?.origins?.equity?.source)
    : leg.origins?.equity?.source;
  const timestamps = [equityAt, leg.qtyAt].filter(Boolean).sort();
  return {
    ...leg,
    equity,
    equityAt,
    qtyAt: leg.qtyAt ?? null,
    freeAt: leg.origins?.free?.at ?? null,
    anchor: (!shared || shared.asset === asset) && equityAt === leg.equityAt ? leg.anchor : null,
    at: timestamps[0],
    source: equitySource || '本机手工快照',
    equityAsset: shared?.asset ?? asset,
    otherPositions:
      leg.otherPositions ||
      Object.entries(state.assets).some(
        ([sym, s]) => sym !== asset && s[side]?.qty && Number(s[side].qty) !== 0
      )
  };
}

// Planned starting balances belong to the formula worksheet, never to the live account store.
export function presetAccount(r, side) {
  const common = {
    sourceKind: 'plan',
    source: '预设资金规划',
    qty: '0',
    orders: [],
    otherHold: '0',
    marginMode: 'cross'
  };
  try {
    const capital = nonnegative(r.planCapital);
    const paid = nonnegative(r.registration);
    if (paid.gt(capital)) throw Error('报名费超过预设个人本金');
    const equity =
      side === 'pf'
        ? out(positive(r.planPF))
        : r.stage === 'funded'
          ? out(nonnegative(r.planFundedCash))
          : out(capital.minus(paid));
    return {
      ...common,
      equity,
      free: equity,
      leverage: side === 'hl' ? out(positive(r.planLeverage)) : null
    };
  } catch (e) {
    return { ...common, error: '请核对预设参数：' + e.message };
  }
}
