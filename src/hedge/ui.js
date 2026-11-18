import { D, dec, out, positive, nonnegative, ratio, normalizeExposure, solveBudgetBounds } from './math.js';
import { createBook, applyLedgerEvent, advanceClock, balances, markEquity, iso } from './book.js';
import { solve, profileInputs, projectSettlementEquity } from './solver.js';
import {
  atPrice,
  applyTargets,
  settlePositions,
  settleBoundary,
  replayFixture,
  seekReplay,
  scenarioNames,
  parseReplayCSV
} from './replay.js';
import {
  collectHype,
  manualVs,
  versionGate,
  subscribeHype,
  freshness,
  reconcileAnchor,
  accountMode,
  poolKey
} from './adapters.js';
import { KEY, read, restore, write, eventCSV } from './workspace.js';
const $ = (id) => document.getElementById(id),
  val = (id) => $(id).value,
  when = () => new Date().toISOString();
const show = (id, value) => {
  const el = $(id);
  if (el.textContent !== String(value)) el.textContent = value;
};
const fmt = (v, n = 2) => (v == null ? '待核实' : dec(v).toFixed(n));
const pct = (v) => (v == null ? '待核实' : fmt(out(dec(v).times(100)), 4) + '%');
const u = (v) => (v == null ? '待核实' : fmt(v) + ' U');
const time = (t) => new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const escape = (x) =>
  String(x ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const metrics = (items) =>
  '<div class="metrics">' +
  items
    .map(
      ([k, v]) =>
        '<div class="metric"><small>' + escape(k) + '</small><strong>' + escape(v) + '</strong></div>'
    )
    .join('') +
  '</div>';
const table = (headers, rows) =>
  '<div class="scroll"><table><thead><tr>' +
  headers.map((x) => '<th>' + escape(x) + '</th>').join('') +
  '</tr></thead><tbody>' +
  rows.map((row) => '<tr>' + row.map((x) => '<td>' + escape(x) + '</td>').join('') + '</tr>').join('') +
  '</tbody></table></div>';
const labels = {
  FEASIBLE: '当前搜索内有候选',
  CASH_BEFORE_PAYOUT: '到账前现金不足',
  PROFIT_TARGET_UNATTAINABLE: '本轮增益不足',
  NO_MATCH_IN_SEARCH: '当前搜索范围内未找到',
  NO_DISCRETE_MATCH: '合法数量网格无解',
  HOLD: '空仓等待',
  MARGIN_UNVERIFIED: '保证金未验证',
  UNVERIFIED: '未验证',
  CHALLENGE_ACTIVE: '考核进行中',
  FUNDED_ACTIVE: 'Funded 进行中',
  CHALLENGE_TIMEOUT_EXIT: '考核到期退出',
  CHALLENGE_PASS_PENDING_SETTLEMENT: '通过待结算',
  CHALLENGE_FAILED: '考核失败',
  FUNDED_FAILED: 'Funded 失败',
  PAYOUT_PENDING: '分成处理中',
  HYPE_LIQUIDATION: 'Hype 清算中断',
  TIMED_OUT_CLOSED: '到期已模拟平仓',
  PENDING_EXIT_QUOTE: '到期等待有效退出报价',
  AMBIGUOUS_EVENT_ORDER: '触线顺序不确定',
  MARK: '本根未触线',
  START: '回放起点',
  PAYOUT_RECEIVED: '回放分成已到账',
  STALE_QUOTE: '单边报价过期',
  EXIT_REQUIRED: '到期需处理',
  NO_PAYOUT_TARGET: '参考点无可分毛利润',
  REFERENCE_REACHED: '已达提款参考点'
};
const label = (k) => labels[k] ?? k;
let w = read(),
  branch = 'demo',
  solution,
  preview,
  market,
  stageId = 'unit',
  pendingVS = null,
  liveData = null,
  streamStop = null,
  connection = '未连接',
  replay = null,
  index = 0,
  player = null,
  lastReplay = null;
const requestVersion = versionGate();
const mode = () => val('mode');
const book = () => w.branches[branch];
const id = () => crypto.randomUUID();
const options = (o, items) => {
  const selected = o.value;
  o.replaceChildren(...items.map(([k, v]) => new Option(v, k)));
  if (items.some(([k]) => k === selected)) o.value = selected;
};
function handle(fn) {
  return async () => {
    try {
      show('errors', '');
      await fn();
    } catch (e) {
      show('errors', e.message);
    }
  };
}
async function mutate(fn) {
  try {
    w = await write(w.revision, (x) => {
      fn(x);
      return x;
    });
  } catch (e) {
    w = read();
    throw e;
  } finally {
    hydrate();
    render();
  }
}
const ev = (s, type, payload = {}, at = when()) => ({
  id: id(),
  type,
  payload,
  occurredAt: at,
  receivedAt: at,
  source: s.mode
});
function ensureLocal() {
  if (!['manual', 'demo'].includes(mode())) throw Error('此模式仅供观察');
}
async function ledger(fn) {
  ensureLocal();
  await mutate((x) => {
    const s = x.branches[branch];
    x.branches[branch] = fn(s);
  });
}
const viewKey = KEY + ':view',
  viewFields = [
    'reserve',
    'gain',
    'friction',
    'target',
    'targets',
    'sizing',
    'pf-size',
    'hl-size',
    'sizes',
    'sort',
    'model',
    'direction',
    'jump-bps',
    'basis-bps',
    'delay-bps',
    'funding-debit',
    'quote-age',
    'account-age'
  ];
function captureView() {
  return {
    branch,
    asset: stageId,
    mode: mode(),
    stress: $('stress-enable').checked,
    values: Object.fromEntries(viewFields.map((k) => [k, val(k)]))
  };
}
function restoreView(v) {
  if (!v || typeof v !== 'object') return;
  for (const k of viewFields) if (typeof v.values?.[k] === 'string') $(k).value = v.values[k];
  $('stress-enable').checked = v.stress === true;
  if (w.markets[v.asset]) stageId = v.asset;
  if (['demo', 'manual', 'demo_funded'].includes(v.branch) && w.branches[v.branch]) branch = v.branch;
  if (['demo', 'manual', 'replay', 'live_readonly'].includes(v.mode)) $('mode').value = v.mode;
  hydrate();
}
function rememberView() {
  localStorage.setItem(viewKey, JSON.stringify(captureView()));
}
function hydrate() {
  options(
    $('asset'),
    Object.keys(w.markets).map((k) => [k, w.markets[k].name])
  );
  if (!w.markets[stageId]) stageId = 'unit';
  $('asset').value = stageId;
  market = w.markets[stageId];
  const s = book();
  $('equity').value = markEquity(s, 'pf', { [stageId]: market.pf.mark });
  $('hl').value = markEquity(s, 'hl', { [stageId]: market.hl.mark });
  $('external').value = s.external;
  $('stage').value = s.stage;
  $('profile').value = JSON.stringify(w.profile, null, 2);
  $('spec').value = JSON.stringify(market, null, 2);
  $('pass-trigger').value = w.profile.passTrigger;
  $('failure-trigger').value = w.profile.failureTrigger;
}
function parameters() {
  const list = (k) =>
    val(k)
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((v) => out(positive(v)));
  return {
    target: out(positive(val('target'))),
    R: out(nonnegative(val('reserve'))),
    g: out(nonnegative(val('gain'))),
    k: out(nonnegative(val('friction'))),
    pfSize: out(nonnegative(val('pf-size'))),
    hlSize: out(nonnegative(val('hl-size'))),
    mode: val('sizing'),
    sizes: list('sizes'),
    targets: list('targets'),
    sort: val('sort'),
    directions: val('direction') === 'both' ? [1, -1] : [Number(val('direction'))]
  };
}
function stressSettings() {
  return $('stress-enable').checked
    ? Object.fromEntries(
        [
          ['jumpBps', 'jump-bps'],
          ['basisBps', 'basis-bps'],
          ['delayBps', 'delay-bps'],
          ['fundingDebit', 'funding-debit']
        ].map(([k, id]) => [k, out(nonnegative(val(id)))])
      )
    : undefined;
}
function displayBudget(t, live = false) {
  resetOutput(
    label(t.code),
    t.min != null
      ? '失败回本下限 ' +
          pct(t.min) +
          ' · 到账前留存上限 ' +
          pct(t.cashMax) +
          (t.profitMax == null ? '' : ' · 本轮增益上限 ' + pct(t.profitMax))
      : '当前处于规则边界'
  );
  show('bounds', t.min == null ? '已达边界' : t.selected ? pct(t.min) + ' – ' + pct(t.max) : '无交集');
  show('actual', t.selected ? '预算 ' + pct(t.selected.h) : '无合格比例');
  show('legs', live ? '真实合约与保证金未验证。' : '连续预算未取整；切换逐笔成交模型可核对合法仓位。');
  const c = t.selected ?? t.atMinimum;
  if (c)
    $('outcomes').innerHTML = metrics([
      ['下限失败端现金', u(c.fail)],
      ['下限成功到账前', u(c.before)],
      ...(t.selected
        ? [
            ['假设分成到账', u(c.after)],
            ['相对本轮基准', u(c.gain)]
          ]
        : [
            ['约束缺口（比例）', pct(out(dec(t.min).minus(t.max)))],
            ['方案状态', '无可行比例']
          ])
    ]);
  if (!t.selected && c) show('risk', '下限比例的压力结果；该比例未通过全部约束。');
}
function projection() {
  const s = structuredClone(book());
  for (const [v, field] of [
    ['pf', 'equity'],
    ['hl', 'hl']
  ])
    s[v] = out(dec(s[v]).plus(dec(val(field)).minus(markEquity(s, v, { [stageId]: market[v].mark }))));
  s.external = out(nonnegative(val('external')));
  if (val('stage') !== s.stage) {
    s.stage = val('stage');
    if (['CHALLENGE_ACTIVE', 'FUNDED_ACTIVE'].includes(s.status))
      s.status = s.stage === 'challenge' ? 'CHALLENGE_ACTIVE' : 'FUNDED_ACTIVE';
  }
  return s;
}
function drawBook() {
  const s = book(),
    b = balances(s);
  const pending = s.payouts[s.pendingPayout],
    transfer = s.transfers[pending?.transferId];
  $('demo-stage').hidden = mode() !== 'demo';
  $('claim').disabled = s.status !== 'FUNDED_ACTIVE';
  $('receive').disabled = !pending || !!pending.destination;
  $('transfer-out').disabled = pending?.destination !== 'external' || !!pending.transferId;
  $('transfer-in').disabled = transfer?.status !== 'in_transit';
  $('new-round').disabled =
    s.status !== 'PAYOUT_PENDING' || !(pending?.destination === 'hl' || transfer?.status === 'received');
  $('close').disabled = !Object.keys(s.positions).length;
  const pfQty = Object.values(s.positions).find((p) => p.venue === 'pf' && p.asset === stageId)?.qty ?? '0';
  let net = null;
  try {
    net = out(projectSettlementEquity(s, market, 'pf', pfQty, '0', 'net_settlement', w.markets));
  } catch {
    /* Show unknown when the portfolio has no complete exit depth. */
  }
  show('book-state', label(s.status) + (s.exitStatus ? ' · ' + s.exitStatus : ''));
  $('accounts').innerHTML = metrics([
    ['PF 标记净值', u(markEquity(s, 'pf'))],
    ['按盘口平仓 PF 净权益', u(net)],
    ['Hype 权益', u(b.hl)],
    ['外部到账', u(s.external)],
    ['在途资金', u(b.inTransit)],
    ['分成应收', u(b.receivable)],
    ['本轮冻结 C_ref', u(s.ref)],
    ['个人总权益', u(b.total)],
    ['本轮净增益', u(b.gain)],
    ['累计报名费', u(s.fees.registration)],
    ['成交费 PF / Hype', u(s.fees.pf) + ' / ' + u(s.fees.hl)],
    ['Hype 资金费净额', u(s.funding.hl)],
    ['累计到账分成', u(s.paid)]
  ]);
  show(
    'clock',
    (s.stage === 'challenge'
      ? '考核截止 ' + time(s.challengeDeadlineAt) + '（上海时间）'
      : 'Funded 无强制盈利目标') +
      ' · 基准事件 ' +
      s.refEvent
  );
  $('history').innerHTML = table(
    ['上海时间', '事件', '标的 / 平台', '成交数量', '成交价', '成交费', 'PF 余额', 'Hype 现金', '外部账户'],
    s.events
      .slice(-25)
      .reverse()
      .map((e) => [
        time(e.occurredAt),
        e.type,
        [e.payload.asset, e.payload.venue].filter(Boolean).join(' / '),
        e.payload.qty ?? '',
        e.payload.price ?? '',
        e.payload.fee != null ? u(e.payload.fee) : '',
        u(e.pfBalance),
        u(e.hlBalance),
        u(e.external)
      ])
  );
  $('curves').innerHTML = ['pfEquity', 'personalEquity']
    .map((key, i) => {
      const vals = s.events.filter((e) => e[key] != null).map((e) => Number(e[key]));
      if (!vals.length) return '<p>历史事件缺少权益快照。</p>';
      const lo = Math.min(...vals),
        hi = Math.max(...vals);
      return (
        '<p>' +
        ['PF 标记净值', '个人总权益'][i] +
        '（U） · ' +
        escape(fmt(String(lo))) +
        ' 至 ' +
        escape(fmt(String(hi))) +
        '</p><svg viewBox="0 0 540 45" width="540" height="45" role="img" aria-label="' +
        key +
        '"><polyline fill="none" stroke="' +
        ['#2e7082', '#ab662b'][i] +
        '" stroke-width="2" points="' +
        vals
          .map(
            (v, k) =>
              2 + (k * 536) / Math.max(1, vals.length - 1) + ',' + (42 - (38 * (v - lo)) / (hi - lo || 1))
          )
          .join(' ') +
        '"/></svg>'
      );
    })
    .join('');
}
function resetOutput(status, msg) {
  solution = null;
  show('calc-status', status);
  show('bounds', '待核实');
  show('actual', '待核实');
  show('limits', msg);
  for (const k of ['legs', 'outcomes', 'deadline-result', 'risk', 'comparison', 'rejections', 'stress'])
    show(k, '');
  options($('compare'), []);
  $('simulate').disabled = true;
}
function compare() {
  const a = solution?.selected,
    b = solution?.candidates[Number(val('compare'))];
  if (!a || !b) return show('comparison', '当前没有两组可比方案。');
  $('comparison').innerHTML = table(
    ['同一快照', 'PF 名义额', 'Hype 名义额', '失败现金', '到账前现金', '初始保证金 PF / Hype'],
    [a, b].map((r, i) => [
      i ? '对比' : '当前',
      u(r.vsNotional),
      u(r.hlNotional),
      u(r.failureCash),
      u(r.cashBeforePayout),
      r.initialMargin.map((v) => u(v)).join(' / ')
    ])
  );
  const delta = document.createElement('p');
  delta.textContent =
    '选用对比方案时，Hype 目标名义额变化 ' +
    u(out(dec(b.hlNotional).minus(a.hlNotional))) +
    '，失败端现金变化 ' +
    u(out(dec(b.failureCash).minus(a.failureCash))) +
    '，成功到账前现金变化 ' +
    u(out(dec(b.cashBeforePayout).minus(a.cashBeforePayout))) +
    '。';
  $('comparison').append(delta);
}
function render() {
  const live = mode() === 'live_readonly',
    rp = mode() === 'replay';
  $('ledger').hidden = live || rp;
  $('replay').hidden = live;
  for (const k of ['equity', 'hl', 'external', 'stage']) $(k).disabled = live || rp;
  if (live) {
    resetOutput('实时条件未验证', '仅采纳已确认来源。真实 PF 规则、币种折算和候选仓位保证金待核对。');
    $('equity').value = '';
    $('hl').value = '';
    $('external').value = '';
    show('context', '实时只读 · ' + connection + ' · 已读账户和模拟账本分别保存');
    drawLive();
    return;
  }
  if (rp) {
    resetOutput('回放模式', '使用下方播放、单步或进度条核对实际路径。');
    show('context', '独立回放副本');
    return;
  }
  try {
    drawBook();
    preview = projection();
    const p = parameters(),
      b = balances(preview);
    show(
      'context',
      w.profile.id +
        ' v' +
        w.profile.profileVersion +
        ' · ' +
        (mode() === 'demo' ? '离线模拟' : '手动试算') +
        ' · ' +
        (preview.stage === 'challenge'
          ? '考核截止 ' + time(preview.challengeDeadlineAt)
          : 'Funded · 提款参考点 ' + u(p.target)) +
        ' · 本轮冻结基准 ' +
        u(preview.ref)
    );
    if (val('model') === 'budget') {
      if (
        !['CHALLENGE_ACTIVE', 'FUNDED_ACTIVE'].includes(preview.status) ||
        (preview.stage === 'challenge' && Date.now() >= Date.parse(preview.challengeDeadlineAt))
      ) {
        resetOutput('本轮已终止', '请在账本核对事件');
        return;
      }
      displayBudget(solveBudgetBounds(profileInputs(preview, p, market)));
      return;
    }
    solution = solve(preview, market, p, {
      catalog: w.markets,
      now: when(),
      stress: stressSettings(),
      passTrigger: val('pass-trigger'),
      failureTrigger: val('failure-trigger')
    });
    const r = solution,
      t = r.theory,
      c = r.selected;
    show(
      'context',
      w.profile.id +
        ' v' +
        w.profile.profileVersion +
        ' · ' +
        (mode() === 'demo' ? '离线演示' : '手动试算') +
        ' · ' +
        (preview.stage === 'challenge'
          ? '截止 ' + time(preview.challengeDeadlineAt)
          : 'Funded 无强制盈利目标')
    );
    show('calc-status', label(r.code));
    show('bounds', t.min != null ? (t.selected ? pct(t.min) + ' – ' + pct(t.max) : '无交集') : '已达边界');
    show('actual', c ? pct(c.actualRatio) : r.code === 'HOLD' ? '空仓' : '无合格仓位');
    show(
      'limits',
      t.min != null
        ? '失败回本要求至少 ' +
            pct(t.min) +
            '；到账前留存允许至 ' +
            pct(t.cashMax) +
            (t.profitMax != null ? '，本轮增益允许至 ' + pct(t.profitMax) : '') +
            '。预算模型含 k；仓位用实际成交与费用另算。'
        : '当前状态停止新增比例计算。'
    );
    const actualBook = book();
    $('simulate').disabled =
      !c ||
      val('pass-trigger') !== actualBook.passTrigger ||
      val('failure-trigger') !== actualBook.failureTrigger ||
      preview.stage !== actualBook.stage ||
      preview.pf !== actualBook.pf ||
      preview.hl !== actualBook.hl ||
      preview.external !== actualBook.external;
    if (c) {
      $('legs').innerHTML = table(
        ['平台', '现有数量', '目标数量', '本次差额', '目标名义额'],
        [
          [
            'PF',
            c.vsCurrentQuantity,
            c.vsTargetQuantity,
            c.vsDeltaQuantity + ' ' + market.pf.unit,
            u(c.vsNotional)
          ],
          [
            'Hype',
            c.hlCurrentQuantity,
            c.hlTargetQuantity,
            c.hlDeltaQuantity + ' ' + market.hl.unit,
            u(c.hlNotional)
          ]
        ]
      );
      $('outcomes').innerHTML = metrics([
        ['失败可回收', u(c.failureCash)],
        ['成功到账前', u(c.cashBeforePayout)],
        ...(preview.stage === 'funded' ? [['若分成到账', u(c.cashAfterPayout)]] : [['考核可分成', '0.00 U']]),
        ['成功端本轮条件净盈亏', u(c.roundGain)],
        ['失败端相对保护本金', u(out(dec(c.failureCash).minus(preview.B)))],
        [
          preview.stage === 'funded' ? '分成到账后相对保护本金' : '通过后相对保护本金',
          u(out(dec(c.cashAfterPayout).minus(preview.B)))
        ]
      ]);
      show(
        'deadline-result',
        preview.stage === 'challenge'
          ? '若未触线且原价到期，预计退出 ' +
              u(
                out(
                  projectSettlementEquity(
                    preview,
                    market,
                    'hl',
                    c.hlTargetQuantity,
                    '0',
                    'net_settlement',
                    w.markets
                  )
                    .plus(preview.external)
                    .plus(b.inTransit)
                )
              ) +
              '；实际结果以退出报价结算。'
          : '比较的提款参考点 ' + r.targets.join('、') + ' U；当前候选分成 ' + u(c.expectedUserPayout) + '。'
      );
    } else {
      show('legs', '保持现仓或空仓。');
      show('outcomes', '当前没有可执行的条件收益。');
      show('deadline-result', preview.exitCash ? '已结算退出现金 ' + u(preview.exitCash) : '');
    }
    show(
      'risk',
      '规则来源：用户情景 · 保证金：' +
        (c ? '离线 Standard 资金池模拟' : '未通过或未验证') +
        ' · ' +
        (r.searchComplete ? '已枚举指定集合' : '有限搜索') +
        ' · 期限、跳空与成交压力见回放。'
    );
    options(
      $('compare'),
      r.candidates
        .slice(0, 50)
        .map((x, i) => [
          String(i),
          pct(x.actualRatio) + ' · PF ' + u(x.vsNotional) + ' · 目标 ' + u(x.targetEquity)
        ])
    );
    if (r.candidates.length > 1 && val('compare') === '0') $('compare').value = '1';
    compare();
    const reject = r.rejected.find((x) => x.constraints?.some((k) => k.status === 'fail')) ?? r.rejected[0];
    if (!c && reject?.constraints) {
      const constraints = reject.constraints.filter((q) => q.status !== 'pass');
      const blocksSettlement = constraints.some(
        (x) => x.code.includes('MARGIN') || x.code.includes('MAINTENANCE')
      );
      $('outcomes').innerHTML = metrics([
        ['淘汰样例 · 失败端试算', u(reject.failureCash)],
        ['成功端', blocksSettlement ? '路径风险阻断' : u(reject.cashBeforePayout)],
        ['最先未满足', constraints[0]?.code ?? reject.code],
        [
          '相应缺口',
          constraints[0]?.shortfall == null ? '待核实' : constraints[0].shortfall + ' ' + constraints[0].unit
        ]
      ]);
    }
    show(
      'rejections',
      reject
        ? '淘汰示例 ' +
            [
              reject.code,
              ...(reject.constraints ?? [])
                .filter((q) => q.status !== 'pass')
                .map(
                  (q) =>
                    q.code +
                    ' 实际 ' +
                    fmt(q.actual) +
                    ' / 要求 ' +
                    fmt(q.required) +
                    ' / 缺口 ' +
                    fmt(q.shortfall) +
                    ' ' +
                    q.unit +
                    '（' +
                    q.source +
                    '）'
                )
            ].join(' · ')
        : r.unresolved.join(' · ')
    );
    show(
      'stress',
      c
        ? 'PF 失败 / 达标价格 ' +
            fmt(out(dec(market.pf.mark).plus(dec(c.lines.fail).times(market.pf.factor)))) +
            ' / ' +
            fmt(out(dec(market.pf.mark).plus(dec(c.lines.pass).times(market.pf.factor)))) +
            '（' +
            (market.id === 'us100' ? '指数点' : market.pf.currency + '/' + market.unit) +
            '）。每单位波动 PF / Hype 敏感度 ' +
            fmt(normalizeExposure(c.vsTargetQuantity, market.pf), 6) +
            ' / ' +
            fmt(normalizeExposure(c.hlTargetQuantity, market.hl), 6) +
            ' U。Hype 路径维持保证金最小余量 ' +
            u(c.buffer) +
            '。Hype 模拟清算标记价 ' +
            (c.liqMark ? fmt(c.liqMark) : '无已验证的正价触发点') +
            '。' +
            c.stress
              .map((x) => x.name + ' ' + u(x.actual) + ' ' + (x.status === 'pass' ? '满足' : '未通过'))
              .join(' · ')
        : ''
    );
  } catch (e) {
    resetOutput('输入待核实', e.message);
  }
}
async function switchMode() {
  if (streamStop) {
    streamStop();
    streamStop = null;
  }
  requestVersion.next();
  if (player) clearInterval(player);
  if (mode() === 'manual' && !w.branches.manual)
    await mutate((x) => {
      x.branches.manual = createBook({ ...x.profile, id: id(), time: when(), mode: 'manual' });
    });
  if (['manual', 'demo'].includes(mode())) branch = mode();
  hydrate();
  render();
  rememberView();
  if (mode() === 'replay') {
    loadPath();
    $('replay').scrollIntoView();
  }
  if (mode() === 'live_readonly') $('feeds').scrollIntoView();
}
function loadPath() {
  clearInterval(player);
  replay = replayFixture(val('scenario'), stageId, w.markets[stageId]);
  index = 0;
  showReplay();
}
function showReplay() {
  const r = (lastReplay = seekReplay(replay, index));
  $('seek').max = String(replay.bars.length + (replay.kind === 'payout' ? 1 : 0));
  $('seek').value = index;
  show(
    'replay-result',
    (replay.kind === 'csv' ? 'CSV 导入 · ' : '') +
      index +
      ' / ' +
      $('seek').max +
      ' · ' +
      label(r.event) +
      (r.event === 'AMBIGUOUS_EVENT_ORDER'
        ? ' · 分支 ' +
          r.alternatives.map((a) => label(a.event) + ' ' + u(a.cash)).join(' / ') +
          ' · 最坏 ' +
          u(r.worst)
        : '') +
      '\nPF 标记权益 ' +
      u(markEquity(r.state, 'pf')) +
      ' · Hype 权益 ' +
      u(markEquity(r.state, 'hl')) +
      ' · 已到账 ' +
      u(r.state.paid) +
      (r.cash == null ? '' : ' · 个人现金 ' + u(r.cash)) +
      ' · 流水 ' +
      r.state.events.length +
      ' 笔'
  );
}
function step() {
  if (!replay) loadPath();
  if (index < Number($('seek').max)) {
    index++;
    showReplay();
  }
  if (index >= Number($('seek').max) || (lastReplay.stop && replay.kind !== 'payout')) clearInterval(player);
}
function download(name, data, type) {
  const a = document.createElement('a'),
    url = URL.createObjectURL(new Blob([data], { type }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
const liveKey = () => [val('wallet').trim().toLowerCase(), val('symbol').trim()].join('/');
function liveContext() {
  const c = w.liveContexts?.[liveKey()];
  if (!c) return null;
  const ref = w.liveRounds?.[JSON.stringify([val('wallet').trim().toLowerCase(), c.vsAccountId])];
  return ref && ref.referenceEvent !== c.referenceEvent ? null : c;
}
$('confirm-live').onclick = handle(async () => {
  const key = liveKey(),
    user = val('wallet').trim(),
    symbol = val('symbol').trim();
  if (!/^0x[0-9a-f]{40}$/i.test(user) || !symbol) throw Error('先指定实际公开地址和完整合约代码');
  const c = JSON.parse(val('live-context'));
  if (
    !['challenge', 'funded'].includes(c.stage) ||
    typeof c.referenceEvent !== 'string' ||
    !c.referenceEvent.trim() ||
    !c.token ||
    !c.vsCurrency ||
    !c.vsSymbol ||
    c.hlSymbol !== symbol ||
    !c.vsAccountId
  )
    throw Error('需填写确认的两边合约代码、VS 账户标识、币种与本轮事件');
  for (const k of ['ref', 'external', 'inTransit']) c[k] = out(nonnegative(c[k]));
  for (const k of ['hlFx', 'vsFx']) c[k] = out(positive(c[k]));
  for (const k of ['fxAsOf', 'fxUntil']) iso(c[k]);
  if (Date.parse(c.fxUntil) < Date.parse(c.fxAsOf)) throw Error('汇率有效期无效');
  if (c.stage === 'challenge') iso(c.challengeDeadlineAt);
  await mutate((x) => {
    x.liveContexts ??= {};
    const accountKey = JSON.stringify([user.toLowerCase(), c.vsAccountId]);
    x.liveRounds ??= {};
    const old = x.liveRounds[accountKey] ?? x.liveContexts[key];
    if (old?.referenceEvent === c.referenceEvent && (old.ref !== c.ref || old.vsAccountId !== c.vsAccountId))
      throw Error('本轮参考基准已冻结');
    if (old && old.referenceEvent !== c.referenceEvent && !c.newRoundEvidence)
      throw Error('建立新基准需要 newRoundEvidence 事件依据');
    if (
      old?.referenceEvent === c.referenceEvent &&
      (old.stage !== c.stage || old.challengeDeadlineAt !== c.challengeDeadlineAt)
    )
      throw Error('阶段或考核截止变更需登记新的依据事件');
    x.liveRounds[accountKey] = {
      referenceEvent: c.referenceEvent,
      stage: c.stage,
      ref: c.ref,
      vsAccountId: c.vsAccountId,
      challengeDeadlineAt: c.challengeDeadlineAt
    };
    x.liveContexts[key] = { ...c, confirmedAt: when() };
  });
  drawLive();
});
function liveBudget(issues) {
  if (mode() !== 'live_readonly') return;
  const c = liveContext(),
    data = liveData,
    vs = w.vsSnapshot;
  $('equity').value = '';
  $('hl').value = '';
  $('external').value = '';
  if (c?.stage === 'challenge' && Date.now() >= Date.parse(c.challengeDeadlineAt)) {
    resetOutput('考核到期需核对实际退出', '请核对平台实际成交与结算记录。');
    return;
  }
  if (
    !c ||
    !vs ||
    !data?.account ||
    issues.length ||
    data.quote?.symbol !== val('symbol').trim() ||
    data.user !== val('wallet').trim().toLowerCase() ||
    accountMode(data.mode) !== 'standard' ||
    c.vsCurrency !== vs.currency ||
    Date.now() > Date.parse(c.fxUntil) ||
    Date.now() < Date.parse(c.fxAsOf) ||
    vs.accountId !== c.vsAccountId ||
    vs.symbol !== c.vsSymbol ||
    !vs.fields.equity ||
    !vs.fields.mark
  ) {
    resetOutput('实时条件未验证', '需新鲜的双边报价、账户与汇率，完整标的映射和已确认的本轮基准。');
    return;
  }
  const p = parameters(),
    rules = w.profile;
  const currencyEquity = out(dec(data.account.equity).times(c.hlFx)),
    equity = out(dec(vs.fields.equity).times(c.vsFx));
  const t = solveBudgetBounds({
    stage: c.stage,
    E: equity,
    C_hl: currencyEquity,
    C_external: c.external,
    inTransit: c.inTransit,
    C_ref: c.ref,
    B: rules.B,
    floor: c.stage === 'challenge' ? rules.challengeFloor : rules.fundedFloor,
    target: c.stage === 'challenge' ? rules.challengeTarget : p.target,
    baseline: rules.baseline,
    share: rules.share,
    R: p.R,
    g: p.g,
    k: p.k
  });
  displayBudget(t, true);
  show('calc-status', '条件预算 · ' + label(t.code) + ' · 实仓未验证');
  $('equity').value = equity;
  $('hl').value = currencyEquity;
  $('external').value = c.external;
  $('stage').value = c.stage;
}
function drawLive() {
  const f = freshness({
    vs: w.vsSnapshot,
    hl: liveData?.quote,
    account: liveData?.account,
    connected: connection !== 'API_DISCONNECTED',
    quoteMs: Number(val('quote-age')) * 1000,
    accountMs: Number(val('account-age')) * 1000
  });
  if (![Number(val('quote-age')), Number(val('account-age'))].every((v) => Number.isFinite(v) && v > 0))
    f.push('INVALID_FRESHNESS_THRESHOLD');
  if (
    !w.vsSnapshot?.accountAt ||
    Date.now() - Date.parse(w.vsSnapshot.accountAt) > Number(val('account-age')) * 1000 ||
    Date.now() < Date.parse(w.vsSnapshot.accountAt)
  )
    f.push('VS_ACCOUNT_STALE');
  const c = liveContext(),
    a = liveData?.account;
  let coverage = null;
  if (a && c && accountMode(liveData.mode) === 'standard') {
    const pool = poolKey(liveData.user, liveData.dex, c.token),
      balance = out(a.positions.reduce((v, p) => v.minus(p.pnl), dec(a.equity)));
    coverage = reconcileAnchor(
      { balance, ref: c.ref, pool, currency: c.token },
      (liveData.flows ?? []).map((e) => ({ ...e, pool: poolKey(liveData.user, liveData.dex, e.currency) }))
    );
  }
  try {
    liveBudget(f);
  } catch (error) {
    resetOutput('实时输入待核实', error.message);
  }
  show('connection', connection + ' · ' + [...f, ...(liveData?.unresolved ?? [])].join(' / '));
  if (liveData)
    show(
      'api-result',
      JSON.stringify(
        {
          symbol: liveData.symbol,
          mark: liveData.mark,
          book: liveData.quote.levels,
          quoteTime: liveData.quote.occurredAt,
          mode: liveData.mode,
          feesAndFundingCoverage: liveData.coverage,
          accountValue: liveData.account?.equity,
          withdrawable: liveData.account?.withdrawable,
          capacity: liveData.capacity,
          fees: liveData.fees,
          ledgerCoverage: coverage
            ? {
                derivedCash: coverage.balance,
                unresolvedCount: coverage.unresolved.length,
                source: '账户快照；流水覆盖游标须单独对账'
              }
            : null,
          positions: liveData.account?.positions,
          used: liveData.account?.used,
          sourceTime: liveData.account?.occurredAt,
          flowCount: liveData.flows?.length ?? 0,
          latestFlows: (liveData.flows ?? [])
            .slice()
            .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
            .slice(0, 15)
            .map(({ id, asset, type, amount, currency, occurredAt }) => ({
              id,
              asset,
              type,
              amount,
              currency,
              occurredAt
            })),
          snapshotSkewMs: w.vsSnapshot?.occurredAt
            ? Math.abs(Date.parse(w.vsSnapshot.occurredAt) - Date.parse(liveData.quote.occurredAt))
            : null
        },
        null,
        2
      )
    );
}
async function refreshLive() {
  const token = requestVersion.next();
  connection = '查询中';
  drawLive();
  try {
    const data = await collectHype({ symbol: val('symbol').trim(), user: val('wallet').trim() });
    if (!requestVersion.current(token)) return;
    if (liveData?.user === data.user && liveData.symbol === data.symbol) {
      if (liveData.quote.occurredAt > data.quote.occurredAt) data.quote = liveData.quote;
      if (liveData.account?.occurredAt > data.account?.occurredAt) data.account = liveData.account;
      const events = new Map([...(liveData.flows ?? []), ...(data.flows ?? [])].map((e) => [e.id, e]));
      data.flows = [...events.values()];
    }
    liveData = data;
    connection = 'REST 已读取';
  } catch (e) {
    if (!requestVersion.current(token)) return;
    connection = 'API_DISCONNECTED';
    show('errors', e.message);
  }
  drawLive();
  if (mode() === 'live_readonly') render();
}
$('mode').onchange = handle(switchMode);
$('asset').onchange = () => {
  stageId = val('asset');
  hydrate();
  render();
  loadPath();
};
for (const k of [
  'model',
  'stress-enable',
  'jump-bps',
  'basis-bps',
  'delay-bps',
  'funding-debit',
  'stage',
  'equity',
  'hl',
  'external',
  'reserve',
  'target',
  'sizing',
  'pf-size',
  'hl-size',
  'sizes',
  'targets',
  'gain',
  'friction',
  'direction',
  'sort',
  'pass-trigger',
  'failure-trigger'
])
  $(k).oninput = render;
$('compare').onchange = compare;
$('save-profile').onclick = handle(async () => {
  ensureLocal();
  const p = JSON.parse(val('profile'));
  for (const k of ['B', 'baseline', 'challengeTarget', 'challengeFloor', 'fundedFloor', 'hours'])
    positive(p[k]);
  ratio(p.share);
  nonnegative(p.purchaseFee);
  if (
    !dec(p.challengeTarget).gt(p.baseline) ||
    !dec(p.baseline).gt(p.challengeFloor) ||
    !dec(p.baseline).gt(p.fundedFloor)
  )
    throw Error('规则的目标、起点与失败线不相容');
  await mutate((x) => {
    x.profile = {
      ...p,
      profileVersion: x.profile.profileVersion + 1,
      source: 'user_provided',
      verifiedAt: null,
      passTrigger: val('pass-trigger'),
      failureTrigger: val('failure-trigger')
    };
    const s = x.branches[branch];
    for (const k of [
      'B',
      'baseline',
      'challengeTarget',
      'challengeFloor',
      'fundedFloor',
      'share',
      'profileVersion',
      'passTrigger',
      'failureTrigger',
      'additionalRules'
    ])
      s[k] = x.profile[k];
  });
});
$('save-spec').onclick = handle(async () => {
  ensureLocal();
  const m = JSON.parse(val('spec'));
  if (!/^[\w-]{1,60}$/.test(m.id) || ['__proto__', 'constructor', 'prototype'].includes(m.id))
    throw Error('合约 ID 无效');
  for (const v of ['pf', 'hl']) normalizeExposure('1', m[v]);
  stageId = m.id;
  await mutate((x) => {
    x.markets[m.id] = m;
  });
});
$('demo-stage').onclick = handle(async () => {
  if (mode() !== 'demo') throw Error('请切换到离线模拟');
  const stage = val('stage');
  branch = stage === 'challenge' ? 'demo' : 'demo_funded';
  await mutate((x) => {
    if (!x.branches[branch])
      x.branches[branch] = createBook({
        ...x.profile,
        stage,
        id: id(),
        time: when(),
        hl: out(new D(317).div(3))
      });
  });
  if (stage === 'funded') {
    $('reserve').value = '40';
    $('gain').value = '20';
  }
  render();
  rememberView();
});
$('adopt').onclick = handle(() => {
  const p = projection();
  if (p.stage !== book().stage) throw Error('试算阶段与账本不同；过关结算后才迁移正式阶段。');
  return ledger((s) =>
    applyLedgerEvent(
      s,
      ev(s, 'snapshot_edit', { pf: val('equity'), hl: val('hl'), external: val('external') })
    )
  );
});
$('simulate').onclick = handle(() => {
  const c = solution?.selected;
  if (!c || $('simulate').disabled) throw Error('参数与账本尚未一致');
  return ledger((s) =>
    applyTargets(s, market, { pf: c.vsTargetQuantity, hl: c.hlTargetQuantity }, when(), id())
  );
});
$('close').onclick = handle(() => ledger((s) => settlePositions(s, w.markets, when(), id())));
$('settle').onclick = handle(() =>
  ledger((s) => {
    const at = when();
    if (s.stage === 'challenge' && Date.parse(at) >= Date.parse(s.challengeDeadlineAt)) {
      const quotes = {};
      for (const p of Object.values(s.positions)) {
        const l = w.markets[p.asset]?.[p.venue];
        if (l?.bids?.length && l?.asks?.length)
          quotes[p.venue + '/' + p.asset] = {
            asOf: s.mode === 'demo' ? at : l.asOf,
            rate: l.rate,
            bid: l.bids[0][0],
            ask: l.asks[0][0],
            bids: l.bids,
            asks: l.asks
          };
      }
      return advanceClock(s, at, quotes, s.mode);
    }
    const q = Object.values(s.positions).find((p) => p.venue === 'pf' && p.asset === market.id)?.qty ?? '0';
    const failure = projectSettlementEquity(s, market, 'pf', q, '0', val('failure-trigger'), w.markets);
    if (failure.lte(s.stage === 'challenge' ? s.challengeFloor : s.fundedFloor))
      return settleBoundary(s, market, 'failure', at, id(), w.markets).state;
    if (
      s.stage === 'challenge' &&
      projectSettlementEquity(s, market, 'pf', q, '0', val('pass-trigger'), w.markets).gte(s.challengeTarget)
    )
      return settleBoundary(s, market, 'pass', at, id(), w.markets).state;
    throw Error('当前未触及账户规则线');
  })
);
$('claim').onclick = handle(() =>
  ledger((s) => {
    if (s.stage !== 'funded') throw Error('考核不可分配');
    const at = when();
    s = settlePositions(s, w.markets, at, id());
    return applyLedgerEvent(s, ev(s, 'distribution', { payoutId: id() }, at));
  })
);
$('receive').onclick = handle(() =>
  ledger((s) =>
    applyLedgerEvent(s, ev(s, 'receipt', { payoutId: s.pendingPayout, destination: val('destination') }))
  )
);
$('transfer-out').onclick = handle(() =>
  ledger((s) => {
    const pay = s.payouts[s.pendingPayout];
    return applyLedgerEvent(
      s,
      ev(s, 'transfer_out', {
        payoutId: s.pendingPayout,
        transferId: id(),
        amount: pay?.user,
        from: 'external',
        to: 'hl'
      })
    );
  })
);
$('transfer-in').onclick = handle(() =>
  ledger((s) =>
    applyLedgerEvent(s, ev(s, 'transfer_in', { transferId: s.payouts[s.pendingPayout]?.transferId }))
  )
);
$('new-round').onclick = handle(() => ledger((s) => applyLedgerEvent(s, ev(s, 'round_start'))));
$('rebuy').onclick = handle(() =>
  ledger((s) =>
    applyLedgerEvent(
      s,
      ev(s, 'rebuy', {
        attemptId: id(),
        purchaseFee: w.profile.purchaseFee,
        deadline: val('deadline') || new Date(Date.now() + Number(w.profile.hours) * 3600000).toISOString()
      })
    )
  )
);
$('save-json').onclick = () =>
  download('动态对冲备份.json', JSON.stringify({ ...w, view: captureView() }, null, 2), 'application/json');
$('save-csv').onclick = () => download('双账本流水.csv', eventCSV(book()), 'text/csv');
$('restore').onchange = handle(async () => {
  ensureLocal();
  const f = $('restore').files[0];
  if (!f || f.size > 8000000) throw Error('备份大小无效');
  const imported = restore(await f.text());
  if (confirm('替换此只读版的本地模拟工作区？')) {
    await mutate((x) => {
      if (!imported.branches[branch]) branch = 'demo';
      return Object.assign(x, imported);
    });
    restoreView(imported.view);
    rememberView();
    render();
  }
});
options($('scenario'), Object.entries(scenarioNames));
$('load-path').onclick = handle(loadPath);
$('step').onclick = handle(step);
$('pause').onclick = () => clearInterval(player);
$('play').onclick = handle(() => {
  if (!replay) loadPath();
  clearInterval(player);
  player = setInterval(handle(step), 500);
});
$('seek').oninput = handle(() => {
  clearInterval(player);
  if (!replay) loadPath();
  index = Number(val('seek'));
  showReplay();
});
$('csv').onchange = handle(async () => {
  const f = $('csv').files[0];
  if (!f || f.size > 4000000) throw Error('CSV 大小无效');
  const bars = parseReplayCSV(await f.text(), stageId);
  const start = iso(bars[0].startTime || bars[0].time);
  if (Date.parse(start) > Date.parse(bars[0].time)) throw Error('回放开始时间晚于首根 K 线');
  const initialMarket = atPrice(market, out(dec(bars[0].open).minus(market.pf.mark).div(market.pf.factor)));
  const seed = replayFixture(val('scenario'), stageId, initialMarket, start);
  replay = {
    initial: seed.initial,
    market: initialMarket,
    kind: 'csv',
    bars,
    options: { target: val('target'), catalog: w.markets }
  };
  index = 0;
  showReplay();
});
$('parse').onclick = handle(() => {
  pendingVS = null;
  $('confirm-vs').disabled = true;
  pendingVS = manualVs(val('vs-text'), val('currency'), when());
  show('vs-preview', JSON.stringify(pendingVS, null, 2));
  $('confirm-vs').disabled = false;
});
for (const k of ['vs-text', 'currency'])
  $(k).oninput = () => {
    pendingVS = null;
    $('confirm-vs').disabled = true;
  };
$('confirm-vs').onclick = handle(async () => {
  if (!pendingVS) throw Error('先解析');
  await mutate((x) => {
    x.vsSnapshot = { ...pendingVS, verification: 'user_confirmed' };
  });
  pendingVS = null;
  $('confirm-vs').disabled = true;
  show('vs-preview', '快照已确认 · ' + w.vsSnapshot.id);
  drawLive();
});
$('live').onclick = handle(refreshLive);
$('stream').onclick = handle(() => {
  streamStop?.();
  const symbol = val('symbol').trim(),
    user = val('wallet').trim().toLowerCase();
  if (!/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(symbol) || (user && !/^0x[0-9a-f]{40}$/.test(user)))
    throw Error('合约或地址无效');
  streamStop = subscribeHype(
    { symbol, user, dex: symbol.includes(':') ? symbol.split(':')[0] : '' },
    (channel, data) => {
      if (!liveData || liveData.symbol !== symbol || liveData.user !== user) return;
      if (channel === 'l2Book' && data.occurredAt >= liveData.quote.occurredAt) liveData.quote = data;
      else if (channel === 'clearinghouseState') {
        if (!liveData.account?.occurredAt || data.occurredAt >= liveData.account.occurredAt)
          liveData.account = data;
      } else if (Array.isArray(data)) {
        const unique = new Map((liveData.flows ?? []).map((e) => [e.id, e]));
        data
          .filter((e) => (e.asset.includes(':') ? e.asset.split(':')[0] : '') === liveData.dex)
          .forEach((e) => unique.set(e.id, e));
        liveData.flows = [...unique.values()];
      }
      drawLive();
    },
    (msg) => {
      connection = msg;
      drawLive();
    },
    refreshLive
  );
});
$('disconnect').onclick = () => {
  requestVersion.next();
  streamStop?.();
  streamStop = null;
  connection = 'API_DISCONNECTED';
  drawLive();
};
for (const k of ['wallet', 'symbol'])
  $(k).oninput = () => {
    $('disconnect').click();
    liveData = null;
    show('api-result', '');
  };
addEventListener('storage', (e) => {
  if (e.key === KEY) {
    w = read();
    hydrate();
    render();
  }
});
setInterval(() => {
  if (mode() === 'live_readonly') {
    drawLive();
    return;
  }
  const s = book();
  if (
    mode() !== 'replay' &&
    s.status === 'CHALLENGE_ACTIVE' &&
    Date.now() >= Date.parse(s.challengeDeadlineAt)
  ) {
    if (s.mode === 'demo' && Date.now() - Date.parse(s.challengeDeadlineAt) < 1500) $('settle').click();
    else handle(() => ledger((s) => advanceClock(s, when(), {}, s.mode)))();
  }
}, 1000);
document.addEventListener('input', (e) => {
  if (viewFields.includes(e.target.id) || e.target.id === 'stress-enable') rememberView();
});
$('asset').addEventListener('change', rememberView);
hydrate();
try {
  restoreView(JSON.parse(localStorage.getItem(viewKey)));
} catch {
  /* Stored view preferences have no effect on the ledger. */
}
render();
loadPath();
drawLive();
