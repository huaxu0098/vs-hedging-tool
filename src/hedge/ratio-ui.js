import { publicationState } from './display-history.js';
import { planObjectives as objectives } from './position-plans.js';
import { dec } from './math.js';
import { inspectRatio, ratioSlice } from './ratio-scan.js';
import { capitalGroups, reportGroups, subsetGroups, recoveryCushion } from './range-report.js';
import { ledgerLabels, presentLedger } from './settlement-ledger.js';

const $ = (id) => document.getElementById(id);
const setText = (el, text) => {
  text = String(text);
  if (el.textContent === text) return;
  if (el.childNodes.length === 1 && el.firstChild.nodeType === Node.TEXT_NODE) el.firstChild.data = text;
  else el.textContent = text;
};
const write = (id, text) => setText($(id), text);
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
  both: '双路径交集合格',
  profit: '双路径均净盈利',
  legal: '全部合法候选（条件终点估值）',
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
    'PF 有符号目标 ' + row.pf + ' / Hype ' + row.hl + ' · 源快照 ' + audit.snapshotId + ' · 分成到账前计入 Hype 权益 0 U',
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
    if (stop) { lines.push(title + '路径 · ' + stop); continue; }
    for (const venue of ['pf', 'hl']) {
      const l = (row.settlementPaths ?? row.paths)?.[key]?.[venue];
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
function showRepresentative(snapshot, auditScan) {
  const { ratioScan:scan, targets:[maximum], stress } = snapshot;
  const { objective, group, buffer, complete } = scan.representative;
  const row = scan.plans?.focus ?? scan.representative.row;
  const { book, params } = scan.ctx;
  // Prices, cash and advanced postings follow the same signed target.
  const target = maximum ?? row;
  const diagnostic = !maximum && objective === 'diagnostic';
  write('scan-representative', maximum ? '基础情景最大 PF 目标仓位 · ' + pct(target.h) :
    diagnostic ? '条件对照 · 当前无可推荐仓位' : '条件目标方案 · ' + pct(target.h));
  const unit = side => scan.ctx.market[side].unit === 'contract' ? '张' : scan.ctx.market[side].unit;
  write('scan-position', (diagnostic ? '仅作路径对照（对照比例 ' + pct(target.h) + '）' : '') +
    ' PF ' + (target.sign > 0 ? '多 ' : '空 ') + usd(target.pfValue) + '（' + dec(target.pf).abs() + ' ' + unit('pf') +
    '） · Hype ' + (target.j === 0 ? '空仓 ' : target.sign > 0 ? '空 ' : '多 ') + usd(target.hypeValue) +
    '（' + dec(target.hl).abs() + ' ' + unit('hl') + '）' +
    (diagnostic ? ' · ' + (names[group] ?? '通过保证金检查') : '') + (!complete && !diagnostic ? ' · 限已扫描规模' : ''));
  const excess = dec(maximum?.failDelta ?? row.failureVsProtection),
    B = dec(book.B);
  const cushion = maximum ? recoveryCushion(maximum.fail,book.B) : row.cushion;
  const bufferRate = cushion.rate == null ? '无保护基准' : pct(cushion.rate, 6);
  const thin = cushion.thin;
  const stressIncomplete = stress?.missing.length || stress?.zero.length;
  $('scan-fail-net').classList.toggle('thin-buffer', thin);
  const focusThin = target.fail != null && thin;
  $('scan-fail-summary').classList.toggle('thin-buffer', focusThin && !target.failStop);
  write('scan-fail-cash', target.failStop ?? settlementAmount(target.fail));
  write(
    'scan-fail-net',
    target.failStop
      ? target.failStop
      : (excess.lt(0) ? '距离 ' : thin ? '仅比 ' : '比 ') +
          usd(book.B) +
          (excess.lt(0) ? ' 还差 ' : ' 多 ') +
          settlementAmount(excess.abs()) +
          '（相对保护基准 ' +
          bufferRate +
          '）' +
          (thin ? ' · 极薄缓冲（几乎零缓冲）' : '') +
          (thin && stressIncomplete
            ? stress.positive.length
              ? '，基础情景刚好覆盖，完整压力未验证'
              : '，仅基础情景刚好覆盖，完整压力未验证'
            : '') +
          (dec(buffer).gt(0) ? ' · 额外缓冲要求 ' + usd(buffer) : ' · 未设额外安全缓冲')
  );
  write(
    'scan-pass-title',
    row.funded ? '提款线 · Hype 到账前剩余' : '通过后 · Hype 剩余'
  );
  write('scan-pass-cash', target.passStop ?? settlementAmount(target.success));
  const diff = dec(target.successPersonal).minus(B);
  write(
    'scan-pass-net',
    target.passStop
      ? target.passStop
      : '假设 PF 自身净结算达到 ' +
          usd(params.target) +
          '。Hype 平仓权益 ' +
          settlementAmount(target.success) +
          (target.survives ? '，满足 ' : '，低于 ') +
          usd(params.R) +
          ' 最低留存。个人资金' +
          (diff.lt(0) ? '距保护本金尚差 ' : '较保护本金多 ') +
          settlementAmount(diff.abs()) +
          ' · 相对累计投入 ' +
          settlementAmount(params.profitBasis==null ? null : dec(target.successPersonal).minus(params.profitBasis))
  );
  write('scan-fail-summary', target.failStop ? '该路径未结算' :
    (excess.lt(0) ? '距本金差 ' : '高于本金 ') + settlementAmount(excess.abs()) +
    (focusThin ? ' · 极薄缓冲' : ''));
  write('scan-pass-summary', target.passStop ? '该路径未结算' :
    (diff.lt(0) ? '个人距本金差 ' : '个人较本金多 ') + settlementAmount(diff.abs()) +
    ' · ' + (target.survives ? '满足 ' : '低于 ') + usd(params.R) + ' 留存');
  if (maximum && (maximum.sign!==row.sign || maximum.i!==row.i || maximum.j!==row.j)) {
    // Older snapshots can contain a preference ledger for a different position.
    for (const id of ['scan-deadline','scan-deadline-note','scan-risk','scan-funded'])
      write(id,'此历史快照未保存最大仓位的对应明细');
    audit=null;
    auditText();
    return;
  }
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
  audit = { row, scan:auditScan ?? scan, snapshotId:snapshot.snapshotId };
  auditText();
}
const columns = [
  '范围及组合数',
  'PF 数量 / 名义额',
  'Hype 数量 / 名义额',
  '失败个人回收 / 成功 Hype 权益',
  '失败 / 成功双边成交手续费',
  '失败缺口 / B · 成功消耗 / Hype 权益',
  'Hype 初始保证金范围 / 有交点的强平距离范围'
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
    return tr;
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
      pair([range.minMargin,range.maxMargin],usd) + '（' + pair([range.minMarginRate,range.maxMarginRate],pct) + '）',
      range.minBuffer == null ? '无已验证强平交点' : pair([range.minBuffer,range.maxBuffer],v => fmt(v,4)) + ' 原生价格单位'
    ]
  ];
  for (const [top, bottom] of lines) tr.insertCell().append(top, document.createElement('br'), bottom);
  return tr;
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
    if (incoming.dataset.point) {
      for (const key of ['point', 'ratio', 'pfSize']) {
        if (row.dataset[key] !== incoming.dataset[key]) row.dataset[key] = incoming.dataset[key];
      }
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
        for (const audit of cell.querySelectorAll('details[data-path]')) {
          const prior=old.querySelector('details[data-path="'+audit.dataset.path+'"]');
          if (prior) audit.open=prior.open;
        }
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
    const label = binLabel(bin);
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
  if (row.covers && row.coversWithBuffer === false) gaps.push('额外回本缓冲不足');
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
          '）计入双路径闭区间，恰在下界且达标共 ' +
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

function binLabel(bin) {
  if (bin.edgeKey === 'below') return 'h < ' + pct(bin.through);
  if (bin.edgeKey === 'above') return 'h > ' + pct(bin.above);
  if (bin.edgeKey === 'joint') return intervalText(bin.above, bin.through, ' ≤ h ≤ ');
  return '全部合法比例';
}

function formatRatios(records) {
  // Resolve rounding collisions between different executable fractions. Equal
  // fractions keep the same label at every position size on this page.
  const ratios = new Map(records.map(row => [row.fraction ?? row.h, row.h]));
  return row => {
    let digits = 4;
    for (const [key, h] of ratios) {
      if (key === (row.fraction ?? row.h)) continue;
      while (digits < 20 && pct(row.h, digits) === pct(h, digits)) digits++;
      if (pct(row.h, digits) === pct(h, digits)) return row.fraction ?? pct(row.h, digits);
    }
    return pct(row.h, digits);
  };
}

const signedCash = value => value == null ? '未验证' : (dec(value).gt(0) ? '+' : '') + settlementAmount(value);
const targetQty = (qty, leg) => {
  const q = dec(qty), unit = leg.unit === 'contract' ? '张' : leg.unit;
  return (q.isZero() ? '空仓 ' : q.gt(0) ? '多 ' : '空 ') + q.abs() + ' ' + unit;
};
const distanceText = (plan, scan) => plan.distance == null
  ? (plan.j === 0 ? 'Hype 空仓' : '无已验证交点')
  : fmt(plan.distance, 2) + ' ' + scan.plans.hlQuote;

// Columns are objectives. Every metric in a column reads the same solver record.
const comparisonMetrics = [
  ['h', '实际目标对冲比例', (p, s, ratio) => ratio(p)],
  ['pf', 'PF 目标仓位', (p,s) => targetQty(p.pf, s.ctx.market.pf)],
  ['pfValue', 'PF 名义金额', p => usd(p.pfValue)],
  ['hl', 'Hype 目标仓位', (p,s) => targetQty(p.hl, s.ctx.market.hl)],
  ['hypeValue', 'Hype 名义金额', p => usd(p.hypeValue)],
  ['fail', '失败后个人回收', p => settlementAmount(p.fail)],
  ['failDelta', '失败端本金盈亏', p => signedCash(p.failDelta)],
  ['success', '成功后 Hype 剩余', p => settlementAmount(p.success)],
  ['successDelta', '成功端个人资金较本金', p => signedCash(p.successDelta)],
  ['leverage', 'Hype 建议杠杆', p => p.leverage == null ? '未验证' : p.leverage + '×'],
  ['initial', 'Hype 初始保证金', p => usd(p.initial)],
  ['marginRate', '保证金占 Hype 权益', p => pct(p.marginRate, 2)],
  ['free', '开仓后可用抵押品', p => usd(p.free)],
  ['distance', '成功线至 Hype 强平距离', distanceText]
];

function initComparison() {
  const head = $('plan-columns').rows[0];
  for (const [,name] of objectives) {
    const th = document.createElement('th');
    th.scope = 'col';
    const scenario = document.createElement('small');
    th.append(name, scenario);
    head.append(th);
  }
  for (const [key,label] of comparisonMetrics) {
    const tr = $('plan-rows').insertRow();
    tr.dataset.metric = key;
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = label;
    tr.append(th);
    for (let col = 0; col < objectives.length; col++) tr.insertCell();
  }
}

const statusText = value => ({pass:'通过',fail:'未通过',unknown:'未验证',insufficient:'深度不足'})[value] ?? '未验证';
function planChecks(plan) {
  const v = plan.verification ?? {};
  const short = value => ({pass:'✓',fail:'×'})[value] ?? '待验';
  return '失败' + short(v.failureFunds) + ' 成功' + short(v.successFunds) +
    ' 初保' + short(v.initial) + ' 路径' + short(v.liquidation==='fail' || plan.coverage==='verified' ? v.liquidation : 'unknown') + ' 压力' + short(v.stress);
}
function renderComparison(snapshot) {
  const { ratioScan:scan, targets:winners, stress } = snapshot ?? {targets:objectives.map(() => null)};
  const max = winners[0];
  const baseOnly = stress && !stress.positive.length;
  const partial = stress && (stress.missing.length > 0 || stress.zero.length > 0);
  const scenario = !stress ? '压力状态未知' : baseOnly ? '基础情景' : partial ? '部分压力情景' : '已配置压力情景';
  const coverage = !stress ? scenario : stress.missing.length ? (baseOnly ? '压力未配置' : '压力未配齐') :
    stress.zero.length ? '含零压力假设' : '四项压力已配置';
  write('plan-stress', scan ? (scenario === coverage ? scenario : scenario + ' · ' + coverage) : '');
  $('plan-comparison').hidden = !winners.some(Boolean);
  const ratio = formatRatios(winners.filter(Boolean));
  for (const [col, plan] of winners.entries()) {
    const header = $('plan-columns').rows[0].cells[col+1];
    const point = plan?.key ?? '';
    if (header.dataset.point !== point) header.dataset.point = point;
    setText(header.lastElementChild, plan ? planChecks(plan) : '无合格方案');
    for (const [index, [,,format]] of comparisonMetrics.entries()) {
      const td = $('plan-rows').rows[index].cells[col+1];
      setText(td, plan ? format(plan, scan, ratio) : '—');
    }
  }
  $('max-risk').hidden = !max;
  if (!max) return;
  const scope = scan.complete ? '' : '已扫描范围内的';
  const thin = max.fail != null && recoveryCushion(max.fail, scan.ctx.book.B).thin;
  const warning = baseOnly && thin ? '基础情景可行，安全缓冲极薄，压力风险未验证' :
    baseOnly ? '最大基础情景可行仓位，压力安全性未验证' :
    !stress || partial ? '最大条件目标仓位，压力安全性未验证' : '最大基础情景仓位，压力核验另列';
  const stressWarning=max.verification?.stress==='fail' ? ' · 配置的压力情景未通过' :
    !baseOnly && !partial && max.coverage!=='verified' ? ' · 完整路径风险未验证' : '';
  write('max-risk-title', scope + warning + stressWarning);
  const exit=max.liquidity?.fail;
  const exitNote=exit?.settlement && dec(exit.settlement.personal).lt(dec(scan.ctx.book.B).plus(scan.ctx.params.recoveryBuffer??'0'))
    ? ' · 撤去退出最优档后失败回收 '+settlementAmount(exit.settlement.personal)+'，低于回收门槛'
    : exit?.status==='insufficient' ? ' · 撤去退出最优档后，剩余深度不足以平仓' : '';
  write('max-risk-values','占用 '+pct(max.marginRate,2)+' · 开仓可用 '+usd(max.free)+
    ' · 回本缓冲 '+settlementAmount(max.failDelta)+' · 强平距 '+distanceText(max,scan)+
    (Number(max.minimumHeadroom)<0 ? ' · 途中可用 0 U（缺 '+usd(dec(max.minimumHeadroom).neg())+'）':'')+exitNote);
  $('scale-link').hidden = !scan.plans.comparison;
}

function renderScaleComparison(snapshot, fixed = false) {
  const scan = snapshot?.ratioScan;
  const pair = fixed ? snapshot?.scale.fixed : snapshot?.scale.automatic;
  const [small, large] = pair?.rows ?? [];
  const comparison = pair?.comparison;
  const prefix = fixed ? 'fixed-scale' : 'scale';
  const valid = !!(small && large && comparison);
  $(prefix + '-table').hidden = !valid;
  let caption = pair?.reason || '没有可核对的同方向、同一精确比例规模对照。';
  if (valid) {
    const method = fixed ? '两仓固定使用共同通过校验的最低档 ' + small.leverage + '×' :
      '独立择档，小仓 ' + small.leverage + '×，大仓 ' + large.leverage + '×';
    const change = comparison.delta.distance;
    const distanceNote = change == null ? '强平距离未验证' : dec(change).isZero() ? '强平距离相同' :
      '强平距离' + (dec(change).lt(0) ? '缩短 ' : '增加 ') + fmt(dec(change).abs(),2) + ' ' + scan.plans.hlQuote;
    caption = '目标比例 ' + pct(small.h) + ' · ' + method + ' · ' + distanceNote +
      '。小仓' + (small.both ? '满足' : '未同时满足') + '两端保护条件，大仓' +
      (large.both ? '满足' : '未同时满足') + '两端保护条件。';
  }
  write(prefix + '-caption', caption);
  const body = document.createElement('tbody');
  if (valid) {
    const qty = side => v => dec(v).abs() + ' ' + scan.ctx.market[side].unit;
    const metrics = [
      ['PF 数量', 'pf', qty('pf')], ['PF 名义额','pfValue', usd],
      ['Hype 数量','hl',qty('hl')], ['Hype 名义额','hypeValue',usd],
      ['Hype 初始保证金','initial',usd], ['保证金占权益','marginRate',v => pct(v,2)],
      ['失败回收减保护本金','failDelta',settlementAmount], ['成功后 Hype 剩余','success',settlementAmount],
      ['成功线至 Hype 强平距离','distance',v => fmt(v,2)+' '+scan.plans.hlQuote],
      [fixed ? '固定杠杆' : '自动杠杆','leverage',v => v+' 倍'], ['开仓后可用抵押品','free',usd],
      ['失败后个人回收','fail',settlementAmount], ['目标维持保证金','maintenance',usd],
      ['Hype 强平标记价','liquidation',v => fmt(v,2)+' '+scan.plans.hlQuote]
    ];
    for (const [label,key,format] of metrics) {
      const row = body.insertRow();
      row.dataset.metric = key;
      row.insertCell().textContent = label;
      for (const plan of [small,large])
        row.insertCell().textContent = plan[key] == null ? '未验证' : format(plan[key]);
      const change = comparison.delta[key];
      let text = '未验证';
      if (change != null) {
        const number = dec(change);
        const magnitude = key === 'marginRate' ? fmt(number.abs().times(100),2)+' 个百分点' : format(number.abs());
        text = (number.gt(0) ? '+' : number.lt(0) ? '−' : '') + magnitude;
      }
      row.insertCell().textContent = text;
    }
  }
  patchRows($(prefix + '-rows'),body);
}

function detailLine(cell, text) {
  const line = document.createElement('small');
  line.textContent = text;
  cell.append(line);
}

function liquidityLines(cell,first,scan) {
  for (const [label,test] of [['A 完整盘口',first.full],['B 撤档退出 · 撤最优档',first],['C 撤前两档',first.two],['D 剩余可见深度不足',first.shortfall]]) {
    if (!test) continue;
    const cash=test.settlement;
    detailLine(cell,label+' · 退出核验'+statusText(test.status)+' · '+(cash ? '个人资金 '+settlementAmount(cash.personal)+
      ' / Hype '+settlementAmount(cash.hype) : '全量退出资金未验证')+
      (test.reason?' · '+test.reason:'')+
      ' · 清算路径 '+statusText(test.pathStatus)+'，最低维持余量 '+settlementAmount(test.path?.worst?.surplus));
    for (const [side,venue] of [['pf','PF'],['hl','Hype']]) {
      const f=test.depth[side], unit=scan.ctx.market[side].unit;
      detailLine(cell,venue+' 可成交 '+(f.covered??'未知')+' / 未覆盖 '+(f.uncovered??'未知')+' '+unit+
        ' · 退出均价 '+fmt(f.vwap)+' · 档内滑点 '+settlementAmount(f.slippage)+
        ' · 撤档新增成交成本 '+settlementAmount(test.extraExitCost?.[side])+
        ' · 退出手续费 '+settlementAmount(test.exitFees?.[side]));
      const part=f.coveredExecution;
      if(part && (f.status!=='covered' || !part.atEndpoint)) detailLine(cell,
        venue+(part.atEndpoint?' 终点':' 当前盘口')+'已覆盖部分均价 '+fmt(part.vwap)+
        ' · 滑点 '+settlementAmount(part.slippage)+' · 手续费 '+settlementAmount(part.fee));
    }
  }
  detailLine(cell,'退出侧可见档全部撤去时 · 可成交 0，未覆盖 PF '+(first.withdrawn.pf.uncovered??'未知')+
    ' '+scan.ctx.market.pf.unit+' / Hype '+(first.withdrawn.hl.uncovered??'未知')+' '+scan.ctx.market.hl.unit+
    ' · 全量均价、滑点、退出手续费及最终资金均未验证');
}

function pressureMetric(snapshot) {
  const scan=snapshot?.ratioScan, result=scan?.plans?.pressure, row=result?.row;
  const el=$('liquidity-maximum'), body=$('liquidity-evidence-body');
  el.hidden=!snapshot;
  el.dataset.point=row?.key ?? '';
  el.dataset.snapshotId=snapshot?.snapshotId ?? '';
  $('liquidity-evidence').hidden=!row;
  body.replaceChildren();
  const prefix='最大压力情景可行仓位 · ';
  if (!row) {
    setText(el,prefix+(result?.reason ?? '本帧尚无压力搜索结果'));
    return;
  }
  const worst=(end,field)=>[row.liquidity[end].full,row.liquidity[end],row.liquidity[end].two]
    .reduce((a,test)=>dec(test.settlement[field]).lt(a)?dec(test.settlement[field]):a,dec(row.liquidity[end].full.settlement[field]));
  setText(el,prefix+'PF '+targetQty(row.pf,scan.ctx.market.pf)+'（'+usd(row.pfValue)+'） / Hype '+
    targetQty(row.hl,scan.ctx.market.hl)+'（'+usd(row.hypeValue)+'） · A–C 失败最低 '+settlementAmount(worst('fail','personal'))+
    ' / 成功最低 '+settlementAmount(worst('pass','hype'))+' · '+result.reason);
  for (const [end,title] of [['fail','PF 失败'],['pass','PF 达标']]) {
    detailLine(body,title+' · '+targetQty(row.pf,scan.ctx.market.pf)+' / Hype '+targetQty(row.hl,scan.ctx.market.hl));
    liquidityLines(body,row.liquidity[end],scan);
  }
}

function intervalEvidence(cell,label,name,test) {
  if (!test.proof?.continuous || !test.proof.segments.length) return;
  const detail=document.createElement('details'), summary=document.createElement('summary');
  detail.dataset.path=name;
  summary.textContent=label+' · 查看逐段保证金';
  detail.append(summary);
  for (const [i,segment] of test.proof.segments.entries()) {
    const start=test.checkpoints[i], end=test.checkpoints[i+1];
    const pair=field=>usd(start[field])+' → '+usd(end[field]);
    detailLine(detail,fmt(segment.from)+' → '+fmt(segment.to)+' · 权益 '+pair('equity')+
      ' · 维持保证金 '+pair('maintenance')+' · 清算余量 '+pair('surplus')+
      ' · 可追加 '+pair('freeCollateral')+' · 段内最低清算余量 '+usd(segment.minimum));
  }
  cell.append(detail);
}

function renderPlans(snapshot) {
  const scan = snapshot?.ratioScan;
  const report = scan?.plans;
  const riskBody = document.createElement('tbody');
  const positionRows = document.createElement('tbody');
  for (const [i, r] of (snapshot?.targets ?? []).entries()) {
    const name = objectives[i][1];
    if (!r) continue;
    const tr = positionRows.insertRow();
    tr.dataset.point = r.key;
    const heading = tr.insertCell();
    heading.append(name);
    const v = r.verification ?? {};
    for (const [label,value] of [['失败回收',v.failureFunds],['成功留存',v.successFunds],['初始保证金',v.initial],
        ['维持保证金约束',v.maintenance],['设定价格路径',v.path],['压力测试',v.stress]])
      detailLine(heading,label + ' · ' + statusText(value));
    if (r.fail!=null) detailLine(heading,'失败端要求 '+usd(scan.recoveryFloor??scan.ctx.book.B)+
      '，高于门槛 '+settlementAmount(dec(r.fail).minus(scan.recoveryFloor??scan.ctx.book.B))+
      (recoveryCushion(r.fail,scan.ctx.book.B).thin?' · 极薄缓冲':''));
    detailLine(heading,r.coverage==='verified' ? '已核对设定情景与全仓数据' : '路径风险未充分验证');
    if (Number(r.minimumHeadroom)<0) detailLine(heading,'途中可新增 0 U。抵押品缺口 '+usd(dec(r.minimumHeadroom).neg()));
    if (Number(r.minimumInitialHeadroom)<0) detailLine(heading,'无法追加仓位的初保资金缺口 '+usd(dec(r.minimumInitialHeadroom).neg())+'。清算按权益与维持保证金核验');
    for (const side of ['pf', 'hl']) {
      const leg = scan.ctx.market[side], adj = r.adjustments?.[side];
      const cell = tr.insertCell();
      cell.append(targetQty(r[side],leg) + ' / ' + usd(side === 'pf' ? r.pfValue : r.hypeValue));
      if (!adj) { detailLine(cell, '该快照未记录调仓差额'); continue; }
      detailLine(cell, '净仓 ' + adj.current + ' · 挂单 ' + (adj.pending ?? '未知') + ' ' + leg.unit);
      const remaining = adj.remaining == null ? null : dec(adj.remaining);
      detailLine(cell, !remaining ? adj.text : (adj.pending != null && !dec(adj.pending).isZero() ? '若挂单全成，' : '') +
        (remaining.isZero() ? '无需调仓' : (remaining.gt(0) ? '差额买入 ' : '差额卖出 ') + remaining.abs() + ' ' + leg.unit));
    }
    for (const key of ['fail','pass']) {
      const cell = tr.insertCell(), path = r.paths?.[key];
      cell.append(settlementAmount(key === 'fail' ? r.fail : r.success));
      if (!path) { detailLine(cell, r[key === 'fail' ? 'failStop' : 'passStop'] || '该快照未记录路径价格'); continue; }
      for (const side of ['pf','hl']) {
        const unit = side === 'pf' ? report.pfQuote : report.hlQuote;
        const line = path[side], mark = line.mark ?? snapshot.prices[side].mark;
        const direction = dec(line.exitMark).cmp(mark);
        detailLine(cell, (side === 'pf' ? 'PF' : 'Hype') + (direction > 0 ? ' ↑ ' : direction < 0 ? ' ↓ ' : ' → ') +
          fmt(line.exitMark) + ' ' + unit + ' · 平仓 ' + (line.exitPrice == null ? '无仓位' : fmt(line.exitPrice)));
      }
      for (const [side,label] of [['pf','PF'],['hl','Hype']]) {
        const l=path[side];
        if (l.markPnl == null) continue;
        detailLine(cell,label+' '+targetQty(l.target,scan.ctx.market[side])+' × 乘数 '+l.multiplier+
          ' · 标记价格盈亏 '+signedCash(l.markPnl)+' · 成交价调整 '+signedCash(l.fillPnl));
        detailLine(cell,'起始权益 '+settlementAmount(l.startEquity)+' · 调仓均价 '+(l.entryPrice==null?'无调仓':fmt(l.entryPrice))+
          ' · 调仓费 '+settlementAmount(l.entryFee)+' · 平仓费 '+settlementAmount(l.closeFee)+
          ' · 平仓权益 '+settlementAmount(l.finalEquity));
      }
      detailLine(cell,'起点 PF ' + fmt(snapshot.prices.pf.mark) + ' ' + report.pfQuote +
        ' / Hype ' + fmt(snapshot.prices.hl.mark) + ' ' + report.hlQuote);
      for (const side of ['pf','hl']) for (const phase of ['entry','exit']) {
        const fill=r.depth?.[key]?.[side]?.[phase], unit=scan.ctx.market[side].unit;
        const label=(side==='hl'?'Hype':'PF')+(phase==='entry'?' 调仓':' 条件平仓');
        if (fill?.status==='noTrade') { detailLine(cell,label+' · 无成交'); continue; }
        if (fill?.status!=='covered') { detailLine(cell,label+' · 深度未验证'+
          (fill?.uncovered!=null?'，未覆盖 '+fill.uncovered+' '+unit:'')); continue; }
        detailLine(cell,label+' · '+(fill.side==='ask'?'吃卖盘':'吃买盘')+' · 目标 '+fill.target+' '+unit+
          '，覆盖 '+fill.covered+'（'+pct(fill.coverageRatio,2)+'） / 可见 '+fill.visible+'，未覆盖 '+fill.uncovered+'；用 '+fill.levels+
          ' 档，首档 '+fill.topSize+' @ '+fmt(fill.best)+'，均价 '+fmt(fill.vwap)+
          '，半点差成本 '+settlementAmount(fill.spreadCost)+'，深度滑点 '+settlementAmount(fill.slippage));
      }
      detailLine(cell,'深度滑点 PF ' + settlementAmount(path.pf.slippage) + ' / Hype ' + settlementAmount(path.hl.slippage));
      const stressDepth=r.liquidity?.[key];
      if (stressDepth) liquidityLines(cell,stressDepth,scan);
      if (key === 'pass' && r.successPersonal != null) detailLine(cell,'个人资金（到账前） ' + settlementAmount(r.successPersonal));
      for (const [kind,test] of Object.entries(r.pathAudit?.[key] ?? {})) {
        const label = {base:'基础同步',basisWiden:'基差扩大',basisNarrow:'基差收敛',
          adverseJump:'不利跳价',basisAdverse:'基差对当前 Hype 仓不利',basisFavorable:'基差对当前 Hype 仓有利',
          asyncExit:'盘口异步且退出时仍承受不利偏移',dislocation:'途中错位后恢复同步',delayedFill:'延迟成交后',beforeFill:'延迟成交前（原仓）'}[kind];
        const low=test.worst;
        if (low) {
          detailLine(cell,label+' · '+(test.proof?.continuous?'解析检验 '+test.proof.intervals+' 段':'路径风险未充分验证')+
            '，最小维持余量位于'+(low.legIndex===0?'起点':'第 '+low.legIndex+' 段 '+pct(low.progress,1))+
            '，Hype 标记 '+fmt(low.mark)+' '+report.hlQuote);
          detailLine(cell,'账户权益 '+usd(low.equity)+' · 目标初始保证金 '+usd(low.initial)+
            ' · 总保证金占用 '+usd(low.marginUsed)+'（其他已知占用 '+usd(low.otherUsed)+'）');
          if (Number(low.additionalIMShortfall)>0) detailLine(cell,'无法追加仓位的资金缺口 '+settlementAmount(low.additionalIMShortfall)+'（按初保要求）');
          detailLine(cell,'维持保证金 '+usd(low.maintenance)+' · 清算余量 '+usd(low.surplus)+
            ' · 可用抵押品 '+usd(low.freeCollateral)+' · 初始保证金净余量 '+usd(low.initialHeadroom));
          if (Number(test.lowestFree?.free)<0) detailLine(cell,'途中新增仓位可用 0 U，最大抵押缺口 '+
            usd(dec(test.lowestFree.free).neg())+'，出现在 '+fmt(test.lowestFree.mark)+' '+report.hlQuote);
        }
        intervalEvidence(cell,label,kind,test);
        if (test.offset!=null) detailLine(cell,'同步终点基差 '+fmt(test.gapBefore)+' → '+fmt(test.gapAfter)+
          ' '+report.hlQuote+'，'+(Number(test.offset)===0?'无额外位移':test.adverse?'对 Hype 不利':'对 Hype 有利'));
        const v=test.settlement;
        if (v) detailLine(cell,'双边平仓价 PF '+fmt(v.pfFill)+' / Hype '+fmt(v.hlFill)+
          '，PF 净盈亏 '+signedCash(v.pfNet)+'，Hype 净盈亏 '+signedCash(v.hlNet)+
          '，Hype 剩余 '+settlementAmount(v.hype)+'，个人回收（分成到账前） '+settlementAmount(v.personal));
        else if (kind!=='beforeFill') detailLine(cell,'该路径结算未验证');
        if (test.firstBreach) detailLine(cell,'途中首次触线 ' + fmt(test.firstBreach.mark) + ' ' + report.hlQuote);
      }
      if (!r.pathAudit?.[key]?.basisWiden) detailLine(cell,'基差扩大 / 收敛 · 未验证（须有基差幅度和有效同币种参考）');
      detailLine(cell, 'Hype 净盈亏 ' + signedCash(path.hypeNet));
      detailLine(cell, '手续费 PF ' + settlementAmount(path.pf.fees) + ' / Hype ' + settlementAmount(path.hl.fees));
      detailLine(cell, '盘口成交成本 PF ' + settlementAmount(path.pf.executionCost) + ' / Hype ' + settlementAmount(path.hl.executionCost));
    }
  }
  const hasTargets = snapshot?.targets.some(Boolean) ?? false;
  patchRows($('position-list-rows'),positionRows);
  $('position-list').hidden = !hasTargets;
  $('positions-empty').hidden = hasTargets;
  write('positions-empty', hasTargets ? '' : !snapshot ? '等待首份计算快照' :
    report?.legacy ? '该历史快照未保存三项优化目标' :
    report?.pending ? '分成待到账，目标建议已暂停' : '本次计算没有合格目标方案');
  renderScaleComparison(snapshot);
  renderScaleComparison(snapshot,true);
  write('plan-caption', !report ? '' : report.pending ? '分成待到账' :
    report.legacy ? '历史条件目标' : !report.eligible ? '当前门槛下无合格方案' :
    scan.complete ? '按两端现金约束筛选' : '限已扫描规模');
  const units = side => scan.ctx.market[side].unit === 'contract' ? '张' : scan.ctx.market[side].unit;
  function appendRisk(r) {
    const cost = k => [r.failCost, r.passCost].map(v => v ? fmt(v[k], 4) : '未知').join(' / ');
    const detail = riskBody.insertRow();
    for (const str of [pct(r.h) + ' · PF ' + r.pf + ' ' + units('pf'), r.hl + ' ' + units('hl'),
      r.leverage ? r.leverage + '×' : '—', usd(r.initial) + ' · ' + pct(r.marginRate, 2), usd(r.maintenance),
      usd(r.otherInitial), usd(r.free), usd(r.baseSurplus), usd(r.stressSurplus), r.liquidation == null ? '无已验证交点' : fmt(r.liquidation, 4) + ' ' + report.hlQuote,
      r.distance == null ? '无已验证交点' : fmt(r.distance, 4) + ' ' + report.hlQuote, cost('fees') + ' U', cost('slippage') + ' U']) detail.insertCell().textContent = str;
  }
  for (const r of report?.rows ?? []) appendRisk(r);
  patchRows($('plan-risk-rows'), riskBody);
}

function draw(snapshot, auditScan) {
  frame = snapshot?.ratioScan ?? null;
  audit = null;
  const scan = frame,
    rep = scan?.representative;
  pressureMetric(snapshot);
  renderComparison(snapshot);
  renderPlans(snapshot);
  renderAnalysis(scan);
  $('bands-empty').hidden = !!scan?.sets.legal.count || !scan;
  if (scan && !scan.sets.legal.count) write('bands-empty','当前扫描范围没有合法仓位');
  const aggregate = document.createElement('tbody');
  const bands = document.createElement('tbody');
  write('capital-threshold', scan ? ' · ' + scan.ctx.book.B + ' U' : '');
  const floor = scan?.recoveryFloor ?? scan?.ctx.book.B;
  write('joint-threshold', scan ? (scan.historicalIntersection ? ' · 上版合格子集' : '') + ' · ≥' + floor + ' / ≥' + scan.ctx.params.R + ' U' : '');
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
        ? '—'
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
  if (scan) summaryRow(aggregate, names.legal, scan.sets.legal.range, '0 组');
  const excluded = [];
  for (const [n, bin] of (scan?.buckets ?? []).entries()) {
    const label = binLabel(bin);
    if (bin.legal) {
      for (const group of capitalGroups) {
        const range = bin.ranges[group];
        const row = summaryRow(bands, names[group] + ' · ' + label, range, '0 组');
        row.dataset.band = String(n);
        row.dataset.subset = group;
        if (group === 'both' && range) row.classList.add('qualified');
        if (range && n === rep?.segment && group === rep.group) {
          row.classList.add('representative-range');
          row.cells[0].title += ' · 含本帧条件目标方案';
        }
      }
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
  patchRows($('scan-buckets'), bands);
  write('scan-risk-counts', excluded.join('\n'));
  write(
    'scan-intersection',
    scan
      ? '交集要求同组仓位在失败时回收至少 ' +
          usd(floor) +
          '（含额外缓冲），成功时 Hype 至少留存 ' +
          usd(scan.ctx.params.R) +
          '。个人净盈利另按两端平仓后的个人现金与累计投入比较。'
      : ''
  );
  if (rep) showRepresentative(snapshot, auditScan);
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
export function renderScan(result, m, r, plan, status, snapshot) {
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
    const saved = snapshot?.prices?.[key];
    const book = q?.levels?.[0]?.[0] && q.levels[1]?.[0] ? {
      bid:q.levels[0][0][0], ask:q.levels[1][0][0], bookAt:q.bookAt ?? q.asOf
    } : null;
    const prices = book ?? saved;
    const c = observed.currencies?.[key] ?? (saved && {baseAsset:saved.base, quoteAsset:saved.quote});
    const prefix = 'scan-' + key + '-';
    write(prefix + 'product', (key === 'pf' ? 'Vest ' : 'Hyperliquid ') + (m.asset ?? '') + ' Perp');
    write(prefix + 'unit', c?.quoteAsset && c?.baseAsset ? c.quoteAsset + '/' + c.baseAsset : '报价币待核实');
    const bookInvalid = m.errors?.[key] || observed.timing?.clocks?.[key]?.ok === false;
    write(prefix + 'health', prices && (!book || bookInvalid) ? ' · 已失效' : '');
    write(prefix + 'price', q?.mark ?? saved?.mark ?? '—');
    const markAt = q?.mark != null ? q.markAt ?? q.asOf : saved?.markAt ?? saved?.asOf;
    $(prefix + 'price').title = (q?.mark == null && saved ? '历史标记时间 ' : (q?.markSource??'标记时间')+' ') + time(markAt);
    write(prefix + 'bid', prices?.bid ?? '—');
    write(prefix + 'ask', prices?.ask ?? '—');
    const clock = $(prefix + 'book-time');
    const bookAt = prices?.bookAt;
    if (clock.dateTime !== (bookAt ?? '')) clock.dateTime = bookAt ?? '';
    write(prefix + 'book-time', bookAt ? (book ? '盘口 ' : '历史盘口 ') + time(bookAt) : '盘口时间未知');
    write(prefix + 'quote', [m.source === '手工确认盘口' && m.source, clock.textContent,
      m.errors?.[key] || (bookInvalid && '报价过期或盘口无效') || (!book && '等待新报价')].filter(Boolean).join(' · '));
  }
  const displayed = result.ratioScan ? result : result.retained;
  const tr = snapshot?.trace;
  const f = result.funding;
  write('scan-source', plan ? (r.planCrossFlat === true ? '预设资金规划 · 规划空仓' : '预设资金规划 · 仓位待确认') : f?.C_H == null || f?.E == null ? '当前账户快照 · 待读取' : '当前账户快照');
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
  else if (!snapshot?.ratioScan?.representative?.row?.funded)
    write('scan-funded', 'Funded 分成 · 等待有效快照，到账状态待核实');
  const timing = observed.timing;
  const quoteBreak = timing?.quoteSkew > timing?.quoteLimit;
  const state = waitingForMarket ? 'loading' : publicationState(result,snapshot,m,
    !!(quoteBreak || networkError || specError || observed.currencies?.error)),
    id = snapshot?.snapshotId ?? '';
  const stamp = tr ? '输入时点 ' + new Date(tr.at).toLocaleDateString('zh-CN') + ' ' + time(tr.at) : '';
  const desk = $('scan-desk');
  if (desk.dataset.state !== state) desk.dataset.state = state;
  const currentInputs = state === 'ready';
  const reason = quoteBreak ? '行情熔断 · 双边盘口或标记时差 ' + timing.quoteSkew +
    ' ms，阈值 ' + timing.quoteLimit + ' ms' : networkError || observed.currencies?.error || specError || result.issues?.[0] || status;
  let validity;
  if (quoteBreak) {
    validity = tr ? reason : reason + ' · 暂停新目标建议';
  } else if (state === 'recovering') {
    validity = tr ? '行情和输入已恢复，正在重新计算' : '输入就绪，首次计算中';
  } else if (currentInputs) {
    validity = '当前数据有效 · 条件估算（当前快照计算结果）';
    if (displayed?.ratioScan?.complete === false) validity += '（部分网格）';
  } else if (state === 'updating') {
    validity = tr ? (result.trigger === '行情更新' ? '盘口已更新，目标仓位重算中' : '输入已变更，正在重算') + ' · 历史快照，暂停新建议' : '输入就绪，首次计算中';
  } else if (waitingForMarket) {
    validity = '等待双边盘口';
  } else {
    validity = (state === 'failed' ? '计算失败' : '计算暂停') + ' · ' + (reason || '数据待核实');
    if (tr) validity += '（仅供历史参考）';
  }
  const completedAt = snapshot?.calculatedAt;
  const lastTime = completedAt ? new Date(completedAt).toLocaleString('zh-CN',{hour12:false}) : '—';
  const historical = !!tr && !currentInputs;
  if (historical && !validity.includes('历史')) validity+=' · 历史快照，暂停新建议';
  for (const label of document.querySelectorAll('.history-label'))
    setText(label,historical ? '历史快照' : '');
  const cashClock = $('cash-calculated-at');
  if (cashClock.dateTime !== (completedAt ?? '')) cashClock.dateTime = completedAt ?? '';
  write('cash-calculated-at', completedAt ? '最后成功计算 ' + time(completedAt) : '等待首次计算');
  const main = $('current');
  if (main.dataset.historical !== String(historical)) main.dataset.historical = String(historical);
  if (main.dataset.frameState !== state) main.dataset.frameState = state;
  $('snapshot-note').hidden = !historical || state === 'updating';
  write('snapshot-note', historical ? '历史快照 · ' + lastTime + '。新目标建议已暂停，以下资金、区间与仓位仅供核对。' : '');
  write('scan-status', validity + ' ｜ 最近成功计算 ' + (completedAt ? time(completedAt) : lastTime));
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
  if (frameKey !== (id || 'empty')) {
    const auditScan = displayed?.trace?.id === id ? (displayed.baseScan ?? displayed.ratioScan) : null;
    draw(snapshot, auditScan);
    // All panels are patched synchronously from one publication before exposing its version.
    frameKey = id || 'empty';
    for (const panel of ['live-view','positions-view','scale-details','desk-details','scan-results','scan-cash','ratio-intervals','desk-state']) {
      $(panel).dataset.snapshotId = id;
      $(panel).dataset.calculatedAt = completedAt ?? '';
    }
    for (const key of ['quoteSnapshotId','accountSnapshotId','rulesVersion','solverVersion','calculatedAt'])
      desk.dataset[key] = snapshot?.[key] ?? '';
    desk.dataset.resultId = id;
  }

}
export function setupScan() {
  initComparison();
  const buttons = [...$('desk-views').querySelectorAll('button')];
  for (const button of buttons) {
    const panel = $(button.getAttribute('aria-controls'));
    button.onclick = () => { panel.open = true; };
    panel.addEventListener('toggle', () => button.setAttribute('aria-expanded',String(panel.open)));
  }
  $('scale-link').onclick = () => { $('positions-view').open = true; };
  for (const id of ['desk-details', 'audit-details', 'scan-detail'])
    $(id).addEventListener('toggle', auditText);
  $('subset-detail').ontoggle = renderSubsets;
  for (const id of ['range-columns', 'bin-columns', 'subset-columns']) {
    const tr = $(id).insertRow();
    for (const title of columns) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = title;
      tr.append(cell);
    }
  }
}
