// Each leg maps the common reference price to its own mark with a verified slope.
// A multiplier is the settlement-currency payoff per local quote point per lot.
const positive = value => Number.isFinite(value) && value > 0;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const label = value => typeof value === 'string' && value.trim().length > 0;

function validateLeg(leg, name, asset, now, rates, reasons) {
  const reject = message => reasons.push(name + '：' + message);
  if (!leg) {
    reject('缺少合约参数');
    return;
  }
  if (!label(leg.symbol)) reject('缺少合约代码');
  if (!label(leg.benchmark) || leg.benchmark !== asset.benchmark) reject('跟踪基准与所选标的不一致');
  if (leg.type !== 'linear') reject('不支持该合约类型');
  if (leg.open !== true) reject('市场休市或交易状态未知');
  const stamp = Date.parse(leg.asOf);
  if (!Number.isFinite(stamp) || stamp > now) reject('报价时间无效或晚于验算时间');
  else if (now - stamp > asset.maxAgeSec * 1000) reject('报价过期，请更新模拟快照');

  for (const [currency, usd] of [[leg.quote, leg.quoteUsd], [leg.settle, leg.settleUsd]]) {
    if (!label(currency) || !positive(usd)) {
      reject('报价或结算币种无法换算为美元');
      break;
    }
    const code = currency.trim().toUpperCase();
    if (rates.has(code) && Math.abs(rates.get(code) / usd - 1) > 1e-9) {
      reject(code + ' 的美元汇率不一致');
    }
    rates.set(code, usd);
  }
  // quoteScale is the number of native underlying units priced by one local
  // quoted unit (e.g. troy ounces in one gram). Allow rounded FX/unit inputs.
  const quoteScale = leg.quoteScale === undefined ? 1 : leg.quoteScale;
  if (!positive(quoteScale)) reject('报价标尺折合的原生标的数量必须为正数');
  else if (positive(leg.quoteUsd) && positive(leg.ratio) &&
      Math.abs(leg.quoteUsd * leg.ratio / quoteScale - 1) > 0.000100000001)
    reject('报价映射与美元汇率不一致，无法验证参考价格尺度');
  if (![leg.price, leg.multiplier, leg.ratio, leg.tick, leg.step, leg.minQty].every(positive))
    reject('报价、乘数、映射系数、价格步长及下单数量规则必须为正数');
  const spread = leg.spread ?? 0;
  if (!nonnegative(spread) || leg.price - spread / 2 <= 0) reject('买卖点差无效');
  if (!nonnegative(leg.feeRate) || leg.feeRate >= 1) reject('费率须在 0 至 1 之间');
  if (!Number.isFinite(leg.leverage) || leg.leverage < 1 || !nonnegative(leg.mmr) ||
      leg.mmr >= 1 / leg.leverage) reject('维持保证金率须低于初始保证金率，杠杆至少为 1');
}

// Floor exact decimal inputs. Dividing floating-point values first can incorrectly
// discard a tradable step or allow the opening notional to exceed the input.
function decimalParts(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [integer, fraction = ''] = mantissa.split('.');
  return { coefficient: BigInt(integer + fraction), power: Number(exponent) - fraction.length };
}

function tradableQty(usd, leg, entry) {
  const amount = decimalParts(usd);
  const step = decimalParts(leg.step);
  let denominator = step.coefficient;
  let power = amount.power - step.power;
  for (const factor of [entry, leg.multiplier, leg.settleUsd]) {
    const part = decimalParts(factor);
    denominator *= part.coefficient;
    power -= part.power;
  }
  const numerator = amount.coefficient * (power > 0 ? 10n ** BigInt(power) : 1n);
  if (power < 0) denominator *= 10n ** BigInt(-power);
  const steps = numerator / denominator;
  if (steps > BigInt(Number.MAX_SAFE_INTEGER)) return NaN;
  return Number(String(steps * step.coefficient) + 'e' + step.power);
}

