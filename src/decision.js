import { fxIsCurrent } from './feeds.js';
import { grid, tradableQty, validateLeg } from './engine.js';

export const DEFAULT_CONFIG = Object.freeze({
  initialCapital: 500,
  registrationFee: 91,
  vsStart: 10000,
  challengeTarget: 12000,
  challengeFail: 9400,
  fundedFail: 8000,
  payoutTarget: 11000,
  payoutShare: 0.8,
  triggerMode: 'settled',
  minCash: 10,
  maxMarginPct: 90,
  minBuffer: 0,
  basisReserveBps: 2,
  closeSlippageBps: 1,
  maxRoundingDriftPct: 5,
  sortBy: 'worst',
  vsCapUsd: 0,
  hypeCapUsd: 0
});

const venues = ['vs', 'hype'];
const positive = (n) => Number.isFinite(n) && n > 0;
const nn = (n) => Number.isFinite(n) && n >= 0;
const close = (a, b) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
const amount = (n) => Number(n.toFixed(3));
const specValue = (leg) => leg.multiplier * leg.settleUsd;
const markOf = (leg) => leg.mark ?? leg.price;
const refMark = (asset, venue, ref) =>
  markOf(asset[venue]) + (ref - asset.referencePrice) * asset[venue].ratio;
const refPrice = (asset, venue, mark) =>
  asset.referencePrice + (mark - markOf(asset[venue])) / asset[venue].ratio;
const unique = (values) => [...new Set(values)];
const configOf = (config) => ({ ...DEFAULT_CONFIG, ...config });
const priorOf = (asset, account, venue) =>
  account.positions?.find((p) => p.assetId === asset.id && p.venue === venue);
const freeOf = (account, venue) =>
  account[venue + 'Free'] ??
  account[venue === 'vs' ? 'vsBalance' : 'hypeCash'] - (account[venue + 'Used'] ?? 0);
function externalHold(account, venue) {
  const known = (account.positions ?? [])
    .filter((p) => p.venue === venue)
    .reduce((sum, p) => sum + (p.margin ?? 0), 0);
  const used = account[venue + 'Used'] ?? 0,
    equity = account[venue + 'Equity'],
    free = freeOf(account, venue);
  return Math.max(0, used - known, Number.isFinite(equity) ? equity - free - known : 0);
}

export function payoutAmount(equity, config = {}) {
  const c = configOf(config);
  return Math.max(0, equity - c.vsStart) * c.payoutShare;
}

function sideLevels(leg, buy) {
  return leg.book?.[buy ? 'asks' : 'bids'];
}
function topQuote(leg, buy) {
  const listed = sideLevels(leg, buy)?.[0]?.[0] ?? leg[buy ? 'ask' : 'bid'];
  return listed ?? grid(leg.price + ((buy ? 1 : -1) * (leg.spread ?? 0)) / 2, leg.tick, buy);
}

// Future book scenarios translate actual book levels by the mark movement. Size
// and spread are held fixed, then the configured exit slippage stress is applied.
function fill(leg, signedQty, mark, extraBps = 0) {
  const qty = Math.abs(signedQty),
    buy = signedQty > 0,
    side = buy ? 1 : -1;
  const shift = mark - markOf(leg),
    top = topQuote(leg, buy);
  const levels = sideLevels(leg, buy);
  if (!positive(mark) || !positive(top)) return { error: '报价超出有效价格区间' };
  if (!qty) return { price: mark, spreadCost: 0, slippageCost: 0 };
  let sum = 0,
    remaining = qty;
  if (levels) {
    for (const [px, size] of levels) {
      const take = Math.min(remaining, size);
      const price = grid(px + shift, leg.tick, buy);
      if (!positive(price)) return { error: '情景报价超出有效价格区间' };
      sum += price * take;
      remaining -= take;
      if (remaining <= qty * 1e-12) break;
    }
    if (remaining > qty * 1e-12) return { error: '已知盘口深度不足以完整成交' };
  } else {
    const price = grid(top + shift, leg.tick, buy);
    if (!positive(price)) return { error: '情景报价超出有效价格区间' };
    sum = price * qty;
  }
  const vwap = sum / qty;
  const price = extraBps > 0 ? grid(vwap * (1 + (side * extraBps) / 10000), leg.tick, buy) : vwap;
  const midpoint = (topQuote(leg, true) + topQuote(leg, false)) / 2;
  const half = Math.max(0, side * (top - midpoint));
  return {
    price,
    spreadCost: qty * specValue(leg) * half,
    basisCost: qty * specValue(leg) * side * (midpoint - markOf(leg)),
    slippageCost: qty * specValue(leg) * Math.max(0, side * (price - top - shift))
  };
}

export function settleLeg(asset, venue, signedQty, avgEntry, ref, config = {}) {
  const c = configOf(config),
    leg = asset[venue],
    mark = refMark(asset, venue, ref);
  if (!signedQty)
    return {
      ok: true,
      reasons: [],
      exitPrice: mark,
      mark,
      gross: 0,
      fee: 0,
      net: 0,
      spreadCost: 0,
      slippageCost: 0
    };
  const exit = fill(leg, -signedQty, mark, c.closeSlippageBps);
  if (exit.error) return { ok: false, reasons: [venue + '：' + exit.error] };
  const point = specValue(leg);
  const gross = signedQty * point * (exit.price - avgEntry);
  const exitNotional = Math.abs(signedQty) * point * exit.price;
  if (exitNotional + 1e-9 < (leg.minNotional ?? 0))
    return { ok: false, reasons: [venue + ' 平仓成交名义额低于配置的最小门槛'] };
  const fee = exitNotional * leg.feeRate;
  return {
    ok: true,
    reasons: [],
    exitPrice: exit.price,
    mark,
    gross,
    fee,
    net: gross - fee,
    spreadCost: exit.spreadCost,
    slippageCost: exit.slippageCost,
    basisCost: exit.basisCost ?? 0
  };
}

function configIssues(account, c) {
  const errors = [];
  if ((account.status && account.status !== 'active') || !['challenge', 'funded'].includes(account.stage))
    errors.push('当前周期已结束或阶段未知');
  if (![account.vsBalance, account.hypeCash, ...venues.map((v) => freeOf(account, v))].every(Number.isFinite))
    errors.push('缺少双平台账面余额或可用保证金');
  if (
    ![c.initialCapital, c.vsStart, c.challengeTarget, c.challengeFail, c.fundedFail, c.payoutTarget].every(
      positive
    ) ||
    c.challengeTarget <= c.vsStart ||
    c.challengeFail >= c.vsStart ||
    c.fundedFail >= c.vsStart ||
    c.payoutTarget <= c.vsStart ||
    !nn(c.payoutShare) ||
    c.payoutShare > 1 ||
    !positive(c.maxMarginPct) ||
    c.maxMarginPct > 100 ||
    ![
      c.registrationFee,
      c.minCash,
      c.minBuffer,
      c.basisReserveBps,
      c.closeSlippageBps,
      c.vsCapUsd,
      c.hypeCapUsd,
      c.maxRoundingDriftPct,
      account.externalUnrecovered ?? 0
    ].every(nn) ||
    c.closeSlippageBps >= 10000 ||
    !['mark', 'settled'].includes(c.triggerMode)
  )
    errors.push('账户或风控配置无效');
  return errors;
}

