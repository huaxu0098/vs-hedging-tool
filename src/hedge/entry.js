import { dec, out, nonnegative, positive } from './math.js';
import {
  rules,
  splitReserves,
  calculateCurrent,
  fresh,
  quoteClock,
  fieldTime,
  stressFields,
  reason as constraintReason
} from './current.js';
import { renderScan, setupScan } from './ratio-ui.js';
import { ledgerLabels, presentLedger } from './settlement-ledger.js';
import { captureScript } from '../vs-parser.js';
import { manualVs } from './adapters.js';
import { accountSnapshot, manualAccount, presetAccount } from './current-account.js';

const $ = (id) => document.getElementById(id);
const key = 'vs-hype:current-snapshots:v1';
const now = () => new Date().toISOString();
let saved;
try {
  saved = JSON.parse(localStorage.getItem(key));
} catch {
  /* Keep the original until a user edit. */
}
const state = saved?.version === 1 ? saved : { version: 1, asset: 'BTC', rules: {}, assets: {}, shared: {} };
if (state.autoVersion !== 12) {
  state.rules = { ...state.rules, mode: 'auto' };
  state.autoVersion = 12;
}
// v1.2 persisted UI defaults even when the user never entered a pressure value.
if (state.stressVersion !== 1) {
  for (const k of Object.keys(stressFields)) if (state.rules[k] === '0') delete state.rules[k];
  state.stressVersion = 1;
}
const planDefaults = { planCrossFlat: true, planCapital: '500', planPF: '10000', planFundedCash: '101.50' };
const planning = () => state.fundingView === 'plan';
state.fundingView ??= 'plan';
state.rules = { ...rules, ...splitReserves(state.rules) };
state.planRules = { ...rules, ...planDefaults, ...splitReserves(state.planRules) };
let r = planning() ? state.planRules : state.rules;
const save = () => localStorage.setItem(key, JSON.stringify(state));
const fmt = (x, n = 2) => {
  if (x == null || x === '') return '—';
  try {
    return dec(String(x)).toFixed(n);
  } catch {
    return '待填写';
  }
};
const money = (x) => (x == null ? '—' : fmt(x) + ' U');
const pct = (x) => {
  if (x == null || x === '') return '—';
  try {
    return dec(x).times(100).toFixed(3) + '%';
  } catch {
    return '待填写';
  }
};
const signed = (x) => (x == null ? '未验证' : (dec(x).gt(0) ? '+' : '') + out(dec(x)));
const checkNumber = (x, unit) => {
  if (x == null) return '—';
  return unit === 'U' && dec(x).abs().gte('0.01') ? fmt(x) : dec(x).toSignificantDigits(8).toString();
};
const signedMoney = (x) => (x == null ? '—' : (dec(x).gt(0) ? '+' : '') + money(x));
const clock = (t) =>
  t && Number.isFinite(Date.parse(t)) ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '未确认';
const put = (id, str) => {
  if ($(id).textContent !== str) $(id).textContent = str;
};
const asset = () => state.asset;
const local = () => (state.assets[asset()] ??= { pf: {}, hl: {} });
const ruleFields = {
  pfUtil: 'VS 最大保证金占权益（%）',
  hlUtil: 'Hype 最大保证金占权益（%）',
  movePct: '假定两日内有利价格变动（%，选填）',
  jumpBps: '不利跳价（基点）',
  delayBps: 'Hype 调仓延迟期间不利变动（基点）',
  fundingDebit: '持有期间资金费支出压力（U）',
  adverseBps: 'Hype 不利基差及汇率偏移（基点，1 基点 = 0.01%）',
  externalFx: '每单位外币的已确认 USDC 估值（选填）',
  recoveryBuffer: '失败回本之外要求的额外安全缓冲（U，选填）',
  registration: '本金中已支付的报名费（U）',
  investedCapital: '净收益核算的实际总投入（含报名费及已投入的外部资金，U）',
  outsideCosts: '本金之外另需收回的历史成本（U）',
  minMaintenanceSurplus: 'Hype 路径最低维持保证金余量（U）',
  minBuffer: '成功线到 Hype 强平线的最低价格距离',
  challengeFloor: '考核固定失败线（U）',
  challengeTarget: '考核通过净值（U）',
  fundedFloor: '出金户固定失败线（U）',
  fundedTarget: '首次分成参考净值（U）',
  baseline: '分成基线（U）',
  share: '个人分成比例（0 至 1）',
  external: '已到账且确认归属的外部资金（原币）',
  inTransit: '在途金额（U，仅展示）',
  receivable: '分成待到账（U）',
  receivedPayout: '本轮实际到账分成（U，已计入收款账户，未知留空）',
  deadlineMark: '截止时 PF 标记价（明确压力终点，按当前品种与截止时间）',
  k: '额外终点摩擦预算（U，已计成交费勿重复填）',
  ref: '本轮起点 C_ref（未知留空）',
  g: '本轮最低收益要求（U）',
  roundIn: '本轮外部净入本金（U）',
  roundOut: '本轮已取出本金（U）',
  pfFee: 'VS 单边费率（小数）',
  hlFee: 'Hype 手工单边费率（小数）',
  deadline: '考核实际截止时间（本地）',
  quoteSecs: '盘口有效期（秒）',
  accountSecs: '账户确认有效期（秒）',
  quoteSkewMs: '行情最大时间差（毫秒）',
  accountSkewSecs: '账户快照最大时间差（秒）',
  rebalanceSteps: '最小调仓变动（两边各自数量步长，0 为关闭）',
  fx: '手工 USDC/USDT 汇率（选填）'
};
const legFields = {
  maxQty: '平台另设总数量上限（如有）',
  anchor: '权益对应的标记价',
  free: '剩余可开仓保证金（U）',
  otherHold: '其他仓位与挂单保留额（U，未知留空）',
  orders: '未成交订单（剩余有符号数量，逗号分隔；无单填 0）'
};
function input(box, id, label, type = 'text') {
  const l = document.createElement('label'),
    e = document.createElement('input');
  l.textContent = label;
  e.id = id;
  e.type = type;
  if (type === 'text') e.inputMode = 'decimal';
  l.append(e);
  $(box).append(l);
}
const planFields = {
  planCapital: '个人起始本金（U）',
  planPF: 'VS 起始权益（U）',
  planFundedCash: '通过后 Hype 结余（U）'
};
for (const [k, label] of Object.entries(planFields)) input('plan-fields', k, label);
for (const [k, label] of Object.entries(ruleFields))
  input(
    k in stressFields ? 'stress-fields' : 'rule-fields',
    k,
    label,
    k === 'deadline' ? 'datetime-local' : 'text'
  );
for (const side of ['pf', 'hl'])
  for (const [k, label] of Object.entries(legFields))
    if (k !== 'free') input('leg-settings', side + '-' + k, (side === 'pf' ? 'VS ' : 'Hype ') + label);
for (const side of ['pf', 'hl']) {
  const label = document.createElement('label'),
    select = document.createElement('select');
  label.textContent = (side === 'pf' ? 'VS' : 'Hype') + ' 保证金模式';
  select.id = side + '-marginMode';
  for (const [value, name] of [
    ['', '待核实'],
    ['cross', '已确认全仓'],
    ['isolated', '逐仓（需另核实）']
  ])
    select.add(new Option(name, value));
  label.append(select);
  $('quick-margin').append(label);
}
function action(q, d) {
  if (d == null || q == null) return '—';
  const change = dec(d),
    before = dec(q),
    after = before.plus(change);
  if (change.isZero()) return '保持 0';
  const label = before.times(after).lt(0) ? '反向调仓' : after.abs().gt(before.abs()) ? '增仓' : '减仓';
  return label + ' ' + signed(d) + ' ' + asset();
}
let previous = null;
let feed = {},
  rates = {},
  api = null,
  apiError = '',
  quoteError = '',
  pending = null,
  feedVersion = 0,
  accountVersion = 0;
let quoteTimer,
  accountTimer,
  lastCalculation = '',
  manualPrices = null;
