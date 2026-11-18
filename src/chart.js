const ns = 'http://www.w3.org/2000/svg';
const charts = new WeakMap();
const palette = { vs: '#3b7859', hype: '#ab7d44', muted: '#54675b', grid: '#e2e9e3' };

function svgElement(name, attrs, text) {
  const node = document.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatNumber(value, interval) {
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e8 || magnitude < 0.00001) return value.toExponential(2);
  const digits = Math.min(10, Math.max(0, 1 - Math.floor(Math.log10(interval))));
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function niceStep(target) {
  const order = 10 ** Math.floor(Math.log10(target));
  return ([1, 2, 2.5, 5, 10].find(factor => factor * order >= target) ?? 10) * order;
}

function emptyChart(container, reason) {
  const message = reason ? '无法绘制价格情景。' + reason : '等待有效的价格和仓位。';
  const placeholder = document.createElement('div');
  placeholder.className = 'chart-empty';
  placeholder.textContent = message;
  container.setAttribute('aria-label', message);
  container.replaceChildren(placeholder);
}

// Keep four short labels readable even when several thresholds share a tick.
function placeLabels(markers, xmin, xmax) {
  const gap = 33;
  let previous = xmin - gap;
  for (const marker of markers) {
    marker.labelX = Math.max(marker.x, previous + gap);
    previous = marker.labelX;
  }
  let next = xmax + gap;
  for (let i = markers.length - 1; i >= 0; i--) {
    markers[i].labelX = Math.min(markers[i].labelX, next - gap);
    next = markers[i].labelX;
  }
}

function render(container, { asset, result, width }) {
  const ref = asset?.referencePrice;
  const { pass, fail, liq } = result ?? {};
  if (![ref, pass, fail, liq].every(value => Number.isFinite(value) && value > 0) ||
      ![result?.vs?.delta, result?.hype?.delta].every(Number.isFinite)) {
    emptyChart(container, result?.reasons?.[0]);
    return;
  }
  const markers = [
    { short: '失败', full: 'VS 失败', price: fail, color: '#8d6857' },
    { short: '参考', full: '当前参考', price: ref, color: '#5a695e' },
    { short: '通过', full: 'VS 通过', price: pass, color: palette.vs },
    { short: '强平', full: 'Hype 强平', price: liq, color: palette.hype },
  ].sort((a, b) => a.price - b.price);
  const first = markers[0].price, last = markers[3].price;
  const margin = Math.max((last - first) * 0.08, Math.abs(ref) * 1e-9, Number.EPSILON);
  const low = Math.max(0, first - margin), high = last + margin;
  const span = high - low;
  const maxDollars = Math.max(Math.abs(result.vs.delta), Math.abs(result.hype.delta)) *
    Math.max(Math.abs(low - ref), Math.abs(high - ref));
  if (!(span > 0 && maxDollars > 0) || !Number.isFinite(span) || !Number.isFinite(maxDollars)) {
    emptyChart(container, '价格情景超出图表显示范围。');
    return;
  }

  const top = 44, bottom = 132, left = 49, right = width - 12;
  const baseline = (top + bottom) / 2;
  const x = price => left + (price - low) / span * (right - left);
  const y = dollars => baseline - dollars / maxDollars * (bottom - top) * 0.48;
  const svg = svgElement('svg', { viewBox: '0 0 ' + width + ' 172', class: 'plot-svg', 'aria-hidden': 'true',
    'font-family': 'system-ui, sans-serif', 'font-size': 10, fill: palette.muted });
  function add(tag, attributes, text) {
    const node = svgElement(tag, attributes, text);
    svg.append(node);
    return node;
  }
  const line = (x1, y1, x2, y2, opts = {}) => add('line', { x1, y1, x2, y2, stroke: palette.grid, ...opts });
  const label = (cx, cy, value, opts = {}) => add('text', { x: cx, y: cy, ...opts }, value);

  add('rect', { x: left, y: top, width: right - left, height: bottom - top, fill: '#fff' });
  const bufferLeft = Math.min(x(pass), x(liq)), bufferWidth = Math.abs(x(pass) - x(liq));
  const sufficient = result.buffer > 0 && result.buffer >= asset.minBuffer;
  add('rect', { x: bufferLeft, y: top, width: bufferWidth, height: bottom - top,
    fill: sufficient ? '#eff5ee' : '#f9eee3' });
  const xStep = niceStep(span / (width < 430 ? 3 : 5));
  // Use an upper bound so extreme price inputs cannot produce an unbounded tick loop.
  const firstTick = Math.ceil(low / xStep);
  for (let i = 0; i < 8; i++) {
    const tick = (firstTick + i) * xStep;
    if (!Number.isFinite(tick) || tick > high) break;
    const cx = x(tick);
    line(cx, top, cx, bottom);
    const tickText = formatNumber(tick, xStep);
    const halfLabel = tickText.length * 3.3;
    const labelX = Math.max(left, Math.min(width - halfLabel - 2, cx));
    label(labelX, bottom + 15, tickText, { 'text-anchor': 'middle' });
  }
  const yTick = niceStep(maxDollars / 4);
  const yLimit = Math.floor(maxDollars / yTick) * yTick;
  for (const dollar of [-yLimit, 0, yLimit]) {
    const cy = y(dollar);
    line(left, cy, right, cy, { stroke: dollar === 0 ? '#adbfaf' : palette.grid });
    label(left - 6, cy + 3, (dollar > 0 ? '+' : '') + formatNumber(dollar, yTick), { 'text-anchor': 'end' });
  }
  label(left, 12, '美元盈亏变化');
  const unitLabel = [...String(asset.priceUnit || '')].slice(0, 14).join('');
  label(right, 165, '标的价格（' + unitLabel + '）', { 'text-anchor': 'end' });

  for (const marker of markers) marker.x = x(marker.price);
  placeLabels(markers, left + 10, right - 10);
  for (const marker of markers) {
    line(marker.x, top, marker.x, bottom, { stroke: marker.color, opacity: 0.5, 'stroke-dasharray': '3 4' });
    line(marker.labelX, top - 10, marker.x, top - 1, { stroke: marker.color, opacity: 0.55 });
    label(marker.labelX, top - 12, marker.short, { 'text-anchor': 'middle', fill: marker.color });
    const hit = add('rect', { x: marker.x - 5, y: top, width: 10, height: bottom - top, fill: 'transparent' });
    hit.append(svgElement('title', {}, marker.full + ' ' + marker.price + ' ' + asset.priceUnit));
  }
  if (bufferWidth > 75) {
    label(bufferLeft + bufferWidth / 2, bottom - 4, '强平缓冲', { 'text-anchor': 'middle',
      fill: sufficient ? '#537453' : '#956d48', 'font-size': 10 });
  }
  for (const venue of ['vs', 'hype']) {
    const delta = result[venue].delta;
    line(left, y((low - ref) * delta), right, y((high - ref) * delta), { stroke: palette[venue], 'stroke-width': 2 });
  }
  add('circle', { cx: x(ref), cy: baseline, r: 3, fill: '#fff', stroke: '#455a49', 'stroke-width': 1.4 });
  const details = markers.map(m => m.full + ' ' + m.price.toLocaleString('zh-CN', { maximumSignificantDigits: 8 }));
  container.setAttribute('aria-label', asset.name + '价格情景。以当前参考价为零点，每上涨 1 ' + asset.priceUnit +
    '，VS 盈亏变化 ' + result.vs.delta + ' 美元，Hype 盈亏变化 ' + result.hype.delta + ' 美元。' + details.join('，') + '。');
  container.replaceChildren(svg);
}

export function drawChart(container, asset, result) {
  let chart = charts.get(container);
  if (!chart) {
    chart = {};
    charts.set(container, chart);
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        if (container.clientWidth > 0 && container.clientWidth !== chart.width) {
          chart.width = Math.max(230, container.clientWidth);
          render(container, chart);
        }
      });
      observer.observe(container);
    }
  }
  Object.assign(chart, { asset, result, width: Math.max(230, container.clientWidth || 550) });
  render(container, chart);
}
