import { dec } from './math.js';
import { reportGroups } from './range-report.js';
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
const pct = (x, n = 4) => (x == null ? '未验证' : dec(String(x)).times(100).toFixed(n) + '%');
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
let frame = null,
  frameKey = '',
  audit = null;
const names = {
  protect: '失败端本金回收',
  survive: '成功端最低留存',
  both: '失败回本 + 成功端最低留存',
  profit: '个人净盈利'
};
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
      '条件现金含不利价格偏移 ' +
        row.stress.priceShock +
        '、延迟成本 ' +
        usd(row.stress.delayDebit) +
        '、资金费 ' +
        usd(row.stress.fundingDebit)
    );
  write('scan-audit', lines.join('\n'));
}
function showRepresentative(scan, result) {
  const { row, objective, group, buffer, complete } = scan.representative;
  const { book, params } = scan.ctx;
  write(
    'scan-representative',
    objective === 'diagnostic' ? '自动计算代表方案 · 当前无可推荐仓位' : '自动计算代表方案 · ' + pct(row.h)
  );
  write(
    'scan-position',
    (objective === 'diagnostic' ? '仅作路径对照' : '') +
      (objective === 'diagnostic' ? '（对照比例 ' + pct(row.h) + '）' : '') +
      ' PF ' +
      (row.sign > 0 ? '多 ' : '空 ') +
      usd(row.pfValue) +
      '（数量 ' +
      row.pf +
      ' ' +
      (scan.ctx.market.pf.unit === 'contract' ? '张' : scan.ctx.market.pf.unit) +
      '） · Hype ' +
      (row.j === 0 ? '空仓 ' : row.sign > 0 ? '空 ' : '多 ') +
      usd(row.hypeValue) +
      '（数量 ' +
      row.hl +
      ' ' +
      (scan.ctx.market.hl.unit === 'contract' ? '张' : scan.ctx.market.hl.unit) +
      '）' +
      (objective === 'diagnostic' ? ' · ' + (names[group] ?? '通过保证金检查') : '') +
      (!complete && objective !== 'diagnostic' ? ' · 当前覆盖内的方案' : '')
  );
  const excess = dec(row.failureVsProtection),
    B = dec(book.B);
  const bufferRate = row.cushion.rate == null ? '无保护基准' : pct(row.cushion.rate, 6);
  const thin = row.cushion.thin;
  const stressIncomplete = result.stress?.missing.length || result.stress?.zero.length;
  $('scan-fail-net').classList.toggle('thin-buffer', thin);
  write('scan-fail-cash', row.failStop ?? settlementAmount(row.fail));
  write(
    'scan-fail-net',
    row.failStop
      ? '提前触线，实际清算金额未知。'
      : (excess.lt(0) ? '距离 ' : thin ? '仅比 ' : '比 ') +
          usd(book.B) +
          (excess.lt(0) ? ' 还差 ' : ' 多 ') +
          settlementAmount(excess.abs()) +
          '（相对保护基准 ' +
          bufferRate +
          '）' +
          (thin ? ' · 极薄缓冲（几乎零缓冲）' : '') +
          (thin && stressIncomplete
            ? result.stress.positive.length
              ? '，已配置情景刚好覆盖，完整压力未验证'
              : '，仅基础情景刚好覆盖，完整压力未验证'
            : '') +
          (dec(buffer).gt(0) ? ' · 额外缓冲要求 ' + usd(buffer) : ' · 未设额外安全缓冲')
  );
  write(
    'scan-pass-title',
    row.funded ? '若 PF 达到提款参考线 · 到账前条件结余' : '若 PF 达到通过线 · 条件结余'
  );
  write('scan-pass-cash', row.passStop ?? settlementAmount(row.successPersonal));
  const diff = dec(row.successPersonal).minus(B);
  write(
    'scan-pass-net',
    row.passStop
      ? '提前触线，实际清算金额未知。'
      : '假设 PF 自身净结算达到 ' +
          usd(params.target) +
          '。Hype 平仓权益 ' +
          settlementAmount(row.success) +
          (row.survives ? '，满足 ' : '，低于 ') +
          usd(params.R) +
          ' 最低留存。个人资金' +
          (diff.lt(0) ? '距保护本金尚差 ' : '较保护本金多 ') +
          settlementAmount(diff.abs()) +
          ' · 相对累计投入 ' +
          settlementAmount(row.successNet)
  );
  write(
    'scan-fail-summary',
    row.failStop
      ? '提前触线 · 清算结余未知'
      : (excess.lt(0) ? '距本金差 ' : '高于本金 ') +
          settlementAmount(excess.abs()) +
          (thin ? ' · 极薄缓冲' : '')
  );
  write(
    'scan-pass-summary',
    row.passStop
      ? '提前触线 · 清算结余未知'
      : (row.survives ? '满足 ' : '低于 ') +
          usd(params.R) +
          ' 留存 · ' +
          (diff.lt(0) ? '距本金差 ' : '高于本金 ') +
          settlementAmount(diff.abs())
  );
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
    'Hype 现金消耗 / 起始权益 ' +
      pct(row.consumption) +
      ' · 初始保证金 / 起始权益 ' +
      pct(row.imRate) +
      ' · 维持余量 / 路径权益 ' +
      pct(row.surplusRate) +
      ' · 强平距离 / 当前标记价 ' +
      (row.bufferRate == null ? '无正价交点或空仓' : pct(row.bufferRate))
  );
  audit = { row, scan };
  auditText();
}
const columns = [
  '范围及组合数',
  'PF 数量 / 名义额',
  'Hype 数量 / 名义额',
  '失败回收 / 成功剩余',
  '失败 / 成功双边成交手续费',
  '失败缺口 / B · 成功消耗 / Hype 权益',
  '最大保证金 / Hype 权益 · 最小强平距离 / 标记价'
];
const pair = (values, format) =>
  !values || values.some((v) => v == null) ? '未知' : values.map((v) => format(v)).join(' – ');
