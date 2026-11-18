const NS = 'http://www.w3.org/2000/svg';
const LEFT = 14,
  RIGHT = 696,
  TOP = 15,
  BOTTOM = 164;
export const VISIBLE_CANDLES = 60;

function svgNode(name, attrs = {}, text) {
  const el = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}

const price = (n) => n.toLocaleString('zh-CN', { maximumSignificantDigits: 10 });
const time = (ts) =>
  new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

// The caller supplies only completed replay steps for one instrument.
export function drawCandles(container, asset, bars) {
  const last = bars.at(-1);
  const title = document.createElement('strong');
  title.textContent = asset.ticker + ' · ' + asset.priceUnit;
  const quotes = document.createElement('span');
  quotes.textContent = [
    '开 ' + price(last.open),
    '高 ' + price(last.high),
    '低 ' + price(last.low),
    '收 ' + price(last.close)
  ].join('　');
  const head = document.createElement('div');
  head.className = 'sim-candle-meta';
  head.append(title, quotes);

  const svg = svgNode('svg', {
    viewBox: '0 0 820 195',
    role: 'img',
    'aria-label': asset.ticker + ' 已播放的 ' + bars.length + ' 根价格蜡烛图'
  });
  const lo = Math.min(...bars.map((row) => row.low)),
    hi = Math.max(...bars.map((row) => row.high));
  const pad = (hi - lo) * 0.09 || Math.max(Math.abs(lo) * 0.00025, Number.MIN_VALUE);
  const low = lo - pad,
    high = hi + pad;
  const y = (value) => TOP + ((high - value) / (high - low)) * (BOTTOM - TOP);
  const slot = (RIGHT - LEFT) / Math.max(1, bars.length),
    w = Math.min(20, slot * 0.64);
  const at = (i) => LEFT + (i + 0.5) * slot;

  for (let i = 0; i < 4; i++) {
    const value = low + ((high - low) * i) / 3,
      yy = y(value);
    svg.append(
      svgNode('line', { x1: LEFT, x2: RIGHT, y1: yy, y2: yy, stroke: '#dfe7df' }),
      svgNode('text', { x: RIGHT + 12, y: yy + 4, fill: '#54645b', 'font-size': 13 }, price(value))
    );
  }
  for (const [i, row] of bars.entries()) {
    const x = at(i),
      color = row.close >= row.open ? '#247156' : '#b35938';
    const bodyHeight = Math.abs(y(row.close) - y(row.open));
    const bodyY =
      bodyHeight < 1.5 ? (y(row.close) + y(row.open)) / 2 - 0.75 : Math.min(y(row.close), y(row.open));
    const group = svgNode('g', { 'data-candle': row.assetId });
    group.append(
      svgNode(
        'title',
        {},
        time(row.ts) +
          '　开 ' +
          price(row.open) +
          '　高 ' +
          price(row.high) +
          '　低 ' +
          price(row.low) +
          '　收 ' +
          price(row.close)
      ),
      svgNode('line', { x1: x, x2: x, y1: y(row.high), y2: y(row.low), stroke: color, 'stroke-width': 1.7 }),
      svgNode('rect', {
        x: x - w / 2,
        y: bodyY,
        width: w,
        height: Math.max(1.5, bodyHeight),
        rx: 1,
        fill: color
      })
    );
    svg.append(group);
  }
  svg.append(
    svgNode(
      'text',
      { x: Math.max(62, at(0)), y: 189, 'text-anchor': 'middle', fill: '#54645b', 'font-size': 13 },
      time(bars[0].ts)
    )
  );
  if (bars.length > 1)
    svg.append(
      svgNode(
        'text',
        {
          x: Math.min(RIGHT - 46, at(bars.length - 1)),
          y: 189,
          'text-anchor': 'middle',
          fill: '#54645b',
          'font-size': 13
        },
        time(last.ts)
      )
    );
  container.replaceChildren(head, svg);
}
