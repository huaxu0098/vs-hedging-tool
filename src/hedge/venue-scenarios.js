// FX is expressed as Vest quote units per Hype quote unit.
import { dec, out, min, nonnegative } from './math.js';

export const venueCases = {
  premiumWider: ['跨所基差扩大', 'widenBps'],
  premiumCloser: ['跨所基差收敛', 'narrowBps'],
  vestJump: ['Vest 单边跳过触线价', 'vestJumpBps'],
  hypeJump: ['Hype 单边不利跳价', 'hypeJumpBps'],
  vestFirst: ['Vest 先平，Hype 延迟平仓', 'vestFirstBps'],
  hypeFirst: ['Hype 先平，Vest 随后触线', 'hypeFirstBps']
};
export const venueFields = [...Object.values(venueCases).map(([, field]) => field),'exitLagBps'];

export function basisObservation(pf, hl, fx) {
  if (fx == null || !dec(fx).gt(0)) return null;
  const converted = dec(hl).times(fx);
  const gap = converted.minus(pf);
  return { converted: out(converted), gap: out(gap), bps: out(gap.times(10000).div(pf)), rate: fx };
}

export function venuePath(id, market, pfEnd, fx, bps, hypeQty) {
  const vestStart = dec(market.pf.mark), hypeStart = dec(market.hl.mark);
  const basis = basisObservation(vestStart, hypeStart, fx);
  if (!basis) return { error: '缺少同帧、有方向的报价币汇率' };
  const trigger = dec(pfEnd), move = trigger.minus(vestStart), width = nonnegative(bps).div(10000);
  const common = hypeStart.times(trigger).div(vestStart);
  const hypeSide = dec(hypeQty).cmp(0);
  // Before the event both venues follow the same proportional move.
  let vestExit = trigger, vestInterim = trigger, hypeExit = common, hypeInterim = common;
  switch (id) {
    case 'premiumWider':
    case 'premiumCloser': {
      const premium = dec(basis.bps).div(10000);
      const side = premium.cmp(0) || -hypeSide || 1;
      const magnitude = id === 'premiumWider' ? premium.abs().plus(width) : premium.abs().minus(min(premium.abs(), width));
      hypeExit = trigger.div(fx).times(magnitude.times(side).plus(1));
      break;
    }
    case 'vestJump':
      vestExit = trigger.plus(vestStart.times(width).times(move.cmp(0)));
      break;
    case 'hypeJump': {
      const shock = hypeStart.times(width).times(-hypeSide);
      vestInterim = vestStart;
      hypeInterim = hypeStart.plus(shock);
      hypeExit = common.plus(shock);
      break;
    }
    case 'vestFirst':
      hypeExit = common.times(dec('1').minus(width.times(hypeSide)));
      break;
    case 'hypeFirst':
      // Hype closes before the last segment of the move to Vest's boundary.
      vestInterim = trigger.minus(min(move.abs(), vestStart.times(width)).times(move.cmp(0)));
      hypeExit = hypeStart.times(vestInterim).div(vestStart);
      hypeInterim = hypeExit;
      break;
    default:
      throw Error('未知跨所压力情景');
  }
  if ([vestExit, hypeExit, hypeInterim, vestInterim].some(mark => !mark.gt(0)))
    return { error: '压力情景超出正价格范围' };
  return {
    triggerMark: out(trigger), pfEnd: out(vestExit), hlEnd: out(hypeExit),
    pfInterim: out(vestInterim), hlInterim: out(hypeInterim),
    basisBefore: basis, basisAfter: basisObservation(vestExit, hypeExit, fx), bps
  };
}