function grid(value, tick, up) {
  const count = value / tick;
  if (!Number.isFinite(count) || Math.abs(count) >= Number.MAX_SAFE_INTEGER) return NaN;
  const nearest = Math.round(count);
  // Exact decimal multiples often have a tiny IEEE-754 residual.
  const tolerance = Math.min(1e-8, Number.EPSILON * Math.max(1, Math.abs(count)) * 4);
  const units = Math.abs(count - nearest) <= tolerance ? nearest : (up ? Math.ceil(count) : Math.floor(count));
  // Form the decimal product before converting back to double.
  const part = decimalParts(tick);
  return Number(String(BigInt(units) * part.coefficient) + 'e' + part.power);
}

function executable(mark, leg, buy) {
  return grid(mark + (buy ? 0.5 : -0.5) * (leg.spread ?? 0), leg.tick, buy);
}

function position(leg, usd, sign) {
  const entryPrice = executable(leg.price, leg, sign > 0);
  const exitPrice = executable(leg.price, leg, sign < 0);
  if (!positive(entryPrice) || !positive(exitPrice)) return null;
  const qty = tradableQty(usd, leg, entryPrice);
  const lotValue = leg.multiplier * leg.settleUsd;
  const pointValue = qty * lotValue;
  const notional = pointValue * entryPrice;
  const fees = pointValue * leg.feeRate * (entryPrice + exitPrice);
  return {
    qty, qtyUnit: leg.qtyUnit, idealQty: usd / (entryPrice * lotValue),
    side: sign > 0 ? 'long' : 'short', entryPrice, exitPrice, pointValue,
    delta: sign * pointValue * leg.ratio, notional, margin: notional / leg.leverage,
    feeRate: leg.feeRate, fees
  };
}

function vsBoundary(asset, position, sign, target) {
  const leg = asset.vs;
  // target = size * [side * (exit-entry) - fee * (entry+exit)].
  const exit = (target / position.pointValue + (sign + leg.feeRate) * position.entryPrice) /
    (sign - leg.feeRate);
  // Executable bids floor to the quote grid and asks ceil, but the mark itself
  // can be between ticks. Pass is inclusive. Loss first reaches its limit
  // strictly beyond the adjacent tick edge; use that edge as the risk boundary.
  const exitTick = grid(exit, leg.tick, sign * target > 0);
  const edge = target < 0 ? exitTick + sign * leg.tick : exitTick;
  const mark = edge + sign * (leg.spread ?? 0) / 2;
  return asset.referencePrice + (mark - leg.price) / leg.ratio;
}

function liquidation(asset, leg, position, sign) {
  // Isolated equity equals the fixed maintenance ratio times mark notional.
  // Fees are held separately from this position's isolated margin.
  const mark = (sign * position.entryPrice - position.margin / position.pointValue) / (sign - leg.mmr);
  // Maintenance is checked on the continuous mark. Delaying it to the next
  // tradable order tick could overstate the buffer.
  return asset.referencePrice + (mark - leg.price) / leg.ratio;
}

function blankResult() {
  return { ok: false, reasons: [], vs: null, hype: null, pass: null, fail: null, liq: null,
    vsLiq: null, failRelation: null, buffer: null, bufferPct: null, reserve: null, netDelta: null, matchPct: null, basisPct: null };
}