export function decisionInputIssues(asset, account, c, now = Date.now()) {
  const reasons = [...(asset.sourceIssues ?? []), ...configIssues(account, c)];
  if (!positive(asset.referencePrice) || !positive(asset.maxAgeSec) || !asset.verified || !asset.benchmark)
    reasons.push('参考价格、有效期或标的映射未验证');
  const rates = new Map([['USD', 1]]);
  for (const venue of venues) {
    const leg = asset[venue];
    if (!leg) {
      reasons.push(venue + ' 缺少合约参数');
      continue;
    }
    // Missing maintenance data is handled by the liquidation verifier, which can
    // also accept an attested price scoped to an exact candidate.
    const stamp = typeof leg.asOf === 'number' ? new Date(leg.asOf).toJSON() : leg.asOf;
    validateLeg(
      { ...leg, price: markOf(leg), asOf: stamp, mmr: leg.mmr ?? 0 },
      venue === 'vs' ? 'VS' : 'Hype',
      asset,
      now,
      rates,
      reasons
    );
    if (
      !fxIsCurrent(leg, asset.maxAgeSec, now) ||
      (leg.account && !fxIsCurrent(leg.account, asset.maxAgeSec, now))
    )
      reasons.push(venue + ' 行情估值依赖的 USD 汇率已过期');
    if (!nn(leg.minNotional ?? 0)) reasons.push(venue + ' 最小成交名义额无效');
    if (!nn(leg.slippageBps ?? 0) || (leg.slippageBps ?? 0) >= 10000) reasons.push(venue + ' 入场滑点无效');
    const bid = topQuote(leg, false),
      ask = topQuote(leg, true);
    if (!positive(bid) || !positive(ask) || bid > ask) reasons.push(venue + ' 买卖报价无效');
    if (leg.book)
      for (const buy of [false, true]) {
        const levels = sideLevels(leg, buy);
        if (
          !Array.isArray(levels) ||
          !levels.length ||
          levels.some(
            (row, i) =>
              !Array.isArray(row) ||
              !row.every(positive) ||
              row.length !== 2 ||
              (i && (buy ? row[0] < levels[i - 1][0] : row[0] > levels[i - 1][0]))
          )
        )
          reasons.push(venue + ' 盘口档位无效');
      }
    const venuePositions = (account.positions ?? []).filter((p) => p.venue === venue);
    if (Number.isFinite(account[venue + 'Equity'])) {
      let expected = account[venue === 'vs' ? 'vsBalance' : 'hypeCash'];
      for (const p of venuePositions) {
        const contract = p.assetId === asset.id ? leg : p.asset?.[venue];
        const floating =
          p.unrealized ??
          p.upnl ??
          (contract ? p.qty * specValue(contract) * ((p.mark ?? markOf(contract)) - p.entry) : NaN);
        expected += floating;
      }
      if (
        !Number.isFinite(expected) ||
        Math.abs(expected - account[venue + 'Equity']) > Math.max(0.05, Math.abs(expected) * 1e-5)
      )
        reasons.push(venue + ' 标记净值与账面余额及完整持仓浮盈不一致');
    }
    const positions = account.positions?.filter((p) => p.venue === venue && p.assetId === asset.id) ?? [];
    if (
      positions.length > 1 ||
      positions.some((p) => !Number.isFinite(p.qty) || !positive(p.entry) || !nn(p.margin))
    )
      reasons.push(venue + ' 的现有净持仓资料不完整或重复');
  }
  if (asset.vs && asset.hype) {
    const prices = [asset.referencePrice, ...venues.map((v) => markOf(asset[v]) / asset[v].ratio)];
    const basis = ((Math.max(...prices) - Math.min(...prices)) / asset.referencePrice) * 100;
    if (!Number.isFinite(basis) || basis > (asset.maxBasisPct ?? 1) + 1e-8)
      reasons.push('两侧价格映射后的基差超限');
  }
  return unique(reasons);
}

function limitsOf(asset, account, c) {
  const limits = {};
  for (const v of venues) {
    const leg = asset[v],
      prior = priorOf(asset, account, v);
    if (!leg) {
      limits[v] = {};
      continue;
    }
    const p = markOf(leg),
      value = specValue(leg);
    const used = account[v + 'Used'] ?? 0,
      currentMargin = prior?.margin ?? 0;
    const free = freeOf(account, v),
      equity = account[v + 'Equity'] ?? free + used;
    const raw = Math.max(0, free + currentMargin);
    const safe = Math.max(
      0,
      Math.min(
        raw - (v === 'hype' ? c.minCash : 0),
        (equity * c.maxMarginPct) / 100 - Math.max(0, used - currentMargin)
      )
    );
    const unitCost = p * value * (1 / leg.leverage + leg.feeRate);
    const bySide = {};
    const cap = c[v + 'CapUsd'] || Infinity;
    const upper = Math.max(
      0,
      Math.floor(((raw / unitCost) * 2 + Math.abs(prior?.qty ?? 0) + leg.minQty) / leg.step)
    );
    const oldGross = prior
      ? (prior.unrealized ?? prior.upnl ?? prior.qty * value * ((prior.mark ?? p) - prior.entry))
      : 0;
    function capacity(sign, risk) {
      if (!Number.isSafeInteger(upper) || !positive(p) || !positive(leg.step)) return 0;
      let lo = 0,
        hi = upper;
      while (lo < hi) {
        const n = Math.ceil((lo + hi) / 2),
          qty = grid(n * leg.step, leg.step, false);
        if (qty < leg.minQty) {
          lo = n;
          continue;
        }
        const pos = orderLeg(asset, account, v, 0, sign, qty * sign);
        if (pos.belowMinimum) {
          lo = n;
          continue;
        }
        let valid = !pos.error;
        if (valid) {
          const change = pos.realized - pos.tradeFee + pos.currentGross - oldGross;
          const after = free + change - pos.marginChange,
            total = used + pos.marginChange;
          const tier = leg.tiers?.findLast((row) => pos.markNotional >= row.lowerBound);
          valid =
            after >= -1e-8 &&
            (!(leg.tiersVerified || leg.marginVerified) ||
              !tier?.maxLeverage ||
              leg.leverage <= tier.maxLeverage);
          if (risk)
            valid =
              valid &&
              after >= (v === 'hype' ? c.minCash : 0) - 1e-8 &&
              total <= ((equity + change) * c.maxMarginPct) / 100 + 1e-8 &&
              pos.notional <= cap + 1e-8;
        }
        if (valid) lo = n;
        else hi = n - 1;
      }
      const qty = grid(lo * leg.step, leg.step, false);
      if (qty < leg.minQty) return 0;
      return orderLeg(asset, account, v, 0, sign, sign * qty).error ? 0 : qty;
    }
    for (const sign of [-1, 1])
      bySide[sign > 0 ? 'long' : 'short'] = { maxQty: capacity(sign, false), safeQty: capacity(sign, true) };
    const maxQty = Math.max(bySide.long.maxQty, bySide.short.maxQty);
    const safeQty = Math.max(bySide.long.safeQty, bySide.short.safeQty);
    for (const [key, row] of Object.entries(bySide)) {
      const sign = key === 'long' ? 1 : -1;
      for (const kind of ['max', 'safe']) {
        const q = row[kind + 'Qty'];
        row[kind + 'Usd'] = q ? orderLeg(asset, account, v, 0, sign, sign * q).notional : 0;
      }
    }
    const maxUsd = Math.max(bySide.short.maxUsd, bySide.long.maxUsd),
      safeUsd = Math.max(bySide.short.safeUsd, bySide.long.safeUsd);
    limits[v] = {
      maxQty,
      maxUsd,
      safeQty,
      safeUsd,
      addUsd: Math.max(0, safeUsd - Math.abs(prior?.qty ?? 0) * p * value),
      safeMargin: safe,
      rawMargin: raw,
      free,
      used,
      equity,
      bySide,
      currentQty: prior?.qty ?? 0
    };
  }
  return limits;
}

