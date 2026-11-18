import { escapeHTML as h, money, number as n, signed, stateNames } from './format.js';

const $ = (id) => document.getElementById(id);
const titles = { vs: 'VS 考核账户', hype: 'Hype 永续账户' };
const mark = (leg) => leg?.mark ?? leg?.price;
const pct = (value) => n(value) + '%';
const ratio = (a, b) => (Number.isFinite(a) && b > 0 ? (a / b) * 100 : null);
const line = (label, value) => '<div class="pair"><dt>' + h(label) + '</dt><dd>' + h(value) + '</dd></div>';
const metric = (label, value) =>
  '<div class="metric"><small>' + h(label) + '</small><b>' + h(value) + '</b></div>';
const row = (cells) => '<tr>' + cells.map((c) => '<td>' + h(c) + '</td>').join('') + '</tr>';
const table = (heads, rows) =>
  '<div class="scroll"><table><thead><tr>' +
  heads.map((c) => '<th>' + h(c) + '</th>').join('') +
  '</tr></thead><tbody>' +
  rows +
  '</tbody></table></div>';
const defs = (values) => '<dl>' + values.map(([k, v]) => line(k, v)).join('') + '</dl>';
const info = (message) => '<p class="hint">' + h(message) + '</p>';
const progress = (value) =>
  '<div class="bar"><i class="' +
  (value > 100 ? 'red' : value >= 80 ? 'amber' : '') +
  '" style="width:' +
  Math.max(0, Math.min(100, value || 0)) +
  '%"></i></div>';
const planSide = (c) =>
  c?.vsLong === true ? 'VS 多 / Hype 空' : c?.vsLong === false ? 'VS 空 / Hype 多' : '—';
const labelStatus = (c) =>
  c?.noTrade ? '不交易' : stateNames[c?.status] || (c?.ok ? '匹配可交易' : '无法验证');
