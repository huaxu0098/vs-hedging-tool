import { dec } from './math.js';
import { inspectRatio, ratioSlice, nearestRatio } from './ratio-scan.js';
import { ledgerLabels, presentLedger } from './settlement-ledger.js';

const $ = (id) => document.getElementById(id);
const write = (id, text) => {
  if ($(id).textContent !== text) $(id).textContent = text;
};
const fmt = (x, n = 2) => (x == null ? '未验证' : dec(String(x)).toFixed(n));
const usd = (x) =>
  x == null ? '未验证' : fmt(x, dec(String(x)).abs().lt('1') && !dec(String(x)).isZero() ? 4 : 2) + ' U';
const settlementAmount = (x) =>
  x == null
    ? '未验证'
    : (dec(String(x)).abs().lt('0.0001') && !dec(String(x)).isZero()
        ? dec(String(x)).toSignificantDigits(4).toString()
        : fmt(x, 4)) + ' U';
const pct = (x) => (x == null ? '未验证' : dec(String(x)).times(100).toFixed(4) + '%');
const time = (x) =>
  x
    ? new Date(x).toLocaleTimeString('zh-CN', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
      })
    : '未知';
const id = (p) => p.sign + '/' + p.i + '/' + p.j;
let sourceScope = '',
  kind = 'legal',
  frame = null,
  frameKey = '',
  selected = null,
  preferredH = null,
  audit = null,
  rendered = [],
  pending = null;