// Compare integer lot indices, not the floating-point subtraction of two valid quantities.
function lotIndex(quantity, step) {
  const ratio = quantity / step;
  const count = Math.round(ratio);
  const tolerance = Math.min(1e-6, Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8);
  return Number.isSafeInteger(count) && Math.abs(ratio - count) <= tolerance ? count : null;
}

function fromLots(count, step) {
  if (!Number.isSafeInteger(count)) return NaN;
  const qty = count * step;
  return grid(qty, step, qty / step < count);
}

function orderLeg(asset, account, v, usd, sign, exactQty) {
  const leg = asset[v],
    prior = priorOf(asset, account, v),
    oldQty = prior?.qty ?? 0;
  const mark = markOf(leg),
    value = specValue(leg);
  const heldLots = lotIndex(oldQty, leg.step);
  if (heldLots === null) return { error: '现有持仓数量与当前数量步长不一致' };
  let qty;
  if (exactQty !== undefined) {
    const lots = lotIndex(exactQty, leg.step);
    if (lots === null || (lots && Math.sign(lots) !== sign))
      return { error: '精确目标数量与方向或步长不一致' };
    qty = fromLots(Math.abs(lots), leg.step);
  } else {
    if (!nn(usd)) return { error: '目标美元名义值无效' };
    const top = topQuote(leg, sign > 0),
      sameQty = Math.max(0, sign * oldQty);
    // A remaining position is quoted at its current opening-side BBO. New or
    // incremental size uses the price of its actual difference order, incl. VWAP.
    if (sameQty && usd <= sameQty * value * top) {
      qty = tradableQty(usd, leg, top);
    } else {
      const levels = sideLevels(leg, sign > 0),
        extra = leg.slippageBps ?? 0;
      if (!levels) {
        const px = fill(leg, sign * leg.minQty, mark, extra).price;
        if (!positive(px)) return { error: '入场成交价无效' };
        qty = tradableQty(usd, leg, px);
      } else {
        const depth = levels.reduce((total, row) => total + row[1], 0);
        const capacity = sign * oldQty + depth;
        const full = fill(leg, sign * depth, mark, extra);
        if (!positive(full.price) || capacity <= 0 || usd >= (capacity + leg.step) * value * full.price)
          return { error: '已知盘口深度不足以完整成交目标美元仓位' };
        const minPx = Math.max(
          leg.tick,
          Math.min(...levels.map((row) => row[0])) * (1 - extra / 10000) - leg.tick
        );
        let lo = Math.max(0, sign * heldLots),
          hi = Math.floor(Math.min(capacity, usd / (minPx * value)) / leg.step + 1e-10);
        if (!Number.isSafeInteger(hi)) return { error: '数量超出可表示范围' };
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2),
            test = fromLots(mid, leg.step);
          const f = fill(leg, fromLots(sign * mid - heldLots, leg.step), mark, extra);
          if (f.error || test * value * f.price > usd + Math.max(1, usd) * Number.EPSILON * 4) hi = mid - 1;
          else lo = mid;
        }
        qty = fromLots(lo, leg.step);
      }
    }
    if (!Number.isFinite(qty)) return { error: '数量超出精度范围' };
  }
  if (qty < leg.minQty) return { error: '取整后无解：实际目标低于最小下单量' };
  const targetLots = lotIndex(sign * qty, leg.step);
  if (targetLots === null) return { error: '目标数量超出步长精度范围' };
  const targetQty = fromLots(targetLots, leg.step);
  const tradeQty = fromLots(targetLots - heldLots, leg.step);
  if (!Number.isFinite(tradeQty)) return { error: '差额数量超出精度范围' };
  if (tradeQty && Math.abs(tradeQty) < leg.minQty) return { error: '取整后无解：差额低于最小下单量' };
  const execution = fill(leg, tradeQty, mark, leg.slippageBps ?? 0);
  if (execution.error) return { error: execution.error };
  const entryPrice = execution.price;
  const closing = oldQty * tradeQty < 0 ? Math.min(Math.abs(oldQty), Math.abs(tradeQty)) : 0;
  const realized = closing ? Math.sign(oldQty) * closing * value * (entryPrice - prior.entry) : 0;
  let avgEntry = entryPrice;
  if (oldQty * targetQty > 0) {
    avgEntry =
      qty > Math.abs(oldQty)
        ? (prior.entry * Math.abs(oldQty) + entryPrice * Math.abs(tradeQty)) / qty
        : prior.entry;
  }
  const tradeNotional = Math.abs(tradeQty) * value * entryPrice;
  if (tradeQty && tradeNotional + 1e-9 < (leg.minNotional ?? 0))
    return {
      error: '取整后无解：本次差额成交名义额低于最小门槛 ' + leg.minNotional + ' USD',
      belowMinimum: true
    };
  const markNotional = qty * value * mark;
  const valuationPrice = sign * tradeQty > 0 ? entryPrice : topQuote(leg, sign > 0);
  const notional = qty * value * valuationPrice;
  const margin = !tradeQty && prior ? prior.margin : markNotional / leg.leverage;
  return {
    qty,
    qtyUnit: leg.qtyUnit,
    side: sign > 0 ? 'long' : 'short',
    targetQty,
    tradeQty,
    entryPrice,
    avgEntry,
    notional,
    markNotional,
    valuationPrice,
    margin,
    delta: targetQty * value * leg.ratio,
    tradeNotional,
    tradeFee: tradeNotional * leg.feeRate,
    realized,
    marginChange: margin - (prior?.margin ?? 0),
    spreadCost: execution.spreadCost,
    slippageCost: execution.slippageCost,
    basisCost: execution.basisCost ?? 0,
    currentGross: targetQty * value * (mark - avgEntry)
  };
}

