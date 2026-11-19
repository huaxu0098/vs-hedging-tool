import { dec, out, nonnegative, positive } from './math.js';
import { rules, calculateCurrent, fresh } from './current.js';
import { captureScript } from '../vs-parser.js';
import { manualVs } from './adapters.js';
import { accountSnapshot } from './current-account.js';

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
const r = (state.rules = { ...rules, ...state.rules });
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
  registration: '本金中已支付的报名费（U）',
  outsideCosts: '本金之外另需收回的历史成本（U）',
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
for (const [k, label] of Object.entries(ruleFields))
  input('rule-fields', k, label, k === 'deadline' ? 'datetime-local' : 'text');
for (const side of ['pf', 'hl'])
  for (const [k, label] of Object.entries({
    ...legFields,
    ...(side === 'hl' ? { leverage: '当前杠杆倍数' } : {})
  }))
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
  $('leg-settings').append(label);
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
const useAPI = () => $('hl-source').value === 'api';
function market() {
  if ($('quote-source').value !== 'manual') return feed;
  return {
    ...feed,
    asset: asset(),
    pf: manualPrices?.pf,
    hl: manualPrices?.hl,
    errors: { spec: feed.errors?.spec }
  };
}
function account(side) {
  if (side === 'hl' && useAPI())
    return api ? { ...api, error: apiError } : { error: apiError || '等待 Hype 账户同步' };
  const leg = local()[side],
    shared = state.shared[side];
  const eq = shared?.asset === asset() ? leg.equity : (shared?.equity ?? leg.equity);
  const risk = {};
  for (const k of ['free', 'otherHold', 'orders', 'leverage', 'marginMode']) {
    const meta = leg.origins?.[k];
    if (meta && !fresh(meta.at, Date.now(), Number(r.accountSecs) * 1000)) risk[k] = null;
  }
  const timestamps = [shared?.at ?? leg.equityAt, leg.qtyAt].filter(Boolean).sort();
  return {
    ...leg,
    ...risk,
    equity: eq,
    anchor: shared?.asset === asset() ? leg.anchor : null,
    at: timestamps[0],
    source: leg.origins?.qty?.source ?? leg.origins?.equity?.source ?? '手工确认',
    otherPositions:
      leg.otherPositions ||
      Object.entries(state.assets).some(
        ([sym, s]) => sym !== asset() && s[side]?.qty && Number(s[side].qty) !== 0
      )
  };
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
  $('asset').value = asset();
  for (const k of ['mode', 'stage', 'B', 'R', 'objective', 'externalCurrency', ...Object.keys(ruleFields)])
    $(k).value = r[k] ?? '';
  $('objective-label').hidden = r.mode !== 'auto';
  for (const side of ['pf', 'hl']) {
    const a = account(side);
    for (const k of ['equity', 'qty', ...Object.keys(legFields), 'leverage', 'marginMode']) {
      const el = $(side + '-' + k);
      if (!el) continue;
      const value =
        k === 'orders' ? a.orders?.map((o) => o.qty).join(',') || (a.orders ? '0' : '') : (a[k] ?? '');
      if (el !== document.activeElement || (side === 'hl' && useAPI())) el.value = value;
      if (el.tagName === 'SELECT') el.disabled = side === 'hl' && useAPI();
      else el.readOnly = side === 'hl' && useAPI();
    }
  }
}
function updateLeg(side, fields, stamp = now(), source = '手工确认') {
  const leg = local()[side];
  leg.origins ??= {};
  for (const k of Object.keys(fields)) leg.origins[k] = { at: stamp, source };
  if ('equity' in fields) {
    state.shared[side] = { asset: asset(), equity: fields.equity, at: stamp };
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
        : '已按全仓维持保证金档位验算失败和成功路径。'
      : '等待可测算的候选仓位。'
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
    ['Hype 在 VS 成功线的压力标记价', fmt(c?.pressureMark)],
    [
      'Hype 目标仓强平标记价',
      c?.liqMark
        ? fmt(c.liqMark) + ' · ' + c.liqSource
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
    ['路径最低 Hype 维持保证金余量', money(c?.buffer)],
    ['目标初始保证金（含其他占用）', 'VS ' + margin('pf') + ' / Hype ' + margin('hl')]
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
let worker = null,
  version = 0,
  pendingKey = '',
  response = null,
  displayed = null;
function cancelAuto() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  pendingKey = '';
  response = null;
  displayed = null;
  version++;
}
function currentFrame(a, m, t) {
  const base = calculateCurrent(r, a, m, rates, t, { deferAuto: true });
  if (!base.needsSearch) {
    if (pendingKey) cancelAuto();
    return base;
  }
  const context = JSON.stringify([r, a, m.asset, useAPI()]);
  const signature = JSON.stringify([context, m, rates]);
  if (signature !== pendingKey) {
    if (worker && !response) {
      worker.terminate();
      worker = null;
    }
    pendingKey = signature;
    response = null;
    const revision = ++version;
    if (!worker) worker = new Worker('/src/hedge/auto-worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (revision !== version || data.version !== version) return;
      response = data.error
        ? { ...base, autoStatus: 'AUTO_PARTIAL', issues: [data.error] }
        : { ...data.result, stateVersion: data.version };
      render();
    };
    worker.onerror = () => {
      if (revision === version) {
        worker.terminate();
        worker = null;
        response = { ...base, autoStatus: 'AUTO_PARTIAL', issues: ['后台计算失败，请刷新重试'] };
        render();
      }
    };
    worker.postMessage({ version, r, a, m, rates, t });
  }
  if (response) {
    displayed = { context, stamps: [m.pf.asOf, m.hl.asOf, m.hl.markAt].filter(Boolean) };
    return response;
  }
  if (
    displayed?.context === context &&
    displayed.stamps.every((at) => fresh(at, t, Number(r.quoteSecs) * 1000))
  ) {
    put('summary-status', '行情已更新，正在核算。当前展示上一帧及其计算时间。');
    return null;
  }
  return { ...base, autoStatus: 'AUTO_PARTIAL', issues: ['正在检查双边合法仓位'] };
}
const autoLabels = {
  AUTO_FEASIBLE: '有可行仓位',
  AUTO_PARTIAL: '部分可算',
  AUTO_DATA_BLOCKED: '数据待补或过期',
  AUTO_INFEASIBLE: '完整搜索无解',
  AUTO_DEADLINE_EXIT_REQUIRED: '考核已到期，待退出',
  AUTO_HOLD: '保持现仓'
};
function render() {
  const m = market(),
    a = { pf: account('pf'), hl: account('hl') };
  let result;
  try {
    result = currentFrame(a, m, Date.now());
    if (!result) return;
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
    stale = result.issues.some((x) => /过期|请求失败|断开|未连接/.test(x));
  const status = result.autoStatus
    ? autoLabels[result.autoStatus] +
      ' · ' +
      (result.issues[0] ?? result.notices.at(-1) ?? '按当前资金和保证金规则计算')
    : c
      ? '按当前现金规则计算，' +
        (c.code === 'MARGIN_UNVERIFIED' ? '保证金条件待验证' : '已验算所设保证金条件')
      : result.issues[0] || result.notices.at(-1) || '等待当前快照';
  put('calc-status', status);
  put(
    'summary-status',
    result.autoStatus
      ? status
      : c
        ? (c.code === 'FEASIBLE' ? '当前规则已验算' : '条件测算 · 保证金待验证') +
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
    put(key + '-summary', q == null ? '—' : (q.isZero() ? '空仓 ' : q.gt(0) ? '多 ' : '空 ') + money(amount));
    put(key + '-change', q == null ? '' : q.abs().toString() + ' ' + asset() + ' · ' + hint);
  }
  const projection = c ?? result.heldCash;
  put('protect-funds', money(result.protect));
  put(
    'margin-funds',
    Array.isArray(result.marginHL)
      ? '买 ' + money(result.marginHL[0]) + ' / 卖 ' + money(result.marginHL[1])
      : money(result.marginHL)
  );
  put('success-hl', money(projection?.hlBeforePayout));
  put(
    'summary-margin',
    c?.initialMargin?.length === 2
      ? '初始保证金 VS ' + money(c.initialMargin[0]) + ' / Hype ' + money(c.initialMargin[1])
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
      : !r.movePct
        ? '未验证两日触线可达性。'
        : !result.pressure
          ? '等待可计算的当前快照。'
          : '条件情景：假设两日有利变动 ' +
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
                (result.maximum.complete ? '最大可行 PF ' : '本次已验最大 PF ') +
                money(result.maximum.amount)
              : '') +
            (c
              ? '。所选 PF ' + money(c.vsNotional) + '，条件净结算权益 ' + money(result.stressedEquity) + '。'
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
      '） · 在途 ' +
      money(r.inTransit) +
      ' · 待到账分成 ' +
      money(r.receivable ?? '0')
  );
  $('alternatives').hidden = r.mode !== 'auto';
  const rowsAuto = (result.top ?? []).map((c) =>
    cellRow([
      signed(c.vsTargetQuantity) + ' / ' + money(c.vsNotional),
      signed(c.hlTargetQuantity) + ' / ' + money(c.hlNotional),
      pct(c.actualRatio),
      money(c.worstCash),
      fmt(c.priceBuffer),
      money(c.initialMargin.reduce((sum, x) => sum.plus(x), dec('0')).toString())
    ])
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
              fmt(rejected.check.actual) +
              ' / 要求 ' +
              fmt(rejected.check.required) +
              '，差 ' +
              fmt(rejected.check.shortfall) +
              ' ' +
              rejected.check.unit +
              '（' +
              rejected.check.source +
              '）'
            : '')
      : result.issues.join(' · ')
  );
  put(
    'stress-assumptions',
    '压力设置：基差及汇率 ' +
      r.adverseBps +
      ' 基点，跳价 ' +
      r.jumpBps +
      ' 基点，延迟 ' +
      r.delayBps +
      ' 基点，资金费 ' +
      money(r.fundingDebit) +
      '。按较大不利价格偏移并计入延迟与资金费核算。'
  );
  put(
    'auto-search',
    result.search
      ? (result.search.complete ? '已完成合法网格最优性检查' : '搜索未穷尽，仅展示已验证候选') +
          ' · 精算 ' +
          result.search.evaluations +
          ' 组 · ' +
          result.autoStatus +
          ' · 版本 ' +
          result.stateVersion
      : (result.autoStatus ?? '')
  );
  if (result.flatHold)
    for (const k of ['pf', 'hl']) {
      put(k + '-summary', '空仓 0.00 U');
      put(k + '-change', '保持等待');
    }
  put('fail-summary', money(projection?.failureCash));
  put('pass-summary', money(projection?.pressureCashAfter));
  put('pass-heading', r.stage === 'funded' ? '首笔分成到账后个人资金' : 'VS 通过后个人资金');
  for (const [id, diff] of [
    ['fail', result.failVsPrincipal],
    ['pass', result.passVsPrincipal]
  ])
    put(id + '-change', diff == null ? '' : '相对保护本金及额外成本 ' + signedMoney(diff));
  put(
    'current-h',
    result.currentH == null
      ? result.qty.pf === '0'
        ? result.qty.hl === '0'
          ? '双边空仓'
          : 'VS 空仓 · 比例无定义'
        : '—'
      : pct(result.currentH) + (result.sameDirection ? ' · 同向敞口' : '')
  );
  put('range', b?.min == null ? '—' : dec(b.max).lt(b.min) ? '无交集' : pct(b.min) + ' – ' + pct(b.max));
  const budgetOnly =
    !c && !result.heldCash && b?.selected && !result.notices.some((n) => /已到期|待到账|待平台/.test(n));
  put(
    'target-h',
    c
      ? pct(c.actualRatio) +
          (c.code === 'FEASIBLE' && result.autoStatus !== 'AUTO_PARTIAL'
            ? result.search && !result.search.complete
              ? ' · 已验候选'
              : ' · 推荐'
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
      ? (r.objective === 'cash'
          ? '优先最差压力情景个人剩余现金，再比较 PF 仓位。'
          : '优先最大可行 PF 名义额，再比较最差压力情景个人剩余现金。') +
          '并列时优先较大强平缓冲、较低保证金占用。'
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
          ' · Hype 初始保证金比例上限 ' +
          (result.marginMax != null ? pct(result.marginMax) : '未核实') +
          (r.stage === 'funded'
            ? ' · 整轮利润上限 ' + (b.profitMax == null ? '缺少本轮起点' : pct(b.profitMax))
            : '') +
          (b.code !== 'FEASIBLE'
            ? ' · 按最低保护比例，成功端现金 ' + money(b.atMinimum.hlBefore) + '，要求留存 ' + money(r.R)
            : '')
      : '资金范围只需两边当前权益和已设规则。'
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
            ? ' · ' + money(out(dec(delta).abs().times(String(m[s].mark))))
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
        clock(a[s].at) +
        ' · ' +
        freshnessLabel(a[s].at, r.accountSecs) +
        (result.cash[s] != null
          ? ' · ' + (a[s].anchor ? '按标记价估算 ' : '权益快照 ') + money(result.cash[s])
          : '')
    );
  }
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
    ['失败端个人现金', money(projection?.failureCash ?? budget?.fail)],
    ['成功端分成到账前个人资金（含外部已到账）', money(projection?.cashBeforePayout ?? budget?.before)],
    ['若分成到账后', money(projection?.pressureCashAfter ?? budget?.after)],
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
  else lastCalculation = '计算于 ' + clock(now());
  put('times', lastCalculation + ' · PF 快照 ' + clock(a.pf.at) + ' · Hype 快照 ' + clock(a.hl.at));
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
            (q.markAt
              ? ' · 标记价 REST 请求 ' + clock(q.markAt) + ' ' + freshnessLabel(q.markAt, r.quoteSecs)
              : '')
          : '')
    );
  }
  put(
    'field-sources',
    ['pf', 'hl']
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
                (rates[k]
                  ? fmt(String(rates[k].rate), 6) + ' ' + rates[k].source + ' ' + clock(rates[k].asOf)
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
      : '当前使用手工账户快照，公开行情独立更新。'
  );
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
  quoteTimer = setTimeout(refreshMarket, 1250);
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
for (const k of ['mode', 'stage', 'B', 'R', 'objective', 'externalCurrency', ...Object.keys(ruleFields)]) {
  $(k).addEventListener('input', () => {
    r[k] = $(k).value.trim();
    r.editedAt = now();
    if (k === 'externalFx') r.externalFxAt = now();
    if (k === 'externalCurrency') {
      r.externalFx = '';
      r.externalFxAt = null;
      $('externalFx').value = '';
    }
    if (k === 'fx') r.fxAt = now();
    $('objective-label').hidden = r.mode !== 'auto';
    save();
    render();
  });
}
for (const s of ['pf', 'hl'])
  for (const k of ['equity', 'qty', ...Object.keys(legFields), 'leverage', 'marginMode']) {
    const el = $(s + '-' + k);
    if (!el) continue;
    el.addEventListener('input', () => {
      if (s === 'hl' && useAPI()) return;
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
        markAt: null,
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
inputs();
render();
refreshMarket();
// A stalled network must not leave an old actionable delta on screen.
let quality = '';
setInterval(() => {
  const t = Date.now(),
    m = market();
  const next = [
    ...['pf', 'hl'].map((k) => fresh(m[k]?.asOf, t, Number(r.quoteSecs) * 1000)),
    !m.hl?.markAt || fresh(m.hl.markAt, t, Number(r.quoteSecs) * 1000),
    ...['pf', 'hl'].map((k) => fresh(account(k).at, t, Number(r.accountSecs) * 1000)),
    ...['pf', 'hl'].flatMap((k) =>
      Object.values(local()[k].origins ?? {}).map((meta) => fresh(meta.at, t, Number(r.accountSecs) * 1000))
    ),
    !!r.deadline && Date.parse(r.deadline) <= t,
    fresh(r.fxAt, t, Number(r.accountSecs) * 1000),
    ...['USDC', 'USDT'].map((k) => fresh(rates[k]?.asOf, t, 60000))
  ].join('/');
  if (next !== quality) {
    quality = next;
    render();
  }
}, 350);