const useAPI = () => !planning() && $('hl-source').value === 'api';
function market() {
  if ($('quote-source').value !== 'manual') return { ...feed, source: 'Vest / Hyperliquid 公开行情' };
  return {
    ...feed,
    asset: asset(),
    source: '手工确认盘口',
    pf: manualPrices?.pf,
    hl: manualPrices?.hl,
    errors: { spec: feed.errors?.spec }
  };
}
function account(side) {
  if (planning()) return presetAccount(r, side);
  if (side === 'hl' && useAPI())
    return api ? { ...api, error: apiError } : { error: apiError || '等待 Hype 账户同步' };
  return manualAccount(state, asset(), side);
}
function approvedOrders(v) {
  if (!Array.isArray(v)) throw Error('orders 须为数组，未知请省略');
  const ids = new Set();
  return v.map((o) => {
    const qty = out(dec(String(o.qty)));
    if (dec(qty).isZero()) throw Error('未成交剩余数量须非零，无挂单请填 []');
    if (o.id != null && ids.has(String(o.id))) throw Error('挂单 ID 重复');
    if (o.id != null) ids.add(String(o.id));
    return {
      qty,
      id: o.id == null ? null : String(o.id),
      conditional: !!o.conditional,
      reduceOnly: !!o.reduceOnly
    };
  });
}
function inputs() {
  $('plan-cross-flat').checked = r.planCrossFlat === true;
  $('funding-view').value = state.fundingView;
  $('plan-settings').hidden = !planning();
  $('investedCapital').parentElement.hidden = planning();
  for (const id of ['hl-source', 'wallet', 'paste', 'bridge-pair', 'leg-settings']) {
    const el = $(id);
    const wrapper = el.closest('details:not(#desk-details)') ?? el.closest('.form');
    if (wrapper) wrapper.hidden = planning();
  }
  put('sync', planning() ? '立即刷新双边行情' : '立即刷新行情与账户');
  $('flat-entry').hidden = $('confirm-balances').hidden = $('quick-margin').hidden = planning();
  for (const k of Object.keys(planFields)) $(k).value = r[k] ?? '';
  $('receiptSource').parentElement.hidden = $('receivedPayout').parentElement.hidden =
    planning() || r.stage !== 'funded';
  $('deadlineMark').parentElement.hidden = r.stage === 'funded';
  $('planFundedCash').parentElement.hidden = r.stage !== 'funded';
  $('receiptSource').value = r.receiptSource ?? 'external';
  $('asset').value = asset();
  for (const k of [
    'mode',
    'stage',
    'B',
    'R_success',
    'R_free',
    'riskPreference',
    'externalCurrency',
    ...Object.keys(ruleFields)
  ])
    $(k).value =
      k === 'deadlineMark' && (r.deadlineAsset !== asset() || r.deadlineBound !== r.deadline)
        ? ''
        : (r[k] ?? '');

  for (const side of ['pf', 'hl']) {
    const a = account(side);
    for (const k of ['equity', 'qty', ...Object.keys(legFields), 'leverage', 'marginMode']) {
      const el = $(side + '-' + k);
      if (!el) continue;
      const value =
        k === 'orders' ? a.orders?.map((o) => o.qty).join(',') || (a.orders ? '0' : '') : (a[k] ?? '');
      if (el !== document.activeElement || (side === 'hl' && useAPI())) el.value = value;
      if (el.tagName === 'SELECT') el.disabled = planning() || (side === 'hl' && useAPI());
      else el.readOnly = planning() || (side === 'hl' && useAPI());
    }
  }
}
function updateLeg(side, fields, stamp = now(), source = '手工确认') {
  const leg = local()[side];
  if (('qty' in fields && fields.qty !== '0') || fields.otherPositions) leg.allFlatAt = null;
  if ('orders' in fields && fields.orders?.length !== 0) leg.noOrdersAt = null;
  leg.origins ??= {};
  for (const k of Object.keys(fields)) leg.origins[k] = { at: stamp, source };
  if (
    ('qty' in fields && fields.qty !== '0') ||
    (fields.orders && fields.orders.length) ||
    fields.otherPositions
  )
    leg.flatConfirmedAt = null;
  if ('equity' in fields) {
    state.shared[side] = { asset: asset(), equity: fields.equity, at: stamp, source };
    leg.equityAt = stamp;
    leg.anchor =
      fields.anchor ??
      (fresh(market()[side]?.asOf, Date.parse(stamp), Number(r.quoteSecs) * 1000)
        ? String(market()[side].mark)
        : null);
  }
  if ('qty' in fields) {
    if (!('equity' in fields) && fields.qty !== leg.qty && leg.qtyAt && leg.equityAt && leg.qtyAt !== stamp)
      leg.anchor = null;
    leg.qtyAt = stamp;
  }
  Object.assign(leg, fields);
}
function cellRow(values) {
  const row = document.createElement('tr');
  for (const value of values) {
    const td = document.createElement('td');
    td.textContent = value;
    row.append(td);
  }
  return row;
}
function renderPairs(id, pairs) {
  const dl = [];
  for (const [k, v] of pairs) {
    const dt = document.createElement('dt'),
      dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dl.push(dt, dd);
  }
  if ($(id).textContent !== dl.map((el) => el.textContent).join('')) $(id).replaceChildren(...dl);
}
function renderRisk(result, accounts, market) {
  const c = result.candidate;
  put(
    'risk-status',
    c
      ? result.riskMissing.length
        ? '仍需确认：' + result.riskMissing.join('、')
        : (result.audit?.status ?? '条件估算') + ' · 已按全仓维持保证金档位计算两条基础路径。'
      : '等待可测算的候选仓位。'
  );
  const audit = result.audit;
  put(
    'cross-audit',
    audit
      ? [
          audit.status,
          '独立权益与维持保证金交点核对 ' +
            (audit.mathMatches == null ? '无法验证' : audit.mathMatches ? '一致' : '不一致'),
          '目标仓模型 ' + fmt(audit.model) + ' / 独立数值解 ' + fmt(audit.independent),
          '交易所核验 · ' + audit.exchangeCheck,
          '现仓模型 ' + fmt(audit.currentModel) + ' / 平台现仓参考 ' + fmt(audit.reference),
          '现仓维持要求 模型 ' + money(audit.currentMaintenance) + ' / 平台 ' + money(audit.apiMaintenance),
          ...audit.gaps
        ].join(' · ')
      : '清算条件估算待核实 · 需要全仓权益、所有持仓、费率及维持档位'
  );
  const sources = [];
  if (market.spec)
    sources.push('VS 保证金规格 · Vest exchangeInfo' + (market.specAt ? ' ' + clock(market.specAt) : ''));
  if (market.hl?.markAt) sources.push('Hype 档位 · 主网 meta ' + clock(market.hl.markAt));
  sources.push('VS 单边费率 ' + pct(r.pfFee || null) + '（本机设置）');
  sources.push(
    'Hype 单边费率 ' +
      pct(accounts.hl.fee ?? (r.hlFee || null)) +
      (accounts.hl.fee != null ? '（公开账户 API）' : '（本机设置）')
  );
  put('cost-sources', sources.join(' ｜ '));
  const paths =
    c && market.pf
      ? [c.lines.fail, c.lines.pass].map((x) => fmt(out(dec(String(market.pf.mark)).plus(x))))
      : ['—', '—'];
  const margin = (key) => money(c?.constraints.find((x) => x.code === key + '_INITIAL_MARGIN')?.required);
  renderPairs('risk-values', [
    ['VS 失败价 / 成功价', paths.join(' / ')],
    ['Hype 在 VS 成功线的映射标记价', fmt(c?.pressureMark)],
    [
      'Hype 目标仓强平标记价',
      c?.liqMark
        ? fmt(c.liqMark) + ' · ' + c.liqSource + ' · ' + (result.audit?.status ?? '条件估算')
        : c && dec(c.hlTargetQuantity).isZero()
          ? 'Hype 空仓，无强平价'
          : c && c.buffer != null
            ? '模型内无正价格强平点'
            : '未验证'
    ],
    [
      '当前仓平台参考强平价',
      accounts.hl.liquidation ? fmt(accounts.hl.liquidation) + ' · API 当前持仓' : '未提供'
    ],
    [
      '成功线到强平线的距离',
      c?.priceBuffer != null
        ? fmt(c.priceBuffer) + ' 价格单位 · ' + pct(out(dec(c.priceBuffer).div(c.pressureMark)))
        : '—'
    ],
    ['Hype 目标仓初始保证金', money(c?.requiredInitialMargin)],
    ['Hype 目标仓当前维持保证金', money(c?.maintenanceMargin)],
    ...(result.stress?.positive.length
      ? [
          ['已配置压力情景标记价 / 强平价', fmt(c?.stressPressureMark) + ' / ' + fmt(c?.stressLiqMark)],
          ['已配置压力下的清算缓冲', fmt(c?.stressPriceBuffer)]
        ]
      : []),
    [
      '最小余量处的权益 / 维持保证金',
      money(c?.stressedEquity ?? c?.baseEquity) + ' / ' + money(c?.stressedMaintenance ?? c?.baseMaintenance)
    ],
    ['路径最低 Hype 维持保证金余量', money(c?.stressedSurplus ?? c?.buffer)],
    [
      '有效杠杆（目标名义额 ÷ Hype 权益）',
      c?.effectiveLeverage != null ? fmt(c.effectiveLeverage, 3) + '×' : '—'
    ],
    ['PF 模拟初始保证金（含其他占用）', margin('pf')],
    ['Hype 其他保证金占用', money(c?.otherInitialMargin)],
    ['Hype 调仓后的可用抵押品（含已留存金额）', money(c?.availableAfter)]
  ]);
  const rows = ['pf', 'hl'].map((k) => {
    const t = result.costs?.[k],
      pair = (side) => (t ? money(t[side].fee) + ' / ' + money(t[side].impact) : '—');
    return cellRow([
      k === 'pf' ? 'VS' : 'Hype',
      money(t?.entry.fee),
      money(t?.entry.impact),
      pair('fail'),
      pair('pass')
    ]);
  });
  if ($('costs').textContent !== rows.map((el) => el.textContent).join(''))
    $('costs').replaceChildren(...rows);
}
function freshnessLabel(at, seconds) {
  if (!at) return '未确认';
  return fresh(at, Date.now(), Number(seconds) * 1000) ? '有效' : '过期';
}
let lastFinished = null,
  workerTimer;
let worker = null,
  version = 0,
  running = null,
  completed = null;