function otherState(asset, account, venue, c, now) {
  let unrealized = 0,
    net = 0,
    maintenance = 0,
    crossPnl = 0,
    isolated = 0,
    unknown = false;
  for (const p of account.positions ?? []) {
    if (p.venue !== venue || p.assetId === asset.id || !p.qty) continue;
    const spec = p.asset?.[venue],
      mark = p.mark ?? (spec && markOf(spec));
    if (spec) {
      const stamp = typeof spec.asOf === 'number' ? spec.asOf : Date.parse(spec.asOf);
      if (
        p.asset.sourceIssues?.length ||
        !fxIsCurrent(spec, p.asset.maxAgeSec, now) ||
        spec.open !== true ||
        !positive(p.asset.maxAgeSec) ||
        !Number.isFinite(stamp) ||
        stamp > now ||
        now - stamp > p.asset.maxAgeSec * 1000
      )
        unknown = true;
    }
    const floating = p.unrealized ?? p.upnl ?? (spec && p.qty * specValue(spec) * (mark - p.entry));
    if (!Number.isFinite(floating)) {
      unknown = true;
      continue;
    }
    unrealized += floating;
    if (p.asset && positive(mark)) {
      const exit = settleLeg(p.asset, venue, p.qty, p.entry, refPrice(p.asset, venue, mark), c);
      if (exit.ok) net += exit.net;
      else unknown = true;
    } else {
      net += floating;
      if (asset.feedMode === 'live' && !Number.isFinite(p.closeFee)) unknown = true;
      else net -= p.closeFee ?? 0;
    }
    if (venue === 'hype') {
      const mode = p.marginMode ?? spec?.marginMode;
      if (mode === 'isolated') isolated += p.margin ?? 0;
      else {
        crossPnl += floating;
        if (asset.feedMode === 'live' && mode !== 'cross') unknown = true;
        const notional = spec && Math.abs(p.qty) * specValue(spec) * mark;
        const tier = spec?.tiers?.findLast((row) => notional >= row.lowerBound);
        const mm =
          p.maintenance ??
          p.maintenanceMargin ??
          (tier && (spec.tiersVerified || spec.marginVerified)
            ? Math.max(0, notional * tier.mmr - tier.deduction)
            : nn(p.mmr) && positive(notional)
              ? notional * p.mmr
              : undefined);
        if (nn(mm)) maintenance += mm;
        else if (asset.feedMode === 'live' && !nn(account.hypeOtherMaintenance)) unknown = true;
        else maintenance += p.margin ?? 0;
      }
    }
  }
  if (venue === 'vs') net += account.otherVsSettleAdjustment ?? 0;
  return {
    unrealized,
    net,
    crossPnl,
    isolated,
    maintenance: venue === 'hype' ? (account.hypeOtherMaintenance ?? maintenance) : 0,
    unknown
  };
}

function vsAt(asset, vs, base, ref, c) {
  if (c.triggerMode === 'mark')
    return base.mark + vs.targetQty * specValue(asset.vs) * (refMark(asset, 'vs', ref) - vs.avgEntry);
  const close = settleLeg(asset, 'vs', vs.targetQty, vs.avgEntry, ref, c);
  return close.ok ? base.net + close.net : NaN;
}

function threshold(asset, vs, base, target, c) {
  const ref = asset.referencePrice,
    current = vsAt(asset, vs, base, ref, c);
  if (!Number.isFinite(current)) return null;
  if (Math.abs(current - target) < 1e-9) return ref;
  const favorable = target > current,
    fulfilled = (equity) => (favorable ? equity >= target : equity <= target);
  const direction = Math.sign(vs.targetQty) * (favorable ? 1 : -1);
  const leg = asset.vs;
  const lowestPx = Math.min(topQuote(leg, false), ...(leg.book?.bids ?? []).map((level) => level[0]));
  const lowestRef = Math.max(1e-10, ref - (lowestPx - 2 * leg.tick) / leg.ratio);
  let lo = 0,
    hi = Math.max(Math.abs((target - current) / vs.delta), leg.tick / leg.ratio);
  for (let i = 0; i < 50; i++) {
    if (direction < 0) hi = Math.min(hi, ref - lowestRef);
    if (!(hi > 0)) return null;
    const val = vsAt(asset, vs, base, ref + direction * hi, c);
    if (Number.isFinite(val) && fulfilled(val)) break;
    if (!Number.isFinite(val) || (direction < 0 && hi >= ref - lowestRef) || i === 49) return null;
    hi *= 2;
  }
  for (let i = 0; i < 45; i++) {
    const mid = (lo + hi) / 2;
    if (fulfilled(vsAt(asset, vs, base, ref + direction * mid, c))) hi = mid;
    else lo = mid;
  }
  return ref + direction * hi;
}