const each = (segments, fun) => segments.reduce((n, [a, b]) => fun(n, a, b), 0);
function auditText() {
  if (!$('scan-detail').open || !audit) {
    write('scan-audit', '');
    return;
  }
  const { row, scan } = audit;
  const lines = [
    '源快照 ' + frameKey + ' · 分成到账前计入 Hype 权益 0 U',
    '建议档位 ' + (row.lev ?? '空仓') + ' · 初始占用 ' + usd(row.initial) + ' · 开仓后可用 ' + usd(row.free),
    'Hype 压力后维持余量 ' + (row.stress ? usd(row.surplus) : '未配置，基础情景 ' + usd(row.surplus)),
    '若实际到账则个人分成 ' +
      usd(row.payout) +
      '；净收益基准含报名费和待收回历史成本 ' +
      usd(scan.ctx.params.profitBasis)
  ];
  for (const [key, title] of [
    ['fail', '失败'],
    ['pass', '成功']
  ]) {
    for (const venue of ['pf', 'hl']) {
      const l = row.paths?.[key]?.[venue];
      if (!l) continue;
      const view = presentLedger(l);
      lines.push(
        title +
          ' · ' +
          (venue === 'pf' ? 'PF 模拟' : 'Hype') +
          ' · 标记 ' +
          fmt(l.mark, 5) +
          ' → ' +
          fmt(l.exitMark, 5) +
          '，平仓均价 ' +
          fmt(l.exitPrice, 5),
        Object.entries(ledgerLabels)
          .map(([k, label]) => label + ' ' + view.entries[k])
          .join(' ｜ '),
        '显示舍入差 ' + view.rounding + '；平仓权益 ' + view.total + ' U'
      );
    }
  }
  if (row.stress)
    lines.push(
      '所选现金含不利价格偏移 ' +
        row.stress.priceShock +
        '、延迟成本 ' +
        usd(row.stress.delayDebit) +
        '、资金费 ' +
        usd(row.stress.fundingDebit)
    );
  write('scan-audit', lines.join('\n'));
}
function selectPoint(p, remember = true) {
  if (!frame || !p) return;
  let row;
  try {
    row = inspectRatio(frame.ctx, p, frame.endpoint);
  } catch (e) {
    write('scan-selected', '该数量组合无法结算 · ' + e.message);
    return;
  }
  selected = p;
  if (remember) preferredH = row.h;
  $('scan-side').value = String(p.sign);
  $('scan-size').step = frame.ctx.market.pf.step;
  $('scan-size').value = dec(row.pf).abs().toString();
  let bands = ratioSlice(frame, p.sign, p.i, kind);
  if (!bands.some(([a, b]) => p.j >= a && p.j <= b)) {
    kind = 'legal';
    $('scan-filter').value = kind;
    bands = ratioSlice(frame, p.sign, p.i);
  }
  const len = each(bands, (n, a, b) => n + b - a + 1);
  let index = 0;
  for (const [a, b] of bands) {
    if (p.j >= a && p.j <= b) {
      index += p.j - a;
      break;
    }
    index += b - a + 1;
  }
  const slider = $('scan-slider');
  slider.max = String(Math.max(0, len - 1));
  slider.value = String(index);
  slider.disabled = len < 2;
  if (document.activeElement !== $('scan-percent'))
    $('scan-percent').value = dec(row.h).times(100).toFixed(6);
  const show = (b) =>
    b.length
      ? b
          .map(
            ([a, z]) =>
              pct(dec(frame.constant).times(a).div(p.i)) + '–' + pct(dec(frame.constant).times(z).div(p.i))
          )
          .join('、')
      : '无';
  write(
    'scan-bands',
    '当前 PF 数量下 ' +
      $('scan-filter').selectedOptions[0].textContent +
      ' 的离散 h · ' +
      show(ratioSlice(frame, p.sign, p.i, kind)) +
      '。相邻 Hype 步长对应 ' +
      pct(dec(frame.constant).div(p.i)) +
      '。'
  );
  const flag = row.physical ? '' : ' · 风控不通过，所列终点现金仅为假设值';
  write(
    'scan-selected',
    '已选 ' +
      pct(row.h) +
      ' ｜ PF ' +
      (p.sign > 0 ? '多 ' : '空 ') +
      usd(row.pfValue) +
      '（' +
      row.pf +
      '） · Hype ' +
      (p.j === 0 ? '空仓 ' : p.sign > 0 ? '空 ' : '多 ') +
      usd(row.hypeValue) +
      '（' +
      row.hl +
      '）' +
      flag
  );
  write(
    'scan-cash',
    '失败端个人资金 ' +
      settlementAmount(row.fail) +
      '（相对总投入 ' +
      settlementAmount(row.failNet) +
      '） · 成功端 Hype 平仓权益 ' +
      settlementAmount(row.success) +
      '（相对当前 ' +
      usd(row.successChange) +
      '） · 所选终点个人净收益 ' +
      (!frame.endpoint ? '待选终点' : row.physical ? settlementAmount(row.net) : '路径风险不通过')
  );
  write(
    'scan-risk',
    '失败保护缺口 ' +
      usd(row.shortfall) +
      ' / ' +
      pct(row.gapRate) +
      ' · 成功端现金消耗 ' +
      pct(row.consumption) +
      ' · 初始保证金 ' +
      usd(row.initial) +
      ' / ' +
      pct(row.imRate) +
      ' · 维持余量 ' +
      usd(row.surplus) +
      ' / ' +
      pct(row.surplusRate) +
      ' · 强平价 ' +
      (row.liquidation == null ? '模型无正价交点或空仓' : fmt(row.liquidation)) +
      ' · 距离 ' +
      fmt(row.buffer) +
      ' / ' +
      pct(row.bufferRate) +
      (row.reason ? ' · ' + row.reason.code + '，缺 ' + fmt(row.reason.shortfall) : '')
  );
  audit = { row, scan: frame };
  auditText();
  for (const tr of $('scan-rows').rows) tr.setAttribute('aria-selected', String(tr.dataset.point === id(p)));
}
function table(points) {
  const tbody = $('scan-rows');
  tbody.replaceChildren();
  const dedup = new Set();
  rendered = [];
  for (const p of points.filter(Boolean)) {
    if (dedup.has(id(p))) continue;
    dedup.add(id(p));
    let row;
    try {
      row = inspectRatio(frame.ctx, p, frame.endpoint);
    } catch {
      continue;
    }
    rendered.push(row);
  }
  for (const row of rendered.sort((a, b) => dec(a.h).cmp(b.h))) {
    const tr = tbody.insertRow();
    tr.tabIndex = 0;
    tr.dataset.point = id(row);
    const risk = row.physical ? (row.covers && row.survives ? '满足两端' : '现金约束缺口') : '路径风险不通过';
    for (const text of [
      pct(row.h),
      usd(row.pfValue) + ' / ' + row.pf,
      usd(row.hypeValue) + ' / ' + row.hl,
      pct(row.gapRate),
      usd(row.successChange),
      !frame.endpoint ? '待选终点' : row.physical ? settlementAmount(row.net) : '终点不可用',
      pct(row.imRate) + ' · ' + risk
    ])
      tr.insertCell().textContent = text;
    tr.onclick = () => selectPoint(row);
    tr.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectPoint(row);
      }
    };
  }
}
function draw(result) {
  const s = result.ratioScan;
  $('scan-results').hidden = !s?.defaultPoint;
  $('scan-focus').hidden = !s?.defaultPoint;
  for (const k of ['protect', 'survive', 'profit']) {
    const set = s?.sets[k];
    write(
      'scan-' + k,
      k === 'profit' && s && s.ctx.params.profitBasis == null
        ? '待录入实际总投入'
        : k === 'profit' && !s?.endpoint
          ? '待选择终点'
          : !set
            ? '—'
            : set.min
              ? pct(set.min.h) + ' – ' + pct(set.max.h)
              : s.complete
                ? '无'
                : '当前覆盖内未找到'
    );
    write(
      'scan-' + k + '-count',
      set && (k !== 'profit' || s.endpoint) ? set.count.toLocaleString() + ' 组合法仓位 · 离散比例边界' : ''
    );
  }
  write(
    'scan-intersection',
    !s
      ? ''
      : s.ctx.params.profitBasis == null
        ? '请在资金规则中录入实际总投入，以核算个人净收益。'
        : !s.endpoint
          ? '选择结算终点后计算净收益。'
          : s.sets.joint.count
            ? '满足保护、留存与净盈利目标的离散比例 ' +
              pct(s.sets.joint.min.h) +
              ' – ' +
              pct(s.sets.joint.max.h)
            : s.complete
              ? '当前规则下没有同时满足条件的盈利比例。'
              : '已扫描部分未找到交集，完整范围未验证。'
  );
  write(
    'scan-loss',
    s?.sets.loss.count
      ? '成功到账前，相对本金亏损的离散比例 ' + pct(s.sets.loss.min.h) + ' – ' + pct(s.sets.loss.max.h)
      : ''
  );
  if (s?.sets.high.count)
    write(
      'scan-loss',
      $('scan-loss').textContent +
        ' · 高风险或资金缺口 ' +
        s.sets.high.count.toLocaleString() +
        ' 组，可按定位范围查看。'
    );
  if (s?.complete && !s.sets.both.count)
    write(
      'scan-intersection',
      '无解 · 没有同时达到失败保护、成功留存及风控约束的仓位。' +
        (s.endpoint && !s.sets.joint.count ? '当前规则下没有同时满足条件的盈利比例。' : '')
    );
  if (!s?.defaultPoint) {
    frame = null;
    frameKey = '';
    selected = null;
    audit = null;
    $('scan-rows').replaceChildren();
    for (const id of ['scan-selected', 'scan-cash', 'scan-risk', 'scan-bands', 'scan-audit']) write(id, '');
    return;
  }
  frame = s;
  frameKey = result.trace.id;
  const p = preferredH != null ? (nearestRatio(s, preferredH, kind) ?? s.defaultPoint) : s.defaultPoint;
  const edges = Object.values(s.sets).flatMap((v) => [v.min, v.max]);
  const bands = ratioSlice(s, p.sign, p.i);
  const inside = bands.flatMap(([a, b]) => [a, Math.floor((a + b) / 2), b].map((j) => ({ ...p, j })));
  table([p, s.defaultPoint, ...edges, ...inside]);
  selectPoint(p, false);
}
export function renderScan(result, m, r, plan, status) {
  const scope = String(plan) + '/' + m.asset + '/' + r.stage;
  if (scope !== sourceScope) {
    sourceScope = scope;
    preferredH = null;
    kind = 'legal';
    $('scan-filter').value = kind;
  }
  for (const [key, title] of [
    ['pf', 'VS'],
    ['hl', 'Hype']
  ]) {
    const q = m[key];
    write('scan-' + key + '-price', q?.mark == null ? '—' : fmt(q.mark));
    write(
      'scan-' + key + '-quote',
      q?.levels
        ? '买 ' + fmt(q.levels[0]?.[0]?.[0]) + ' / 卖 ' + fmt(q.levels[1]?.[0]?.[0]) + ' · ' + time(q.asOf)
        : title + ' 等待盘口'
    );
  }
  const factor = result.ratioScan?.ctx.market.hl.factor;
  const diff = m.pf?.mark && m.hl?.mark && factor ? dec(m.hl.mark).div(factor).minus(m.pf.mark) : null;
  write('scan-basis', diff ? fmt(diff, 3) + ' / ' + pct(diff.div(m.pf.mark)) : '待换汇核对');
  write('scan-clock', (m.source ?? '等待来源') + (factor ? ' · 价格换算系数 ' + fmt(factor, 6) : ''));
  const f = result.funding;
  write(
    'scan-capital',
    f?.E != null
      ? '保护基准 ' +
          usd(f.B) +
          ' · Hype ' +
          usd(f.C_H) +
          ' · 外部到账 ' +
          usd(f.C_E) +
          ' · PF ' +
          usd(f.E) +
          '（失败 ' +
          fmt(f.F) +
          ' / 成功 ' +
          fmt(f.T) +
          '） · 成功最低留存 ' +
          usd(f.R_success)
      : plan
        ? '预设规划 · 等待完整行情和规划条件'
        : '当前账户 · 等待有效权益和持仓快照'
  );
  $('scan-endpoint').querySelector('[value="paid"]').disabled = r.stage !== 'funded';
  $('scan-endpoint').value = r.scanEndpoint === 'paid' && r.stage !== 'funded' ? '' : (r.scanEndpoint ?? '');
  pending = result.refreshPending
    ? { since: result.since, trigger: result.trigger, last: result.lastFinished }
    : null;
  const s = result.ratioScan;
  write(
    'scan-status',
    s
      ? (s.complete ? '全网格扫描' : '扫描预算已到，范围仅覆盖已验分支') +
          ' · ' +
          s.sets.legal.count.toLocaleString() +
          ' 组可结算仓位 · ' +
          (result.solveMs ?? 0) +
          ' ms · ' +
          (result.autoStatus ?? '条件扫描') +
          ' · ' +
          (result.stress?.label || '按配置压力') +
          '。区间两端均有对应仓位，中间按数量步长取值。同一比例换用另一组仓位，费用和风险会改变。' +
          (s.sets.risk.count ? '' : ' 当前没有通过保证金与清算检查的仓位。')
      : pending
        ? pendingText()
        : (status ?? '等待数据') + (result.lastFinished ? ' · 上次完成 ' + result.lastFinished.id : '')
  );
  const previousTick = !!(pending && frame && result.trigger === '实时行情或汇率更新');
  const desk = $('scan-desk');
  desk.classList.toggle('scan-stale', previousTick);
  $('scan-results').inert = previousTick;
  if (!previousTick && (!s || frameKey !== result.trace?.id)) draw(result);
}
function pendingText() {
  return (
    (pending.trigger ?? '输入更新') +
    ' · 重算 ' +
    Math.max(0, Math.round(performance.now() - (pending.since ?? performance.now()))) +
    ' ms · ' +
    (pending.trigger === '实时行情或汇率更新' && frame ? '灰色结果为上帧，已失效 · ' : '') +
    (pending.last ? '上次完成 ' + pending.last.id + ' ' + time(pending.last.at) : '首次扫描')
  );
}
export function setupScan(onPath, onConfig) {
  $('scan-config').onclick = onConfig;
  $('scan-endpoint').onchange = () => onPath($('scan-endpoint').value);
  $('scan-detail').ontoggle = auditText;
  $('scan-filter').onchange = () => {
    kind = $('scan-filter').value;
    if (!frame) return;
    const point = frame.sets[kind]?.min;
    if (point) {
      table([point, ...rendered]);
      selectPoint(point);
    } else write('scan-bands', '当前条件下该集合没有可供选择的仓位。');
  };
  $('scan-find').onclick = () => {
    if (!frame) return;
    const value = $('scan-percent').value;
    if (value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return;
    const p = nearestRatio(frame, dec(value).div(100), kind);
    if (p) {
      table([p, ...rendered]);
      selectPoint(p);
      write(
        'scan-bands',
        '输入 ' + value + '%，最近合法比例 ' + pct(audit.row.h) + '。' + $('scan-bands').textContent
      );
    } else write('scan-bands', '所选集合没有符合条件的比例。');
  };
  $('scan-scale').onclick = () => {
    if (!frame || !selected) return;
    const input = $('scan-size').value;
    if (!input) return;
    const lot = dec(input).div(frame.ctx.market.pf.step);
    const sign = Number($('scan-side').value);
    if (!lot.isInteger() || !Number.isSafeInteger(lot.toNumber()) || lot.lte(0)) {
      write('scan-bands', '请输入符合 PF 数量步长的正数量。');
      return;
    }
    const i = lot.toNumber(),
      bands = ratioSlice(frame, sign, i, kind);
    if (!bands.length) {
      write('scan-bands', '该方向和 PF 数量下，所选集合为空。');
      return;
    }
    const raw = dec(audit.row.h).times(i).div(frame.constant).round().toNumber();
    const js = bands.map(([a, b]) => Math.max(a, Math.min(b, raw)));
    const j = js.reduce((a, b) => (Math.abs(a - raw) <= Math.abs(b - raw) ? a : b));
    const point = { i, j, sign };
    table([point, ...rendered]);
    selectPoint(point);
  };
  $('scan-percent').onkeydown = (e) => {
    if (e.key === 'Enter') $('scan-find').click();
  };
  $('scan-reset').onclick = () => {
    preferredH = null;
    if (frame) selectPoint(frame.defaultPoint, false);
  };
  $('scan-slider').oninput = () => {
    if (!frame || !selected) return;
    let n = Number($('scan-slider').value);
    for (const [a, b] of ratioSlice(frame, selected.sign, selected.i, kind)) {
      if (n <= b - a) {
        selectPoint({ ...selected, j: a + n });
        return;
      }
      n -= b - a + 1;
    }
  };
  setInterval(() => {
    if (pending) write('scan-status', pendingText());
  }, 250);
}