function cancelAuto() {
  clearTimeout(workerTimer);
  worker?.terminate();
  worker = null;
  running = null;
  completed = null;
  version++;
}
function currentFrame(a, m, t) {
  const base = calculateCurrent(r, a, m, rates, t, { deferAuto: true });
  base.lastFinished = lastFinished;
  if (!base.needsSearch) {
    if (running || completed) cancelAuto();
    return base;
  }
  const { obtainedAt, ...spec } = m.spec;
  const context = JSON.stringify([
    r,
    a,
    m.asset,
    useAPI(),
    $('quote-source').value,
    spec,
    m.hl.marginTiers,
    m.hl.maxLeverage,
    m.hl.sizeDecimals,
    m.hl.onlyIsolated
  ]);
  const key = JSON.stringify([context, m, rates]);
  if ((running && running.context !== context) || (completed && completed.context !== context)) cancelAuto();
  if (!running && completed?.key !== key) {
    const frameRates = rates;
    const revision = ++version;
    running = {
      context,
      key,
      since: performance.now(),
      trigger: completed?.context === context ? '实时行情或汇率更新' : '账户、资金规则或行情输入更新'
    };
    if (!worker) worker = new Worker('/src/hedge/auto-worker.js', { type: 'module' });
    const finish = (result) => {
      if (revision !== version) return;
      clearTimeout(workerTimer);
      running = null;
      if (result.ratioScan) lastFinished = { id: result.trace.id, at: result.trace.at };
      completed = {
        context,
        key,
        stamps: ['pf', 'hl'].flatMap((k) => [m[k].bookAt ?? m[k].asOf, m[k].markAt ?? m[k].asOf]),
        result: {
          ...result,
          stateVersion: revision,
          calculatedAt: new Date(t).toISOString(),
          calculationMarket: m,
          calculationRates: frameRates
        }
      };
      render();
    };
    workerTimer = setTimeout(() => {
      if (revision !== version) return;
      worker.terminate();
      worker = null;
      finish({
        ...base,
        needsSearch: false,
        range: null,
        funding: null,
        autoStatus: 'AUTO_PARTIAL',
        issues: ['比例扫描超过 10 秒，本帧结果已撤回。下一次行情或输入更新后重试。']
      });
    }, 10000);
    worker.onmessage = ({ data }) => {
      if (data.version === revision)
        finish(
          data.error
            ? {
                ...base,
                autoStatus: 'AUTO_PARTIAL',
                range: null,
                funding: null,
                issues: [constraintReason(data.error)]
              }
            : data.result
        );
    };
    worker.onerror = () => {
      if (revision !== version) return;
      worker.terminate();
      worker = null;
      finish({ ...base, range: null, funding: null, autoStatus: 'AUTO_PARTIAL', issues: ['后台计算失败'] });
    };
    const priorTarget = completed?.context === context ? completed.result.advice?.pair : null;
    worker.postMessage({ version: revision, r, a, m, rates, t, priorTarget });
  }
  // A new tick queues the latest frame without starving an in-flight search.
  // Account edits, safety gates and rule changes invalidate old answers immediately.
  if (completed?.key === key && completed.stamps.every((v) => fresh(v, t, Number(r.quoteSecs) * 1000)))
    return { ...completed.result, lastFinished, refreshPending: completed.key !== key };
  return {
    ...base,
    range: null,
    funding: null,
    trace: null,
    autoStatus: 'AUTO_PARTIAL',
    refreshPending: true,
    lastFinished,
    priorError:
      completed?.context === context && !completed.result.ratioScan ? completed.result.issues?.[0] : null,
    trigger: running?.trigger,
    since: running?.since,
    issues: ['当前快照正在重算，仓位调整建议已暂停']
  };
}
const autoLabels = {
  AUTO_FEASIBLE: '有可行仓位',
  AUTO_PARTIAL: '部分可算',
  AUTO_DATA_BLOCKED: '数据待补或过期',
  AUTO_INFEASIBLE: '完整搜索无解',
  AUTO_DEADLINE_EXIT_REQUIRED: '考核已到期，待退出',
  AUTO_PAYOUT_PENDING: '首笔分成待到账',
  AUTO_CYCLE_SETTLED: '首笔分成已到账，本轮结束',
  AUTO_HOLD: '保持现仓'
};
function updateDeadline() {
  if (r.stage !== 'challenge') return put('deadline-clock', '出金阶段');
  const end = Date.parse(r.deadline);
  if (!Number.isFinite(end)) return put('deadline-clock', '实际截止时间未配置');
  const seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000));
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  put(
    'deadline-clock',
    clock(r.deadline) +
      (seconds ? ' · 剩余 ' + [h, m, s].map((v) => String(v).padStart(2, '0')).join(':') : ' · 已到期')
  );
}
setInterval(updateDeadline, 1000);
const frameCards = document.querySelectorAll(
  '.desk-summary article, .desk-ratios, .dual-plans > div, [aria-labelledby="result-heading"], #risk, #cash-results, #funding-formula'
);
for (const el of frameCards) {
  const stamp = document.createElement('small');
  stamp.className = 'frame-key';
  (el.id === 'cash-results' ? el.parentElement : el).append(stamp);
}
function renderFunding(result, a, m, plan) {
  const f = result.funding,
    c = result.candidate,
    v = c?.funding;
  put(
    'formula-inputs',
    f?.lower == null
      ? '等待有效的资金快照、阶段和边界。'
      : '保护本金及额外历史成本 B ' +
          money(f.B) +
          ' · Hype 当前权益 ' +
          money(f.C_H) +
          '（' +
          (a.hl.source ?? '手工快照') +
          '）＋外部已到账 ' +
          money(f.C_E) +
          ' = 保护资金 ' +
          money(f.C_P) +
          '。PF 权益 ' +
          money(f.E) +
          '（' +
          (a.pf.source ?? '手工快照') +
          '），失败线 ' +
          money(f.F) +
          '，成功线 ' +
          money(f.T) +
          '。'
  );
  put(
    'formula-bounds',
    f?.lower == null
      ? ''
      : '理论保护下限 max(0, (' +
          fmt(f.B) +
          ' − ' +
          fmt(f.C_P) +
          ' + ' +
          fmt(f.failCost) +
          ') ÷ ' +
          fmt(f.loss) +
          ') = ' +
          pct(f.lower) +
          '；到账前上限 (' +
          fmt(f.C_H) +
          ' − ' +
          fmt(f.R_success) +
          ' − ' +
          fmt(f.passCost) +
          ') ÷ ' +
          fmt(f.gain) +
          ' = ' +
          pct(f.upper) +
          '。理论区间仅含另设的终点摩擦预算。开仓后可用抵押品另须达到 R_free ' +
          money(f.R_free) +
          '。' +
          (f.code === 'NO_CASH_INTERSECTION'
            ? '理论无交集。取下限时成功端缺 ' +
              money(f.successShortfallAtLower) +
              (f.failureShortfallAtUpper == null
                ? '；零对冲亦缺留存 ' + money(f.reserveShortfallAtZero)
                : '；取上限时失败保护缺 ' + money(f.failureShortfallAtUpper)) +
              '。'
            : '')
  );
  put(
    'formula-pair',
    v
      ? '本候选按两边实际数量核算，每单位共同价格变化 PF ' +
          fmt(v.Kpf, 7) +
          ' U、Hype ' +
          fmt(v.Kh, 7) +
          ' U。目标 h = |Hype / PF| = ' +
          pct(v.h) +
          '。实际成交成本折算到对冲端，失败 ' +
          money(v.failCost) +
          '、成功 ' +
          money(v.passCost) +
          '；代入本候选成本的现金下限 ' +
          pct(v.lower) +
          '，上限 ' +
          pct(v.upper) +
          '。' +
          (v.stress
            ? '计入已配置压力，保护下限 ' + pct(v.stress.lower) + '，留存上限 ' + pct(v.stress.upper) + '。'
            : '')
      : result.refreshPending
        ? '资金、规则或行情已更新，等待本版仓位核算。'
        : '当前没有可逐笔核对的 AUTO 候选。'
  );
  const paths = result.paths;
  const cols = ['fail', 'pass'].flatMap((s) => ['pf', 'hl'].map((k) => paths?.[s]?.[k]));
  const exact = $('ledger-exact').checked;
  const views = cols.map((x) => x && (exact ? { entries: x.entries, total: x.settled } : presentLedger(x)));
  const rows = [];
  if (paths) {
    for (const [key, label] of Object.entries(ledgerLabels)) {
      const row = cellRow([label, ...views.map((v) => v?.entries[key] ?? '—')]);
      row.dataset.posting = key;
      rows.push(row);
    }
    if (!exact) {
      const row = cellRow(['逐项显示舍入差（U）', ...views.map((v) => v?.rounding ?? '—')]);
      row.dataset.posting = 'rounding';
      rows.push(row);
    }
    const total = cellRow(['结算权益（以上逐项相加）', ...views.map((v) => v?.total ?? '—')]);
    total.dataset.total = 'settled';
    rows.push(total);
    for (const [field, label] of Object.entries({
      difference: '与按成交均价独立复算差额（U）',
      target: '平仓数量（有符号目标仓）',
      adjustment: '本次调仓数量（有符号差额）',
      mark: '当前标记价',
      entryPrice: '调仓成交均价',
      exitMark: '边界映射标记价',
      exitPrice: '预计平仓成交均价',
      entryNominal: '调仓计费名义额（U）',
      exitNominal: '平仓计费名义额（U）',
      rate: '单边费率',
      multiplier: '合约乘数',
      fx: '结算币兑 U',
      factor: '共同价格变动映射系数',
      step: '数量步长'
    }))
      rows.push(cellRow([label, ...cols.map((x) => x?.[field] ?? '—')]));
  }
  const table = $('path-rows');
  if (table.textContent !== rows.map((row) => row.textContent).join('')) table.replaceChildren(...rows);
  put(
    'settlement-note',
    paths
      ? '正数增加权益，负数减少权益。初始保证金单列为占用。独立复算容差 0.000000000001 U。终点按当前可见盘口平移至 VS 触线时的预计成交均价。表内价差、深度滑点和手续费各计一次。PF 模拟利润留在 PF 账本。外部已到账 ' +
          money(result.externalValue) +
          '。成功时预计可分 ' +
          money((c ?? result.heldCash)?.expectedUserPayout) +
          '，到账前不计入 Hype。'
      : ''
  );
  put(
    'path-mapping',
    paths
      ? ['fail', 'pass']
          .map((k) => {
            const legs = paths[k],
              change = dec(legs.pf.exitMark).div(legs.pf.mark).minus(1);
            return (
              (k === 'fail' ? '失败' : '成功') +
              ' · PF 标记价变化 ' +
              pct(change) +
              '，Hype 映射标记价 ' +
              fmt(legs.hl.exitMark, 5)
            );
          })
          .join(' ｜ ') +
          '。两日内是否触线未知。按本帧映射系数、固定汇率和平移盘口结算；有其他仓位时假定其权益贡献不变。'
      : ''
  );
  const pass = paths?.pass;
  put(
    'pass-bridge',
    pass
      ? 'Hype 起点 ' +
          money(pass.hl.start) +
          ' → 成功路径预计 ' +
          money(pass.hl.settled) +
          '；Hype 标记盈亏 ' +
          signedMoney(pass.hl.move) +
          '。'
      : ''
  );
  put(
    'frame-times',
    result.trace
      ? '行情 · VS ' +
          clock(m.pf?.bookAt ?? m.pf?.asOf) +
          ' / Hype ' +
          clock(m.hl?.asOf) +
          ' ｜ 账户 · ' +
          (plan
            ? '预设资金规划'
            : 'VS ' + clock(fieldTime(a.pf, 'equity')) + ' / Hype ' + clock(fieldTime(a.hl, 'equity'))) +
          ' ｜ 规则 · ' +
          (r.editedAt ? clock(r.editedAt) : '初始配置') +
          ' ｜ 计算 · ' +
          clock(result.trace.at)
      : '等待同一版本的计算结果'
  );
  const s = result.search;
  put(
    'search-coverage',
    s?.pruned
      ? '数量上限与深度分段后共 ' +
          s.gridPairs +
          ' 对网格点。分支定界，实际核算 ' +
          s.exactPairs +
          ' 对与 ' +
          s.leverageRows +
          ' 个杠杆档次，访问 ' +
          s.nodes +
          ' 个分支（预算 ' +
          s.budget +
          '）。剪枝次数 · 仓位上界 ' +
          s.pruned.sizeBound +
          '、价格失效 ' +
          s.pruned.invalidPrice +
          '、现金上下界 ' +
          s.pruned.cashBound +
          '、已知更优解 ' +
          s.pruned.incumbentBound +
          '。' +
          (s.proof
            ? '最优目标下界 ' +
              (s.proof.lower ?? '未知') +
              ' U，上界 ' +
              (s.proof.upper ?? '未知') +
              ' U，最优性容差 ' +
              s.proof.optimalityTolerance +
              ' U。'
            : '') +
          (s.complete && s.proof?.complete
            ? '仅在本帧给定约束和合法网格内证明。'
            : '搜索或条件不完整，最优性未证实。') +
          (s.stoppedByBudget ? '已用尽预算。' : '') +
          (result.solveMs == null ? '' : '本帧联合求解 ' + result.solveMs + ' ms。')
      : ''
  );
  if ($('bound-details').open)
    put('bound-witness', s?.proof ? JSON.stringify(s.proof, null, 2) : '等待同一快照的搜索证明');
}
function renderConditions(result, a, m, plan) {
  renderFunding(result, a, m, plan);
  put(
    'funding-banner',
    plan
      ? '预设资金规划 · 账户权益、空仓与抵押品按规划条件计算'
      : '当前账户快照 · 权益与可用抵押品按平台读取或手工确认'
  );
  $('funding-banner').classList.toggle('account', !plan);
  put('margin-detail-title', plan ? 'Hype 规划初始保证金' : 'Hype 真实账户 · 目标初始保证金');
  const actualStress = !!result.stress?.positive.length;
  const scenario = actualStress ? '已配置压力情景' : '基础情景（未计额外压力）';
  put('lev-equity-heading', scenario + '权益');
  put('candidate-surplus-heading', scenario + '最低维持余量');
  put('candidate-cash-heading', scenario + '最差个人现金');
  const t = result.timing;
  const age = (n) => (n == null ? '未知' : (n / 1000).toFixed(1) + ' 秒');
  put(
    'clock-skew',
    t
      ? 'VS 盘口 ' +
          (t.clocks.pf.bookAt ?? '未取得') +
          '，年龄 ' +
          age(t.quoteAges.pf) +
          ' / Hype 盘口 ' +
          (m.hl?.asOf ?? '未取得') +
          '，年龄 ' +
          age(t.quoteAges.hl) +
          ' · 标记年龄 VS ' +
          age(t.clocks.pf.markAge) +
          ' / Hype ' +
          age(t.clocks.hl.markAge) +
          ' · 盘口与标记有效期 ' +
          age(t.quoteTTL) +
          ' · 盘口与标记最大时差 ' +
          (t.quoteSkew ?? '—') +
          ' / 允许 ' +
          t.quoteLimit +
          ' 毫秒 · ' +
          (plan
            ? '预设账户无实时快照'
            : 'VS 权益 ' +
              (fieldTime(a.pf, 'equity') ?? '未取得') +
              '，年龄 ' +
              age(t.accountAges.pf) +
              ' / Hype 权益 ' +
              (fieldTime(a.hl, 'equity') ?? '未取得') +
              '，年龄 ' +
              age(t.accountAges.hl) +
              ' · 账户字段最大时差 ' +
              age(t.accountSkew) +
              ' / 允许 ' +
              age(t.accountLimit))
      : ''
  );
  put(
    'size-title',
    result.maximum && !result.maximum.complete ? '已找到的仓位方案 · 最大值待验证' : '最大可行方案'
  );
  put(
    'cash-title',
    result.conservative && !result.conservative.complete
      ? '现金优先候选 · 最优性待验证'
      : actualStress
        ? '已配置情景 · 现金优先'
        : '基础情景 · 现金优先'
  );
  const diff = result.comparison;
  put(
    'plan-tradeoff',
    diff
      ? '选择现金优先方案，PF 名义仓位减少 ' +
          money(diff.pfReduction) +
          '（' +
          pct(diff.reductionRatio) +
          '），成功端 Hype 现金变化 ' +
          signedMoney(diff.successGain) +
          '，最差个人现金缓冲变化 ' +
          signedMoney(diff.worstGain) +
          '。'
      : '等待同一快照的两套方案'
  );
  put(
    'preference-info',
    (r.riskPreference ?? '0') +
      '% · 当前方案最差个人现金留存下限 ' +
      money(result.preference?.floor) +
      (result.preference
        ? '（' +
          money(result.preference.sizeFloor) +
          ' + ' +
          (r.riskPreference ?? '0') +
          '% × 两端最低现金差）'
        : '') +
      '；失败保护、保证金与清算约束继续生效。'
  );
  $('riskPreference').disabled = r.mode !== 'auto';
  put(
    'risk-tradeoff',
    diff
      ? '现金优先相对仓位优先 · Hype 名义额 ' +
          signedMoney(diff.hypeChange) +
          '，失败端现金 ' +
          signedMoney(diff.failureChange) +
          '，当前维持保证金 ' +
          signedMoney(diff.maintenanceChange) +
          '，路径最低维持余量 ' +
          signedMoney(diff.surplusChange) +
          '，成功线至强平线距离变化 ' +
          (diff.distanceChange == null ? '无可比较交点' : signed(diff.distanceChange) + ' 价格单位') +
          '，候选杠杆变化 ' +
          (diff.leverageChange == null ? '—' : signed(diff.leverageChange) + '×')
      : ''
  );
  const h = result.advice;
  put(
    'hysteresis',
    h
      ? (h.source === 'existing'
          ? '变化低于最小调仓阈值，建议保持现仓'
          : h.source === 'previous'
            ? '变化低于最小调仓阈值，沿用已复核的上一目标'
            : '按本帧目标计算差额') +
          ' · 阈值 ' +
          h.threshold +
          ' 个数量步长 · 建议目标 PF ' +
          signed(h.pair[0]) +
          ' / Hype ' +
          signed(h.pair[1]) +
          ' ' +
          asset() +
          ' · 建议档位 ' +
          (h.leverage ? h.leverage + '×' : '无敞口')
      : ''
  );
  const missing = $('missing-list'),
    fields = result.missingFields ?? [];
  const key = JSON.stringify([plan, fields]);
  if (missing.dataset.key !== key) {
    missing.dataset.key = key;
    missing.replaceChildren(
      ...fields.map(({ id, label }) => {
        const link = document.createElement('a');
        let el = $(id);
        if (plan && (id === 'hl-source' || el?.closest('#snapshot'))) el = $('funding-view');
        if (!el) el = $('rules');
        link.href = '#' + el.id;
        link.textContent = label;
        link.onclick = (event) => {
          event.preventDefault();
          for (let n = el; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
          el.scrollIntoView({ block: 'center' });
          if (!el.matches('input,select,button')) el.tabIndex = -1;
          el.focus({ preventScroll: true });
        };
        return link;
      })
    );
  }
  const tr = result.trace;
  const stamp = tr ? '行情 ' + clock(m.hl?.asOf) + ' · 核算 ' + clock(tr.at) : '等待同帧核算';
  for (const el of document.querySelectorAll('.frame-key')) {
    if (el.textContent !== stamp) el.textContent = stamp;
    el.title = tr ? [tr.marketId, tr.accountsId, tr.rulesId, tr.model, tr.id].join(' / ') : stamp;
  }
  updateDeadline();
}
function render() {
  let m = market();
  const a = { pf: account('pf'), hl: account('hl') };
  let result;
  try {
    result = currentFrame(a, m, Date.now());
    if (result.calculationMarket) m = result.calculationMarket;
  } catch (e) {
    cancelAuto();
    result = {
      autoStatus: r.mode === 'auto' ? 'AUTO_DATA_BLOCKED' : null,
      issues: [e.message],
      notices: [],
      cash: {},
      qty: { pf: null, hl: null },
      currentNotional: {}
    };
  }
  const c = result.candidate,
    b = result.range,
    stale = result.issues.some((x) => /过期|请求失败|断开|未连接|熔断/.test(x));
  const status = result.autoStatus
    ? (result.flatHold ? '无可行非零仓位，保持空仓' : (result.dataState ?? autoLabels[result.autoStatus])) +
      ' · ' +
      (result.issues[0] ?? result.notices.at(-1) ?? '按当前资金和保证金规则计算')
    : c
      ? '按当前现金规则计算，' +
        (c.code === 'MARGIN_UNVERIFIED' || result.audit?.gaps.length
          ? '保证金条件估算'
          : '已验算所设保证金条件')
      : result.issues[0] || result.notices.at(-1) || '等待当前快照';
  const plan = planning();
  renderScan(result, m, r, plan, status);
  renderConditions(result, a, m, plan);
  const leverage = c?.candidateLeverage;
  const configured =
    useAPI() && !a.hl.error && fresh(a.hl.at, Date.now(), Number(r.accountSecs) * 1000)
      ? a.hl.configuredLeverage
      : null;
  put('suggested-leverage', leverage ? leverage + '×' : c?.hlTargetQuantity === '0' ? '空仓' : '—');
  put('configured-leverage', configured ? configured + '×' : '未知');
  put(
    'leverage-cap',
    (c?.exchangeMaxLeverage
      ? '该仓位档位上限 ' + c.exchangeMaxLeverage + '× · 合约上限 ' + c.contractMaxLeverage + '×'
      : '合约上限 ' + (m.hl?.maxLeverage ? m.hl.maxLeverage + '×' : '待核实')) +
      ' · 档位读取 ' +
      clock(m.hl?.tiersAt)
  );
  put(
    'leverage-status',
    (plan
      ? '规划资金 · LEVERAGE_UNVERIFIED · 候选调档额度未经交易所确认'
      : configured
        ? 'Hyperliquid 只读快照 · ' +
          clock(a.hl.at) +
          (result.leverageStatus === 'LEVERAGE_UNVERIFIED' ? ' · LEVERAGE_UNVERIFIED' : '')
        : '账户设置未读取 · LEVERAGE_UNVERIFIED') +
      (configured != null && leverage === configured ? ' · 按当前档额度' : ' · 目标档额度待核实')
  );
  const grid = c?.leverageGrid ?? [];
  const lower = grid.find((row) => row.leverage === leverage - 1);
  const higher = grid.findLast((row) => row.leverage > leverage && row.status === 'pass');
  const gap = lower?.constraint;
  const why = leverage
    ? [
        leverage + '× 是该仓位的最低可行档位，初始保证金 ' + money(c.requiredInitialMargin) + '。',
        lower &&
          lower.leverage +
            '× ' +
            constraintReason(lower.reason) +
            (gap?.shortfall != null ? '，缺 ' + checkNumber(gap.shortfall, gap.unit) + ' ' + gap.unit : '') +
            '。',
        higher &&
          '升至 ' +
            higher.leverage +
            '× 仅释放初始保证金 ' +
            money(out(dec(c.requiredInitialMargin).minus(higher.initial))) +
            '；两端现金、维持保证金、情景权益与强平距离均相同。'
      ]
        .filter(Boolean)
        .join(' ')
    : c?.hlTargetQuantity === '0'
      ? 'Hype 目标为空仓。'
      : '';
  put('effective-level', c?.effectiveLeverage == null ? '—' : fmt(c.effectiveLeverage, 3) + '×');
  put('initial-needed', '目标初始 ' + money(c?.requiredInitialMargin));
  const used =
    !plan && !a.hl.error && fresh(fieldTime(a.hl, 'used'), Date.now(), Number(r.accountSecs) * 1000)
      ? a.hl.used
      : null;
  const withdrawable =
    !plan && !a.hl.error && fresh(a.hl.at, Date.now(), Number(r.accountSecs) * 1000)
      ? a.hl.withdrawable
      : null;
  put(
    'already-used',
    (plan ? '当前占用按规划估算' : '当前账户占用 ' + money(used)) +
      ' · 交易所可提金额 ' +
      (withdrawable == null ? '未核实' : money(withdrawable))
  );
  put('leverage-reason', why);
  const levRows = grid.map((x) =>
    cellRow([
      x.leverage ? x.leverage + '×' : '空仓',
      money(x.initial),
      money(x.postEntryEquity),
      money(x.marginUsed),
      money(x.freeAfter) + ' / ' + money(x.freeFloor),
      money(x.successEquity) + ' / ' + money(r.R_success),
      money(x.maintenance),
      money(x.stressedEquity ?? x.baseEquity),
      money(x.surplus),
      !x.leverage
        ? '空仓'
        : (x.liquidation == null ? '无正价交点' : fmt(x.liquidation)) +
          ' · ' +
          (result.audit?.status ?? '条件估算'),
      x.status === 'pass'
        ? x.leverage === leverage
          ? '通过所设条件 · 最低可行'
          : '通过所设条件'
        : constraintReason(x.reason) +
          (x.reason === 'hl_FREE_RESERVE' ? ' · R_free 缺 ' + money(x.constraint.shortfall) : '')
    ])
  );
  if ($('leverage-grid').textContent !== levRows.map((x) => x.textContent).join(''))
    $('leverage-grid').replaceChildren(...levRows);

  $('receiptSource').parentElement.hidden = $('receivedPayout').parentElement.hidden =
    planning() || r.stage !== 'funded';
  $('deadlineMark').parentElement.hidden = r.stage === 'funded';
  $('planFundedCash').parentElement.hidden = r.stage !== 'funded';
  put('account-heading', plan ? '规划起点与计算条件' : '当前账户与持仓');
  put('protection-label', plan ? '规划个人保护资金' : '已确认个人保护资金');
  put('margin-label', plan ? 'Hype 规划可用保证金' : 'Hype 可用抵押品');
  put(
    'plan-basis',
    plan
      ? (r.stage === 'funded'
          ? '出金阶段沿用通过后结余 ' + money(a.hl.equity)
          : '个人本金 ' +
            money(r.planCapital) +
            ' − 报名费 ' +
            money(r.registration) +
            ' = Hype 起始资金 ' +
            money(a.hl.equity)) +
          (r.planCrossFlat ? '。按规划全仓、空仓且无挂单计算。' : '。请确认下方规划条件以计算目标。')
      : ''
  );
  put('plan-heading', r.stage === 'funded' ? '首次分成资金规划' : '开考前资金规划');
  const coverage = result.stress?.label ?? '';
  const directional = (qty, amount) =>
    (dec(qty).gt(0) ? '多 ' : dec(qty).lt(0) ? '空 ' : '空仓 ') + money(amount);

  const msg = [
    c && result.autoStatus === 'AUTO_PARTIAL' ? 'AUTO_PARTIAL · 条件方案' : status,
    ...(result.unverified ?? []),
    c && !result.unverified && result.leverageStatus === 'LEVERAGE_UNVERIFIED' && '条件方案 · 账户设置未验证',
    c && !result.unverified?.includes(coverage) && coverage
  ]
    .filter(Boolean)
    .join(' · ');
  put('calc-status', (plan ? '预设规划 · ' : '') + msg);
  const gaps = result.inputGaps ?? [];
  const checklist = [
    ...gaps.map((g) => g.text),
    ...result.issues.filter((v) => !gaps.some((g) => g.text === v) && !v.includes('持仓数量未录入'))
  ];
  put(
    'quick-status',
    plan && !r.planCrossFlat
      ? '请先确认资金规划的账户模式、空仓与挂单条件'
      : [...new Set(checklist)].join(' · ') || (c ? '已按当前输入计算' : status)
  );
  put('quick-entry', plan ? '调整预设参数' : '快速录入当前账户');
  $('quick-entry').onclick = () => {
    if (plan) {
      $('planCapital').focus();
      return;
    }
    const el = gaps.map((g) => $(g.id)).find((el) => el && !el.readOnly && !el.disabled) ?? $('pf-equity');
    el.focus();
    el.scrollIntoView({ block: 'center' });
  };
  for (const button of $('separate-confirm').children)
    button.disabled = planning() || (useAPI() && button.id.startsWith('confirm-hl-'));
  $('confirm-flat').disabled =
    useAPI() &&
    (!a.hl.at ||
      !!a.hl.error ||
      !fresh(a.hl.at, Date.now(), Number(r.accountSecs) * 1000) ||
      a.hl.qty !== '0' ||
      a.hl.otherPositions ||
      a.hl.orders?.length !== 0 ||
      a.hl.marginMode !== 'cross' ||
      a.hl.otherHold !== '0');
  put(
    'fund-source',
    'Hype ' +
      (result.cash.hl == null ? '待确认' : money(result.cash.hl)) +
      '（' +
      (a.hl.source ?? '账户未接入') +
      '，' +
      clock(fieldTime(a.hl, 'equity')) +
      '）＋ 已到账外部 ' +
      money(result.externalValue) +
      (result.cash.hl == null && a.hl.equity != null && a.hl.equity !== ''
        ? '。上次录入 ' + money(a.hl.equity) + '，未计入'
        : '')
  );
  put(
    'collateral-source',
    (a.hl.source ?? '账户未接入') +
      (fieldTime(a.hl, 'free')
        ? ' · ' +
          clock(fieldTime(a.hl, 'free')) +
          ' · ' +
          freshnessLabel(fieldTime(a.hl, 'free'), r.accountSecs)
        : ' · 可用保证金未确认')
  );

  if (plan) {
    put(
      'fund-source',
      '预设 Hype 权益 ' + money(result.cash.hl) + ' ＋ 规划外部已到账 ' + money(result.externalValue)
    );
    put('collateral-source', r.planCrossFlat ? '按全仓空仓规划计算' : '等待确认规划起点');
  }
  put(
    'summary-status',
    result.autoStatus
      ? (plan ? '预设规划 · ' : '') + msg
      : c
        ? (c.code === 'FEASIBLE' && !result.audit?.gaps.length
            ? '当前规则已验算'
            : '条件测算 · 保证金待验证') +
          ' · ' +
          coverage +
          ' · 两种现金结果均假设先触及对应 VS 边界'
        : status + (result.heldCash ? ' · 现金按现仓保持不动计算' : '')
  );
  for (const [key, qty, delta, amount] of [
    ['pf', c?.vsTargetQuantity, c?.vsDeltaQuantity, c?.vsNotional],
    ['hl', c?.hlTargetQuantity, c?.hlDeltaQuantity, c?.hlNotional]
  ]) {
    const q = qty == null ? null : dec(qty);
    const adj = result.adjust?.[key];
    let hint = '待核对挂单';
    if (adj?.remaining != null)
      hint = dec(adj.remaining).isZero()
        ? dec(delta).isZero()
          ? '保持现仓'
          : '挂单已覆盖差额'
        : action(adj.projected ?? result.qty[key], adj.remaining);
    if (result.advice?.source === 'existing') hint = '变化低于最小调仓阈值，建议保持';
    if (result.advice?.source === 'previous') hint = '沿用经本帧复核的调整 · ' + hint;
    put(key + '-summary', q == null ? '—' : (q.isZero() ? '空仓 ' : q.gt(0) ? '多 ' : '空 ') + money(amount));
    put(key + '-change', q == null ? '' : q.abs().toString() + ' ' + asset() + ' · ' + hint);
  }
  const projection = c ?? result.heldCash;
  const bridge = result.bridge;
  put(
    'cash-bridge',
    bridge
      ? '失败路径 Hype（U） · ' +
          Object.entries(ledgerLabels)
            .map(([k, label]) => label + ' ' + fmt(bridge.entries[k], 4))
            .join('，') +
          '，预计结算 ' +
          fmt(bridge.settled, 4) +
          '。显示舍入差 ' +
          presentLedger(bridge).rounding +
          ' U。'
      : ''
  );
  put('protect-funds', money(result.protect));
  put(
    'margin-funds',
    Array.isArray(result.marginHL)
      ? '买 ' + money(result.marginHL[0]) + ' / 卖 ' + money(result.marginHL[1])
      : money(result.marginHL)
  );
  put('success-hl', r.stage === 'challenge' ? '考核利润不可分' : money(projection?.expectedUserPayout));
  put(
    'fail-parts',
    projection?.failureHypeCash == null
      ? ''
      : 'Hype 结算现金 ' +
          money(projection.failureHypeCash) +
          ' ＋ 外部已到账 ' +
          money(projection.externalReceived)
  );
  put(
    'summary-margin',
    r.stage === 'funded' && projection?.pressureCashAfter != null
      ? '若首次分成到账，个人资金合计 ' + money(projection.pressureCashAfter)
      : ''
  );
  put(
    'summary-buffer',
    c?.priceBuffer != null
      ? '强平距离 ' + fmt(c.priceBuffer) + ' 价格单位'
      : c && dec(c.hlTargetQuantity).isZero()
        ? 'Hype 空仓，无强平价'
        : ''
  );
  const goalReached = result.stressedEquity != null && dec(result.stressedEquity).gte(r.challengeTarget);
  put(
    'reach-label',
    r.stage === 'funded'
      ? '出金阶段'
      : result.stressedEquity == null
        ? '未验证'
        : goalReached
          ? '条件下达到'
          : '条件下未到'
  );
  const stressNote =
    r.stage === 'funded'
      ? '两日考核压力仅用于考核阶段。'
      : !result.deadline
        ? '实际截止时间未配置，两日可达性未验证。'
        : !r.movePct
          ? '未验证两日触线可达性。'
          : !result.pressure
            ? '等待可计算的当前快照。'
            : '条件情景：假设实际截止前走完所填幅度，不按剩余时间外推波幅。有利变动 ' +
              r.movePct +
              '%。' +
              [1, -1]
                .map(
                  (d) =>
                    (d === 1 ? '做多' : '做空') +
                    '至少需 ' +
                    money(result.pressure[d]?.amount) +
                    '（' +
                    result.pressure[d]?.source +
                    '）'
                )
                .join('，') +
              (result.maximum?.amount
                ? '。' +
                  (result.maximum.complete ? '当前网格内最大可行 PF ' : '本次已验 PF 候选 ') +
                  money(result.maximum.amount)
                : '') +
              (c
                ? '。所选 PF ' +
                  money(c.vsNotional) +
                  '，条件净结算权益 ' +
                  money(result.stressedEquity) +
                  '。'
                : '');
  put('two-day', stressNote);
  put(
    'external-value',
    '计入个人保护的外部资金 ' +
      money(result.externalValue) +
      ' · 每单位原币 ' +
      (result.externalRate ?? '待核实') +
      ' USDC（' +
      (result.externalSource ?? '待核实') +
      '）' +
      (r.externalAt && !plan ? ' · 金额确认于 ' + clock(r.externalAt) : '') +
      ' · 在途 ' +
      money(r.inTransit) +
      ' · 待到账分成 ' +
      money(r.receivable ?? '0')
  );
  $('alternatives').hidden = r.mode !== 'auto';
  const rowsAuto = (result.top ?? []).map((c, i) =>
    cellRow([
      (i === 0 ? '首选' : i === 1 ? '第二优' : '候选 ' + (i + 1)) +
        ' · ' +
        signed(c.vsTargetQuantity) +
        ' / ' +
        money(c.vsNotional),
      signed(c.hlTargetQuantity) + ' / ' + money(c.hlNotional),
      pct(c.actualRatio),
      c.candidateLeverage ? c.candidateLeverage + '×' : '空仓',
      money(c.requiredInitialMargin),
      money(c.stressedSurplus ?? c.baseSurplus),
      money(c.worstCash),
      fmt(c.priceBuffer),
      money(c.initialMargin[0]),
      (c.funding
        ? '失败 / 成功成本 ' + money(c.funding.failCost) + ' / ' + money(c.funding.passCost) + ' · '
        : '') +
        '基础约束通过 · 失败端 ' +
        money(c.failureCash) +
        ' / 成功端 Hype ' +
        money(c.hlBeforePayout) +
        ' · 最低维持余量 ' +
        money(c.buffer)
    ])
  );
  for (const bad of result.rejections ?? [])
    rowsAuto.push(
      cellRow([
        '淘汰 · ' + signed(bad.pf) + ' / ' + money(bad.candidate?.vsNotional),
        signed(bad.hl) + ' / ' + money(bad.candidate?.hlNotional),
        pct(bad.candidate?.actualRatio),
        bad.candidate?.candidateLeverage ? bad.candidate.candidateLeverage + '×' : '—',
        money(bad.candidate?.requiredInitialMargin),
        money(bad.candidate?.stressedSurplus ?? bad.candidate?.baseSurplus),
        money(bad.candidate?.worstCash),
        fmt(bad.candidate?.priceBuffer),
        money(bad.candidate?.initialMargin?.[0]),
        (bad.candidate?.funding
          ? '失败 / 成功成本 ' +
            money(bad.candidate.funding.failCost) +
            ' / ' +
            money(bad.candidate.funding.passCost) +
            ' · '
          : '') +
          bad.why +
          (bad.check
            ? '，实算 ' +
              checkNumber(bad.check.actual, bad.check.unit) +
              ' / 要求 ' +
              checkNumber(bad.check.required, bad.check.unit) +
              '，差 ' +
              checkNumber(bad.check.shortfall, bad.check.unit) +
              ' ' +
              bad.check.unit
            : '') +
          (bad.gaps?.length > 1
            ? ' ｜ ' +
              bad.gaps
                .filter((gap) => gap.code !== bad.check?.code)
                .map(
                  (gap) =>
                    constraintReason(gap.code) +
                    (gap.shortfall == null
                      ? ' 待核实'
                      : ' 缺 ' + checkNumber(gap.shortfall, gap.unit) + ' ' + gap.unit)
                )
                .join('、')
            : '')
      ])
    );
  $('plan-comparison').hidden = r.mode !== 'auto';
  for (const [id, plan] of [
    ['size-plan', result.maximum],
    ['cash-plan', result.conservative]
  ]) {
    const pick = plan?.candidate;
    put(
      id,
      pick
        ? [
            'PF ' +
              directional(pick.vsTargetQuantity, pick.vsNotional) +
              ' / Hype ' +
              directional(pick.hlTargetQuantity, pick.hlNotional),
            '对冲比例 ' +
              pct(pick.actualRatio) +
              ' · 候选杠杆 ' +
              (pick.candidateLeverage ? pick.candidateLeverage + '×' : '空仓') +
              ' · 当前账户设置 ' +
              (configured ? configured + '×' : '未核实'),
            '失败端个人合计 ' +
              money(pick.failureCash) +
              ' / 成功端到账前 Hype ' +
              money(pick.hlBeforePayout),
            '最差个人现金 ' +
              money(pick.worstCash) +
              ' · Hype 初始保证金 ' +
              money(pick.requiredInitialMargin),
            '路径最低维持余量 ' +
              money(pick.stressedSurplus ?? pick.baseSurplus) +
              ' · 成功线至强平线距离 ' +
              (pick.priceBuffer == null
                ? '无可比较交点'
                : fmt(pick.stressPriceBuffer ?? pick.priceBuffer) + ' 价格单位'),
            plan.complete
              ? '当前输入、行情快照、已配置约束与已枚举数量网格内最优'
              : '本次搜索已找到的候选，最优性待验证',
            plan.audit?.status + (plan.audit?.gaps?.length ? ' · ' + plan.audit.gaps.join('、') : ''),
            id === 'cash-plan' && plan.unverified?.length ? '条件方案 · ' + plan.unverified.at(-1) : ''
          ]
            .filter(Boolean)
            .join('\n')
        : status
    );
  }
  const trace = result.trace;
  put('trace-id', trace ? trace.model + ' / ' + trace.id : '等待计算');
  put(
    'trace-sources',
    trace
      ? [
          '计算于 ' + trace.at,
          '规则 ' + trace.rulesId,
          '账户 ' + trace.accountsId,
          (m.source ?? '行情') + ' ' + trace.marketId,
          'VS ' + (m.pf?.asOf ?? '无时间'),
          'Hype ' + (m.hl?.asOf ?? '无时间'),
          'VS 资金 ' +
            (a.pf.source ?? '未确认') +
            (fieldTime(a.pf, 'equity') ? ' ' + fieldTime(a.pf, 'equity') : ''),
          'Hype 资金 ' +
            (a.hl.source ?? '未确认') +
            (fieldTime(a.hl, 'equity') ? ' ' + fieldTime(a.hl, 'equity') : '')
        ].join(' · ')
      : ''
  );
  $('trace-download').disabled = !trace;
  $('trace-download').onclick = () => {
    if (!trace) return;
    const { inputs, ...identity } = trace;
    const { trace: _, calculationRates, calculationMarket, ...outputs } = result;
    const payload = JSON.stringify(
      { ...identity, inputs: JSON.parse(inputs), outputs },
      (_, v) => (typeof v === 'bigint' ? String(v) : v),
      2
    );
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'hedge-' + trace.id + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const detail = $('trace-inputs').parentElement;
  const showInputs = () =>
    put('trace-inputs', trace && detail.open ? JSON.stringify(JSON.parse(trace.inputs), null, 2) : '');
  detail.ontoggle = showInputs;
  showInputs();
  const maximum = result.maximum,
    runner = result.top?.[1];
  put(
    'best-two',
    [
      maximum?.amount
        ? (maximum.complete ? '当前网格内最大可行 PF ' : '已找到的 PF 候选 ') +
          directional(maximum.candidate.vsTargetQuantity, maximum.amount) +
          ' / Hype ' +
          directional(maximum.candidate.hlTargetQuantity, maximum.candidate.hlNotional) +
          ' · ' +
          pct(maximum.candidate.actualRatio)
        : '',
      runner
        ? '第二优 PF ' +
          directional(runner.vsTargetQuantity, runner.vsNotional) +
          ' / Hype ' +
          directional(runner.hlTargetQuantity, runner.hlNotional) +
          ' · ' +
          pct(runner.actualRatio)
        : result.search
          ? '未找到第二个可行候选'
          : '',
      result.leverageStatus === 'LEVERAGE_UNVERIFIED' ? '账户设置未验证' : ''
    ]
      .filter(Boolean)
      .join(' ｜ ')
  );
  if ($('top-auto').textContent !== rowsAuto.map((x) => x.textContent).join(''))
    $('top-auto').replaceChildren(...rowsAuto);
  put(
    'flat-option',
    result.waiting?.personalCash != null
      ? '双边目标均为零时，按当前盘口平掉现仓后的个人现金 ' +
          money(result.waiting.personalCash) +
          '，其中 Hype ' +
          money(result.waiting.hlCash) +
          '；VS / Hype 差额成交费 ' +
          result.waiting.deltaFees.map(money).join(' / ') +
          '。空仓等待期间没有 VS 触线目标。'
      : ''
  );
  const rejected = result.eliminated;
  put(
    'rejected-auto',
    rejected
      ? '淘汰：PF ' +
          signed(rejected.pf) +
          '，Hype ' +
          signed(rejected.hl) +
          ' · ' +
          rejected.why +
          (rejected.check
            ? '，实算 ' +
              checkNumber(rejected.check.actual, rejected.check.unit) +
              ' / 要求 ' +
              checkNumber(rejected.check.required, rejected.check.unit) +
              '，差 ' +
              checkNumber(rejected.check.shortfall, rejected.check.unit) +
              ' ' +
              rejected.check.unit +
              '（' +
              rejected.check.source +
              '）'
            : '')
      : result.issues.join(' · ')
  );
  put('stress-assumptions', coverage + '。基础结果已计盘口成交费用。');
  put(
    'auto-search',
    result.search
      ? (result.search.complete
          ? c
            ? '当前输入与配置、五档深度、双边合法数量和杠杆网格内最优'
            : '当前输入与配置的合法网格搜索完成'
          : '搜索未穷尽，仅展示已验证候选') +
          ' · 精算 ' +
          result.search.evaluations +
          ' 组 · ' +
          result.autoStatus +
          ' · 版本 ' +
          result.stateVersion +
          ' · ' +
          (result.domain ?? [])
            .map(
              (x) =>
                (x.pfSide > 0 ? 'PF 多/Hype 空' : 'PF 空/Hype 多') +
                '：PF ' +
                (x.pf ? x.pf.min + '–' + x.pf.max + '（步长 ' + x.pf.step + '）' : '空集') +
                ' / Hype ' +
                (x.hl ? x.hl.min + '–' + x.hl.max + '（步长 ' + x.hl.step + '）' : '空集')
            )
            .join(' ｜ ')
      : (result.autoStatus ?? '')
  );
  if (result.flatHold)
    for (const k of ['pf', 'hl']) {
      put(k + '-summary', '空仓 0.00 U');
      put(k + '-change', '保持等待');
    }
  put('fail-summary', money(projection?.failureCash));
  put('pass-summary', money(projection?.hlBeforePayout));
  for (const [id, diff] of [
    ['fail', result.failVsPrincipal],
    ['pass', result.passVsPrincipal]
  ])
    put(
      id + '-change',
      diff == null
        ? ''
        : (id === 'pass' ? (r.stage === 'funded' ? '若分成到账，' : '') + '含外部资金的个人合计' : '') +
            '相对保护本金及额外成本 ' +
            signedMoney(diff)
    );
  put(
    'current-h',
    result.currentH == null
      ? result.qty.pf === '0'
        ? result.qty.hl === '0'
          ? '不适用 / 双边无现仓'
          : 'VS 空仓 · 比例无定义'
        : '—'
      : pct(result.currentH) + (result.sameDirection ? ' · 同向敞口' : '')
  );
  put('range', b?.min == null ? '—' : dec(b.max).lt(b.min) ? '无交集' : pct(b.min) + ' – ' + pct(b.max));
  const budgetOnly =
    !stale &&
    !result.refreshPending &&
    !c &&
    !result.heldCash &&
    b?.selected &&
    !result.notices.some((n) => /已到期|待到账|待平台/.test(n));
  put(
    'target-h',
    c
      ? pct(c.actualRatio) +
          (c.code === 'FEASIBLE' && result.autoStatus !== 'AUTO_PARTIAL'
            ? result.search && !result.search.complete
              ? ' · 已验候选'
              : result.stress?.missing.length || result.stress?.zero.length
                ? ' · 基础候选'
                : result.leverageStatus === 'LEVERAGE_UNVERIFIED'
                  ? ' · 条件推荐'
                  : ' · 推荐'
            : c.code === 'FEASIBLE'
              ? ' · 基础候选（条件方案）'
              : ' · 待验证')
      : '—'
  );
  const verified = result.verified;
  put(
    'verified-range',
    verified
      ? '本次搜索已验证的离散比例 ' +
          pct(verified.min) +
          ' 至 ' +
          pct(verified.max) +
          '，共 ' +
          verified.count +
          ' 个可行比例'
      : '本次搜索已验证的可行比例：' + (c ? '保证金参数待补' : '暂无')
  );
  $('ratio-points').hidden = !verified;
  put('points', (result.points ?? []).map((x) => dec(x).times(100).toFixed(5) + '%').join('、'));
  put(
    'basis',
    r.mode === 'auto'
      ? '在现金留存与风险约束内比较 PF 仓位、最差现金和强平缓冲，同等风险选最低可行杠杆。'
      : '固定所选一侧的已成交仓位，在可行候选中优先成功端剩余现金。'
  );
  put(
    'profile-source',
    '来源：' +
      (r.editedAt ? '本机规则，最近编辑 ' + clock(r.editedAt) : '初始规则，待按平台确认') +
      '。保护本金中含报名费 ' +
      money(r.registration) +
      '，本金外需收回 ' +
      money(r.outsideCosts) +
      '。当前权益按账户快照计入。'
  );
  put(
    'bounds-detail',
    b?.min != null
      ? '保护下限 ' +
          pct(b.min) +
          ' · 到账前现金上限 ' +
          pct(b.cashMax) +
          ' · Hype 初始保证金按每对目标数量和候选档位单独核验' +
          (r.stage === 'funded'
            ? ' · 整轮利润上限 ' + (b.profitMax == null ? '缺少本轮起点' : pct(b.profitMax))
            : '') +
          (b.code !== 'FEASIBLE'
            ? ' · 按最低保护比例，成功端现金 ' +
              money(b.atMinimum.hlBefore) +
              '，要求留存 ' +
              money(r.R_success)
            : '')
      : '资金范围只需两边当前权益和已设规则。'
  );
  put(
    'bound-formula',
    b?.min != null && result.protect != null
      ? '失败保护下限 = max(0, (保护本金及额外历史成本 − 个人保护资金 + 额外摩擦预算) ÷ VS 到失败线的净值距离) = max(0, (' +
          fmt(dec(r.B).plus(r.outsideCosts)) +
          ' − ' +
          fmt(result.protect) +
          ' + ' +
          fmt(r.k) +
          ') ÷ ' +
          fmt(b.failureUnit) +
          ') = ' +
          pct(b.min) +
          '。成功端现金上限 = (Hype 权益 − 最低留存 − 额外摩擦预算) ÷ VS 到成功线的净值距离 = (' +
          fmt(result.cash.hl) +
          ' − ' +
          fmt(r.R_success) +
          ' − ' +
          fmt(r.k) +
          ') ÷ ' +
          fmt(b.successUnit) +
          ' = ' +
          pct(b.cashMax) +
          '。实际比例为两边目标仓位每单位价格变动的美元盈亏绝对值之比。取整后逐笔验算成交成本、可用保证金和维持保证金。'
      : '需要双方有效权益及阶段规则，才能代入上下限公式。'
  );
  const rows = [],
    orders = [];
  for (const [s, name, target, delta, notional] of [
    ['pf', 'VS / PF', c?.vsTargetQuantity, c?.vsDeltaQuantity, c?.vsNotional],
    ['hl', 'Hype', c?.hlTargetQuantity, c?.hlDeltaQuantity, c?.hlNotional]
  ]) {
    const q = result.qty[s],
      adj = result.adjust?.[s],
      u = ' ' + asset();
    const amt = (x) =>
      x == null ? '未知' : dec(x).eq(0) ? '空仓' : (dec(x).gt(0) ? '多 ' : '空 ') + dec(x).abs() + u;
    rows.push(
      cellRow([
        name,
        amt(q) + (result.currentNotional[s] != null ? ' · ' + money(result.currentNotional[s]) : ''),
        target == null
          ? ((r.mode === 'keepPF' && s === 'pf') || (r.mode === 'keepHL' && s === 'hl')) && q != null
            ? '保持 ' + amt(q)
            : '—'
          : amt(target) + ' · ' + money(notional),
        action(q, delta) +
          (delta != null && !dec(delta).isZero()
            ? ' · ' +
              money(
                out(
                  dec(delta)
                    .abs()
                    .times(String(m[s].mark))
                    .times(String((s === 'pf' ? m.spec : m.hl)?.contractMultiplier ?? '1'))
                    .times(String((s === 'pf' ? m.spec : m.hl)?.settlementToUSDC ?? '1'))
                )
              )
            : ''),
        adj
          ? adj.remaining == null
            ? '待核对挂单'
            : dec(adj.remaining).isZero()
              ? '保持 / 已覆盖'
              : action(adj.projected ?? q, adj.remaining)
          : '—'
      ])
    );
    const list = a[s].orders;
    const orderSummary =
      list == null
        ? '挂单未知'
        : !list.length
          ? '无挂单'
          : list
              .map((o) => signed(o.qty) + (o.conditional ? ' 触发单' : '') + (o.reduceOnly ? ' 只减仓' : ''))
              .join('、');
    orders.push(
      name +
        ' ' +
        orderSummary +
        (adj?.projected != null ? '；若全部成交 ' + signed(adj.projected) + u + ' · ' + adj.text : '')
    );
    const rawAccount = a[s].unsupported
      ? '该资金池待核实 · API 原始权益 ' + money(a[s].rawEquity) + '。'
      : '';
    put(
      s + '-capacity',
      rawAccount +
        (a[s].directionalFree
          ? 'API 可用保证金 · 买入 ' +
            money(a[s].directionalFree[0]) +
            ' / 卖出 ' +
            money(a[s].directionalFree[1])
          : '')
    );
    $(s + '-free').hidden = !!a[s].directionalFree;
    $(s + '-free').parentElement.hidden = !!a[s].directionalFree;
    const origin = a[s].source || '手工确认';
    put(
      s + '-meta',
      origin +
        ' · ' +
        clock(fieldTime(a[s], 'equity')) +
        ' · ' +
        freshnessLabel(fieldTime(a[s], 'equity'), r.accountSecs) +
        (result.cash[s] != null
          ? ' · ' + (a[s].anchor ? '按标记价估算 ' : '权益快照 ') + money(result.cash[s])
          : '')
    );
  }
  if (plan)
    for (const s of ['pf', 'hl'])
      put(
        s + '-meta',
        '预设起始权益 ' + money(a[s].equity) + (r.planCrossFlat ? ' · 规划空仓' : ' · 起始持仓待确认')
      );
  if ($('legs').textContent !== rows.map((row) => row.textContent).join(''))
    $('legs').replaceChildren(...rows);
  put('order-detail', orders.join(' ｜ '));
  const context = JSON.stringify([r, asset(), useAPI(), a.pf.at, a.pf.qty, a.hl.at, a.hl.qty]);
  if (c) previous = { context, asOf: now(), delta: c.hlDeltaQuantity, h: c.actualRatio };
  put(
    'previous',
    stale && previous?.context === context
      ? '过期前最后一次计算（仅供核对） ' +
          clock(previous.asOf) +
          ' · h ' +
          pct(previous.h) +
          ' · Hype 差额 ' +
          signed(previous.delta) +
          ' ' +
          asset()
      : ''
  );
  put(
    'reason',
    [...new Set([...result.issues, ...(c ? ['差额按五档盘口计费；已有仓位保持时开仓费为零。'] : [])])].join(
      ' · '
    )
  );
  const budget =
    !stale && budgetOnly && !result.issues.some((x) => /无解|没有满足|没有可行/.test(x)) ? b.atMinimum : null;
  const lines = [
    ['失败端 Hype 结算现金', money(projection?.failureHypeCash)],
    ['外部已到账资金', money(result.externalValue)],
    ['失败端个人保护资金合计', money(projection?.failureCash ?? budget?.fail)],
    ['成功端到账前 Hype 现金', money(projection?.hlBeforePayout)],
    ['成功端分成到账前个人资金（含外部已到账）', money(projection?.cashBeforePayout ?? budget?.before)],
    ...(r.stage === 'funded'
      ? [['若首次分成到账后个人合计', money(projection?.pressureCashAfter ?? budget?.after)]]
      : []),
    ['失败端相对保护本金及额外成本', money(result.failVsPrincipal)],
    ['成功端相对保护本金及额外成本', money(result.passVsPrincipal)],
    ['从当前起的现金变化', money(result.forward)],
    ['整轮条件净收益', r.ref ? money(result.round) : '缺少本轮起点'],
    ['当前可分金额（未到账）', r.stage === 'funded' ? money(result.claim) : '考核期不可分']
  ];
  renderPairs('cash-results', lines);
  renderRisk(result, a, m);
  put(
    'rule-events',
    [...(budget ? ['仅按资金参考比例估算，具体成交成本待验算'] : []), ...result.notices].join(' · ')
  );
  if (stale) lastCalculation = '当前时间 ' + clock(now()) + ' · 过期，暂停调整量';
  else
    lastCalculation =
      '计算于 ' + clock(result.calculatedAt ?? now()) + (result.refreshPending ? ' · 新行情正在重算' : '');
  put(
    'times',
    lastCalculation +
      (plan
        ? ' · 资金来自预设，行情时间见双边报价'
        : ' · PF 快照 ' + clock(a.pf.at) + ' · Hype 快照 ' + clock(a.hl.at))
  );
  const qs = ['pf', 'hl'].map((s) => {
    const q = m[s];
    return (
      (s === 'pf' ? 'Vest' : 'Hyperliquid') +
      ' ' +
      (q
        ? '标记 ' +
          q.mark +
          ' · 买/卖 ' +
          q.levels?.[0]?.[0]?.[0] +
          ' / ' +
          q.levels?.[1]?.[0]?.[0] +
          ' · ' +
          clock(q.asOf)
        : '等待报价')
    );
  });
  for (const [i, k] of ['pf', 'hl'].entries()) {
    const q = m[k],
      manual = $('quote-source').value === 'manual';
    put(
      k + '-quote',
      qs[i] +
        (q
          ? ' · ' +
            (manual ? '手工盘口' : k === 'pf' ? 'Vest WebSocket' : q.bookSource) +
            ' · ' +
            freshnessLabel(q.asOf, r.quoteSecs) +
            (q.markAt ? ' · 标记价 ' + clock(q.markAt) + ' ' + freshnessLabel(q.markAt, r.quoteSecs) : '')
          : '')
    );
  }
  put(
    'field-sources',
    plan
      ? '来源为规划参数。已保存的真实账户读数可在当前账户快照中查看。'
      : ['pf', 'hl']
          .map((k) => {
            if (k === 'hl' && useAPI()) return 'Hype 主网账户查询 ' + clock(a.hl.at);
            return (
              (k === 'pf' ? 'VS' : 'Hype') +
              ' ' +
              Object.entries(local()[k].origins ?? {})
                .map(
                  ([field, meta]) =>
                    (legFields[field] ??
                      { qty: '持仓', equity: '权益', leverage: '杠杆', marginMode: '保证金模式' }[field] ??
                      field) +
                    ' ' +
                    meta.source +
                    ' ' +
                    clock(meta.at) +
                    ' ' +
                    freshnessLabel(meta.at, r.accountSecs)
                )
                .join('、')
            );
          })
          .join(' ｜ ')
  );
  put(
    'quotes',
    ($('quote-source').value === 'api' ? '公开行情' : '手工盘口') +
      ' ｜ ' +
      qs.join(' ｜ ') +
      (m.pf?.asOf && m.hl?.asOf
        ? ' · 双边时差 ' + Math.abs(Date.parse(m.pf.asOf) - Date.parse(m.hl.asOf)) + ' ms'
        : '') +
      (quoteError ? ' ｜ ' + quoteError : '')
  );
  const frameRates = result.calculationRates ?? rates;
  put(
    'fx-source',
    '共同价格因子按 USDC/USDT 折算 · ' +
      (r.fx && fresh(r.fxAt, Date.now(), Number(r.accountSecs) * 1000)
        ? '手工 ' + r.fx + ' · ' + clock(r.fxAt)
        : ['USDC', 'USDT']
            .map(
              (k) =>
                k +
                '/USD ' +
                (frameRates[k]
                  ? fmt(String(frameRates[k].rate), 6) +
                    ' ' +
                    frameRates[k].source +
                    ' ' +
                    clock(frameRates[k].asOf)
                  : '未取得')
            )
            .join(' ｜ '))
  );
  put(
    'sync-status',
    useAPI()
      ? apiError ||
          (api
            ? 'Hype 主网 · ' +
              api.mode +
              ' · 返回账户价值 ' +
              money(api.rawEquity) +
              ' · 已用保证金 ' +
              money(api.used) +
              ' · 可转出 ' +
              money(api.withdrawable)
            : '等待读取公开地址')
      : plan
        ? '使用预设资金和双边公开行情。账户余额、持仓和挂单按规划起点计算。'
        : '当前使用手工账户快照，公开行情独立更新。'
  );
}
// Consume one coherent public tick at a time. A slow scan gets a chance to
// publish before polling the latest book again; the independent expiry timer
// still revokes data at its original timestamp.
function pollNextMarket() {
  if (running && ['pf', 'hl'].every((k) => quoteClock(feed[k], Date.now(), Number(r.quoteSecs) * 1000).ok)) {
    quoteTimer = setTimeout(pollNextMarket, 120);
    return;
  }
  refreshMarket();
}
async function refreshMarket() {
  const version = ++feedVersion,
    symbol = asset();
  clearTimeout(quoteTimer);
  const res = await Promise.allSettled(
    ['/api/current-market?asset=' + encodeURIComponent(symbol), '/api/usd-rates'].map(async (url) => {
      const resp = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!resp.ok) throw Error('HTTP ' + resp.status);
      return resp.json();
    })
  );
  if (version !== feedVersion) return;
  if (res[0].status === 'fulfilled' && res[0].value.asset === symbol) {
    feed = res[0].value;
    quoteError = Object.values(feed.errors ?? {})
      .filter(Boolean)
      .join(' · ');
  } else {
    quoteError = '本地行情连接断开';
    feed = { ...feed, errors: { ...feed.errors, pf: quoteError, hl: quoteError } };
  }
  if (res[1].status === 'fulfilled') rates = res[1].value.rates ?? {};
  render();
  quoteTimer = setTimeout(pollNextMarket, 1250);
}
async function refreshAccount() {
  const version = ++accountVersion;
  clearTimeout(accountTimer);
  if (!useAPI()) {
    api = null;
    apiError = '';
    inputs();
    render();
    return;
  }
  const wallet = $('wallet').value.trim();
  if (!/^0x[0-9a-f]{40}$/i.test(wallet)) {
    api = null;
    apiError = '请填写完整的公开地址';
    inputs();
    render();
    return;
  }
  try {
    const value = await accountSnapshot(wallet, asset(), async (body) => {
      const resp = await fetch('/api/hype-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ network: 'mainnet', request: body }),
        signal: AbortSignal.timeout(7000)
      });
      if (!resp.ok) throw Error('主网查询失败');
      return resp.json();
    });
    if (version !== accountVersion) return;
    if (api?.at && value.at < api.at) throw Error('Hype 返回旧快照，保留最近读数');
    api = value;
    apiError = '';
  } catch (e) {
    if (version !== accountVersion) return;
    apiError = e.message;
  }
  inputs();
  render();
  accountTimer = setTimeout(refreshAccount, 5000);
}
function invalidatePreview() {
  pending = null;
  $('confirm').disabled = true;
  put('preview', '');
}
function manualImport(side, v, stamp) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('每个平台须提供当前快照对象');
  const f = {};
  for (const k of ['equity', 'qty', 'anchor', 'leverage', 'otherHold', 'free', 'maxQty']) {
    if (v[k] != null && v[k] !== '')
      f[k] = out(
        (['anchor', 'leverage'].includes(k)
          ? positive
          : ['otherHold', 'free', 'maxQty'].includes(k)
            ? nonnegative
            : dec)(String(v[k]))
      );
  }
  if (v.marginMode != null) {
    if (!['cross', 'isolated'].includes(v.marginMode)) throw Error('保证金模式无效');
    f.marginMode = v.marginMode;
  }
  if (v.orders !== undefined) f.orders = approvedOrders(v.orders);
  if (v.otherPositions !== undefined) f.otherPositions = v.otherPositions === true;
  if (!Object.keys(f).length) throw Error('未读取到可用字段');
  if (v.currency && v.currency !== 'USDC') throw Error('此表单需要 USDC 等值快照');
  if (v.at != null && (!Number.isFinite(Date.parse(v.at)) || Date.parse(v.at) > Date.now() + 1000))
    throw Error('快照时间无效');
  return { side, fields: f, stamp: v.at ?? stamp };
}
function parseVS(raw, stamp) {
  const v = manualVs(raw, 'USDC', stamp),
    listed = v.positions?.filter((p) => p.symbol === asset() + '-PERP' || p.symbol === asset());
  if (v.symbol && ![asset(), asset() + '-PERP'].includes(v.symbol)) throw Error('VS 快照与当前合约不同');
  if (listed?.length > 1) throw Error('同品种多笔分仓，请核对后输入带符号净数量');
  const f = {
    equity: v.fields.equity,
    free: v.fields.free,
    anchor: v.fields.mark,
    at: v.accountAt ?? v.occurredAt ?? stamp
  };
  if (listed) {
    f.qty = listed[0]?.qty ?? '0';
    f.otherPositions = listed.length !== v.positions.length;
  }
  return { edit: manualImport('pf', f, stamp), stage: v.stage };
}
$('parse').onclick = () => {
  invalidatePreview();
  try {
    const stamp = now(),
      raw = $('paste').value.trim(),
      edits = [];
    let stage = null;
    if ($('paste-kind').value === 'both') {
      const j = JSON.parse(raw);
      if (j.asset !== asset()) throw Error('快照品种与当前合约不同');
      for (const k of ['pf', 'hl']) if (j[k]) edits.push(manualImport(k, j[k], stamp));
      stage = j.stage;
    } else {
      const parsed = parseVS(raw, stamp);
      edits.push(parsed.edit);
      stage = parsed.stage;
    }
    if (!edits.length || (stage && !['challenge', 'funded'].includes(stage)))
      throw Error('当前快照或阶段无效');
    if (edits.some((e) => e.side === 'hl') && useAPI()) throw Error('请切换到手工 Hype 来源后确认');
    pending = {
      edits,
      stage,
      source: $('paste-kind').value === 'vs' ? 'VS 粘贴确认' : '手工确认 · 快照导入'
    };
    put('preview', JSON.stringify(pending, null, 2));
    $('confirm').disabled = false;
  } catch (e) {
    put('preview', e.message);
  }
};
function applySnapshot(snapshot) {
  if (planning()) throw Error('请先切换到当前账户快照，再写入识别结果');
  for (const e of snapshot.edits) {
    const old = local()[e.side];
    const stamps = Object.keys(e.fields).map((k) => old.origins?.[k]?.at);
    if ('qty' in e.fields) stamps.push(old.qtyAt);
    if ('equity' in e.fields) stamps.push(state.shared[e.side]?.at);
    if (stamps.some((t) => t && Date.parse(e.stamp) < Date.parse(t)))
      throw Error('识别结果早于当前快照，请核对平台时间。');
  }
  for (const e of snapshot.edits) updateLeg(e.side, e.fields, e.stamp, snapshot.source);
  if (snapshot.stage) {
    r.stage = snapshot.stage;
    r.editedAt = now();
  }
  save();
  inputs();
  render();
}
$('confirm').onclick = () => {
  if (!pending) return;
  try {
    applySnapshot(pending);
    invalidatePreview();
    put('preview', '已确认当前快照');
  } catch (e) {
    put('preview', e.message);
  }
};