function liquidation(asset, account, h, other, baseCash, now) {
  const leg = asset.hype,
    mode = leg.marginMode,
    qty = h.targetQty;
  if (!['cross', 'isolated'].includes(mode)) return { error: 'Hype 逐仓/全仓模式未验证' };
  const prior = priorOf(asset, account, 'hype');
  const collateral =
    mode === 'cross'
      ? baseCash +
        other.crossPnl -
        other.maintenance -
        (account.hypeIsolatedCollateral ?? other.isolated) -
        externalHold(account, 'hype')
      : h.margin;
  const isManual = leg.liqSource === 'manual';
  const stamp = typeof leg.liqAsOf === 'number' ? leg.liqAsOf : Date.parse(leg.liqAsOf);
  const currentManual =
    positive(leg.liqPrice) &&
    Number.isFinite(stamp) &&
    stamp <= now &&
    now - stamp <= asset.maxAgeSec * 1000 &&
    Math.abs(leg.liqQty - qty) <= leg.step * 1e-8 &&
    leg.liqMarginMode === mode &&
    close(leg.liqEntry, h.avgEntry) &&
    close(leg.liqCollateral, collateral);
  const wallet = leg.account,
    existing = (account.positions ?? []).filter((p) => p.venue === 'hype' && p.qty);
  const sameWallet =
    wallet &&
    close(wallet.cash, account.hypeCash) &&
    close(wallet.used, account.hypeUsed) &&
    close(wallet.equity, account.hypeEquity) &&
    close(wallet.free, account.hypeFree) &&
    Array.isArray(wallet.positions) &&
    wallet.positions.length === existing.length &&
    existing.every((p) =>
      wallet.positions.some(
        (row) =>
          p.symbol === row.symbol &&
          close(p.qty, row.qty) &&
          close(p.entry, row.entry) &&
          close(p.margin, row.marginUsed) &&
          p.marginMode === row.marginMode
      )
    );
  const apiUnchanged =
    leg.liqSource === 'api' &&
    !h.tradeQty &&
    prior &&
    !account.liquidationInvalidated &&
    positive(prior.liqPrice ?? prior.liquidationPrice) &&
    Number.isFinite(stamp) &&
    stamp <= now &&
    now - stamp <= asset.maxAgeSec * 1000 &&
    prior.marginMode === mode &&
    (sameWallet || close(leg.liqCollateral, collateral)) &&
    close(leg.liqEntry, h.avgEntry);
  if ((isManual && currentManual) || apiUnchanged) {
    const mark = isManual ? leg.liqPrice : (prior.liqPrice ?? prior.liquidationPrice);
    return {
      mark,
      ref: refPrice(asset, 'hype', mark),
      source: isManual ? '手工精确值 · 当前仓位' : '只读账户 · 原持仓快照',
      collateral
    };
  }
  if (mode === 'cross' && other.unknown) return { error: '全仓其他品种的抵押、维持或结算参数不完整' };
  if (!(leg.tiersVerified || leg.marginVerified) || !Array.isArray(leg.tiers) || !leg.tiers.length)
    return { error: 'Hype 强平线无法验证：缺少当前仓位精确价或完整已验证的维持保证金档位' };
  const tiers = leg.tiers,
    point = Math.abs(qty) * specValue(leg),
    side = Math.sign(qty),
    currentMark = markOf(leg);
  let applicable, previous, root;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i],
      lower = tier.lowerBound,
      upper = tier.maxNotional ?? tiers[i + 1]?.lowerBound ?? Infinity;
    if (
      !nn(lower) ||
      !nn(tier.mmr) ||
      tier.mmr >= 1 ||
      !nn(tier.deduction) ||
      !(upper > lower) ||
      (i === 0 && (lower !== 0 || tier.deduction !== 0)) ||
      (previous &&
        (!close(previous.upper, lower) ||
          tier.mmr < previous.mmr ||
          !close(tier.deduction, previous.deduction + lower * (tier.mmr - previous.mmr))))
    )
      return { error: 'Hype 维持保证金档位缺失、不连续或扣减额不一致' };
    previous = { ...tier, upper };
    const notional = point * currentMark;
    if (notional >= lower && notional < upper) applicable = tier;
    const mark = (side * point * h.avgEntry - collateral - tier.deduction) / (point * (side - tier.mmr));
    if (mark >= 0 && point * mark >= lower - 1e-8 && point * mark <= upper + 1e-8) root = mark;
  }
  if (!applicable || previous.upper !== Infinity) return { error: 'Hype 维持保证金档位未覆盖价格路径' };
  if (applicable.maxLeverage != null && leg.leverage > applicable.maxLeverage)
    return { error: '候选仓位超过当前保证金档位允许的杠杆' };
  const equityAtMark = collateral + qty * specValue(leg) * (currentMark - h.avgEntry);
  if (equityAtMark <= applicable.mmr * point * currentMark - applicable.deduction) root = currentMark;
  if (root === undefined && side > 0 && collateral >= point * h.avgEntry) root = 0;
  if (!nn(root)) return { error: '无法验证当前仓位的强平价格' };
  return {
    mark: root,
    ref: refPrice(asset, 'hype', root),
    collateral,
    source:
      (leg.marginSource ?? '已验证分档') +
      ' · ' +
      (mode === 'cross' ? '全仓' : '逐仓') +
      (root === 0 ? '（跌至零前无正价强平线）' : '')
  };
}

function newContext(asset, account, c, now) {
  const reasons = decisionInputIssues(asset, account, c, now);
  if (reasons.length) return { reasons, limits: { vs: {}, hype: {} }, cache: new Map(), other: {} };
  return {
    reasons,
    limits: limitsOf(asset, account, c),
    cache: new Map(),
    other: {
      vs: otherState(asset, account, 'vs', c, now),
      hype: otherState(asset, account, 'hype', c, now)
    }
  };
}
function empty(asset, order, limits) {
  return {
    ok: false,
    status: 'unverified',
    reasons: [],
    assetId: asset.id,
    vsLong: order.vsLong,
    requested: { vsUsd: order.vsUsd, hypeUsd: order.hypeUsd, vsLong: order.vsLong },
    vs: null,
    hype: null,
    pass: null,
    fail: null,
    liq: null,
    buffer: null,
    bufferPct: null,
    liqSource: '未验证',
    limits,
    checks: { capital: false, recovery: false, safety: false, runway: false },
    runway: { ok: false, label: '未验证' },
    costs: null,
    passState: null,
    failState: null,
    closeState: null
  };
}

