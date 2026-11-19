// Independent check: accrue maintenance over the marginal bands, then find the
// price at which collateral plus marked P&L equals maintenance. No analytic root
// or cumulative deduction from the main liquidation solver is reused.
import { dec, out } from './math.js';

function marginalMaintenance(tiers, notional) {
  let total = dec('0');
  for (const [i, tier] of tiers.entries()) {
    const start = dec(tier.from);
    if (notional.lte(start)) break;
    const next = tiers[i + 1];
    const end = next && notional.gt(next.from) ? dec(next.from) : notional;
    total = total.plus(end.minus(start).times(tier.mmr));
  }
  return total;
}

export function crossCheckRoot(leg, q, equity, mark, otherMM) {
  const size = dec(q).times(leg.multiplier).times(leg.fx);
  if (size.isZero()) return null;
  const start = dec(mark);
  const surplus = (price) =>
    dec(equity)
      .plus(size.times(price.minus(start)))
      .minus(otherMM)
      .minus(marginalMaintenance(leg.tiers, size.abs().times(price)));
  if (surplus(start).lte(0)) return out(start);
  let safe = start,
    unsafe = dec('0');
  if (size.gt(0) && surplus(unsafe).gte(0)) return null;
  if (size.lt(0)) {
    unsafe = start.times(2);
    while (surplus(unsafe).gt(0)) unsafe = unsafe.times(2);
  }
  for (let i = 0; i < 100; i++) {
    const mid = safe.plus(unsafe).div(2);
    if (surplus(mid).gt(0)) safe = mid;
    else unsafe = mid;
  }
  return out(safe.plus(unsafe).div(2));
}

export function auditCross(leg, account, c, planning) {
  const gaps = [];
  if (
    planning ||
    account.source !== 'Hype 主网 API' ||
    !['standard', 'disabled'].includes(account.mode) ||
    account.unsupported
  )
    gaps.push('实际账户模式');
  if (account.crossPoolVerified !== true) gaps.push('全仓抵押权益');
  if (account.otherPositions !== false || account.otherHold == null || !Array.isArray(account.orders))
    gaps.push('全账户仓位与挂单');
  if (account.fee == null) gaps.push('实际费率');
  const audit = {
    exchangeCheck: '未取得可比现仓',
    gaps,
    model: c.modelLiq ?? null,
    independent: null,
    reference: null,
    status: '条件估算'
  };
  const im = c.constraints.find((x) => x.code === 'hl_INITIAL_MARGIN');
  if (!leg.tiers || leg.marginMode !== 'cross' || leg.hold == null || im?.actual == null) {
    gaps.push('完整全仓维持模型');
    return audit;
  }
  const other = leg.otherMaintenance ?? leg.hold;
  const unit = dec(leg.multiplier).times(leg.fx),
    mark = dec(leg.mark);
  const held = dec(String(account.qty)),
    delta = dec(c.hlTargetQuantity).minus(held);
  let equity = dec(String(account.equity)).plus(
    held.times(unit).times(mark.minus(account.anchor || leg.mark))
  );
  let remaining = delta.abs();
  for (const [price, available] of delta.gt(0) ? leg.asks : leg.bids) {
    if (remaining.isZero()) break;
    const fill = remaining.lt(available) ? remaining : dec(available);
    const gross = fill.times(unit);
    equity = equity
      .plus(gross.times(delta.gt(0) ? 1 : -1).times(mark.minus(price)))
      .minus(gross.times(price).times(leg.rate));
    remaining = remaining.minus(fill);
  }
  if (!remaining.isZero()) {
    gaps.push('差额成交深度不足');
    return audit;
  }
  audit.postEntryEquity = out(equity);
  audit.independent = crossCheckRoot(leg, c.hlTargetQuantity, equity, leg.mark, other);
  const near = (x, y, tolerance) =>
    x == null || y == null ? x == null && y == null : dec(x).minus(y).abs().lte(tolerance);
  audit.mathMatches =
    near(audit.model, audit.independent, mark.times('1e-12')) && near(equity, im.actual, '0.00000001');
  if (!audit.mathMatches) gaps.push('目标仓两种算法结果不一致');
  // Account comparison uses the position and mark belonging to the exchange
  // snapshot; the exchange does not publish a reference for an unfilled target.
  if (account.source === 'Hype 主网 API' && account.equity != null && account.qty != null) {
    const flat = dec(account.qty).isZero(),
      anchor = account.anchor;
    audit.exchangeCheck = flat ? '当前空仓，无现仓强平参考' : '现仓参考未完成核对';
    if (!flat && !anchor) gaps.push('现仓快照标记价');
    if (account.crossMaintenance == null) gaps.push('平台全仓维持要求');
    if (flat || anchor) {
      const mark = flat ? leg.mark : anchor;
      const currentMM = marginalMaintenance(
        leg.tiers,
        dec(account.qty).abs().times(leg.multiplier).times(leg.fx).times(mark)
      ).plus(other);
      audit.currentMaintenance = out(currentMM);
      audit.apiMaintenance = account.crossMaintenance ?? null;
      if (account.crossMaintenance != null && !near(currentMM, account.crossMaintenance, '0.01'))
        gaps.push('现仓维持要求与 API 不符');
      if (!flat) {
        audit.currentModel = crossCheckRoot(leg, account.qty, account.equity, mark, other);
        audit.reference = account.liquidation ?? null;
        audit.priceTolerance = out(dec(mark).times('0.0001'));
        if (audit.reference != null && near(audit.currentModel, audit.reference, audit.priceTolerance))
          audit.exchangeCheck = gaps.length ? '现仓参考在容差内，账户资料不全' : '已核对现仓参考';
        if (audit.reference == null || !near(audit.currentModel, audit.reference, audit.priceTolerance))
          gaps.push('现仓强平参考缺失或偏差超过快照标记价的 1 基点');
      }
    }
  }
  if (!gaps.length)
    audit.status =
      audit.exchangeCheck === '已核对现仓参考'
        ? '模型与当前账户快照已核对'
        : '目标仓条件估算 · 当前账户维持要求已核对';
  return audit;
}