const signedQty = (c, a, v) => signed(c?.[v]?.tradeQty, 8) + ' ' + a[v].qtyUnit;
const totalQty = (c, a, v) => n(c?.[v]?.qty, 8) + ' ' + a[v].qtyUnit;
const reason = (c) => (c?.reasons ?? []).join(' · ');
function localQuote(leg, side) {
  const live = leg[side] ?? leg.book?.[side === 'bid' ? 'bids' : 'asks']?.[0]?.[0];
  if (Number.isFinite(live)) return live;
  if (leg.sourceKind === 'live' || leg.sourceKind === 'page') return null;
  return Number.isFinite(mark(leg)) ? mark(leg) + ((side === 'bid' ? -1 : 1) * (leg.spread ?? 0)) / 2 : null;
}
function asClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return (
    d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
  );
}
export function showVenue(v, a, acct, config, limits, c, snapshot) {
  const l = limits?.[v] ?? {},
    pos = c?.[v],
    leg = a[v],
    isVS = v === 'vs';
  if (
    !isVS &&
    config.useExternalAccounts !== false &&
    snapshot?.mode !== 'offline' &&
    snapshot?.addressConfigured &&
    !a.hype?.account
  ) {
    $('hype-panel').innerHTML =
      '<div class="eyebrow">HYPERLIQUID</div><h2>Hype 永续账户</h2><div class="big">—</div>' +
      info('等待公开地址的有效余额与抵押币换算，暂不能计算可开额度。');
    return;
  }
  const threshold = acct.stage === 'funded' ? config.payoutTarget : config.challengeTarget;
  const fail = acct.stage === 'funded' ? config.fundedFail : config.challengeFail;
  const externalAccount =
    config.useExternalAccounts !== false && snapshot
      ? isVS
        ? snapshot.vs?.account
        : snapshot.mode !== 'offline' && a.hype.account
      : null;
  const equity = externalAccount ? externalAccount.equity : acct[v + 'Equity'];
  const used = externalAccount ? externalAccount.used : acct[v + 'Used'];
  const free = externalAccount ? externalAccount.free : acct[v + 'Free'];
  let source = '本地账户';
  if (externalAccount) {
    if (isVS) source = externalAccount.source ?? 'VS 已确认快照';
    else source = snapshot.mode === 'frozen' ? '公开地址冻结快照' : '公开地址同步';
  }
  const fresh = externalAccount?.asOf ? ' · ' + asClock(externalAccount.asOf) : '';
  const cap = (usd, qty) => money(usd) + ' / ' + n(qty, 8) + ' ' + leg.qtyUnit;
  $(v + '-panel').innerHTML =
    '<div class="eyebrow"><span>' +
    h(isVS ? 'PROP FIRM' : 'HYPERLIQUID') +
    '</span><span>' +
    h(source + fresh) +
    '</span></div>' +
    '<h2>' +
    h(isVS && acct.stage === 'funded' ? 'VS 出金账户' : titles[v]) +
    '</h2><div class="big">' +
    n(free) +
    '<small>U 可用</small></div>' +
    progress(ratio(used, equity)) +
    defs([
      ['当前净值', money(equity)],
      ['已占用保证金', money(used)],
      ...(isVS
        ? [
            ['距目标净值', money(threshold - equity)],
            ['距固定失败线', money(equity - fail)]
          ]
        : [
            ['较个人初始本金', signed(equity - config.initialCapital) + ' U'],
            ['最低现金留存', money(config.minCash)]
          ])
    ]) +
    '<div class="rule">' +
    defs([
      ['最大总仓位', cap(l.maxUsd, l.maxQty)],
      ['资金风控上限', cap(l.safeUsd, l.safeQty)],
      ['通过回本与强平验算的最大样本', cap(l.matchedSafeUsd, l.matchedSafeQty)],
      ['剩余可增开额度', money(l.addUsd)],
      ['所选仓位保证金', money(pos?.margin)],
      ['增减后可用', money(pos?.freeAfter)]
    ]) +
    '</div>' +
    (!isVS ? info('强平缓冲逐候选验算，已通过区间见中栏。') : '');
}
export function showCross(a, c, result, snap) {
  const v = a.vs,
    y = a.hype;
  const both = [v, y].every((leg) => Number.isFinite(mark(leg)) && leg.ratio > 0);
  const vsPx = mark(v) / v.ratio,
    hyPx = mark(y) / y.ratio,
    basis = both ? Math.abs(vsPx - hyPx) : null;
  const spreads = [v, y].map((leg) => {
    const ask = localQuote(leg, 'ask'),
      bid = localQuote(leg, 'bid');
    return Number.isFinite(ask) && Number.isFinite(bid) ? (ask - bid) / leg.ratio : null;
  });
  const spread = spreads.every(Number.isFinite) ? spreads[0] + spreads[1] : null;
  const iv = result.interval ?? {},
    cost = c?.costs ?? {},
    lim = result.limits ?? {};
  const list = (lo, hi) =>
    Number.isFinite(lo) && Number.isFinite(hi) ? n(lo) + ' – ' + money(hi) : '无已验算范围';
  const fraction = (v) => pct(c?.[v]?.marginPct);
  let hypeSource = 'Hype 缺少实时快照';
  if (y.sourceKind === 'live' && y.asOf && Number.isFinite(mark(y))) {
    const state = snap?.mode === 'frozen' ? '冻结快照 · ' : snap?.mode === 'offline' ? '持仓留存快照 · ' : '';
    hypeSource =
      state +
      'Hype 交易所盘口 ' +
      asClock(y.asOf) +
      ' · 标记价接收 ' +
      asClock(y.contextReceivedAt) +
      ' · 请求耗时 ' +
      n(y.latencyMs, 0) +
      ' ms';
  } else if (a.feedMode === 'offline' && Number.isFinite(mark(y))) {
    hypeSource = 'Hype 离线模拟 · 模板报价时间 ' + asClock(y.asOf);
  }
  $('cross-panel').innerHTML =
    '<div class="eyebrow"><span>两边报价与交集</span><span>' +
    h(a.ticker) +
    '</span></div><h2>跨平台价格与仓位</h2>' +
    '<div class="quote">' +
    metric('VS 买一 / 卖一', n(localQuote(v, 'bid'), 5) + ' / ' + n(localQuote(v, 'ask'), 5)) +
    metric('Hype 买一 / 卖一', n(localQuote(y, 'bid'), 5) + ' / ' + n(localQuote(y, 'ask'), 5)) +
    '</div>' +
    defs([
      [
        'Hype 标记价 / 资金费率',
        n(mark(y), 5) + ' / ' + pct(Number.isFinite(y.fundingRate) ? y.fundingRate * 100 : null)
      ],
      ['标记价差 / 基差', n(basis, 5) + ' ' + a.priceUnit + ' / ' + pct(ratio(basis, a.referencePrice))],
      ['盘口点差合计', n(both ? spread : null, 5) + ' ' + a.priceUnit],
      [
        '点差、滑点 / 成本预算',
        money(Number.isFinite(cost.spread) ? cost.spread + (cost.slippage ?? 0) : null) +
          ' / ' +
          money(cost.budget)
      ]
    ]) +
    progress(cost.utilizationPct) +
    '<div class="rule">' +
    defs([
      ['VS 可行候选区间', list(iv.vsMin, iv.vsMax)],
      ['Hype 可行候选区间', list(iv.hypeMin, iv.hypeMax)],
      ['敏感度之比 Hype / VS', pct(ratio(Math.abs(c?.hype?.delta), Math.abs(c?.vs?.delta)))],
      ['所选保证金占各自净值', fraction('vs') + ' / ' + fraction('hype')]
    ]) +
    '</div>' +
    info(hypeSource);
}
export function showVerdict(a, c, result, config) {
  const ok = c?.ok && !c.noTrade;
  $('verdict').className = 'verdict' + (ok ? '' : ' bad');
  const plan =
    c?.vs && c?.hype
      ? planSide(c) +
        '，VS ' +
        money(c.vs.notional) +
        '（' +
        totalQty(c, a, 'vs') +
        '），Hype ' +
        money(c.hype.notional) +
        '（' +
        totalQty(c, a, 'hype') +
        '）'
      : '当前没有可执行的双边方案';
  $('verdict').innerHTML =
    '<header><h2>' +
    h(labelStatus(c)) +
    '</h2><strong>' +
    h(a.ticker + ' · ' + plan) +
    '</strong></header>' +
    '<p>' +
    h(
      (c?.vs && c?.hype
        ? '相对现仓的带符号调整：VS ' + signedQty(c, a, 'vs') + '，Hype ' + signedQty(c, a, 'hype') + '。 '
        : '') +
        (ok
          ? c.runway?.ok
            ? '按当前假设可安全续航至首次出金。'
            : '仅可完成本阶段，详见续航验算。'
          : reason(c) || result.reasons?.join(' · ') || '未找到可行候选，维持不交易。')
    ) +
    '</p>';
}
export function showAxes(a, c, account, config, scenario) {
  const ref = a.referencePrice,
    failTarget = account.stage === 'funded' ? config.fundedFail : config.challengeFail;
  const target = account.stage === 'funded' ? config.payoutTarget : config.challengeTarget;
  const points = [
    ['当前标记', ref, '#466b50'],
    ['VS 固定失败', c?.fail, '#ac7050'],
    [account.stage === 'funded' ? 'VS 出金目标' : 'VS 考核通过', c?.pass, '#467c53'],
    ['Hype 强平', c?.liq, '#a38139']
  ].filter(([, p]) => Number.isFinite(p) && p > 0);
  const map = (v, p) => (Number.isFinite(mark(a[v])) ? mark(a[v]) + (p - ref) * a[v].ratio : null);
  $('axis-unit').textContent = a.priceUnit;
  let chart = '';
  if (points.length > 1) {
    const values = points.map((x) => x[1]),
      lo = Math.min(...values),
      hi = Math.max(...values);
    const x = (p) => 44 + ((p - lo) / Math.max(hi - lo, Number.EPSILON)) * 500;
    const lines = [60, 105]
      .map((y) => '<line x1="34" x2="554" y1="' + y + '" y2="' + y + '" stroke="#9eb5a1"/>')
      .join('');
    const ordered = points
      .map(([label, p, color]) => ({ label, p, color, at: x(p) }))
      .sort((a, b) => a.at - b.at);
    let edge = 0;
    for (const pt of ordered) {
      pt.textX = Math.max(pt.at, edge + 52);
      edge = pt.textX;
    }
    edge = 605;
    for (const pt of [...ordered].reverse()) {
      pt.textX = Math.min(pt.textX, edge - 52);
      edge = pt.textX;
    }
    const ticks = ordered
      .map(
        ({ label, p, color, at, textX }) =>
          '<g><title>' +
          h(label + ' · VS ' + n(map('vs', p), 6) + ' / Hype ' + n(map('hype', p), 6)) +
          '</title>' +
          '<text x="' +
          textX +
          '" y="45" fill="' +
          color +
          '" font-size="11" text-anchor="middle">' +
          h(label.replace('VS ', '').replace('Hype ', '')) +
          '</text>' +
          '<path d="M' +
          textX +
          ' 47 L' +
          at +
          ' 55" stroke="' +
          color +
          '"/><line x1="' +
          at +
          '" x2="' +
          at +
          '" y1="55" y2="113" stroke="' +
          color +
          '" stroke-dasharray="3 3"/>' +
          [60, 105]
            .map((y) => '<circle cx="' + at + '" cy="' + y + '" r="3.5" fill="' + color + '"/>')
            .join('') +
          '</g>'
      )
      .join('');
    const quoteTicks = ['vs', 'hype']
      .map((v, i) => {
        const leg = a[v],
          cy = i === 0 ? 60 : 105;
        return ['bid', 'ask']
          .map((side) => {
            const px = localQuote(leg, side),
              refQuote = ref + (px - mark(leg)) / leg.ratio,
              xx = x(refQuote);
            if (!Number.isFinite(xx) || xx < 34 || xx > 554) return '';
            return (
              '<path d="M' +
              (xx - 2) +
              ' ' +
              (cy + 7) +
              ' l4 0 l-2 -4 z" fill="#48675a"><title>' +
              h(v + ' ' + side + ' ' + n(px, 6)) +
              '</title></path>'
            );
          })
          .join('');
      })
      .join('');
    const shade =
      Number.isFinite(c?.liq) && Number.isFinite(c?.pass)
        ? '<rect x="' +
          Math.min(x(c.liq), x(c.pass)) +
          '" y="51" width="' +
          Math.abs(x(c.liq) - x(c.pass)) +
          '" height="63" fill="' +
          (c.buffer > 0 ? '#e1edda' : '#f5e1d0') +
          '"/>'
        : '';
    chart =
      '<svg class="axis-svg" viewBox="0 0 590 138" role="img" aria-label="VS 与 Hype 按同一标的价格变化对齐；竖向虚线对应下表各触线。"><text x="34" y="29">VS · ' +
      h(a.vs.quote) +
      '</text><text x="34" y="90">Hype · ' +
      h(a.hype.quote) +
      '</text>' +
      shade +
      lines +
      ticks +
      quoteTicks +
      '<text x="554" y="31" text-anchor="end">' +
      h(n(map('vs', lo), 4) + ' → ' + n(map('vs', hi), 4)) +
      '</text><text x="554" y="130" text-anchor="end">' +
      h(n(map('hype', lo), 4) + ' → ' + n(map('hype', hi), 4)) +
      '</text></svg>';
  }
  const rows = points
    .map(([name, p]) =>
      row([
        name,
        n(map('vs', p), 5),
        n(map('hype', p), 5),
        signed(p - ref, 4) + ' / ' + signed(ratio(p - ref, ref)) + '%'
      ])
    )
    .join('');
  $('axis').innerHTML =
    chart +
    table(['条件', 'VS 价格', 'Hype 价格', '距离 · 原生 / %'], rows) +
    info(
      '当前到 VS 目标尚差 ' +
        money(target - account.vsEquity) +
        '；到失败线还有 ' +
        money(account.vsEquity - failTarget) +
        '。'
    ) +
    info(
      Number.isFinite(c?.liq)
        ? '强平依据：' +
            c.liqSource +
            '。缓冲 ' +
            n(c.buffer, 4) +
            ' ' +
            a.priceUnit +
            '（' +
            pct(c.bufferPct) +
            '）。'
        : '强平线未验证。'
    );
  const state = c?.[scenario];
  $('scenario-result').innerHTML =
    state?.reachable === false
      ? info(state.condition ?? 'Hype 先触及强平线。此端点无法沿假设路径到达。')
      : state
        ? '<div class="scenario-grid">' +
          metric('VS 可结算净值', money(state.vsEquity)) +
          metric('Hype 结算现金', money(state.hypeCash)) +
          metric('若分成到账后个人现金', money(state.personalCash)) +
          metric('平仓费前 VS 净值', money(state.vsEquity + (state.vs?.fee ?? 0))) +
          metric('平仓费前 Hype 现金', money(state.hypeCash + (state.hype?.fee ?? 0))) +
          metric('双边平仓手续费', money(state.closeFees)) +
          '</div>' +
          info('条件推演结果。估算分成 ' + money(state.payout) + '；资金到账须另行在虚拟账本确认。')
        : info('此情景尚无可验证的结算结果。');
  document
    .querySelectorAll('[data-scenario]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scenario === scenario)));
}
export function showChecks(c, a) {
  const checks = c?.checks ?? {},
    cost = c?.costs ?? {};
  const entries = [
    ['capital', '个人资金与双边保证金'],
    ['recovery', 'VS 失败时能否收回本金'],
    ['safety', '通过前的强平缓冲'],
    ['runway', '过关后能否续航至首次出金']
  ];
  $('checks').innerHTML =
    entries
      .map(([key, title]) => {
        const raw = checks[key],
          ok = typeof raw === 'boolean' ? raw : raw?.ok;
        const text =
          key === 'runway'
            ? c?.runway?.reason
            : typeof raw === 'object'
              ? (raw.reason ?? raw.message ?? raw.detail)
              : null;
        return (
          '<div class="check"><span class="icon ' +
          (ok ? '' : 'no') +
          '">' +
          (ok ? '✓' : ok === false ? '×' : '·') +
          '</span><div><b>' +
          h(title) +
          '</b><p>' +
          h(text ?? (ok ? '通过' : ok === false ? '未达标' : '无法验证')) +
          '</p></div></div>'
        );
      })
      .join('') +
    defs([
      [
        '上涨 1 ' + a.priceUnit + ' · VS / Hype',
        signed(c?.vs?.delta, 6) + ' / ' + signed(c?.hype?.delta, 6) + ' U'
      ],
      [
        '资金回收差额',
        signed(
          Number.isFinite(c?.failState?.personalCash) ? c.failState.personalCash - c.personalTarget : null
        ) + ' U'
      ],
      ['本次增减成交费 · VS / Hype', money(c?.vs?.tradeFee) + ' / ' + money(c?.hype?.tradeFee)],
      ['点差 / 滑点 / 手续费', money(cost.spread) + ' / ' + money(cost.slippage) + ' / ' + money(cost.fees)],
      [
        '盈亏平衡点差 / 安全入场点差',
        n(cost.breakEvenSpread, 6) + ' / ' + n(cost.safeEntrySpread, 6) + ' ' + a.priceUnit
      ]
    ]);
}
export function showCandidates(result, current) {
  const candidates = (result.candidates ?? []).filter((c) => c.ok && !c.noTrade).slice(0, 6);
  const reject = Array.isArray(result.rejected) ? result.rejected[0] : result.rejected;
  if (reject && !candidates.includes(reject)) candidates.push(reject);
  if (!candidates.length && current) candidates.push(current);
  if (!candidates.some((c) => c.noTrade)) candidates.push({ noTrade: true });
  $('candidates-note').textContent = '按当前搜索范围与风控排序';
  const rows = candidates
    .map((c, i) => {
      if (c.noTrade) return row(['空仓等待', '0 U', '0 U', '—', '保留现金，不产生新交易费', '—']);
      return (
        '<tr><td>' +
        h(planSide(c)) +
        '</td><td>' +
        money(c.vs?.notional) +
        '</td><td>' +
        money(c.hype?.notional) +
        '</td><td>' +
        money(c.worstCash) +
        '</td><td>' +
        h(
          c.ok ? labelStatus(c) + ' · ' + (c.runway?.ok ? '可续航' : '仅本阶段') : reason(c) || labelStatus(c)
        ) +
        '</td><td><button data-choice="' +
        i +
        '">查看</button></td></tr>'
      );
    })
    .join('');
  $('candidates').innerHTML = table(
    ['方向', 'VS 总仓位', 'Hype 总仓位', '最差现金', '判定依据', '情景'],
    rows
  );
  return candidates;
}
export function showComparison(current, pinned, a) {
  if (!pinned) {
    $('comparison').innerHTML = info('点「固定此方案对比」，再调整仓位，即可比较两组结果。');
    return;
  }
  const arr = [
    ['固定方案', pinned],
    ['当前方案', current]
  ];
  $('comparison').innerHTML =
    table(
      ['方案', 'VS 名义额', 'Hype 名义额', '失败结算现金', '达标结算现金', '强平缓冲', '结论'],
      arr
        .map(([name, c]) =>
          row([
            name,
            money(c?.vs?.notional),
            money(c?.hype?.notional),
            money(c?.failState?.personalCash),
            c?.passState?.reachable === true
              ? money(c.passState.personalCash)
              : c?.passState?.reachable === false
                ? '达标前先强平'
                : '无法验证',
            n(c?.buffer, 5) + ' ' + a.priceUnit,
            labelStatus(c)
          ])
        )
        .join('')
    ) +
    info(
      '相对固定方案，VS 仓位变动 ' +
        signed(current?.vs?.notional - pinned?.vs?.notional) +
        ' U，Hype 仓位变动 ' +
        signed(current?.hype?.notional - pinned?.hype?.notional) +
        ' U。' +
        (reason(current) || '当前候选通过已验算条件。')
    );
}
