import { observationKey, assessObservation, validateObservation } from './account-observation.js';

const main = document.querySelector('main');
const make = (tag, value, className) => {
  const el = document.createElement(tag);
  if (value !== undefined) el.textContent = value;
  if (className) el.className = className;
  return el;
};
const money = (n) => (n == null ? '未读取' : '$' + n);
const date = (t) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(t));
function resultCard(title, value, detail) {
  const card = make('section', undefined, 'card');
  card.append(make('h2', title), make('strong', value, 'readout-number'), make('p', detail));
  return card;
}
function receipt(title, entries) {
  const box = make('section', undefined, 'card');
  box.append(make('h2', title));
  const list = make('dl');
  for (const [name, value] of entries) list.append(make('dt', name), make('dd', value));
  box.append(list);
  return box;
}
function section(title) {
  return make('h2', title, 'readout-heading');
}
function openDesk() {
  const a = make('a', '打开只读账户接入');
  a.href = '/?live-input=1#feeds';
  return a;
}
function render(s) {
  const r = assessObservation(s);
  main.id = 'account-readout';
  main.append(
    make('h1', '本次双边仓位与盈亏'),
    make('p', s.vs.symbol + ' × ' + s.hl.symbol + ' · 官网页面只读快照 · 上海时间', 'observation-meta')
  );
  const message = make(
    'p',
    r.flatAndBlocked
      ? '本次不开仓。VS 可用保证金和交易额度均为零，当前没有持仓。'
      : r.stop
        ? '本次不开仓。当前 VS 主账户没有考核通过或失败情景。'
        : '当前资料不足以核实双边新增金额。',
    'observation-verdict'
  );
  const grid = make('div', undefined, 'observation-grid');
  grid.append(
    resultCard('VS 本次新增名义额', r.tickets, r.stop ? '本次新增数量为零。' : '需确认实际账户和可开仓位。'),
    resultCard(
      'Hype 本次新增名义额',
      r.tickets,
      r.stop ? '没有对应的 VS 新仓，双边方案不增开对冲。' : '需确认资金池、可用保证金及合法数量。'
    )
  );
  main.append(message, grid, section('VS 触线时的个人净盈亏'));
  const scenarios = make('div', undefined, 'observation-grid');
  const desc = r.stop ? '本次新增交易带来的盈亏为 $0.00。' : '本次新增交易的盈亏仍待核算。';
  scenarios.append(resultCard('VS 通过', r.scenario, desc), resultCard('VS 失败', r.scenario, desc));
  main.append(
    scenarios,
    make('p', '个人整轮盈亏待核算，已付报名费、历史交易和其他账户持仓需要独立核对。'),
    section('两边实际读到了什么')
  );
  const values = make('div', undefined, 'observation-grid');
  values.append(
    receipt('VS · ' + s.vs.symbol, [
      ['账户', s.vs.primary ? '主账户' : '类型待确认'],
      ['账户价值', money(s.vs.equity)],
      ['可用保证金', money(s.vs.free)],
      ['页面交易额度', money(s.vs.capacity)],
      ['持仓', s.vs.emptyPositions ? '页面明确显示无持仓' : '需核对完整列表'],
      ['读取时间', date(s.vs.at)]
    ]),
    receipt('Hyperliquid · ' + s.hl.symbol, [
      ['连接状态', s.hl.disconnected ? '页面显示 Connect' : '需要核对账户身份'],
      ['账户价值', money(s.hl.equity)],
      ['可用额度（页面原币）', s.hl.free ?? '未读取'],
      ['持仓', s.hl.disconnected ? '钱包未连接，无法读取' : '需核对完整列表'],
      ['读取时间', date(s.hl.at)]
    ])
  );
  main.append(values, section('继续核算还缺什么'));
  const ul = make('ul');
  r.missing.forEach((x) => ul.append(make('li', x)));
  main.append(ul, openDesk());
}
export function showReport() {
  document.title = '本次双边仓位与盈亏 · VS × Hype';
  main.replaceChildren();
  const nav = document.querySelector('nav');
  nav.replaceChildren();
  const back = make('a', '返回动态匹配');
  back.href = '/';
  nav.append(back, openDesk());
  try {
    const raw = new URLSearchParams(location.hash.slice(1)).get('observation');
    if (raw && raw.length > 6000) throw Error('快照过大');
    if (raw) {
      history.replaceState(null, '', location.pathname + '?accounts=last');
    }
    const snapshot = validateObservation(JSON.parse(raw ?? localStorage.getItem(observationKey)));
    if (raw) localStorage.setItem(observationKey, JSON.stringify(snapshot));
    render(snapshot);
  } catch (e) {
    main.append(make('h1', '尚无可用的账户识别结果'), make('p', e.message), openDesk());
  }
}