let bridge = null;
async function bridgeRequest(action, body) {
  const response = await fetch(
    '/api/bridge/' + action,
    body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const value = await response.json();
  if (!response.ok) throw Error(value.error ?? '本机桥接失败');
  return value;
}
function clearBridge() {
  bridge = null;
  $('bridge-script').value = '';
  $('bridge-script').hidden = true;
  $('bridge-copy').disabled = true;
}
$('bridge-pair').onclick = async () => {
  try {
    const assetId = asset(),
      origin = new URL($('bridge-origin').value).origin;
    const paired = await bridgeRequest('pair', { origin, assetId });
    if (assetId !== asset()) return;
    bridge = { ...paired, sequence: 0 };
    $('bridge-script').value = captureScript({ ...paired, baseURL: location.origin });
    $('bridge-script').hidden = false;
    $('bridge-copy').disabled = false;
    put(
      'bridge-state',
      '已配对 ' +
        assetId +
        ' · ' +
        origin +
        '，有效至 ' +
        clock(new Date(paired.expires).toISOString()) +
        '。在来源页确认 USDC 等值快照后自动更新。'
    );
  } catch (e) {
    put('bridge-state', e.message);
  }
};
$('bridge-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('bridge-script').value);
    put('bridge-state', '已复制，请在配对的 VS 页面核对并发送快照。');
  } catch {
    $('bridge-script').select();
    put('bridge-state', '已选中采集脚本，可直接复制。');
  }
};
$('bridge-revoke').onclick = async () => {
  try {
    await bridgeRequest('revoke', {});
    clearBridge();
    put('bridge-state', '配对已撤销');
  } catch (e) {
    put('bridge-state', e.message);
  }
};
async function pollBridge() {
  if (planning()) return;
  const pair = bridge;
  if (!pair) return;
  if (Date.now() >= pair.expires) {
    clearBridge();
    put('bridge-state', '配对已到期');
    return;
  }
  try {
    const msg = await bridgeRequest('latest');
    if (
      !msg ||
      pair !== bridge ||
      pair.assetId !== asset() ||
      msg.assetId !== asset() ||
      msg.sequence <= pair.sequence
    )
      return;
    pair.sequence = msg.sequence;
    const parsed = parseVS(JSON.stringify(msg.snapshot), msg.snapshot.asOf);
    applySnapshot({ edits: [parsed.edit], stage: parsed.stage, source: 'VS 本机桥接 · ' + pair.origin });
    put('bridge-state', '已接收当前账户快照 · ' + clock(msg.receivedAt));
  } catch (e) {
    put('bridge-state', e.message);
  }
}
setInterval(pollBridge, 1500);
$('paste').oninput = invalidatePreview;
$('paste-kind').onchange = invalidatePreview;
for (const k of [
  'mode',
  'stage',
  'B',
  'R_success',
  'R_free',
  'riskPreference',
  'receiptSource',
  'externalCurrency',
  ...Object.keys(ruleFields)
]) {
  $(k).addEventListener('input', () => {
    r[k] = $(k).value.trim();
    if (k === 'mode' && r.mode !== 'auto') $('desk-details').open = true;
    r.editedAt = now();
    if (k === 'stage' || (planning() && k === 'registration')) inputs();
    if (k === 'deadlineMark') {
      r.deadlineAsset = asset();
      r.deadlineBound = r.deadline;
    }
    if (k === 'deadline') {
      r.deadlineMark = '';
      $('deadlineMark').value = '';
    }
    if (k === 'receivedPayout' || k === 'receiptSource') r.receivedPayoutAt = r.editedAt;
    if (k === 'external' || k === 'externalCurrency') r.externalAt = r.editedAt;
    if (k === 'externalFx') r.externalFxAt = now();
    if (k === 'externalCurrency') {
      r.externalFx = '';
      r.externalFxAt = null;
      $('externalFx').value = '';
    }
    if (k === 'fx') r.fxAt = now();

    save();
    render();
  });
}
for (const s of ['pf', 'hl'])
  for (const k of ['equity', 'qty', ...Object.keys(legFields), 'leverage', 'marginMode']) {
    const el = $(s + '-' + k);
    if (!el) continue;
    el.addEventListener('input', () => {
      if (planning() || (s === 'hl' && useAPI())) return;
      try {
        const str = el.value.trim(),
          value =
            k === 'orders'
              ? str
                ? str === '0'
                  ? []
                  : approvedOrders(str.split(/[,，]/).map((q) => ({ qty: q.trim() })))
                : null
              : str;
        updateLeg(s, { [k]: value });
        delete local()[s].error;
      } catch (e) {
        local()[s].error = e.message;
        if (k === 'orders') local()[s].orders = null;
      }
      save();
      render();
    });
  }