function core(asset, account, c, order, now, ctx) {
  const r = empty(asset, order, ctx.limits),
    errors = r.reasons;
  if (ctx.reasons.length) {
    errors.push(...ctx.reasons);
    return r;
  }
  if (typeof order.vsLong !== 'boolean') {
    errors.push('请选择双边方向');
    return r;
  }
  const vsLong = order.vsLong,
    sign = vsLong ? 1 : -1,
    ref = asset.referencePrice;
  const key = [sign, order.vsUsd, order.targetQty?.vs].join('/');
  let vsData = ctx.cache.get(key);
  if (!vsData) {
    const leg = orderLeg(asset, account, 'vs', order.vsUsd, sign, order.targetQty?.vs);
    vsData = { leg };
    if (!leg.error) {
      const netBalance = account.vsBalance + leg.realized - leg.tradeFee;
      const base = { mark: netBalance + ctx.other.vs.unrealized, net: netBalance + ctx.other.vs.net };
      const target = account.stage === 'challenge' ? c.challengeTarget : c.payoutTarget;
      const floor = account.stage === 'challenge' ? c.challengeFail : c.fundedFail;
      const equity = vsAt(asset, leg, base, ref, c);
      Object.assign(vsData, {
        base,
        equity,
        target,
        floor,
        pass: threshold(asset, leg, base, target, c),
        fail: threshold(asset, leg, base, floor, c)
      });
    }
    ctx.cache.set(key, vsData);
  }
  r.vs = vsData.leg;
  r.hype = orderLeg(asset, account, 'hype', order.hypeUsd, -sign, order.targetQty?.hype);
  for (const v of venues) if (r[v].error) errors.push(v + '：' + r[v].error);
  if (errors.length) {
    r.status = 'unmatched';
    return r;
  }
  const { vs, hype } = r,
    { pass, fail, equity, target, floor } = vsData;
  r.pass = pass;
  r.fail = fail;
  r.targetEquity = target;
  r.failEquity = floor;
  r.currentVsEquity = equity;
  r.netDelta = vs.delta + hype.delta;
  r.ratio = Math.abs(hype.delta / vs.delta);
  r.matchPct = Math.min(r.ratio, 1 / r.ratio) * 100;
  r.reserve = hype.margin + hype.tradeFee;
  r.personalTarget = c.initialCapital + (account.externalUnrecovered ?? 0);
  for (const v of venues) {
    const p = r[v],
      prior = priorOf(asset, account, v);
    const oldMarkPnl = prior
      ? (prior.unrealized ??
        prior.upnl ??
        prior.qty * specValue(asset[v]) * ((prior.mark ?? markOf(asset[v])) - prior.entry))
      : 0;
    const before = ctx.limits[v];
    const change = p.realized - p.tradeFee + p.currentGross - oldMarkPnl;
    const free = before.free + change - p.marginChange,
      equity = before.equity + change;
    const used = before.used + p.marginChange;
    p.freeAfter = free;
    p.usedAfter = used;
    p.marginPct = equity > 0 ? (100 * used) / equity : Infinity;
    const cashHold = v === 'hype' ? c.minCash : 0;
    const excess = Math.max(cashHold - free, used - (equity * c.maxMarginPct) / 100, 0);
    if (excess > 1e-7)
      errors.push((v === 'vs' ? 'VS' : 'Hype') + ' 保证金或最低现金留存差 ' + amount(excess) + ' U');
    if (c[v + 'CapUsd'] > 0 && p.notional > c[v + 'CapUsd'] + 1e-8) errors.push(v + ' 仓位超过用户名义上限');
  }
  r.checks.capital = !errors.length;
  if (!order.targetQty && positive(order.vsUsd) && positive(order.hypeUsd)) {
    const wanted = (v) => (order[v + 'Usd'] * asset[v].ratio) / r[v].valuationPrice;
    const expected = wanted('hype') / wanted('vs');
    r.roundingDriftPct = 100 * Math.abs(r.ratio / expected - 1);
    if (r.roundingDriftPct > (asset.maxRoundingDriftPct ?? c.maxRoundingDriftPct) + 1e-8)
      errors.push('取整后无解：实际敏感度比例偏离计划 ' + amount(r.roundingDriftPct) + '%');
  }
  const baseHype = account.hypeCash + hype.realized - hype.tradeFee;
  const liq = liquidation(asset, account, hype, ctx.other.hype, baseHype, now);
  if (!liq.error) {
    r.liq = liq.ref;
    r.liqMark = liq.mark;
    r.liqSource = liq.source;
    r.hypeCollateral = liq.collateral;
  }
  if (ctx.other.vs.unknown || ctx.other.hype.unknown) {
    errors.push('其他品种持仓缺少完整浮盈或平仓参数，无法验证双账本情景');
    return r;
  }
  if (!positive(pass) || !positive(fail) || !(equity > floor && equity < target)) {
    if (!Number.isFinite(equity)) errors.push('现有盘口无法覆盖全部平仓数量');
    else errors.push('取整后无解：VS 已触线或正价格区间无法到达两条规则线');
    r.status = 'unmatched';
    return r;
  }
  function scenario(price, type) {
    const sv = settleLeg(asset, 'vs', vs.targetQty, vs.avgEntry, price, c),
      sh = settleLeg(asset, 'hype', hype.targetQty, hype.avgEntry, price, c);
    if (!sv.ok || !sh.ok) return null;
    const vsEquity = vsData.base.net + sv.net,
      hypeCash = baseHype + ctx.other.hype.net + sh.net;
    const payout = type === 'pass' && account.stage === 'funded' ? payoutAmount(vsEquity, c) : 0;
    return {
      ref: price,
      vsEquity,
      hypeCash,
      payout,
      personalCash: hypeCash + payout,
      vs: sv,
      hype: sh,
      closeFees: sv.fee + sh.fee,
      hypeProfit: sh.net + hype.realized - hype.tradeFee
    };
  }
  r.passState = scenario(pass, 'pass');
  r.failState = scenario(fail, 'fail');
  r.closeState = scenario(ref, 'close');
  if (!r.passState || !r.failState || !r.closeState) {
    errors.push('情景平仓盘口深度或报价不足');
    return r;
  }
  r.failGap = r.failState.personalCash - r.personalTarget;
  r.checks.recovery = r.failGap >= -1e-8;
  if (!r.checks.recovery)
    errors.push('VS 失败时仍差 ' + amount(-r.failGap) + ' U 才收回个人本金及未入账成本');
  if (liq.error) {
    errors.push(liq.error);
    return r;
  }
  r.pressureMark = refMark(asset, 'hype', pass);
  r.buffer = sign * (r.liq - pass);
  r.bufferPct = (r.buffer / ref) * 100;
  r.localBuffer = sign * (r.liqMark - r.pressureMark);
  r.passState.reachable = r.buffer > 0;
  if (!r.passState.reachable) r.passState.condition = 'Hype 将先触及强平，此处为未执行强平的压力参考值';
  const minimum = Math.max(c.minBuffer, asset.minBuffer ?? 0);
  const safetyErrors = [];
  if (r.buffer <= 0 || r.buffer + 1e-9 < minimum)
    safetyErrors.push(
      '取整后强平缓冲不足，距离要求差 ' + amount(Math.max(0, minimum - r.buffer)) + ' ' + asset.priceUnit
    );
  r.otherHold = externalHold(account, 'hype');
  r.passState.availableCash = r.passState.hypeCash - r.otherHold;
  r.failState.availableCash = r.failState.hypeCash - r.otherHold;
  const remaining = r.passState.availableCash - c.minCash;
  if (remaining < -1e-8) safetyErrors.push('VS 达标平仓后最低现金留存差 ' + amount(-remaining) + ' U');
  // VS risk uses the account's general equity and fixed prop-firm floor.
  const vsMM = asset.vs.mmr;
  if (
    nn(vsMM) &&
    Math.min(
      ...[fail, pass].map(
        (x) =>
          vsData.base.mark +
          vs.targetQty * specValue(asset.vs) * (refMark(asset, 'vs', x) - vs.avgEntry) -
          Math.abs(vs.targetQty) * specValue(asset.vs) * refMark(asset, 'vs', x) * vsMM
      )
    ) < 0
  )
    safetyErrors.push('VS 在规则线前触及维持保证金');
  const fees = vs.tradeFee + hype.tradeFee + r.failState.closeFees;
  const spread = vs.spreadCost + hype.spreadCost + r.failState.vs.spreadCost + r.failState.hype.spreadCost;
  const slippage =
    vs.slippageCost + hype.slippageCost + r.failState.vs.slippageCost + r.failState.hype.slippageCost;
  const friction = spread + slippage,
    sensitivity = Math.abs(vs.delta) + Math.abs(hype.delta);
  const budget = Math.max(0, friction + Math.min(r.failGap, remaining));
  const basisReserve = ((vs.notional + hype.notional) * c.basisReserveBps) / 10000;
  const exitCost =
    r.failState.vs.spreadCost +
    r.failState.hype.spreadCost +
    r.failState.vs.slippageCost +
    r.failState.hype.slippageCost;
  const basis = vs.basisCost + hype.basisCost + r.failState.vs.basisCost + r.failState.hype.basisCost;
  r.costs = {
    spread,
    slippage,
    basis,
    fees,
    budget,
    basisReserve,
    exitCost,
    friction,
    breakEvenSpread: budget / sensitivity,
    safeEntrySpread: Math.max(0, budget - basisReserve - exitCost) / sensitivity,
    utilizationPct: budget > 0 ? (100 * (friction + basisReserve)) / budget : Infinity
  };
  if (friction + basisReserve > budget + 1e-8 && r.checks.recovery && remaining >= 0)
    safetyErrors.push(
      '扣除平仓滑点与基差余量后，成本预算差 ' + amount(friction + basisReserve - budget) + ' U'
    );
  r.checks.safety = !safetyErrors.length;
  errors.push(...safetyErrors);
  r.worstCash = Math.min(r.passState.personalCash, r.failState.personalCash);
  r.distances = Object.fromEntries(
    [
      ['pass', pass],
      ['fail', fail],
      ['liq', r.liq]
    ].map(([key, x]) => [key, { value: x - ref, pct: (x / ref - 1) * 100 }])
  );
  r.netNeeded = { pass: target - equity, fail: equity - floor };
  r.ok = errors.length === 0 && r.checks.capital && r.checks.recovery && r.checks.safety;
  r.status = r.ok
    ? 'matched'
    : r.checks.capital && r.checks.recovery !== r.checks.safety
      ? 'one-sided'
      : 'unmatched';
  r.runway = {
    ok: account.stage === 'funded' && r.ok,
    label: account.stage === 'funded' && r.ok ? '可安全续航至首次出金' : '仅可完成本阶段'
  };
  r.checks.runway = r.runway.ok;
  return r;
}