export function evaluate(asset, order, available = 500, now = Date.now()) {
  const out = blankResult();
  const reasons = out.reasons;
  if (!asset || !order) {
    reasons.push('缺少品种或开仓金额');
    return out;
  }
  const { referencePrice: ref } = asset;
  const maxBasisPct = asset.maxBasisPct ?? 1;
  const minMatchPct = asset.minMatchPct ?? 95;
  if (!label(asset.benchmark) || asset.verified !== true) reasons.push('尚未验证同一标的及两边的价格映射');
  if (![ref, asset.maxAgeSec, asset.vsProfit, asset.vsLoss].every(positive) ||
      !nonnegative(asset.minBuffer) || !nonnegative(maxBasisPct) ||
      !nonnegative(minMatchPct) || minMatchPct > 100) reasons.push('品种参考价、报价期限或风控阈值无效');
  if (!positive(order.vsUsd) || !positive(order.hypeUsd)) reasons.push('两边美元名义金额必须大于零');
  if (typeof order.vsLong !== 'boolean') reasons.push('请选择两边相反的开仓方向');
  if (!nonnegative(available) || !Number.isFinite(now)) reasons.push('可用本金或验算时间无效');
  const rates = new Map([['USD', 1]]);
  validateLeg(asset.vs, 'VS', asset, now, rates, reasons);
  validateLeg(asset.hype, 'Hype', asset, now, rates, reasons);
  if (reasons.length) return out;

  const marks = [ref, asset.vs.price / asset.vs.ratio, asset.hype.price / asset.hype.ratio];
  out.basisPct = (Math.max(...marks) - Math.min(...marks)) / ref * 100;
  if (!Number.isFinite(out.basisPct) || out.basisPct > maxBasisPct + 1e-10) {
    reasons.push('两边报价映射后的基差超出允许范围，价格关系无法验证');
    return out;
  }

  const vsSign = order.vsLong ? 1 : -1;
  out.vs = position(asset.vs, order.vsUsd, vsSign);
  out.hype = position(asset.hype, order.hypeUsd, -vsSign);
  for (const [leg, name, pos] of [[asset.vs, 'VS', out.vs], [asset.hype, 'Hype', out.hype]]) {
    if (!pos || !Number.isFinite(pos.qty) || !Number.isFinite(pos.delta) || !Number.isFinite(pos.notional)) {
      reasons.push(name + '：报价或数量超出可计算范围');
    } else if (pos.qty < leg.minQty || !positive(pos.pointValue)) {
      reasons.push(name + '：按数量步长向下取整后，低于最小下单量');
    }
  }
  if (reasons.length) return out;

  const { vs, hype } = out;
  out.pass = vsBoundary(asset, vs, vsSign, asset.vsProfit);
  out.fail = vsBoundary(asset, vs, vsSign, -asset.vsLoss);
  out.failRelation = vsSign > 0 ? '<' : '>';
  out.liq = liquidation(asset, asset.hype, hype, -vsSign);
  out.vsLiq = liquidation(asset, asset.vs, vs, vsSign);
  out.netDelta = vs.delta + hype.delta;
  const larger = Math.max(Math.abs(vs.delta), Math.abs(hype.delta));
  out.matchPct = Math.min(Math.abs(vs.delta), Math.abs(hype.delta)) / larger * 100;
  out.buffer = vsSign * (out.liq - out.pass);
  out.bufferPct = out.buffer / ref * 100;
  // Reserve the highest projected Hype exit fee across the modeled boundaries.
  const highest = Math.max(ref, out.pass, out.fail, out.liq);
  const highestMark = asset.hype.price + (highest - ref) * asset.hype.ratio;
  const highestExit = executable(highestMark, asset.hype, vsSign > 0);
  hype.fees = hype.pointValue * hype.feeRate * (hype.entryPrice + highestExit);
  out.reserve = hype.margin + hype.fees;

  if (![out.pass, out.fail, out.liq, out.vsLiq, out.buffer, out.bufferPct, out.reserve, out.netDelta,
    out.matchPct].every(Number.isFinite)) {
    reasons.push('仓位或价格超出可计算范围');
    return out;
  }
  const lowest = Math.min(ref, out.pass, out.fail, out.liq);
  if (lowest <= 0 || [asset.vs, asset.hype].some(leg =>
    leg.price + (lowest - ref) * leg.ratio - (leg.spread ?? 0) / 2 <= 0))
    reasons.push('存在非正触发价，超出当前模拟价格区间');
  const initialVsNet = vsSign * vs.pointValue * (vs.exitPrice - vs.entryPrice) - vs.fees;
  if (initialVsNet <= -asset.vsLoss) reasons.push('计入点差与手续费后，VS 入场时已达失败线');
  if (vsSign * (out.vsLiq - out.fail) >= 0) reasons.push('VS 逐仓维持保证金线先于考核失败触发');
  if (vsSign * (out.liq - ref) <= 0) reasons.push('Hype 入场时已触及维持保证金线');
  if (out.buffer <= 0 || out.buffer + Math.abs(out.buffer) * 1e-12 < asset.minBuffer)
    reasons.push('取整后强平缓冲不足');
  if (out.matchPct + 1e-10 < minMatchPct) reasons.push('取整后美元盈亏敏感度的匹配率低于阈值');
  if (out.reserve - available > Math.max(1, available) * Number.EPSILON * 4)
    reasons.push('共享可用本金不足，无法预留 Hype 逐仓保证金与费用');
  out.ok = reasons.length === 0;
  return out;
}
