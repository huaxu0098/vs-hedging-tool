import { dec, out, nonnegative, positive } from './math.js';
import { readAccount, accountMode } from './adapters.js';

export async function accountSnapshot(user, asset, query, clock = Date.now) {
  if (!/^0x[0-9a-f]{40}$/i.test(user)) throw Error('请填写有效的 Hype 公开地址');
  const types = [
    'clearinghouseState',
    'frontendOpenOrders',
    'userAbstraction',
    'activeAssetData',
    'userFees',
    'spotClearinghouseState'
  ];
  const requested = {};
  const data = await Promise.allSettled(
    types.map((type) => {
      requested[type] = new Date(clock()).toISOString();
      return query({ type, user, ...(type === 'activeAssetData' ? { coin: asset } : {}) });
    })
  );
  if (data[0].status !== 'fulfilled') throw Error('Hype 账户查询失败');
  const result = (i) => (data[i].status === 'fulfilled' ? data[i].value : undefined);
  const receivedAt = new Date(clock()).toISOString();
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
  const spotBalances = Array.isArray(result(5)?.balances) ? result(5).balances : null;
  const spotUsdcRow = spotBalances?.find((b) => b.token === 0 || b.coin === 'USDC');
  const spotUsdcTotal = spotUsdcRow?.total != null ? nonnegative(String(spotUsdcRow.total)) : null;
  const nonUsdcSpot = spotBalances
    ? spotBalances.filter((b) => b.token !== 0 && b.coin !== 'USDC' && dec(String(b.total || '0')).gt(0))
    : [];
  const isUnifiedUsdcOnly = mode === 'unifiedAccount' && spotBalances != null && nonUsdcSpot.length === 0;
  const unsupported = accountMode(mode) !== 'standard' && !isUnifiedUsdcOnly;
  const marginMode = validCap ? cap.leverage?.type : pos?.leverage?.type;
  const qty = pos?.qty ?? '0';
  const anchor =
    pos && !dec(qty).isZero() && pos.entry ? out(dec(pos.entry).plus(dec(pos.pnl).div(qty))) : null;
  const cross=result(0).crossMarginSummary;
  const positionsElsewhere=account.positions.some(p=>p.symbol!==asset && !dec(p.qty).isZero());
  const targetMargin=marginMode==='cross' && pos ? dec(pos.margin) : dec('0');
  const reportedUsed=cross?.totalMarginUsed == null ? null : nonnegative(String(cross.totalMarginUsed));
  // A wallet-wide summary can contain isolated collateral. Never use it as
  // the cross pool. Orders of any symbol can reserve this pool as well.
  const knownHolds=!unsupported && !positionsElsewhere && Array.isArray(orders) && !orders.length;
  const otherHold=knownHolds ? (reportedUsed==null ? '0' :
    reportedUsed.gte(targetMargin) ? out(reportedUsed.minus(targetMargin)) : null) : null;
  const computedEquity = unsupported || cross?.accountValue == null
    ? null
    : isUnifiedUsdcOnly
      ? out(dec(String(cross.accountValue)).plus(spotUsdcTotal ?? '0'))
      : out(dec(String(cross.accountValue)));
  return {
    source: 'Hype 主网 API',
    sourceDetail: isUnifiedUsdcOnly ? 'Hype 主网 API（Unified USDC）' : 'Hype 主网 API',
    at: account.occurredAt,
    ordersAt: requested.frontendOpenOrders,
    feeAt: requested.userFees,
    capacityAt: requested.activeAssetData,
    freeAt: requested.activeAssetData,
    leverageAt: validCap ? requested.activeAssetData : account.occurredAt,
    marginModeAt: validCap ? requested.activeAssetData : account.occurredAt,
    receivedAt,
    equity: computedEquity,
    rawEquity: account.equity,
    spotUsdc: spotUsdcTotal ? out(spotUsdcTotal) : null,
    unifiedUsdcOnly: isUnifiedUsdcOnly,
    qty,
    anchor,
    orders: mapped,
    mode,
    crossPoolVerified: !unsupported && computedEquity != null,
    unsupported,
    marginMode,
    otherPositions:positionsElsewhere,
    otherHold,
    liquidation: pos?.liquidation ?? null,
    directionalFree:
      validCap && Array.isArray(cap.availableToTrade) && cap.availableToTrade.length === 2
        ? cap.availableToTrade.map((x) => out(nonnegative(x)))
        : null,
    configuredLeverage: (validCap ? cap.leverage?.value : null) ?? pos?.leverage?.value ?? null,
    leverage: String((validCap ? cap.leverage?.value : null) ?? pos?.leverage?.value ?? '') || null,
    currentMarginCredit: !unsupported && marginMode === 'cross' && pos ? pos.margin : null,
    capacity: validCap ? cap.maxTradeSzs : null,
    fee: result(4)?.userCrossRate ? out(nonnegative(result(4).userCrossRate)) : null,
    crossMaintenance:
      result(0).crossMaintenanceMarginUsed == null
        ? null
        : out(nonnegative(String(result(0).crossMaintenanceMarginUsed))),
    used: reportedUsed==null ? null : out(reportedUsed),
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
    configuredLeverage: null,
    currentMarginCredit: null,
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
    qty: r.planCrossFlat === true ? '0' : null,
    orders: r.planCrossFlat === true ? [] : null,
    otherHold: r.planCrossFlat === true ? '0' : null,
    marginMode: r.planCrossFlat === true ? 'cross' : null
  };
  try {
    const capital = nonnegative(r.planCapital ?? r.B);
    const paid = nonnegative(r.registration);
    if (paid.gt(capital)) throw Error('报名费超过预设个人本金');
    const equity =
      side === 'pf'
        ? out(positive(r.stage==='funded' ? (r.fundedAccount?.equity ?? r.planPF ?? '10000') : r.planPF))
        : r.stage === 'funded'
          ? (r.planFundedCash === '' || r.planFundedCash == null
              ? (() => { throw Error('请填写当前 Funded 阶段实盘结余（U）'); })()
              : out(nonnegative(r.planFundedCash)))
          : out(capital.minus(paid));
    return {
      ...common,
      equity,
      free: r.planCrossFlat === true ? equity : null
    };
  } catch (e) {
    return { ...common, error: '请核对预设参数：' + e.message };
  }
}
