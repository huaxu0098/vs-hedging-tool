import { dec } from './math.js';
import { inspectRatio, ratioSlice } from './ratio-scan.js';
import { reportGroups, subsetGroups } from './range-report.js';
import { ledgerLabels, presentLedger } from './settlement-ledger.js';

const $ = (id) => document.getElementById(id);
const write = (id, text) => {
  const el = $(id);
  text = String(text);
  if (el.textContent === text) return;
  if (el.childNodes.length === 1 && el.firstChild.nodeType === Node.TEXT_NODE) el.firstChild.data = text;
  else el.textContent = text;
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
  profit: '双路径均净盈利',
  legal: '全部合法仓位',
  risk: '通过保证金检查',
  failProfit: '失败路径净盈利',
  passProfit: '成功路径净盈利'
};
// The existing scan already prices both directions. Inspect its legal lots on
// demand at the representative size, using the same settlement ledgers.
function executionComparison(scan, row) {
  const lines = ['同规模双边成交成本 · PF ' + dec(row.pf).abs() + ' / Hype ' + dec(row.hl).abs() +
    '（各自合约数量）；价格为原生报价，费用与深度滑点为 U。'];
  for (const sign of [1, -1]) {
    const direction = (sign === 1 ? 'PF 多 / ' : 'PF 空 / ') +
      (row.j === 0 ? 'Hype 空仓' : sign === 1 ? 'Hype 空' : 'Hype 多');
    let candidate = row;
    if (sign !== row.sign) {
      if (!scan.cells) { lines.push(direction + ' · 历史快照未保留反向盘口'); continue; }
      if (!ratioSlice(scan, sign, row.i).some(([lo, hi]) => lo <= row.j && row.j <= hi)) {
        lines.push(direction + ' · 当前模式或盘口不支持同规模反向仓位');
        continue;
      }
      try {
        candidate = inspectRatio(scan.ctx, { sign, i: row.i, j: row.j });
      } catch (error) {
        lines.push(direction + ' · 成本未验证 · ' + error.message);
        continue;
      }
    }
    const fill = (leg, entry) => {
      const q = entry ? dec(leg.adjustment) : dec(leg.target).neg();
      if (q.isZero()) return '无需成交';
      const field = entry ? 'entry' : 'exit';
      return (q.gt(0) ? '买 Ask ' : '卖 Bid ') + fmt(leg[field + 'Price'], 5) +
        '（费 ' + fmt(leg[field + 'Fee'], 5) + '，滑点 ' + fmt(leg[field + 'Slippage'], 5) + '）';
    };
    for (const [label, path, entry] of [['开仓/调仓', 'fail', true], ['失败平仓', 'fail', false], ['成功平仓', 'pass', false]]) {
      const stop = !entry && (path === 'fail' ? candidate.failStop : candidate.passStop);
      const legs = candidate.paths?.[path];
      lines.push(direction + ' · ' + label + ' · ' + (stop || (!legs ? '未验证' :
        'PF ' + fill(legs.pf, entry) + ' / Hype ' + fill(legs.hl, entry))));
    }
  }
  return lines;
}
function auditText() {
  if (!$('scan-detail').open || !$('desk-details').open || !$('audit-details').open || !audit) {
    write('scan-audit', '');
    return;
  }
  const { row, scan } = audit;
  const lines = [
    ...executionComparison(scan, row),
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
          '，调仓 ' + (dec(l.adjustment).isZero() ? '无需成交' : (dec(l.adjustment).gt(0) ? '买入 Ask ' : '卖出 Bid ') + l.entryPrice) +
          '，条件平仓 ' + (dec(l.target).isZero() ? '空仓' : (dec(l.target).gt(0) ? '卖出 Bid ' : '买入 Ask ') + l.exitPrice) +
          '（各自原生报价，按当前深度平移至终点估算）',
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
      '（' +
      dec(row.pf).abs() +
      ' ' +
      (scan.ctx.market.pf.unit === 'contract' ? '张' : scan.ctx.market.pf.unit) +
      '） · Hype ' +
      (row.j === 0 ? '空仓 ' : row.sign > 0 ? '空 ' : '多 ') +
      usd(row.hypeValue) +
      '（' +
      dec(row.hl).abs() +
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
  $('scan-fail-summary').classList.toggle('thin-buffer', thin && !row.failStop);
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
    row.funded ? '提款线 · Hype 到账前剩余' : '通过后 · Hype 剩余'
  );
  write('scan-pass-cash', row.passStop ?? settlementAmount(row.success));
  const diff = dec(row.successPersonal).minus(B);
  const hypeVsCapital = dec(row.success).minus(B);
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
      : (hypeVsCapital.lt(0) ? '距保护本金差 ' : '比保护本金多 ') +
          settlementAmount(hypeVsCapital.abs()) + ' · ' + (row.survives ? '满足 ' : '低于 ') + usd(params.R) + ' 留存'
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
  '失败个人回收 / 成功 Hype 权益',
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
    [pair(range.failure, settlementAmount), pair(range.successHype, settlementAmount)],
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
    if (incoming.hasAttribute('data-band')) {
      if (row.dataset.band !== incoming.dataset.band) row.dataset.band = incoming.dataset.band;
      if (row.dataset.subset !== incoming.dataset.subset) row.dataset.subset = incoming.dataset.subset;
    }
    if (row.className !== incoming.className) row.className = incoming.className;
    const cells = Array.from(incoming.cells);
    for (const [j, cell] of cells.entries()) {
      const old = row.cells[j];
      if (!old) row.append(cell);
      else if (!old.isEqualNode(cell)) {
        if (old.title !== cell.title) old.title = cell.title;
        if (old.colSpan !== cell.colSpan) old.colSpan = cell.colSpan;
        const sameLayout =
          old.childNodes.length === cell.childNodes.length &&
          [...old.childNodes].every((node, k) => node.nodeName === cell.childNodes[k].nodeName);
        if (sameLayout) {
          [...old.childNodes].forEach((node, k) => {
            const nextText = cell.childNodes[k].nodeValue;
            if (node.nodeType === Node.TEXT_NODE && node.nodeValue !== nextText) node.nodeValue = nextText;
            if (node.nodeType === Node.ELEMENT_NODE && !node.isEqualNode(cell.childNodes[k]))
              node.replaceWith(cell.childNodes[k].cloneNode(true));
          });
        } else old.replaceChildren(...cell.childNodes);
      }
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
function renderSubsets() {
  if (!$('subset-detail').open) return;
  const details = document.createElement('tbody');
  for (const bin of frame?.buckets ?? []) {
    if (!bin.legal) continue;
    const label =
      bin.above == null
        ? '0%'
        : '＞' + (bin.through == null ? pct(bin.above) : intervalText(bin.above, bin.through, ' 至 ≤'));
    for (const key of subsetGroups) {
      const unknown =
        (key === 'profit' || key.endsWith('Profit')) &&
        (frame.ctx.params.profitBasis == null || frame.ctx.params.externalPriced === false);
      summaryRow(
        details,
        label + ' · ' + names[key],
        unknown ? null : bin.ranges[key],
        unknown ? '投入基准待核实' : '0 组'
      );
    }
  }
  patchRows($('scan-subsets'), details);
}
function neighborVerdict(row) {
  if (!row.physical) return row.failStop || row.passStop || '保证金或强平缓冲不足';
  if (row.both) return '双路径保护';
  const gaps = [];
  if (!row.covers) gaps.push('回本差 ' + settlementAmount(row.shortfall));
  if (!row.survives) gaps.push('留存差 ' + settlementAmount(dec(row.reserveHeadroom).neg()));
  return gaps.join('，');
}

function renderAnalysis(scan) {
  const info = scan?.analysis;
  $('ratio-analysis').hidden = !info;
  if (!info) return;
  const { boundary, theory, change } = info;
  const rep = scan.representative;
  const qty = (q, leg) => q + ' ' + (leg.unit === 'contract' ? '张' : leg.unit);
  const leg = scan.ctx.market;
  const counts = scan.buckets.filter((b) => b.both).map((b) => b.both.toLocaleString());
  write(
    'ratio-counts',
    '交集对账' +
      (scan.complete ? '' : '（已覆盖网格）') +
      '　' +
      (counts.length ? counts.join(' + ') + ' = ' : '') +
      scan.sets.both.count.toLocaleString() +
      ' 组'
  );
  write(
    'ratio-boundary',
    boundary
      ? '下界 ' +
          boundary.fraction +
          '（约 ' +
          pct(boundary.h, 8) +
          '）计入右端含等号的一段，共 ' +
          boundary.count.toLocaleString() +
          ' 组。' +
          (boundary.count === 1 ? '该组' : '其中一组') +
          ' PF ' +
          qty(boundary.pf, leg.pf) +
          '，Hype ' +
          qty(boundary.hl, leg.hl) +
          '。'
      : ''
  );
  const objective = {
    max_pf: '优先扩大可行 PF 仓位，同额时取最差路径剩余现金较多的一组。',
    max_min_cash: '优先提高两端较低的个人现金，并列时取较小 PF 仓位。',
    max_pf_with_cash_floor: '最差个人现金至少 ' + usd(info.cashFloor) + '，再优先扩大 PF 仓位。',
    fixed: '按固定侧现仓求解另一侧。',
    diagnostic: '当前没有可推荐仓位，以下为条件路径对照。'
  };
  write(
    'ratio-objective',
    rep
      ? (rep.complete ? '' : '当前搜索范围内，') +
          (objective[rep.objective] ?? '') +
          '固定' +
          (info.fixed === 'hl' ? ' Hype ' : ' PF ') +
          '数量和方向，对比另一侧相邻合法档。数量正为多、负为空。' +
          (info.neighbors.length === 1 ? '当前仅此一档。' : '')
      : '当前没有可供比较的代表仓位。'
  );
  const next = document.createElement('tbody');
  for (const row of info.neighbors) {
    const tr = next.insertRow();
    tr.classList.toggle('representative-range', row.center);
    const head = document.createElement('th');
    head.scope = 'row';
    head.append(
      (row.center ? '代表 · ' : '') + pct(row.h, 6),
      document.createElement('br'),
      neighborVerdict(row)
    );
    head.title = dec(row.h).times(100).toString() + '%';
    tr.append(head);
    for (const [value, q, venue] of [
      [row.pfValue, row.pf, leg.pf],
      [row.hypeValue, row.hl, leg.hl]
    ]) {
      tr.insertCell().append(usd(value), document.createElement('br'), qty(q, venue));
    }
    tr.insertCell().textContent = row.failStop || settlementAmount(row.fail);
    tr.insertCell().textContent = row.passStop || settlementAmount(row.success);
    tr.insertCell().append(usd(row.initial), document.createElement('br'), pct(row.imRate, 2));
    tr.insertCell().textContent =
      row.buffer == null
        ? row.physical
          ? '无正价交点或空仓'
          : '未验证'
        : fmt(row.buffer) + ' ' + info.quote;
  }
  patchRows($('ratio-neighbors'), next);
  write(
    'ratio-theory',
    '理论下限 ' + pct(theory.lower) + '（待回收 ' + usd(theory.recoveryNeed) + ' ÷ PF 失败空间 ' + usd(theory.loss) +
    '），理论上限 ' + pct(theory.upper) + '（Hype 留存后可承亏 ' + usd(theory.spendable) + ' ÷ PF 成功空间 ' + usd(theory.gain) +
    '）。' + (dec(theory.lower).gt(theory.upper) ? '理论无交集。' : '') +
    '实际区间另计成交成本、数量步长及风险约束。'
  );
  let message = '';
  if (change) {
    if (change.changes.length) message += '较上一帧，' + change.changes.join('、') + '有变动。';
    if (change.theoryChanged) message += '资金理论界限已变。';
    else if (change.changes.includes('每单位盈亏敏感度')) message += '理论界限未变，每单位敏感度已重新换算。';
    else message += '资金边界和线性盈亏敏感度未改变，理论比例保持不变。';
    if (rep && change.previousH != null) {
      if (change.hChanged) {
        message +=
          '代表 h ' +
          intervalText(change.previousH, rep.row.h, ' → ') +
          '，' +
          (change.lotsChanged ? '两边数量步数组合已变。' : '每步的相对盈亏敏感度已变。');
      } else message += '代表 h 未变。';
      if (change.directionChanged) message += '代表方向已反转。';
    }
    if (change.intervalChanged) message += '实际区间端点已变。';
  } else message = '同一标的同步涨跌时，若资金空间和每单位敏感度不变，理论界限可以保持不变。';
  write('ratio-change', message);
}

// Render from one completed scan. The full band and its qualifying subset
// retain their own position and settlement extrema.
function positionBand(body, scan, bin, segment, group) {
  const metrics = bin.ranges[group];
  const subset = group === 'both';
  const checked = group !== 'legal';
  const rep = scan.representative;
  const row = body.insertRow();
  row.dataset.band = String(segment);
  row.dataset.subset = group;
  const allProtected = checked && (subset || bin.both === bin.risk);
  row.classList.toggle('qualified', allProtected);
  const belongs = rep?.segment === segment && (group === 'legal' || rep.row.physical);
  const ownSubsetRow = rep?.row.both && bin.both < bin.risk;
  const containsRep = belongs && (subset ? rep.row.both : !ownSubsetRow);
  row.classList.toggle('representative-range', containsRep);
  const head = document.createElement('th');
  head.scope = 'row';
  const lo = bin.above, hi = bin.through ?? scan.sets[group].max.h;
  // The minimum intersection ratio is itself a cut. Its boundary row can
  // describe a single ratio even if its parent band contains many ratios.
  const exact = subset && dec(hi).eq(scan.sets.both.min.h);
  head.textContent = lo == null || exact ? pct(hi) : '＞' + intervalText(lo, hi);
  head.title = (lo == null || exact ? '单一比例' : '下界不含，上界含') + (containsRep ? ' · 含代表方案' : '');
  if (subset) head.append(document.createElement('br'), '双保护规模');
  row.append(head);
  const limits = (values, format) =>
    dec(values[0]).eq(values[1]) ? format(values[0]) : values.map(format).join(' – ');
  for (const venue of ['pf', 'hl']) {
    const cell = row.insertCell();
    const quantity = document.createElement('small');
    const unit = scan.ctx.market[venue].unit;
    quantity.textContent = limits(metrics[venue + 'Qty'], String) + ' ' + (unit === 'contract' ? '张' : unit);
    cell.append(limits(metrics[venue + 'Value'], (v) => fmt(v, 2)), quantity);
  }
  for (const key of ['failure', 'successHype'])
    row.insertCell().textContent = checked ? limits(metrics[key], (v) => fmt(v, 4)) : '未验证';
  const risk = row.insertCell();
  if (!checked) risk.textContent = '保证金或清算风险未通过';
  else if (allProtected) risk.textContent = '失败回本 · 成功留存';
  else {
    const failure = !bin.protect ? '失败无法回本' : bin.protect < bin.risk ? '部分未回本' : '失败回本';
    const success = !bin.survive ? '成功留存不足' : bin.survive < bin.risk ? '部分留存不足' : '成功留存';
    risk.append(failure, document.createElement('br'), success);
  }
  if (checked && !subset && bin.profit > 0)
    risk.append(document.createElement('br'), bin.profit === bin.risk ? '双端净盈利' : '部分规模双端净盈利');
}

function draw(result) {
  frame = result.ratioScan ?? null;
  frameKey = result.trace?.id ?? '';
  audit = null;
  const scan = frame,
    rep = scan?.representative;
  renderAnalysis(scan);
  $('bands-empty').hidden = !!scan?.sets.legal.count;
  const aggregate = document.createElement('tbody');
  const bands = document.createElement('tbody');
  write('capital-threshold', scan ? ' · ' + scan.ctx.book.B + ' U' : '');
  write('reserve-threshold', scan ? ' · ' + scan.ctx.params.R + ' U' : '');
  const noProfit = '无';
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
    $('scan-' + key).title =
      s?.min && !unknown
        ? dec(s.min.h).times(100).toString() + '% 至 ' + dec(s.max.h).times(100).toString() + '%'
        : '';
    if (scan) summaryRow(aggregate, names[key], unknown ? null : s.range, empty);
    if (key === 'profit') $('profit-panel').classList.toggle('no-profit', !s?.count && empty === noProfit);
  }
  const qualifiedBands = document.createElement('tbody');
  const excluded = [];
  for (const [n, bin] of (scan?.buckets ?? []).entries()) {
    const label =
      bin.above == null
        ? '0% · Hype 空仓'
        : '＞' + (bin.through == null ? pct(bin.above) : intervalText(bin.above, bin.through, ' 至 ≤'));
    if (bin.legal) {
      const fullBand = bin.both && bin.both === bin.risk ? qualifiedBands : bands;
      positionBand(fullBand, scan, bin, n, bin.risk ? 'risk' : 'legal');
      if (bin.both && bin.both < bin.risk) positionBand(qualifiedBands, scan, bin, n, 'both');
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
  renderSubsets();
  patchRows($('scan-rows'), aggregate);
  const featured = qualifiedBands.querySelector('.representative-range');
  if (featured) qualifiedBands.prepend(featured);
  bands.prepend(...Array.from(qualifiedBands.rows));
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
    auditText();
    for (const field of [
      'scan-representative',
      'scan-position',
      'scan-fail-cash',
      'scan-pass-cash',
      'scan-fail-net',
      'scan-fail-summary',
      'scan-pass-summary',
      'scan-pass-net',
      'scan-risk',
      'scan-deadline',
      'scan-deadline-note'
    ])
      write(field, '');
    write('scan-fail-cash', '—');
    write('scan-pass-cash', '—');
    if (scan) write('scan-representative', '当前条件下无可推荐仓位');
  }
}
export function renderScan(result, m, r, plan, status) {
  const observed = result.observed ?? result;
  const networkError = m.errors?.pf || m.errors?.hl;
  const waitingForMarket = !networkError && !m.errors?.spec && m.source !== '手工确认盘口' &&
    ((!m.pf || !m.hl) || (!m.spec && (!m.specStatus || m.specStatus === 'loading')));
  const specError = m.errors?.spec || m.errors?.specRisk;
  const unverifiedVest = !waitingForMarket && !networkError &&
    (specError || /(?:VS 报价币|VS 标的)/.test(observed.currencies?.error ?? ''));
  for (const [key, title] of [
    ['pf', 'VS'],
    ['hl', 'Hype']
  ]) {
    const q = m[key];
    const old = !q?.mark && result.retained?.prices?.[key];
    const c = observed.currencies?.[key] ?? (old && {baseAsset:old.base, quoteAsset:old.quote});
    write('scan-' + key + '-product', (key === 'pf' ? 'Vest ' : 'Hyperliquid ') + (m.asset ?? '') + ' Perp');
    write(
      'scan-' + key + '-unit',
      c?.quoteAsset && c?.baseAsset ? c.quoteAsset + '/' + c.baseAsset : '报价币待核实'
    );
    const prefix = 'scan-' + key + '-';
    const clock = observed.timing?.clocks?.[key];
    const paused = m.errors?.[key] || old || clock?.ok === false;
    write(prefix + 'health', (q?.mark || old) && paused ? ' · 已失效' : '');
    write(prefix + 'price', q?.mark ?? old?.mark ?? '—');
    const markSource = '标记时间 ' + time(q?.markAt ?? old?.markAt ?? q?.asOf ?? old?.asOf);
    if ($(prefix + 'price').title !== markSource) $(prefix + 'price').title = markSource;
    write(prefix + 'bid', q?.levels?.[0]?.[0]?.[0] ?? old?.bid ?? '—');
    write(prefix + 'ask', q?.levels?.[1]?.[0]?.[0] ?? old?.ask ?? '—');
    write(prefix + 'quote', q?.levels
      ? [m.source === '手工确认盘口' && m.source, '盘口 ' + time(q.bookAt ?? q.asOf),
        m.errors?.[key] || (observed.timing?.clocks?.[key]?.ok === false && '报价过期或盘口无效')]
          .filter(Boolean).join(' · ')
      : old ? '历史盘口 · ' + time(old.bookAt ?? old.asOf) + ' · ' + (m.errors?.[key] || '等待新报价')
      : m.errors?.[key] || title + ' 正在连接盘口');
  }
  const displayed = result.ratioScan ? result : result.retained;
  const tr = displayed?.trace;
  write('scan-source', plan ? '预设资金规划' : '当前账户快照');
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
  const state = waitingForMarket ? 'loading' : result.frameState ?? 'paused',
    id = tr?.id ?? '';
  const stamp = tr ? '结果时间 ' + new Date(tr.at).toLocaleDateString('zh-CN') + ' ' + time(tr.at) : '';
  const desk = $('scan-desk');
  const outdated = !!tr && state !== 'ready';
  if (desk.dataset.state !== state) desk.dataset.state = state;
  if (desk.dataset.resultId !== id) desk.dataset.resultId = id;

  const progress =
    state === 'updating'
      ? '更新中 · ' + (result.trigger ?? '后台重算')
      : state === 'ready'
        ? [
            displayed?.ratioScan?.complete === false ? '部分网格' : '',
            displayed?.stress?.missing?.length ? '基础路径 · 压力待补' : '',
            displayed?.autoStatus === 'AUTO_PARTIAL' ? '条件估算' : '条件结果'
          ]
            .filter(Boolean)
            .join(' · ')
        : waitingForMarket ? '正在连接 Vest 与 Hyperliquid 公开行情'
        : '暂停仓位建议 · ' + (networkError || observed.currencies?.error || specError || result.issues?.[0] || status) +
          (unverifiedVest ? '。可在高级详情核对 Vest 合约规格。' : '');
  write('scan-status', [progress, outdated && (state === 'updating' ? '上次完成' : '上次完成 · 历史结果，当前未验证'), stamp].filter(Boolean).join(' ｜ '));
  const currentTime = tr && new Date(tr.at).toLocaleTimeString('zh-CN', { hour12: false });
  const shortState = state === 'ready' ? (displayed?.autoStatus === 'AUTO_PARTIAL' ? '条件估算' : '条件结果')
    : state === 'updating' ? (tr ? '更新中 · 上次结果' : '首次计算中')
    : tr ? '数据待核实 · 历史结果' : waitingForMarket ? '连接盘口中' : '暂不可计算 · 见高级详情';
  write('desk-state', [shortState, currentTime].filter(Boolean).join(' · '));
  if (!displayed || !displayed.ratioScan.sets.legal.count)
    write('bands-empty', displayed ? '当前扫描范围没有合法仓位'
      : !plan && result.inputGaps?.length ? '请在高级详情录入当前账户权益、持仓与可用保证金。' : shortState);
  write(
    'scan-runtime',
    [
      displayed?.trigger,
      displayed?.startedAt && 'Worker 开始 ' + time(displayed.startedAt),
      displayed?.finishedAt && '完成 ' + time(displayed.finishedAt),
      displayed && '耗时 ' + displayed.solveMs + ' ms',
      displayed?.ratioScan && '覆盖 ' + displayed.ratioScan.sets.legal.count.toLocaleString() + ' 组',
      displayed?.stress?.label,
      stamp,
      tr && tr.model + ' / ' + id
    ]
      .filter(Boolean)
      .join(' · ')
  );
  if ((displayed && frameKey !== id) || (!displayed && (frame || frameKey !== 'empty'))) {
    draw(displayed ?? {});
    if (!displayed) frameKey = 'empty';
  }
  if (!displayed) {
    const message = waitingForMarket ? '连接中' : state === 'updating' ? '首次计算中' :
      unverifiedVest ? '待核实 Vest 规格' : state === 'failed' ? '求解失败' : '暂不可计算';
    for (const key of reportGroups) write('scan-' + key, message);
  }
}
export function setupScan() {
  for (const id of ['desk-details', 'audit-details', 'scan-detail'])
    $(id).addEventListener('toggle', auditText);
  $('subset-detail').ontoggle = renderSubsets;
  for (const id of ['range-columns', 'bin-columns', 'subset-columns']) {
    const tr = $(id).insertRow();
    for (const title of id === 'bin-columns'
      ? [
          '对冲比例范围',
          'PF 名义额 / 数量',
          'Hype 名义额 / 数量',
          '失败回收',
          '成功 Hype 剩余',
          '风险状态'
        ]
      : columns) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = title;
      tr.append(cell);
    }
  }
}