for (const field of Object.keys(planFields))
  $(field).oninput = () => {
    if (!planning()) return;
    const followCapital = field === 'planCapital' && r.B === r.planCapital;
    r[field] = $(field).value.trim();
    if (followCapital) r.B = r[field];
    r.editedAt = now();
    save();
    inputs();
    render();
  };
$('plan-cross-flat').onchange = () => {
  if (planning()) {
    r.planCrossFlat = $('plan-cross-flat').checked;
    r.editedAt = now();
    save();
    inputs();
    render();
  }
};
$('funding-view').onchange = () => {
  state.fundingView = $('funding-view').value;
  r = planning() ? state.planRules : state.rules;
  api = null;
  previous = null;
  cancelAuto();
  invalidatePreview();
  save();
  manualPrices = null;
  $('quote-source').value = 'api';
  inputs();
  render();
  refreshAccount();
};
$('confirm-balances').onclick = () => {
  const stamp = now(),
    sides = useAPI() ? ['pf'] : ['pf', 'hl'];
  try {
    const edits = sides.map((side) => {
      const equity = out(dec($(side + '-equity').value.trim()));
      const free = out(nonnegative($(side + '-free').value.trim()));
      return [side, { equity, free }];
    });
    for (const [side, fields] of edits) updateLeg(side, fields, stamp, '手工核对平台余额');
    save();
    inputs();
    render();
    put('flat-feedback', '已记录本次核对的权益与可用保证金 · ' + clock(stamp));
  } catch {
    put('flat-feedback', '请先填写两边实际权益与可用保证金，再确认。');
  }
};
// Each fact is confirmed independently. A full-account declaration may supersede
// stale records on other symbols, but a fresh conflicting position/order needs review.
const factNames = { qty: '全账户空仓', orders: '全账户无挂单', marginMode: '使用全仓' };
function confirmFacts(sides, fields) {
  if (planning()) return;
  const stamp = now(),
    ttl = Number(r.accountSecs) * 1000;
  for (const side of sides) {
    if (side === 'hl' && useAPI()) return;
    const conflict = Object.values(state.assets).some((pair) => {
      const v = pair[side];
      return (
        v &&
        ((fields.includes('qty') &&
          ((v.otherPositions && fresh(v.origins?.otherPositions?.at ?? v.qtyAt, Date.now(), ttl)) ||
            (Number(v.qty) && fresh(v.qtyAt, Date.now(), ttl)))) ||
          (fields.includes('orders') && v.orders?.length && fresh(v.origins?.orders?.at, Date.now(), ttl)))
      );
    });
    if (conflict) return put('flat-feedback', '当前快照有持仓或挂单，请先核对对应品种。');
  }
  for (const side of sides) {
    for (const [symbol, pair] of Object.entries(state.assets)) {
      const v = pair[side];
      if (symbol === asset() || !v) continue;
      v.origins ??= {};
      for (const field of fields.filter((k) => k !== 'marginMode')) {
        v[field] = field === 'qty' ? '0' : [];
        v.origins[field] = { at: stamp, source: '确认' + factNames[field] };
        if (field === 'qty') {
          v.qtyAt = stamp;
          v.anchor = null;
          v.otherPositions = false;
        }
      }
    }
    for (const field of fields) {
      const value = field === 'qty' ? '0' : field === 'orders' ? [] : 'cross';
      updateLeg(side, { [field]: value }, stamp, '手工确认' + factNames[field]);
      if (field === 'qty') {
        local()[side].allFlatAt = stamp;
        local()[side].otherPositions = false;
      }
      if (field === 'orders') local()[side].noOrdersAt = stamp;
    }
    const v = local()[side];
    if (
      fresh(v.allFlatAt, Date.now(), ttl) &&
      fresh(v.noOrdersAt, Date.now(), ttl) &&
      v.qty === '0' &&
      v.orders?.length === 0
    ) {
      const confirmed = v.allFlatAt < v.noOrdersAt ? v.allFlatAt : v.noOrdersAt;
      updateLeg(side, { flatConfirmedAt: confirmed, otherHold: '0' }, confirmed, '全账户持仓及挂单均已核对');
    }
  }
  put(
    'flat-feedback',
    '已确认 ' +
      sides.map((s) => (s === 'pf' ? 'VS' : 'Hype')).join(' / ') +
      ' ' +
      fields.map((k) => factNames[k]).join('、') +
      ' · ' +
      clock(stamp)
  );
  inputs();
  save();
  render();
}
for (const side of ['pf', 'hl'])
  for (const field of Object.keys(factNames)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'confirm-' + side + '-' + field;
    btn.textContent = (side === 'pf' ? 'VS ' : 'Hype ') + factNames[field];
    btn.onclick = () => confirmFacts([side], [field]);
    $('separate-confirm').append(btn);
  }