function summaryRow(body, label, range, emptyText) {
  const tr = body.insertRow();
  const head = document.createElement('th');
  head.scope = 'row';
  head.textContent = label;
  tr.append(head);
  if (!range) {
    const cell = tr.insertCell();
    cell.colSpan = columns.length - 1;
    cell.textContent = emptyText;
    return;
  }
  head.append(document.createElement('br'), range.count.toLocaleString() + ' 组');
  head.title =
    'PF 多 ' + range.pfLong.toLocaleString() + ' 组 / PF 空 ' + range.pfShort.toLocaleString() + ' 组';
  const lines = [
    [pair(range.pfQty, (v) => v), pair(range.pfValue, usd)],
    [pair(range.hlQty, (v) => v), pair(range.hlValue, usd)],
    [pair(range.failure, settlementAmount), pair(range.success, settlementAmount)],
    [pair(range.failureFee, settlementAmount), pair(range.successFee, settlementAmount)],
    [pair(range.gapRate, pct), pair(range.consumption, pct)],
    [
      usd(range.maxMargin) + ' / ' + pct(range.maxMarginRate),
      range.minBufferRate == null
        ? '无正价强平交点或空仓'
        : fmt(range.minBuffer) + ' / ' + pct(range.minBufferRate)
    ]
  ];
  for (const [top, bottom] of lines) tr.insertCell().append(top, document.createElement('br'), bottom);
}
// Keep the live row nodes, focus and horizontal scroll position across snapshots.
function patchRows(body, next) {
  const rows = Array.from(next.rows);
  for (const [i, incoming] of rows.entries()) {
    const row = body.rows[i];
    if (!row) {
      body.append(incoming);
      continue;
    }
    if (row.className !== incoming.className) row.className = incoming.className;
    const cells = Array.from(incoming.cells);
    for (const [j, cell] of cells.entries()) {
      const old = row.cells[j];
      if (!old) row.append(cell);
      else if (!old.isEqualNode(cell)) old.replaceWith(cell);
    }
    while (row.cells.length > cells.length) row.deleteCell(-1);
  }
  while (body.rows.length > rows.length) body.deleteRow(-1);
}
function intervalText(lo, hi, separate = ' – ') {
  let digits = 4;
  while (digits < 48 && !dec(lo).eq(hi) && pct(lo, digits) === pct(hi, digits)) digits++;
  return pct(lo, digits) + separate + pct(hi, digits);
}
function draw(result) {
  frame = result.ratioScan ?? null;
  frameKey = result.trace?.id ?? '';
  audit = null;
  auditText();
  const scan = frame,
    rep = scan?.representative;
  $('scan-results').hidden = !scan;
  $('scan-focus').hidden = !rep;
  const aggregate = document.createElement('tbody');
  const bands = document.createElement('tbody');
  const noProfit = '当前条件下无净盈利比例';
  for (const key of reportGroups) {
    const s = scan?.sets[key];
    const unknown =
      key === 'profit' &&
      scan &&
      (scan.ctx.params.profitBasis == null || scan.ctx.params.externalPriced === false);
    const empty = unknown
      ? '个人投入或外币估值待核实'
      : !scan
        ? '等待有效数据'
        : !scan.complete
          ? '已覆盖范围内未找到'
          : key === 'profit'
            ? noProfit
            : '无符合条件的仓位';
    write('scan-' + key, s?.min && !unknown ? intervalText(s.min.h, s.max.h) : empty);
    write(
      'scan-' + key + '-count',
      !s || unknown
        ? ''
        : s.count.toLocaleString() +
            ' 组' +
            (key === 'profit' ? ' · 两端净现金均高于累计投入' : ' · 离散数量网格')
    );
    $('scan-' + key).title =
      s?.min && !unknown
        ? dec(s.min.h).times(100).toString() + '% 至 ' + dec(s.max.h).times(100).toString() + '%'
        : '';
    if (scan) summaryRow(aggregate, names[key], unknown ? null : s.range, empty);
    if (key === 'profit') $('profit-panel').classList.toggle('no-profit', !s?.count && empty === noProfit);
  }
  const excluded = [];
  for (const [n, bin] of (scan?.buckets ?? []).entries()) {
    const label =
      bin.above == null
        ? '0% · Hype 空仓'
        : '＞' + (bin.through == null ? pct(bin.above) : intervalText(bin.above, bin.through, ' 至 ≤'));
    if (bin.range) {
      const includesRepresentative = rep?.segment === n;
      const tr = bands.insertRow(),
        metrics = bin.range;
      const title = document.createElement('th');
      title.scope = 'row';
      title.append(
        label,
        document.createElement('br'),
        bin.both ? '两端达标 ' + bin.both.toLocaleString() + ' 组' : '无两端达标组合'
      );
      tr.append(title);
      tr.classList.toggle('representative-range', includesRepresentative);
      title.title =
        '交集 ' + bin.both.toLocaleString() + ' 组' + (includesRepresentative ? ' · 含代表方案' : '');
      for (const [qty, value, unit] of [
        [metrics.pfQty, metrics.pfValue, scan.ctx.market.pf.unit],
        [metrics.hlQty, metrics.hlValue, scan.ctx.market.hl.unit]
      ]) {
        const cell = tr.insertCell();
        cell.append(
          pair(value, usd),
          document.createElement('br'),
          pair(qty, (v) => v) + ' ' + (unit === 'contract' ? '张' : unit)
        );
      }
      tr.insertCell().textContent = pair(metrics.failure, settlementAmount);
      tr.insertCell().textContent = pair(metrics.success, settlementAmount);
      const risk = tr.insertCell();
      risk.append(
        '缺口 ' + pct(metrics.gapRate?.[1], 2),
        document.createElement('br'),
        '占用 ' + pct(metrics.maxMarginRate, 2)
      );
      risk.title =
        '失败缺口 / 本金，初始保证金 / Hype 起始权益 · 成功消耗 ' +
        pair(metrics.consumption, pct) +
        ' · 最小强平距离 / 标记价 ' +
        pct(metrics.minBufferRate);
    }
    if (bin.legal)
      excluded.push(
        label +
          ' · 合法 ' +
          bin.legal.toLocaleString() +
          '，失败回本 ' +
          bin.protect.toLocaleString() +
          '，成功留存 ' +
          bin.survive.toLocaleString() +
          '，交集 ' +
          bin.both.toLocaleString() +
          '，未达到两端约束 ' +
          (bin.legal - bin.both).toLocaleString() +
          ' 组'
      );
  }
  patchRows($('scan-rows'), aggregate);
  patchRows($('scan-buckets'), bands);
  write('scan-risk-counts', excluded.join('\n'));
  write(
    'scan-intersection',
    scan
      ? '交集要求同组仓位在失败时回收至少 ' +
          usd(scan.ctx.book.B) +
          '，成功时 Hype 至少留存 ' +
          usd(scan.ctx.params.R) +
          '。个人净盈利另按两端平仓后的个人现金与累计投入比较。'
      : ''
  );
  if (rep) showRepresentative(scan, result);
  else {
    for (const field of [
      'scan-representative',
      'scan-position',
      'scan-fail-cash',
      'scan-pass-cash',
      'scan-fail-net',
      'scan-pass-net',
      'scan-risk',
      'scan-deadline',
      'scan-deadline-note'
    ])
      write(field, '');
    if (scan) write('scan-status', $('scan-status').textContent + ' · 当前没有通过风控检查的代表仓位');
  }
}
export function renderScan(result, m, r, plan, status) {
  for (const [key, title] of [
    ['pf', 'VS'],
    ['hl', 'Hype']
  ]) {
    const q = m[key];
    const c = (result.observed ?? result).currencies?.[key];
    write('scan-' + key + '-product', (key === 'pf' ? 'Vest ' : 'Hyperliquid ') + (m.asset ?? '') + ' Perp');
    write(
      'scan-' + key + '-unit',
      c?.quoteAsset && c?.baseAsset ? c.quoteAsset + '/' + c.baseAsset : '报价币待核实'
    );
    write('scan-' + key + '-price', q?.mark == null ? '—' : fmt(q.mark));
    write(
      'scan-' + key + '-settle',
      c?.settleAsset ? c.settleAsset + (key === 'hl' ? ' 抵押/结算' : ' 结算') : ''
    );
    write(
      'scan-' + key + '-quote',
      q?.levels
        ? '买 ' + fmt(q.levels[0]?.[0]?.[0]) + ' / 卖 ' + fmt(q.levels[1]?.[0]?.[0]) + ' · ' + time(q.asOf)
        : title + ' 等待盘口'
    );
  }
  const observation = result.observed ?? result;
  const map = observation.currencies,
    comp = observation.priceComparison;
  write(
    'scan-basis',
    comp
      ? fmt(comp.diff, 3) + ' ' + map.pf.quoteAsset + ' / ' + pct(comp.fraction)
      : (map?.error?.split(' · ')[0] ?? '等待有效快照')
  );
  const displayed = result.ratioScan ? result : result.retained;
  const tr = displayed?.trace;
  const quoteTime = m.hl?.markAt ?? m.hl?.asOf;
  write('scan-source', plan ? '预设资金规划 · 条件结果' : '当前账户快照');
  write(
    'scan-clock',
    [
      m.source === '手工确认盘口' && m.source,
      comp && (comp.raw != null ? '同币种' : map.hypeToVest.name + ' × ' + fmt(map.hypeToVest.mid, 8)),
      ...(map?.warnings ?? []),
      quoteTime && time(quoteTime)
    ]
      .filter(Boolean)
      .join(' · ')
  );
  const f = result.funding;
  write(
    'scan-capital',
    f?.E != null
      ? (plan ? '预设资金规划 · 条件结果 · ' : '当前账户快照 · 条件结果 · ') +
          '保护基准 ' +
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
  else if (!displayed?.ratioScan?.representative?.row?.funded)
    write('scan-funded', 'Funded 分成 · 等待有效快照，到账状态待核实');
  const state = result.frameState ?? 'paused',
    id = tr?.id ?? '';
  const stamp = tr ? '结果快照 ' + time(tr.at) + ' · ' + id : '';
  const desk = $('scan-desk');
  const outdated = !!tr && state !== 'ready';
  desk.dataset.state = state;
  desk.dataset.resultId = id;
  $('scan-results').inert = outdated;
  const progress =
    state === 'updating'
      ? '更新中 · ' + (result.trigger ?? '后台重算')
      : state === 'ready'
        ? [
            displayed?.ratioScan?.complete === false ? '部分网格' : '',
            displayed?.stress?.missing?.length ? '基础路径 · 压力待补' : '',
            displayed?.autoStatus ?? '条件结果'
          ]
            .filter(Boolean)
            .join(' · ')
        : '暂停仓位建议 · ' + (result.issues?.[0] ?? status);
  write('scan-status', [progress, outdated && '上次完成', stamp].filter(Boolean).join(' ｜ '));
  write(
    'scan-runtime',
    [
      displayed?.trigger,
      displayed?.startedAt && 'Worker 开始 ' + time(displayed.startedAt),
      displayed?.finishedAt && '完成 ' + time(displayed.finishedAt),
      displayed && '耗时 ' + displayed.solveMs + ' ms',
      displayed?.ratioScan && '覆盖 ' + displayed.ratioScan.sets.legal.count.toLocaleString() + ' 组',
      displayed?.stress?.label,
      stamp
    ]
      .filter(Boolean)
      .join(' · ')
  );
  if ((displayed && frameKey !== id) || (!displayed && (frame || frameKey !== 'empty'))) {
    draw(displayed ?? {});
    if (!displayed) frameKey = 'empty';
  }
}
export function setupScan(onConfig) {
  $('scan-config').onclick = onConfig;
  $('scan-detail').ontoggle = auditText;
  for (const id of ['range-columns', 'bin-columns']) {
    const tr = $(id).insertRow();
    for (const title of id === 'bin-columns'
      ? [
          '对冲比例 h',
          'PF 仓位 / 数量',
          'Hype 仓位 / 数量',
          '失败回收',
          '成功剩余',
          '最大缺口率 / 保证金占用率'
        ]
      : columns) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = title;
      tr.append(cell);
    }
  }
}
