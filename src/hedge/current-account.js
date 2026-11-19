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
    otherHold: !account.positions.length && Array.isArray(orders) && !orders.length ? '0' : null,
    leverage: validCap ? String(cap.leverage?.value ?? '') : null,
    capacity: validCap ? cap.maxTradeSzs : null,
    fee: result(4)?.userCrossRate ? out(nonnegative(result(4).userCrossRate)) : null,
    used: account.used,
    withdrawable: account.withdrawable
  };
}
