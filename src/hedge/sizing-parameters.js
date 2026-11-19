import { positive, nonnegative, out } from './math.js';

export const fundedPreviewLimits = { R: '40', g: '20' };

export function sizingParameters(val) {
  const list = (k) =>
    val(k)
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((v) => out(positive(v)));
  return {
    target: out(positive(val('target'))),
    R: out(nonnegative(val('reserve'))),
    g: out(nonnegative(val('gain'))),
    k: out(nonnegative(val('friction'))),
    pfSize: out(nonnegative(val('pf-size'))),
    hlSize: out(nonnegative(val('hl-size'))),
    mode: val('sizing'),
    sizes: list('sizes'),
    targets: list('targets'),
    sort: val('sort'),
    directions: val('direction') === 'both' ? [1, -1] : [Number(val('direction'))]
  };
}
