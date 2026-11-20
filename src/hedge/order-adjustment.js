import { dec, out } from './math.js';

// pending is the signed unfilled quantity of verified same-side active orders.
export function adjustmentAfterOrders(delta, pending) {
  if (pending == null) return { text: '未确认挂单，待核对', remaining: null };
  const d = dec(delta), open = dec(pending);
  if (open.isZero()) return { text: '已确认无挂单', remaining: out(d) };
  if (open.times(d).lte(0)) return { text: '存在条件、减仓或方向冲突挂单，先核对', remaining: null };
  const rest = d.minus(open);
  return rest.times(d).lt(0)
    ? { text: '原挂单已超过目标，先核对', remaining: null }
    : { text: '若同向挂单全部成交', remaining: out(rest) };
}

export function remainingOrder(delta, current, orders) {
  if (!Array.isArray(orders)) return adjustmentAfterOrders(delta, null);
  if (!orders.length) return adjustmentAfterOrders(delta, '0');
  const sizes = orders.map(o => dec(o.qty));
  const pending = sizes.reduce((sum, qty) => sum.plus(qty), dec('0'));
  const projected = out(dec(current).plus(pending));
  if (orders.some((o,i) => o.conditional || o.reduceOnly || sizes[i].times(delta).lte(0)))
    return { text: '存在条件、减仓或方向冲突挂单，先核对', remaining: null, projected };
  return { ...adjustmentAfterOrders(delta, out(pending)), projected };
}