function rank(a, b, c) {
  if (c.sortBy === 'buffer') return b.buffer - a.buffer || b.worstCash - a.worstCash;
  if (c.sortBy === 'success')
    return b.passState.personalCash - a.passState.personalCash || b.worstCash - a.worstCash;
  if (c.sortBy === 'margin') return a.hype.margin - b.hype.margin || b.worstCash - a.worstCash;
  return b.worstCash - a.worstCash || b.buffer - a.buffer;
}
function sweep(lo, hi, n, extra = []) {
  if (!positive(hi) || lo > hi) return [];
  return unique([
    ...Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n),
    ...extra.filter((x) => positive(x) && x >= lo && x <= hi)
  ]);
}

function scan(asset, account, c, request, now, ctx, forProof = false) {
  const accepted = [],
    rejected = [],
    seen = new Set();
  const mode = request.mode ?? 'auto',
    dirs =
      request.direction === 'both' || (!request.direction && typeof request.vsLong !== 'boolean')
        ? [true, false]
        : [request.direction ? request.direction === 'long' : request.vsLong];
  const lr = ctx.limits;
  const minUsd = (v) =>
    Math.max(asset[v].minNotional ?? 0, asset[v].minQty * topQuote(asset[v], true) * specValue(asset[v]));
  if (ctx.reasons.length) return { accepted, rejected };
  for (const vsLong of dirs) {
    const vsFixed = mode === 'manual' || mode === 'fixedVs',
      hypeFixed = mode === 'manual' || mode === 'fixedHype';
    const vsList = vsFixed
      ? [request.vsUsd]
      : sweep(minUsd('vs'), lr.vs.safeUsd, forProof ? 12 : 28, [
          request.vsUsd,
          Math.abs(lr.vs.currentQty) * markOf(asset.vs) * specValue(asset.vs)
        ]);
    if (hypeFixed && !vsFixed) {
      // A fixed Hype amount can have a narrow interval between the recovery and
      // liquidation constraints. Refine every observed sign-changing bracket.
      const anchors = [...vsList].sort((a, b) => a - b);
      const trial = (vsUsd) => core(asset, account, c, { vsUsd, hypeUsd: request.hypeUsd, vsLong }, now, ctx);
      const original = anchors.map(trial),
        edges = [];
      const measures = [
        (r) => (r.costs ? r.failGap - r.costs.basisReserve : NaN),
        (r) => (Number.isFinite(r.buffer) ? r.buffer - Math.max(c.minBuffer, asset.minBuffer ?? 0) : NaN),
        (r) => (r.passState ? r.passState.availableCash - c.minCash : NaN)
      ];
      for (let i = 1; i < anchors.length; i++)
        for (const score of measures) {
          let a = anchors[i - 1],
            b = anchors[i],
            left = score(original[i - 1]),
            right = score(original[i]);
          if (!Number.isFinite(left) || !Number.isFinite(right) || left * right >= 0) continue;
          for (let j = 0; j < 18; j++) {
            const middle = (a + b) / 2,
              y = score(trial(middle));
            if (!Number.isFinite(y)) break;
            if (left * y > 0) {
              a = middle;
              left = y;
            } else b = middle;
          }
          edges.push(a, b);
        }
      const points = unique([...anchors, ...edges]).sort((a, b) => a - b);
      vsList.push(...edges, ...points.slice(1).map((x, i) => (x + points[i]) / 2));
    }
    for (const vsUsd of vsList) {
      const local = [];
      function check(hypeUsd) {
        const order = { vsUsd, hypeUsd, vsLong },
          r = core(asset, account, c, order, now, ctx);
        const key = [vsLong, r.vs?.targetQty ?? vsUsd, r.hype?.targetQty ?? hypeUsd].join('/');
        if (!seen.has(key)) {
          seen.add(key);
          (r.ok ? accepted : rejected).push(r);
        }
        local.push(r);
        return r;
      }
      const hMin = minUsd('hype'),
        hMax = lr.hype.safeUsd;
      const hList = hypeFixed ? [request.hypeUsd] : sweep(hMin, hMax, forProof ? 4 : 8, [request.hypeUsd]);
      for (const n of hList) {
        if (check(n).ok && forProof) return { accepted, rejected };
      }
      if (hypeFixed) continue;
      // The binding break-even amount moves with cash, stage and fees. Locate
      // its intersection on each bracket, including actual lot-grid neighbours.
      for (let i = 1; i < hList.length; i++) {
        const a = local[i - 1],
          b = local[i];
        const cushion = (r) => (r.costs ? r.failGap - r.costs.basisReserve : NaN);
        const x = cushion(a),
          y = cushion(b);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x === y || x * y > 0) continue;
        const value = hList[i - 1] + ((hList[i] - hList[i - 1]) * -x) / (y - x);
        const step = asset.hype.step * specValue(asset.hype) * topQuote(asset.hype, !vsLong);
        let left = hList[i - 1],
          right = hList[i],
          leftScore = x;
        // VWAP can change slope at a book level and rounded fee jumps need
        // not land on a secant estimate. Refine to less than one lot.
        for (let j = 0; j < 44 && Math.abs(right - left) > step / 4; j++) {
          const mid = (left + right) / 2,
            probe = check(mid);
          if (probe.ok && forProof) return { accepted, rejected };
          const score = cushion(probe);
          if (!Number.isFinite(score)) break;
          if (score * leftScore > 0) {
            left = mid;
            leftScore = score;
          } else right = mid;
        }
        for (const n of [
          value - step,
          value,
          value + step,
          value + 2 * step,
          left,
          right,
          left - step,
          right + step
        ]) {
          if (n >= hMin && n <= hMax && check(n).ok && forProof) return { accepted, rejected };
        }
      }
    }
  }
  accepted.sort((a, b) => rank(a, b, c));
  return { accepted, rejected };
}
// Conditional next-stage snapshot. Preserve the observed book shape, depth,
// relative mark/basis and lot sizes, without treating API/manual liquidation
// prices tied to the old portfolio as a new-stage price.
export function projectQuotes(asset, ref) {
  const projected = { ...asset, referencePrice: ref };
  for (const v of venues) {
    const leg = asset[v],
      shift = (ref - asset.referencePrice) * leg.ratio;
    const derived = {
      ...leg,
      mark: markOf(leg) + shift,
      price: leg.price + shift,
      liqPrice: null,
      liqAsOf: null,
      liqSource: 'model',
      account: null
    };
    for (const key of ['bid', 'ask'])
      if (Number.isFinite(leg[key])) derived[key] = grid(leg[key] + shift, leg.tick, key === 'ask');
    if (leg.book) {
      derived.book = Object.fromEntries(
        ['bids', 'asks'].map((side) => [
          side,
          leg.book[side].map(([price, qty]) => [grid(price + shift, leg.tick, side === 'asks'), qty])
        ])
      );
    }
    projected[v] = derived;
  }
  return projected;
}
function continuation(asset, account, c, r, now, memo = new Map()) {
  if (!r.ok || account.stage === 'funded') return r;
  const cash = r.passState.hypeCash;
  const funded = {
    stage: 'funded',
    vsBalance: c.vsStart,
    hypeCash: cash,
    vsUsed: 0,
    hypeUsed: r.otherHold,
    vsFree: c.vsStart,
    hypeFree: cash - r.otherHold,
    positions: [],
    externalUnrecovered: account.externalUnrecovered ?? 0
  };
  const projected = projectQuotes(asset, r.pass);
  const ctx = newContext(projected, funded, c, now);
  let proof;
  for (const witness of memo.values()) {
    if (witness) {
      const trial = core(projected, funded, c, witness, now, ctx);
      if (trial.ok) {
        proof = trial;
        break;
      }
    }
  }
  // Necessary frictionless cash bound for a newly opened funded account in a
  // linear same-underlying hedge. For a nonzero spread/fee, pass moves farther
  // and failure occurs sooner, so the minimum required collateral only rises.
  const gain = c.payoutTarget - c.vsStart,
    loss = c.vsStart - c.fundedFail;
  const theoreticalFloor = (gain * r.personalTarget + loss * (c.minCash + r.otherHold)) / (gain + loss);
  if (!proof && cash + 1e-8 >= theoreticalFloor)
    proof = scan(projected, funded, c, { direction: 'both' }, now, ctx, true).accepted[0];
  if (proof) memo.set(proof.vsLong, proof.requested);
  r.checks.runway = !!proof;
  r.runway = {
    ok: !!proof,
    label: proof ? '可安全续航至首次出金' : '仅可完成本阶段',
    cash,
    reason: proof
      ? '重置后用实际剩余现金重新验算出金阶段双向情景通过'
      : cash < theoreticalFloor
        ? '过关后现金低于下一阶段无摩擦理论下界 ' + amount(theoreticalFloor) + ' U'
        : '重置后未找到满足回本、保证金和出金目标的候选',
    witness: proof
      ? {
          ...proof.requested,
          startRef: r.pass,
          pass: proof.pass,
          fail: proof.fail,
          buffer: proof.buffer,
          payout: proof.passState.payout
        }
      : null
  };
  return r;
}

