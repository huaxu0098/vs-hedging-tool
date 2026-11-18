import { drawCandles, VISIBLE_CANDLES } from './candles.js';
import {
  accountView,
  actSimulation,
  applySimulation,
  firstPayout,
  getSimulation,
  historyCsv,
  restoreSimulation,
  observeSimulationRisk,
  readObservation,
  checkRecordedBeforeWrite,
  SIM_KEY,
  transactSimulation,
  valueAt
} from './simulation.js';
import { DEMOS, compareRounds, makeDemo, parseCandles, previewScenario, stepCandle } from './replay.js';
import { createTemplates } from './assets.js';
import { getLedger } from './ledger.js';

const fmt = (n, d = 2) =>
  Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: d }) : '—';
const outcome = {
  success: '达标结算',
  failure: '失败结算',
  liquidation: 'Hype 强平，终止',
  day: '日内收盘',
  none: '尚未触线',
  uncertain: '触线顺序不确定',
  stopped: '周期已结束'
};
const stateName = {
  active: '进行中',
  failed: '已失败',
  withdrawn: '已出金',
  abandoned: '已放弃',
  liquidated: '已强平'
};
const stage = (s) => (s.stage === 'challenge' ? '考核' : '出金');
function node(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function savefile(name, data, type) {
  const a = document.createElement('a'),
    u = URL.createObjectURL(new Blob([data], { type }));
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
function chart(rows, keys, lines = [], bars = false) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 440 100');
  svg.setAttribute('aria-hidden', 'true');
  const add = (name, attrs) => {
    const e = document.createElementNS(ns, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
  };
  const xs = rows.slice(-120);
  const values = xs.flatMap((row) => keys.map((k) => row[k])).concat(lines);
  const min = bars ? 0 : Math.min(...values),
    max = Math.max(min + 1, ...values);
  const y = (v) => 90 - ((v - min) / (max - min)) * 78;
  const width = 414 / Math.max(1, xs.length - 1);
  lines.forEach((n) =>
    add('line', { x1: 8, x2: 430, y1: y(n), y2: y(n), stroke: '#a2a9a0', 'stroke-dasharray': '4 4' })
  );
  keys.forEach((key, j) => {
    const color = j === 0 ? '#286651' : '#a06d23';
    if (bars)
      xs.forEach((r, i) =>
        add('rect', {
          x: 8 + i * (414 / xs.length) + j * 3,
          y: y(r[key]),
          width: Math.min(3, 202 / xs.length),
          height: 90 - y(r[key]),
          fill: color
        })
      );
    else {
      add('polyline', {
        points: xs.map((r, i) => 8 + i * width + ',' + y(r[key])).join(' '),
        stroke: color,
        'stroke-width': 2.5,
        fill: 'none'
      });
      add('circle', { cx: 8 + (xs.length - 1) * width, cy: y(xs.at(-1)[key]), r: 3, fill: color });
    }
  });
  return svg;
}
export function mountSimulation(box, options) {
  box.innerHTML = `
    <style>
      .sim-lab{display:grid;gap:16px;color:#183b30}.sim-lab h3,.sim-lab p,.sim-lab h4{margin:0}
      .sim-card{padding:18px;background:white;border:1px solid #cbd6cd;border-radius:12px;display:grid;gap:12px}
      .sim-flex,.sim-charts,.sim-metrics{display:flex;gap:9px;flex-wrap:wrap;align-items:center}.sim-charts>div{flex:1;min-width:190px}
      .sim-charts svg{display:block;width:100%;height:85px}.sim-lab button,.sim-lab select,.sim-lab input{border:1px solid #a8b6a9;background:white;color:#173e32;border-radius:6px;padding:7px 10px;font:inherit}
      .sim-lab button{cursor:pointer}.sim-lab button:disabled{opacity:.5;cursor:default}.sim-lab .sim-confirm{background:#244e40;color:white}
      .sim-metrics>div{flex:1;background:#f1f5f0;padding:9px;border-radius:6px}.sim-metrics small,.sim-metrics strong{display:block}
      .sim-lab small,.sim-lab .sim-note{font-size:12px;color:#57685c}.sim-lab output{display:block;white-space:pre-line;overflow-wrap:anywhere}
      .sim-candle-plot{padding:12px;border:1px solid #dbe4dc;background:#f7faf6;border-radius:9px;min-width:0}
      .sim-candle-plot:empty{display:none}.sim-candle-plot svg{display:block;width:100%;height:auto;max-height:245px}
      .sim-candle-meta,.sim-replay-progress{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:13px;font-variant-numeric:tabular-nums}
      .sim-replay-progress[hidden]{display:none}.sim-candle-meta{justify-content:space-between}.sim-replay-progress progress{flex:1;min-width:90px;height:9px;accent-color:#286651}
      .sim-lab pre{overflow:auto;margin:0;white-space:pre-wrap}.sim-table{max-height:340px;overflow:auto}.sim-table table{border-collapse:collapse;min-width:700px;width:100%;font-variant-numeric:tabular-nums}.sim-table th,.sim-table td{padding:5px;border-bottom:1px solid #e4ebe5;text-align:left;font-size:12px}
    </style>
    <div class="sim-lab">
      <section class="sim-card"><h3>模拟账户与成交</h3><div data-v="metrics" class="sim-metrics"></div>
        <p class="sim-note">仅手动确认会写入本地模拟账本。报名费和成交费用单列，VS 虚拟余额单独核算。</p>
        <div class="sim-flex"><button data-op="adopt">以当前看板建立模拟起点</button><button data-op="target" class="sim-confirm">按当前目标模拟开仓／调仓</button><button data-op="close">平当前品种</button><button data-op="day">日内平仓结转</button><button data-op="settle-now">按当前净值结算触线</button><button data-op="withdraw">模拟首次提款到账</button><button data-op="abandon">放弃考核／出金号</button><button data-op="rebuy">重新购买考核号</button></div>
        <output data-v="observation"></output><div><button data-op="observed-event" hidden>按首个已记录报价结算</button></div><output data-v="message" role="status"></output></section>
      <section class="sim-card"><h3>条件推演与结算</h3><p class="sim-note">使用本品种已有模拟持仓。空仓时先按当前目标核验模拟开仓。端点沿单向价格路径推演，途中先发生的事件决定结果。两次行情快照之间的真实路径未知。</p>
        <div class="sim-flex"><label>日内收盘参考价 <input data-v="closePrice" type="number" min="0" step="any" placeholder="当前价格"></label>
        <button data-op="success">到通过／出金线</button><button data-op="failure">到失败线</button><button data-op="scenario-day">日内未达标收盘</button>
        <button data-op="confirm-scenario" class="sim-confirm" disabled>确认情景模拟成交</button></div><output data-v="scenario"></output>
        <div class="sim-flex"><button data-op="rounds">对比空仓、再做一轮、停止及重新买号</button></div><output data-v="rounds"></output></section>
      <section class="sim-card"><h3>双账本资金曲线</h3><div data-v="charts" class="sim-charts"></div><output data-v="costs"></output>
        <div class="sim-flex"><button data-op="csv">导出流水 CSV</button><button data-op="json">导出账本 JSON</button><label>恢复账本 JSON <input data-v="restore" type="file" accept=".json,application/json"></label><a href="/fixtures/ledger-example.csv" download>示例流水 CSV</a><a href="/fixtures/ledger-example.json" download>示例账本 JSON</a></div>
        <div data-v="audit" class="sim-table"></div></section>
      <section class="sim-card"><h3>K 线回放</h3><p class="sim-note">回放在独立副本中运行。示例使用指定期初持仓和固定报价假设。导入行情使用当前模拟持仓，每根 K 线只变动对应品种，其余品种的标记价冻结在最近快照。每步校验所有模拟仓位的维持保证金，结果仅适用于这条条件路径。</p>
        <div class="sim-flex"><label>内置情景 <select data-v="demo"></select></label><button data-op="load-demo">载入情景</button>
          <label>导入 K 线 CSV <input data-v="candles" type="file" accept=".csv,text/csv"></label><a href="/fixtures/multi-asset-candles.csv" download>多品种 K 线样例</a></div>
        <div class="sim-flex"><button data-op="step">单步回放</button><button data-op="play">播放</button><button data-op="pause">暂停</button><button data-op="export-replay">导出回放账本 JSON</button></div>
        <div class="sim-replay-progress" data-v="progressBox" hidden><span data-v="progressLabel"></span><progress data-v="progress" value="0" max="1" aria-label="K 线播放进度"></progress></div>
        <div class="sim-candle-plot" data-v="candlePlot"></div>
        <output data-v="replay" aria-live="polite"></output></section>
    </div>`;
  const q = (k) => box.querySelector('[data-v="' + k + '"]');
  const btn = (k) => box.querySelector('[data-op="' + k + '"]');
  for (const [id, title] of Object.entries(DEMOS)) {
    const o = node('option', title);
    o.value = id;
    q('demo').append(o);
  }
  const ctx = () => {
    const asset = options.getAsset(),
      all = options.getAssets();
    const assets = [asset, ...all.filter((a) => a.id !== asset.id)];
    return {
      asset,
      assets,
      config: options.getConfig(),
      now: Date.now(),
      legacyUsed: getLedger().used,
      viewAccount: options.getAccount?.()
    };
  };
  let state,
    scenario = null,
    replay = null,
    timer = null,
    lock = false;
  const message = (t) => (q('message').textContent = t);
  function display(s, context) {
    const a = accountView(s, context.assets, context.config, context.legacyUsed);
    const metrics = q('metrics');
    metrics.replaceChildren();
    for (const [label, val] of [
      ['阶段', stage(s) + ' · ' + stateName[s.status]],
      ['VS 账面／净值', fmt(a.vsBalance) + ' / ' + fmt(a.vsEquity)],
      ['个人现金／可用', fmt(a.hypeCash) + ' / ' + fmt(a.hypeFree)],
      ['首次已到账', fmt(s.received) + ' U']
    ]) {
      const cell = node('div');
      cell.append(node('small', label), node('strong', val));
      metrics.append(cell);
    }
    const c = context.config;
    const chartBox = q('charts');
    chartBox.replaceChildren();
    for (const [title, keys, lines, bars] of [
      [
        'VS 净值 · 虚线为失败与目标',
        ['vsEquity'],
        [
          s.stage === 'challenge' ? c.challengeFail : c.fundedFail,
          s.stage === 'challenge' ? c.challengeTarget : c.payoutTarget
        ],
        false
      ],
      ['个人现金 · 已扣费用', ['hypeCash'], [], false],
      ['保证金占用 · 绿 VS / 金 Hype', ['vsUsed', 'hypeUsed'], [], true]
    ]) {
      const figure = node('div');
      figure.append(node('small', title), chart(s.history, keys, lines, bars));
      chartBox.append(figure);
    }
    let eligible = '—';
    try {
      eligible = fmt(
        s.stage === 'funded' && s.status === 'active'
          ? firstPayout(valueAt(s, context.assets, c).vsSettled, c)
          : 0
      );
    } catch {}
    q('costs').textContent =
      '累计报名费 ' +
      fmt(s.fees.registration) +
      ' U　VS 成交费 ' +
      fmt(s.fees.vs) +
      ' U　Hype 成交费 ' +
      fmt(s.fees.hype) +
      ' U　毛已实现 VS ' +
      fmt(s.realized.vs) +
      ' / Hype ' +
      fmt(s.realized.hype) +
      ' U　可分未到账 ' +
      eligible +
      ' U';
    const table = node('table'),
      head = node('thead'),
      hr = node('tr');
    for (const h of [
      '时间',
      '操作',
      '账本／品种',
      '带方向数量',
      '成交价',
      '毛盈亏',
      '成交／报名费',
      'VS 账面',
      '个人现金'
    ])
      hr.append(node('th', h));
    head.append(hr);
    table.append(head);
    const body = node('tbody');
    for (const e of s.history.slice(-100).reverse()) {
      const row = node('tr');
      [
        new Date(e.time).toLocaleString('zh-CN'),
        e.label,
        [e.venue, e.assetId].filter(Boolean).join(' / '),
        fmt(e.qty, 8),
        fmt(e.price, 8),
        fmt(e.gross, 5),
        fmt(e.fee, 5),
        fmt(e.vsBalance),
        fmt(e.hypeCash)
      ].forEach((v) => row.append(node('td', v)));
      body.append(row);
    }
    table.append(body);
    q('audit').replaceChildren(table);
  }
  function showObservation(record) {
    btn('observed-event').hidden = !record || record.proofs.length !== 1 || record.pending;
    if (!record) {
      q('observation').textContent = '';
      return;
    }
    if (record.proofs.length > 1) {
      const w = record.proofs.reduce((a, b) => (a.cash <= b.cash ? a : b));
      q('observation').textContent =
        '触线顺序不确定。观察区间重叠，已锁定结算。最坏情景（比较个人现金）为 ' +
        outcome[w.event] +
        ' ' +
        fmt(w.cash) +
        ' U。';
    } else if (record.pending) {
      q('observation').textContent = '已观察到触线，但另一侧报价时点更早，暂缓结算，等待同步快照。';
    } else {
      const p = record.proofs[0];
      q('observation').textContent =
        '已观察到 ' +
        outcome[p.event] +
        ' · ' +
        new Date(p.time).toLocaleString('zh-CN') +
        '，等待明确结算。';
    }
  }
  async function observe() {
    try {
      showObservation(await observeSimulationRisk(ctx()));
    } catch (err) {
      try {
        showObservation(readObservation(getSimulation(options.getConfig())));
      } catch {}
      q('observation').textContent += ' 行情验证暂停：' + err.message;
    }
  }
  function refresh() {
    try {
      const context = ctx();
      state = getSimulation(context.config);
      display(state, context);
      showObservation(readObservation(state));
    } catch (e) {
      message(e.message);
    }
  }
  function scenarioCtx(s, context) {
    const held = s.positions.some((p) => p.assetId === context.asset.id);
    return {
      ...context,
      closePrice: q('closePrice').value ? Number(q('closePrice').value) : context.asset.referencePrice,
      order: held ? null : options.getOrder?.()
    };
  }
  const describe = (result) =>
    outcome[result.event] +
    ' · ' +
    stage(result.state) +
    ' ' +
    stateName[result.state.status] +
    ' · VS 余额 ' +
    fmt(result.state.vsBalance) +
    ' U · 个人现金 ' +
    fmt(result.state.hypeCash) +
    ' U · 已到账 ' +
    fmt(result.state.received) +
    ' U';
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  function replayStep() {
    if (!replay) throw Error('请先载入情景或 CSV');
    if (replay.done || replay.i >= replay.candles.length) {
      stop();
      return;
    }
    const bar = replay.candles[replay.i];
    const step = stepCandle(replay.state, bar, replay.assets, replay.config, replay.legacyUsed);
    if (step.event === 'stopped') {
      replay.done = true;
      stop();
      q('replay').textContent = '模拟周期已结束，回放已停止。';
      return;
    }
    replay.i++;
    const series = replay.chartHistory.get(bar.assetId) ?? [];
    series.push(bar);
    if (series.length > VISIBLE_CANDLES) series.shift();
    replay.chartHistory.set(bar.assetId, series);
    drawCandles(
      q('candlePlot'),
      replay.assets.find((a) => a.id === bar.assetId),
      series
    );
    q('progress').value = replay.i;
    q('progressLabel').textContent = '已播放 ' + replay.i + ' / ' + replay.candles.length + ' 根';
    replay.state = step.state;
    if (step.asset) replay.assets = [step.asset, ...replay.assets.filter((a) => a.id !== step.asset.id)];
    let text =
      '第 ' +
      replay.i +
      ' / ' +
      replay.candles.length +
      ' 根 · ' +
      bar.assetId +
      ' ' +
      new Date(bar.ts).toISOString() +
      '\n';
    if (step.event === 'uncertain') {
      text +=
        step.reason +
        '\n' +
        step.alternatives.map((r) => describe(r)).join('\n') +
        '\n最坏情景（按个人现金）　' +
        describe(step.worst);
    } else text += describe(step);
    if (step.terminal || replay.i === replay.candles.length) {
      if (!step.terminal && replay.kind === 'day') {
        replay.state = applySimulation(
          replay.state,
          { type: 'day' },
          { assets: replay.assets, config: replay.config, now: bar.ts }
        );
        text += '\n日内未到线平仓 · 个人现金 ' + fmt(replay.state.hypeCash) + ' U';
      }
      replay.done = true;
      stop();
    }
    q('replay').textContent = text;
  }
  function loadReplay(data, config) {
    stop();
    replay = { ...data, i: 0, config, done: false, chartHistory: new Map() };
    q('candlePlot').replaceChildren();
    q('progressBox').hidden = false;
    q('progress').max = data.candles.length;
    q('progress').value = 0;
    q('progressLabel').textContent = '已播放 0 / ' + data.candles.length + ' 根';
    q('replay').textContent =
      '已载入 ' +
      data.candles.length +
      ' 根 K 线 · ' +
      (DEMOS[data.kind] || '当前账本持仓副本') +
      ' · 点击播放或单步';
  }
  async function click(op) {
    const context = ctx();
    const c = context.config;
    state = getSimulation(c);
    if (op === 'csv')
      return savefile('vs-hype-ledger.csv', '\uFEFF' + historyCsv(state), 'text/csv;charset=utf-8');
    if (op === 'json')
      return savefile('vs-hype-ledger.json', JSON.stringify(state, null, 2), 'application/json');
    if (op === 'export-replay') {
      if (!replay) throw Error('请先载入回放');
      return savefile('vs-hype-replay.json', JSON.stringify(replay.state, null, 2), 'application/json');
    }
    if (op === 'load-demo') {
      const sample =
        createTemplates(context.now).find((a) => a.id === context.asset.id) ||
        createTemplates(context.now)[0];
      return loadReplay(makeDemo(q('demo').value, sample, c, context.now), c);
    }
    if (op === 'pause') {
      stop();
      return;
    }
    if (op === 'step') {
      stop();
      return replayStep();
    }
    if (op === 'play') {
      stop();
      replayStep();
      if (replay && !replay.done)
        timer = setInterval(() => {
          try {
            replayStep();
          } catch (e) {
            stop();
            q('replay').textContent = e.message;
          }
        }, 600);
      return;
    }
    if (op === 'rounds') {
      const r = compareRounds(
        state,
        context.asset,
        context.assets,
        c,
        options.getOrder(),
        context.now,
        context.legacyUsed
      );
      q('rounds').textContent =
        '共同平仓起点：VS 账面 ' +
        fmt(r.start.vsBalance) +
        ' U，个人现金 ' +
        fmt(r.start.hypeCash) +
        ' U。一次性平仓费用 VS ' +
        fmt(r.once.vs.fee) +
        ' / Hype ' +
        fmt(r.once.hype.fee) +
        ' U；已含在成交价格中的点差与滑点分别为 ' +
        fmt(r.once.vs.spread + r.once.vs.slippage) +
        ' / ' +
        fmt(r.once.hype.spread + r.once.hype.slippage) +
        ' U。\n' +
        '固定仓位、同价来回假设。空仓等待／停止均保留 ' +
        fmt(r.wait) +
        ' U，重新买号' +
        (r.rebuy < 0 ? '余额不足' : '后 ' + fmt(r.rebuy) + ' U') +
        '。\n' +
        r.rows
          .map(
            (row) =>
              row.n +
              ' 轮　VS 成本 ' +
              fmt(row.vsCost) +
              ' U／个人成本 ' +
              fmt(row.hypeCost) +
              ' U／剩余个人现金 ' +
              fmt(row.hype) +
              ' U　' +
              (row.ok ? '仍可继续匹配' : row.reason || '未通过')
          )
          .join('\n') +
        '\n' +
        (r.firstUnsafe === null
          ? '当前假设下未找到失效轮次'
          : r.firstUnsafe === 0
            ? '当前状态已无法满足回本或风险目标'
            : '完成 ' + r.firstUnsafe + ' 轮后，再开仓首次不能满足目标');
      return;
    }
    if (['success', 'failure', 'scenario-day'].includes(op)) {
      if (readObservation(state)) throw Error('已观察到较早触线，请先查看首个触线记录');
      scenario = null;
      btn('confirm-scenario').disabled = true;
      const kind = op === 'scenario-day' ? 'close' : op;
      const sc = scenarioCtx(state, context),
        result = previewScenario(state, kind, sc);
      if (result.event === 'uncertain') {
        q('scenario').textContent = result.reason + ' 最坏 ' + describe(result.worst);
        return;
      }
      scenario = {
        kind,
        revision: state.revision,
        config: JSON.stringify(c),
        asset: JSON.stringify(context.asset),
        order: JSON.stringify(sc.order),
        price: sc.closePrice
      };
      q('scenario').textContent = '条件推演结果　' + describe(result);
      btn('confirm-scenario').disabled = false;
      return;
    }
    if (op === 'confirm-scenario') {
      if (!scenario) throw Error('先选择情景预览');
      const p = scenario;
      await transactSimulation((latest, legacyUsed) => {
        const locked = ctx();
        const fresh = scenarioCtx(latest, { ...locked, legacyUsed });
        checkRecordedBeforeWrite(latest, fresh);
        if (
          latest.revision !== p.revision ||
          JSON.stringify(locked.config) !== p.config ||
          JSON.stringify(locked.asset) !== p.asset ||
          JSON.stringify(fresh.order) !== p.order ||
          fresh.closePrice !== p.price
        )
          throw Error('参数、报价或资金已变更，请重新预览');
        const result = previewScenario(latest, p.kind, fresh);
        if (result.event === 'uncertain') throw Error(result.reason);
        return result.state;
      }, c);
    } else {
      if (
        ['abandon', 'rebuy', 'adopt'].includes(op) &&
        !window.confirm(
          {
            abandon: '确认结清全部模拟仓位并放弃本轮？',
            rebuy: '确认扣除报名费并购买新的模拟考核号？',
            adopt: '确认以当前看板的账面余额和持仓作为模拟起点？'
          }[op]
        )
      )
        return;
      const action =
        op === 'adopt'
          ? { type: op, account: context.viewAccount }
          : op === 'target'
            ? { type: op, order: options.getOrder() }
            : { type: op };
      await actSimulation(action, context);
    }
    scenario = null;
    btn('confirm-scenario').disabled = true;
    message('模拟账本已更新。');
    refresh();
    options.onChange?.();
  }
  box.addEventListener('click', async (e) => {
    const button = e.target.closest('button[data-op]');
    if (!button || lock) return;
    lock = true;
    try {
      await click(button.dataset.op);
    } catch (err) {
      message(err.message);
      if (['step', 'play', 'load-demo'].includes(button.dataset.op)) q('replay').textContent = err.message;
    } finally {
      lock = false;
    }
  });
  q('candles').addEventListener('change', async (e) => {
    try {
      const file = e.target.files[0];
      if (!file) return;
      const c = ctx();
      const candles = parseCandles(await file.text(), c.assets);
      loadReplay(
        { state: getSimulation(c.config), candles, assets: c.assets, legacyUsed: c.legacyUsed },
        c.config
      );
    } catch (err) {
      q('replay').textContent = err.message;
    } finally {
      e.target.value = '';
    }
  });
  q('restore').addEventListener('change', async (e) => {
    try {
      const file = e.target.files[0];
      if (!file) return;
      const c = ctx();
      const current = getSimulation(c.config);
      const text = await file.text();
      if (!window.confirm('用此文件恢复本地模拟账本？当前模拟记录将被替换。')) return;
      await restoreSimulation(text, current.revision, c.config);
      refresh();
      options.onChange?.();
      message('已恢复模拟账本。');
    } catch (err) {
      message(err.message);
    } finally {
      e.target.value = '';
    }
  });
  const storage = (e) => {
    if (!e.key || e.key === SIM_KEY) refresh();
  };
  window.addEventListener('storage', storage);
  refresh();
  return {
    refresh,
    observe,
    destroy: () => {
      stop();
      window.removeEventListener('storage', storage);
      box.replaceChildren();
    }
  };
}