$('confirm-flat').onclick = () => {
  if (planning() || !window.confirm('确认刚刚核对两边全账户空仓、无挂单，并且均使用全仓模式？')) return;
  confirmFacts(useAPI() ? ['pf'] : ['pf', 'hl'], Object.keys(factNames));
};
$('ledger-exact').onchange = render;
$('bound-details').ontoggle = render;
window.addEventListener('storage', (event) => {
  if (event.key !== key) return;
  const next = JSON.parse(localStorage.getItem(key) || 'null');
  if (next?.version !== 1) return;
  Object.assign(state, { assets: next.assets, shared: next.shared, asset: next.asset });
  state.rules = { ...rules, ...splitReserves(next.rules) };
  state.planRules = { ...rules, ...planDefaults, ...splitReserves(next.planRules) };
  r = planning() ? state.planRules : state.rules;
  const switched = feed.asset !== asset();
  if (switched) {
    feed = {};
    api = null;
    manualPrices = null;
  }
  invalidatePreview();
  inputs();
  render();
  if (switched) {
    refreshMarket();
    refreshAccount();
  }
});
$('asset').onchange = () => {
  if (bridge) {
    clearBridge();
    bridgeRequest('revoke', {}).catch(() => {});
    put('bridge-state', '合约已切换，请重新配对。');
  }
  state.asset = $('asset').value;
  feed = {};
  api = null;
  manualPrices = null;
  invalidatePreview();
  save();
  inputs();
  render();
  refreshMarket();
  refreshAccount();
};
$('hl-source').onchange = () => {
  api = null;
  invalidatePreview();
  refreshAccount();
};
$('wallet').oninput = () => {
  api = null;
  if ($('wallet').value.trim()) $('hl-source').value = 'api';
  refreshAccount();
};
$('sync').onclick = () => {
  refreshMarket();
  refreshAccount();
};
$('quote-source').onchange = render;
$('confirm-quote').onclick = () => {
  try {
    const j = JSON.parse($('manual-quote').value);
    if (j.asset !== asset()) throw Error('品种不匹配');
    const both = {};
    for (const k of ['pf', 'hl']) {
      const q = j[k],
        spec = feed[k];
      if (!spec || !q || !fresh(q.asOf, Date.now(), Number(r.quoteSecs) * 1000))
        throw Error('需已识别的合约规格及新鲜盘口来源时间');
      const checked = q.levels.map((side) =>
        side.map(([px, size]) => [out(positive(String(px))), out(positive(String(size)))])
      );
      if (
        checked.length !== 2 ||
        !checked[0].length ||
        !checked[1].length ||
        dec(checked[0][0][0]).gt(checked[1][0][0])
      )
        throw Error('盘口无效');
      both[k] = {
        ...spec,
        bookAt: q.bookAt ?? q.asOf,
        markAt: q.markAt ?? q.asOf,
        bookSource: '手工盘口',
        mark: out(positive(String(q.mark))),
        asOf: q.asOf,
        levels: checked
      };
    }
    manualPrices = both;
    $('quote-source').value = 'manual';
    put('manual-status', '已确认手工盘口');
    render();
  } catch (e) {
    put('manual-status', e.message);
  }
};
setupScan(() => {
  $('desk-details').open = true;
  $('quick-entry').click();
});
inputs();
render();
refreshMarket();
// A stalled network must not leave an old actionable delta on screen.
let quality = '';
setInterval(() => {
  const t = Date.now(),
    m = market();
  const next = [
    completed?.stamps.every((v) => fresh(v, t, Number(r.quoteSecs) * 1000)) ?? false,
    ...['pf', 'hl'].map((k) => quoteClock(m[k], t, Number(r.quoteSecs) * 1000).ok),
    ...['pf', 'hl'].map((k) => fresh(account(k).at, t, Number(r.accountSecs) * 1000)),
    ...['pf', 'hl'].flatMap((k) =>
      Object.values(local()[k].origins ?? {}).map((meta) => fresh(meta.at, t, Number(r.accountSecs) * 1000))
    ),
    !!r.deadline && Date.parse(r.deadline) <= t,
    fresh(r.fxAt, t, Number(r.accountSecs) * 1000),
    fresh(r.externalAt, t, Number(r.accountSecs) * 1000),
    ...['pf', 'hl'].flatMap((k) =>
      ['equity', 'qty', 'free'].map((f) => fresh(fieldTime(account(k), f), t, Number(r.accountSecs) * 1000))
    ),
    ...['USDC', 'USDT'].map((k) => fresh(rates[k]?.asOf, t, 60000))
  ].join('/');
  if (next !== quality) {
    quality = next;
    render();
  }
}, 350);
