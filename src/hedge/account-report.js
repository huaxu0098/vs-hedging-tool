import { defaults } from './workspace.js';
import { createBook } from './book.js';
import { dec } from './math.js';
import { demoMarket, solve } from './solver.js';
import { applyTargets, atPrice, settleBoundary } from './replay.js';
import { sizingParameters } from './sizing-parameters.js';
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
  const simulate = make('a', '用默认考核参数模拟');
  simulate.href = '/?simulation=challenge';
  nav.append(back, simulate, openDesk());
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

function units(value) {
  const [whole, cents] = dec(value).toFixed(2).split('.');
  return whole.replace(/\B(?=(?:\d{3})+(?!\d))/g, ',') + '.' + cents + ' U';
}

export function showChallengeSimulation() {
  const parameters = sizingParameters((id) => {
    const field = document.getElementById(id);
    if (field instanceof HTMLSelectElement)
      return (Array.from(field.options).find((option) => option.defaultSelected) ?? field.options[0]).value;
    return field.defaultValue;
  });
  const at = new Date().toISOString();
  const book = createBook({ ...defaults, id: 'challenge-preview', pf: defaults.baseline, time: at });
  const market = demoMarket('btc');

  main.replaceChildren();
  main.id = 'account-readout';
  document.title = '默认考核模拟 · VS × Hype';
  const back = make('a', '返回动态匹配');
  back.href = '/';
  const nav = document.querySelector('nav');
  nav.replaceChildren(back);
  if (localStorage.getItem(observationKey)) {
    const latest = make('a', '上次账户识别');
    latest.href = '/?accounts=last';
    nav.append(latest);
  }
  main.append(
    make('h1', 'BTC 考核模拟'),
    make(
      'p',
      'VS 初始净值 ' +
        units(book.pf) +
        '。个人本金 ' +
        units(book.B) +
        ' 扣除报名费 ' +
        units(book.fees.registration) +
        '，Hype 开仓前可用 ' +
        units(book.hl) +
        '。'
    )
  );

  const result = solve(book, market, parameters, { now: at });
  const candidate = result.selected;
  if (!candidate) {
    main.append(
      section('本次没有可行的双边仓位'),
      make('p', result.unresolved.join('、') || '当前候选未同时满足失败回本、现金留存和保证金约束。')
    );
    return;
  }
  const opened = applyTargets(
    book,
    market,
    { pf: candidate.vsTargetQuantity, hl: candidate.hlTargetQuantity },
    at,
    'open'
  );
  const tickets = make('div', undefined, 'observation-grid');
  for (const [name, qty, notional, margin] of [
    ['VS', candidate.vsTargetQuantity, candidate.vsNotional, candidate.initialMargin[0]],
    ['Hype', candidate.hlTargetQuantity, candidate.hlNotional, candidate.initialMargin[1]]
  ]) {
    const q = dec(qty);
    tickets.append(
      resultCard(
        name + (q.isZero() ? ' 空仓' : q.gt(0) ? ' 做多' : ' 做空'),
        units(notional),
        q.abs().toString() + ' BTC · 初始保证金 ' + units(margin)
      )
    );
  }
  main.append(section('两边各开多少'), tickets, section('触线平仓后，个人还剩多少'));
  const outcomes = make('div', undefined, 'observation-grid');
  for (const [label, event, shift, threshold] of [
    ['VS 通过', 'pass', candidate.lines.pass, book.challengeTarget],
    ['VS 失败', 'failure', candidate.lines.fail, book.challengeFloor]
  ]) {
    // Both settlements start from the same opening fills and include their own closing fees.
    const exitMarket = atPrice(market, shift);
    const closing = settleBoundary(opened, exitMarket, event, at, event);
    const pnl = dec(closing.cash).minus(book.B);
    const outcome = resultCard(
      label + ' · 净值 ' + units(threshold),
      '剩 ' + units(closing.cash),
      '比最初 ' + units(book.B) + (pnl.isZero() ? ' 持平' : (pnl.gt(0) ? ' 赚 ' : ' 亏 ') + units(pnl.abs()))
    );
    outcome.append(
      make(
        'p',
        '开平仓手续费合计：VS ' +
          units(closing.state.fees.pf) +
          '，Hype ' +
          units(closing.state.fees.hl) +
          '。',
        'observation-meta'
      )
    );
    outcomes.append(outcome);
  }
  main.append(
    outcomes,
    make(
      'p',
      '通过考核后取得 Funded 账户，考核盈利不可提款。两种结果均已计入一次报名费及各自的开平仓手续费。'
    )
  );
  const feeRate = (leg) => dec(leg.rate).times(100).toString() + '%';
  main.append(
    make(
      'p',
      '本次按 BTC 模拟开仓价 ' +
        units(market.pf.mark) +
        '/BTC，VS 单边费率 ' +
        feeRate(market.pf) +
        '、Hype 单边费率 ' +
        feeRate(market.hl) +
        '。假设零点差、零滑点、零资金费，且在 ' +
        defaults.hours +
        ' 小时内先触及相应边界。',
      'observation-meta'
    )
  );
  const details = make('details');
  details.append(
    make('summary', '查看选仓范围与触线价格'),
    make(
      'p',
      'VS 候选名义额为 ' +
        parameters.sizes.map(units).join('、') +
        '。在失败端回本且通过端 Hype 至少保留 ' +
        units(parameters.R) +
        ' 的候选中，按通过后的剩余现金排序。本次对冲比例 ' +
        dec(candidate.actualRatio).times(100).toFixed(2) +
        '%。'
    ),
    make(
      'p',
      'BTC 模拟通过价约 ' +
        units(atPrice(market, candidate.lines.pass).pf.mark) +
        '/BTC，失败价约 ' +
        units(atPrice(market, candidate.lines.fail).pf.mark) +
        '/BTC。'
    )
  );
  main.append(details);
}
