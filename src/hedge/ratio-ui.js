import { dec } from './math.js';
import { inspectRatio, ratioSlice, nearestRatio, adjacentScale } from './ratio-scan.js';
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
    const stop = key === 'fail' ? row.failStop : row.passStop;
    if (stop) lines.push(title + '路径 · ' + stop + '，以下目标价流水仅用于核对公式，实际清算现金未知');
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
    row = inspectRatio(frame.ctx, p);
  } catch (e) {
    write('scan-selected', '该数量组合无法结算 · ' + e.message);
    return;
  }
  $('scan-focus').hidden = false;
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
    '目标仓位 · 已选 ' +
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
      flag +
      ' · 从当前价格先到一条 PF 边界，按当前价格映射与盘口深度估算平仓'
  );
  const protectedPrincipal = (covered) =>
    (covered ? '收回保护本金 ' : '未收回保护本金 ') + usd(frame.ctx.book.B);
  const condition = row.physical ? '在此路径下，' : '若能到达并平仓，';
  write('scan-fail-cash', row.failStop ?? settlementAmount(row.fail));
  write(
    'scan-fail-net',
    condition +
      protectedPrincipal(row.covers) +
      ' · 差额 ' +
      settlementAmount(row.failureVsProtection) +
      ' · 相对总投入 ' +
      settlementAmount(row.failNet) +
      ' · PF 结算 ' +
      usd(row.paths.fail.pf.settled)
  );
  write('scan-pass-title', row.funded ? '若 VS 达到提款线 · 到账前个人剩余' : '若 VS 先通过 · 个人剩余');
  write('scan-pass-cash', row.passStop ?? settlementAmount(row.successPersonal));
  write(
    'scan-pass-net',
    condition +
      protectedPrincipal(row.successCoversPrincipal) +
      ' · Hype 平仓权益 ' +
      settlementAmount(row.success) +
      (row.survives ? '，达到最低留存' : '，低于最低留存') +
      ' · 相对总投入 ' +
      settlementAmount(row.successNet) +
      ' · PF 结算 ' +
      usd(row.paths.pass.pf.settled)
  );
  if (row.failStop) write('scan-fail-net', '按该路径无法完成双边平仓，实际回收待核对清算结算。');
  if (row.passStop) write('scan-pass-net', '按该路径无法完成双边平仓，实际结余待核对清算结算。');
  const cutoff = row.deadline;
  write(
    'scan-deadline',
    cutoff.status === 'scenario'
      ? settlementAmount(cutoff.cash)
      : cutoff.status === 'notApplicable'
        ? '当前阶段不适用'
        : cutoff.status === 'firstBoundary'
          ? cutoff.key === 'fail'
            ? '先触及失败线'
            : '先触及通过线'
          : cutoff.status === 'risk'
            ? '路径风险未通过'
            : '到期结果未知'
  );
  write(
    'scan-deadline-note',
    cutoff.status === 'scenario'
      ? '按指定截止价 ' + cutoff.mark + ' 单向运行并平仓'
      : cutoff.status === 'unknown'
        ? '需要截止时间与明确的终点价格'
        : ''
  );
  if (row.funded && row.passStop)
    write('scan-funded', 'Funded 分成 · ' + row.passStop + '，无法验证该仓位的完整到账路径');
  else if (row.funded)
    write(
      'scan-funded',
      'Funded 分成 · 目标可分 ' +
        usd(row.funded.eligible) +
        ' · 若该笔全额到账，个人现金 ' +
        settlementAmount(row.funded.ifCredited) +
        '，相对总投入 ' +
        settlementAmount(row.funded.ifCreditedNet) +
        ' · 已确认到账 ' +
        (row.funded.received == null ? '未知' : usd(row.funded.received)) +
        (row.funded.pending == null ? '' : ' · 待到账 ' + usd(row.funded.pending))
    );
  write(
    'scan-risk',
    '失败保护缺口 ' +
      (row.failStop ? '未知' : usd(row.shortfall) + ' / ' + pct(row.gapRate)) +
      ' · 成功端现金消耗 ' +
      (row.passStop ? '未知' : pct(row.consumption)) +
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
function contains(scan, point, group) {
  return (
    point && ratioSlice(scan, point.sign, point.i, group).some(([lo, hi]) => lo <= point.j && point.j <= hi)
  );
}
function table(points) {
  const tbody = $('scan-rows');
  tbody.replaceChildren();
  const dedup = new Set();
  rendered = [];
  for (const p of points.filter(Boolean)) {
    if (dedup.has(id(p)) || !contains(frame, p, kind)) continue;
    dedup.add(id(p));
    let row;
    try {
      row = inspectRatio(frame.ctx, p);
    } catch {
      continue;
    }
    rendered.push(row);
  }
  for (const row of rendered.sort((a, b) => dec(a.h).cmp(b.h))) {
    const tr = tbody.insertRow();
    tr.tabIndex = 0;
    tr.dataset.point = id(row);
    const risk = row.both
      ? '双路径保护'
      : !row.physical
        ? '风控不通过'
        : row.covers
          ? '仅失败回本'
          : row.survives
            ? '仅成功留存'
            : '两端均有缺口';
    tr.dataset.both = String(row.both);
    for (const text of [
      pct(row.h) + ' · ' + risk,
      (row.sign > 0 ? '多 ' : '空 ') + usd(row.pfValue) + ' / ' + row.pf,
      (row.j === 0 ? '空仓 ' : row.sign > 0 ? '空 ' : '多 ') + usd(row.hypeValue) + ' / ' + row.hl,
      row.failStop ?? settlementAmount(row.fail) + ' / ' + settlementAmount(row.shortfall),
      row.passStop ??
        settlementAmount(row.successPersonal) +
          ' / ' +
          settlementAmount(row.successNet) +
          (row.successCoversPrincipal ? ' · 回本' : ' · 未回本'),
      (row.failStop ? '未知' : pct(row.gapRate)) + ' / ' + (row.passStop ? '未知' : pct(row.consumption)),
      pct(row.imRate) +
        ' / ' +
        usd(row.surplus) +
        ' / ' +
        (row.buffer == null ? '无已验证价格距离' : fmt(row.buffer))
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
  for (const k of ['protect', 'survive', 'both', 'profit']) {
    const set = s?.sets[k];
    const unknown = k === 'profit' && s && s.ctx.params.profitBasis == null;
    write(
      'scan-' + k,
      unknown
        ? '待录入实际总投入'
        : !set
          ? '—'
          : set.min
            ? pct(set.min.h) + ' – ' + pct(set.max.h)
            : !s.complete
              ? '已扫描范围内未找到'
              : k === 'profit'
                ? s.ctx.params.externalPriced === false
                  ? '已确认资金下无净盈利，外币估值待核实'
                  : '当前已定义路径下无净盈利比例'
                : '无候选'
    );
    write(
      'scan-' + k + '-count',
      set && !unknown
        ? set.count.toLocaleString() +
            ' 组' +
            (k === 'profit'
              ? ' · 两端个人净变化均 > 0'
              : k === 'both'
                ? ' · 失败回本且成功达到留存'
                : ' · 离散边界')
        : ''
    );
  }
  write(
    'scan-intersection',
    '四个区间均限于通过已配置保证金及清算检查的仓位。按方向、PF 数量和 Hype 数量逐组计数。双路径保护要求同组达到两项门槛。净盈利要求失败与成功两端的个人资金均高于累计投入，成功端按分成到账前结算。'
  );
  const describe = (set) =>
    set.count ? pct(set.min.h) + ' – ' + pct(set.max.h) + '（' + set.count.toLocaleString() + ' 组）' : '无';
  write(
    'scan-loss',
    s && s.ctx.params.profitBasis != null
      ? '单项正净现金 · 失败路径 ' +
          describe(s.sets.failProfit) +
          '，成功路径 ' +
          describe(s.sets.passProfit) +
          (s.ctx.book.stage === 'funded'
            ? '，若本轮分成全额到账 ' + describe(s.sets.afterCreditProfit)
            : '') +
          '。'
      : ''
  );
  const bins = $('scan-buckets');
  bins.replaceChildren();
  for (const bin of s?.buckets ?? []) {
    const tr = bins.insertRow();
    const label =
      bin.above == null
        ? '0% · Hype 空仓'
        : '＞' + pct(bin.above) + (bin.through == null ? '' : ' 至 ≤' + pct(bin.through));
    for (const txt of [
      label,
      ...['legal', 'protect', 'survive', 'both', 'profit'].map((k) =>
        k === 'profit' && s.ctx.params.profitBasis == null ? '待核算' : bin[k].toLocaleString()
      )
    ])
      tr.insertCell().textContent = txt;
  }
  if (!s?.defaultPoint) {
    frame = null;
    frameKey = '';
    selected = null;
    audit = null;
    $('scan-rows').replaceChildren();
    for (const id of [
      'scan-selected',
      'scan-fail-cash',
      'scan-fail-net',
      'scan-pass-cash',
      'scan-pass-net',
      'scan-deadline',
      'scan-deadline-note',
      'scan-risk',
      'scan-bands',
      'scan-audit'
    ])
      write(id, '');
    return;
  }
  frame = s;
  frameKey = result.trace.id;
  const p =
    preferredH != null && contains(s, selected, kind)
      ? selected
      : preferredH != null && s.sets[kind]?.count
        ? nearestRatio(s, preferredH, kind)
        : contains(s, s.defaultPoint, kind)
          ? s.defaultPoint
          : s.sets[kind]?.min;
  if (!p) {
    emptyFilter();
    return;
  }
  const edges = Object.values(s.sets).flatMap((v) => [v.min, v.max]);
  const bands = ratioSlice(s, p.sign, p.i);
  const inside = bands.flatMap(([a, b]) => [a, Math.floor((a + b) / 2), b].map((j) => ({ ...p, j })));
  table([p, s.defaultPoint, ...edges, ...inside]);
  selectPoint(p, false);
}
export function renderScan(result, m, r, plan, status) {
  const scope = String(plan) + '/' + m.asset + '/' + r.stage + '/' + r.mode;
  if (scope !== sourceScope) {
    sourceScope = scope;
    preferredH = null;
    selected = null;
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
          (result.notices?.some((v) => v.includes('估值未确认')) ? '（未含待估值外币）' : '') +
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
  if (r.stage !== 'funded') write('scan-funded', 'Funded 分成 · 当前阶段不适用');
  else if (result.receipt?.amount != null && dec(result.receipt.amount).gt(0))
    write(
      'scan-funded',
      '本轮首笔已到账 ' +
        usd(result.receipt.amount) +
        ' · 当前个人现金 ' +
        usd(result.receipt.cash) +
        ' · 相对累计投入 ' +
        settlementAmount(result.receipt.net) +
        ' · 已计入' +
        (result.receipt.source === 'hl' ? ' Hype 权益' : '外部资金')
    );
  else if (!result.ratioScan?.defaultPoint)
    write('scan-funded', 'Funded 分成 · 等待有效快照，到账状态待核实');
  pending = result.refreshPending
    ? { since: result.since, trigger: result.trigger, last: result.lastFinished, error: result.priorError }
    : null;
  const s = result.ratioScan;
  write(
    'scan-status',
    s
      ? (s.complete
          ? r.mode === 'keepPF'
            ? '固定 PF 现仓的完整网格'
            : r.mode === 'keepHL'
              ? '固定 Hype 现仓的完整网格'
              : '全网格扫描'
          : '扫描预算已到，范围仅覆盖已验分支') +
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
  if (result.autoStatus === 'AUTO_DEADLINE_EXIT_REQUIRED')
    write(
      'scan-status',
      result.deadlineExit == null
        ? '考核已到期 · 到期结果未知，缺少截止时双边快照'
        : '考核已到期 · 按截止盘口平仓估算个人现金 ' +
            settlementAmount(result.deadlineExit) +
            '，实际成交待核对'
    );
  const previousTick = !!(pending && frame && result.trigger === '实时行情或汇率更新');
  const desk = $('scan-desk');
  desk.classList.toggle('scan-stale', previousTick);
  $('scan-results').inert = previousTick;
  if (!previousTick && (!s || frameKey !== result.trace?.id)) draw(result);
}
function pendingText() {
  return (
    (pending.error ? pending.error + ' · ' : '') +
    (pending.trigger ?? '输入更新') +
    ' · 重算 ' +
    Math.max(0, Math.round(performance.now() - (pending.since ?? performance.now()))) +
    ' ms · ' +
    (pending.trigger === '实时行情或汇率更新' && frame ? '灰色结果为上帧，已失效 · ' : '') +
    (pending.last ? '上次完成 ' + pending.last.id + ' ' + time(pending.last.at) : '首次扫描')
  );
}
function emptyFilter() {
  table([]);
  selected = null;
  audit = null;
  preferredH = null;
  $('scan-focus').hidden = true;
  $('scan-slider').disabled = true;
  if (frame.ctx.book.stage === 'funded') write('scan-funded', 'Funded 分成 · 当前筛选范围没有候选');
  write('scan-bands', '当前范围没有候选。');
  auditText();
}
export function setupScan(onConfig) {
  $('scan-config').onclick = onConfig;
  $('scan-detail').ontoggle = auditText;
  $('scan-filter').onchange = () => {
    kind = $('scan-filter').value;
    if (!frame) return;
    draw({ ratioScan: frame, trace: { id: frameKey } });
  };
  $('scan-find').onclick = () => {
    if (!frame) return;
    const value = $('scan-percent').value;
    if (value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return;
    const target = dec(value).div(100);
    // The displayed h may represent several sizes. Offer one meeting both conditions
    // if its displayed ratio matches the requested precision; all sizes stay accessible.
    const protectedPoint =
      kind === 'legal' && frame.sets.both.count ? nearestRatio(frame, target, 'both') : null;
    const digits = Math.max(4, dec(value).decimalPlaces());
    const preferred =
      protectedPoint &&
      dec(frame.constant).times(protectedPoint.j).times(100).div(protectedPoint.i).toFixed(digits) ===
        dec(value).toFixed(digits);
    const p = preferred ? protectedPoint : nearestRatio(frame, target, kind);
    if (p) {
      table([p, ...rendered]);
      selectPoint(p);
      write(
        'scan-bands',
        '输入 ' +
          value +
          '%，' +
          (preferred ? '该显示精度内的双路径保护仓位 ' : '最近合法比例 ') +
          pct(audit.row.h) +
          '。' +
          $('scan-bands').textContent
      );
    } else write('scan-bands', '所选集合没有符合条件的比例。');
  };
  for (const [button, direction] of [
    ['scan-smaller', -1],
    ['scan-larger', 1]
  ]) {
    $(button).onclick = () => {
      if (!frame || !selected) return;
      const p = adjacentScale(frame, selected, direction, kind);
      if (p) {
        table([selected, p, ...rendered]);
        selectPoint(p);
      } else
        write(
          'scan-bands',
          '当前方向与筛选范围内，该精确比例没有' + (direction > 0 ? '更大' : '更小') + '的 PF 规模。'
        );
    };
  }
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
    kind = 'legal';
    $('scan-filter').value = kind;
    if (frame) draw({ ratioScan: frame, trace: { id: frameKey } });
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