export function analyzeCandidate(asset, account, config = {}, order = {}, now = Date.now()) {
  const c = configOf(config),
    ctx = newContext(asset, account, c, now);
  return continuation(asset, account, c, core(asset, account, c, order, now, ctx), now);
}

export function decide(asset, account, config = {}, request = {}, now = Date.now()) {
  const c = configOf(config),
    ctx = newContext(asset, account, c, now);
  const results = scan(asset, account, c, request, now, ctx),
    memo = new Map();
  if (results.accepted.length && !results.rejected.length) {
    const reference = results.accepted[0].requested;
    const v = request.mode === 'fixedHype' ? 'vs' : 'hype';
    const probe = {
      ...reference,
      [v + 'Usd']: (asset[v].minQty * markOf(asset[v]) * specValue(asset[v])) / 2
    };
    const rejectedProbe = core(asset, account, c, probe, now, ctx);
    if (!rejectedProbe.ok) results.rejected.push(rejectedProbe);
  }
  const all = results.accepted,
    candidates = all.slice(0, 8).map((r) => continuation(asset, account, c, r, now, memo));
  const rejected = results.rejected.sort((a, b) => {
    const quality = (r) => Number(r.checks.capital) + Number(r.checks.recovery) + Number(r.checks.safety);
    return (
      quality(b) - quality(a) ||
      (Number.isFinite(b.failGap) ? b.failGap : -Infinity) -
        (Number.isFinite(a.failGap) ? a.failGap : -Infinity)
    );
  });
  const best = candidates[0] ?? null,
    review = best ?? rejected[0] ?? null;
  let interval = null;
  if (all.length)
    interval = {
      vsMin: Math.min(...all.map((r) => r.vs.notional)),
      vsMax: Math.max(...all.map((r) => r.vs.notional)),
      hypeMin: Math.min(...all.map((r) => r.hype.notional)),
      hypeMax: Math.max(...all.map((r) => r.hype.notional))
    };
  for (const v of venues) {
    ctx.limits[v].matchedSafeUsd = interval?.[v + 'Max'] ?? 0;
    ctx.limits[v].matchedSafeQty = interval ? Math.max(...all.map((r) => r[v].qty)) : 0;
  }
  const reasons = best
    ? []
    : unique([
        ...ctx.reasons,
        ...(review?.reasons ?? []),
        ...(!review && !ctx.reasons.length ? ['可用资金与合法下单步长没有交集'] : [])
      ]);
  return {
    best,
    review,
    candidates,
    alternatives: candidates.slice(1),
    rejected: rejected.slice(0, 5),
    reasons,
    limits: ctx.limits,
    maxVsUsd: ctx.limits.vs.maxUsd,
    maxHypeUsd: ctx.limits.hype.maxUsd,
    interval,
    noTrade: { label: '不交易', vsUsd: 0, hypeUsd: 0, fees: 0 },
    sampleCount: all.length + rejected.length,
    matchedCount: all.length,
    status: best ? 'matched' : (review?.status ?? (ctx.reasons.length ? 'unverified' : 'unmatched'))
  };
}
