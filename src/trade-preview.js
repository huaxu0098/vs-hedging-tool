import { DEFAULT_CONFIG } from './decision.js';

const number = (value) => (Number.isFinite(value) ? value : null);
const difference = (end, start) => (Number.isFinite(end) && Number.isFinite(start) ? end - start : null);

function outcome(price, localPrice) {
  return {
    status: 'unverified',
    reason: '',
    first: null,
    price: number(price),
    localPrice: number(localPrice),
    cash: null,
    cashChange: null,
    profit: null,
    totalProfit: null,
    pendingPayout: null,
    cashAfterPayout: null,
    profitAfterPayout: null,
    totalProfitAfterPayout: null
  };
}

// Compare the first boundaries encountered on the monotone path from the
// current mark to this outcome. The other side of the current mark is a
// different scenario. A zero local liquidation mark is a bankruptcy boundary
// outside the positive trading range and cannot interrupt either VS scenario.
function pathStatus(key, rows, ref) {
  const localZero = rows.liq.localPrice === 0;
  if (key === 'liq' && localZero)
    return ['preempted', '按当前抵押额，正价格区间内没有 Hype 强平触发点。', null];
  const price = rows[key].price;
  const dir = Math.sign(price - ref);
  const tolerance = 64 * Number.EPSILON * Math.max(1, Math.abs(ref), Math.abs(price));
  const distance = Math.abs(price - ref);
  const names = { pass: 'VS 目标线', fail: 'VS 失败线', liq: 'Hype 强平线' };
  const boundaries = Object.keys(names)
    .filter((k) => !(k === 'liq' && localZero))
    .map((k) => ({ key: k, distance: Math.abs(rows[k].price - ref), along: dir * (rows[k].price - ref) }))
    .filter((b) => b.along >= -tolerance && b.distance <= distance + tolerance)
    .sort((a, b) => a.distance - b.distance);
  const first = boundaries[0];
  if (boundaries[1] && boundaries[1].distance - first.distance <= tolerance)
    return ['simultaneous', '最先到达的触线价格重合，无法判定先后和最终结算金额。', null];
  if (first.key !== key) return ['preempted', '沿当前价格路径先触及' + names[first.key] + '。', first.key];
  return ['conditional', '', key];
}

// Monetary values are USD. The engine supplies the net portfolio settlement
// after all modeled fills and fees. Previously received withdrawals are already
// in hypeCash; posted margin is collateral, not a second cash expense.
export function buildTradePreview(asset, account, config, candidate) {
  const stage = account?.stage;
  const r = candidate;
  const startingCash = number(account?.hypeCash);
  const startingEquity =
    number(account?.hypeEquity) ??
    number(r?.limits?.hype?.equity) ??
    (Array.isArray(account?.positions) && account.positions.every((p) => p.venue !== 'hype' || !p.qty)
      ? startingCash
      : null);
  const initialCapital = number(
    config?.initialCapital ?? account?.initialCapital ?? DEFAULT_CONFIG.initialCapital
  );
  const externalUnrecovered = number(account?.externalUnrecovered ?? 0);
  const basis =
    number(r?.personalTarget) ??
    (initialCapital !== null && externalUnrecovered !== null ? initialCapital + externalUnrecovered : null);
  const ref = asset?.referencePrice;
  const localVS = (price) =>
    Number.isFinite(price) &&
    Number.isFinite(ref) &&
    Number.isFinite(asset?.vs?.ratio) &&
    Number.isFinite(asset.vs.mark ?? asset.vs.price)
      ? (asset.vs.mark ?? asset.vs.price) + (price - ref) * asset.vs.ratio
      : null;
  const rows = {
    fail: outcome(r?.fail, localVS(r?.fail)),
    pass: outcome(r?.pass, localVS(r?.pass)),
    liq: outcome(r?.liq, r?.liqMark),
    close: outcome(r?.closeState?.ref, localVS(r?.closeState?.ref))
  };
  const result = {
    stage,
    startingCash,
    startingEquity,
    initialCapital,
    externalUnrecovered,
    registrationPaid: number(account?.registrationPaid),
    scenarios: rows
  };
  const valid =
    r &&
    r.status !== 'unverified' &&
    !r.noTrade &&
    r.assetId === asset?.id &&
    r.checks?.capital === true &&
    Number.isFinite(r.hype?.targetQty) && r.hype.targetQty !== 0 &&
    !asset.sourceIssues?.length &&
    (stage === 'challenge' || stage === 'funded') &&
    (account?.status === undefined || account.status === 'active') &&
    Number.isFinite(ref) &&
    ref > 0 &&
    rows.fail.price > 0 &&
    rows.pass.price > 0 &&
    rows.liq.price !== null &&
    rows.liq.localPrice !== null &&
    rows.liq.localPrice >= 0 &&
    typeof r.liqSource === 'string' &&
    r.liqSource.trim() &&
    r.liqSource !== '未验证' &&
    !r.reasons?.some((reason) => String(reason).includes('VS 在规则线前触及维持保证金'));
  for (const key of ['fail', 'pass', 'liq', 'close']) {
    const row = rows[key];
    if (!valid) {
      row.reason = asset?.sourceIssues?.[0] || r?.reasons?.[0] || '缺少可建立的双边仓位或可核实的触线顺序。';
      continue;
    }
    // A manual/account quote from the far side of today's mark has already
    // crossed its trigger. Its actual disposition cannot be inferred here.
    if (rows.liq.localPrice > 0 && (ref - rows.liq.price) * Math.sign(r.hype.targetQty) < 0) {
      row.reason = '当前标记价已越过所填 Hype 强平价，请刷新账户持仓和强平参数。';
      continue;
    }
    if (key === 'close') {
      // A flat-price close presupposes an active position with no intervening touch.
      if (rows.liq.localPrice > 0 && ref === rows.liq.price) {
        row.status = 'preempted';
        row.first = 'liq';
        row.reason = '当前价格已触及 Hype 强平线，无法按正常收盘结算。';
        continue;
      }
      row.status = 'conditional';
    } else {
      [row.status, row.reason, row.first] = pathStatus(key, rows, ref);
    }
    if (row.status !== 'conditional') continue;
    if (key === 'liq') {
      // Endpoints use the same reference axis as the signed, rounded per-point exposure.
      row.positionGross = number(r.hype.currentGross + r.hype.delta * (row.price - ref));
      row.reason = '已知强平触发价，尚无实际处置成交价、清算费用与抵押返还额。';
      continue;
    }
    const state = { fail: r.failState, pass: r.passState, close: r.closeState }[key];
    if (!state || !Number.isFinite(state.hypeCash) || (key === 'pass' && state.reachable !== true)) {
      row.status = 'unverified';
      row.reason = state?.condition || '缺少可验证的费用后双边平仓结果。';
      continue;
    }
    row.cash = state.hypeCash;
    row.cashChange = difference(row.cash, startingCash);
    row.profit = difference(row.cash, startingEquity);
    row.totalProfit = difference(row.cash, basis);
    row.pendingPayout = stage === 'funded' && key === 'pass' ? number(state.payout) : 0;
    if (row.pendingPayout !== null && row.pendingPayout >= 0) {
      row.cashAfterPayout = row.cash + row.pendingPayout;
      row.profitAfterPayout = difference(row.cashAfterPayout, startingEquity);
      row.totalProfitAfterPayout = difference(row.cashAfterPayout, basis);
    }
  }
  return result;
}
