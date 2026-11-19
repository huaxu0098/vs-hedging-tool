import { dec, out, nonnegative, positive } from './math.js';
import { rules, calculateCurrent, fresh } from './current.js';
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
const r = (state.rules = { ...rules, ...state.rules });
const save = () => localStorage.setItem(key, JSON.stringify(state));
const fmt = (x, n = 2) => (x == null || x === '' ? '—' : dec(String(x)).toFixed(n));
const money = (x) => (x == null ? '—' : fmt(x) + ' U');
const pct = (x) => (x == null ? '—' : dec(x).times(100).toFixed(3) + '%');
const signed = (x) => (x == null ? '未验证' : (dec(x).gt(0) ? '+' : '') + out(dec(x)));
const clock = (t) =>
  t && Number.isFinite(Date.parse(t)) ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '未确认';
const put = (id, str) => {
  if ($(id).textContent !== str) $(id).textContent = str;
};
const asset = () => state.asset;
const local = () => (state.assets[asset()] ??= { pf: {}, hl: {} });
const ruleFields = {
  challengeFloor: '考核固定失败线（U）',
  challengeTarget: '考核通过净值（U）',
  fundedFloor: '出金户固定失败线（U）',
  fundedTarget: '首次分成参考净值（U）',
  baseline: '分成基线（U）',
  share: '个人分成比例（0 至 1）',
  external: '外部已到账（U）',
  inTransit: '在途资金（U）',
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
    input('leg-settings', side + '-' + k, (side === 'pf' ? 'VS ' : 'Hype ') + label);
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
  const timestamps = [shared?.at ?? leg.equityAt, leg.qtyAt].filter(Boolean).sort();
  return {
    ...leg,
    equity: eq,
    anchor: shared?.asset === asset() ? leg.anchor : null,
    at: timestamps[0],
    source: '手工确认',
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
  for (const k of ['mode', 'stage', 'B', 'R', 'sizes', ...Object.keys(ruleFields)]) $(k).value = r[k] ?? '';
  $('joint-fields').hidden = r.mode !== 'joint';
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
function updateLeg(side, fields, stamp = now()) {
  const leg = local()[side];
  if ('equity' in fields) {
    state.shared[side] = { asset: asset(), equity: fields.equity, at: stamp };
    leg.equityAt = stamp;
    leg.anchor =
      fields.anchor ??
      (fresh(market()[side]?.asOf, Date.now(), Number(r.quoteSecs) * 1000)
        ? String(market()[side].mark)
        : null);
  }
  if ('qty' in fields) leg.qtyAt = stamp;
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
function render() {
  const m = market(),
    a = { pf: account('pf'), hl: account('hl') };
  let result;
  try {
    result = calculateCurrent(r, a, m, rates, Date.now());
  } catch (e) {
    result = { issues: [e.message], notices: [], cash: {}, qty: { pf: null, hl: null }, currentNotional: {} };
  }
  const c = result.candidate,
    b = result.range,
    stale = result.issues.some((x) => /过期|请求失败|断开|未连接/.test(x));
  const status = c
    ? '按当前现金规则计算，' + (c.code === 'MARGIN_UNVERIFIED' ? '保证金条件待验证' : '已验算所设保证金条件')
    : result.issues[0] || result.notices.at(-1) || '等待当前快照';
  put('calc-status', status);
  put(
    'current-h',
    result.currentH == null ? '—' : pct(result.currentH) + (result.sameDirection ? ' · 同向敞口' : '')
  );
  put('range', b?.min == null ? '—' : dec(b.max).lt(b.min) ? '无交集' : pct(b.min) + ' – ' + pct(b.max));
  const budgetOnly = !c && b?.selected && !result.notices.some((n) => /已到期|待到账|待平台/.test(n));
  put('target-h', c ? pct(c.actualRatio) : budgetOnly ? pct(b.min) + ' · 资金参考' : '—');
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
          ? r.mode === 'keepPF' && s === 'pf' && q != null
            ? '保持 ' + amt(q)
            : '—'
          : amt(target) + ' · ' + money(notional),
        action(q, delta),
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
    const origin = a[s].source || '手工确认';
    put(
      s + '-meta',
      origin +
        ' · ' +
        clock(a[s].at) +
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
  const budget = budgetOnly ? b.atMinimum : null;
  const lines = [
    ['失败端个人现金', money(c?.failureCash ?? budget?.fail)],
    ['成功端分成到账前', money(c?.cashBeforePayout ?? budget?.before)],
    ['若分成到账后', money(c?.pressureCashAfter ?? budget?.after)],
    ['从当前起的现金变化', money(result.forward)],
    ['整轮条件净收益', r.ref ? money(result.round) : '缺少本轮起点'],
    ['当前可分金额（未到账）', r.stage === 'funded' ? money(result.claim) : '考核期不可分']
  ];
  const dl = [];
  for (const [k, v] of lines) {
    const dt = document.createElement('dt'),
      dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dl.push(dt, dd);
  }
  if ($('cash-results').textContent !== dl.map((el) => el.textContent).join(''))
    $('cash-results').replaceChildren(...dl);
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
  for (const k of ['equity', 'qty', 'anchor', 'leverage', 'otherHold', 'free']) {
    if (v[k] != null && v[k] !== '')
      f[k] = out(
        (['anchor', 'leverage'].includes(k)
          ? positive
          : ['otherHold', 'free'].includes(k)
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
      edits.push(manualImport('pf', f, stamp));
      stage = v.stage;
    }
    if (!edits.length || (stage && !['challenge', 'funded'].includes(stage)))
      throw Error('当前快照或阶段无效');
    if (edits.some((e) => e.side === 'hl') && useAPI()) throw Error('请切换到手工 Hype 来源后确认');
    pending = { edits, stage };
    put('preview', JSON.stringify(pending, null, 2));
    $('confirm').disabled = false;
  } catch (e) {
    put('preview', e.message);
  }
};
$('confirm').onclick = () => {
  if (!pending) return;
  for (const e of pending.edits) {
    const old = local()[e.side];
    if (
      ('qty' in e.fields && old.qtyAt && Date.parse(e.stamp) < Date.parse(old.qtyAt)) ||
      ('equity' in e.fields &&
        state.shared[e.side]?.at &&
        Date.parse(e.stamp) < Date.parse(state.shared[e.side].at))
    ) {
      invalidatePreview();
      put('preview', '识别结果早于当前快照，请核对平台时间后重新粘贴。');
      return;
    }
  }
  for (const e of pending.edits) updateLeg(e.side, e.fields, e.stamp);
  if (pending.stage) r.stage = pending.stage;
  invalidatePreview();
  put('preview', '已确认当前快照');
  save();
  inputs();
  render();
};
$('paste').oninput = invalidatePreview;
$('paste-kind').onchange = invalidatePreview;
for (const k of ['mode', 'stage', 'B', 'R', 'sizes', ...Object.keys(ruleFields)]) {
  $(k).addEventListener('input', () => {
    r[k] = $(k).value.trim();
    if (k === 'fx') r.fxAt = now();
    $('joint-fields').hidden = r.mode !== 'joint';
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
      both[k] = { ...spec, mark: out(positive(String(q.mark))), asOf: q.asOf, levels: checked };
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
    ...['pf', 'hl'].map((k) => fresh(account(k).at, t, Number(r.accountSecs) * 1000)),
    !!r.deadline && Date.parse(r.deadline) <= t,
    fresh(r.fxAt, t, Number(r.accountSecs) * 1000),
    ...['USDC', 'USDT'].map((k) => fresh(rates[k]?.asOf, t, 60000))
  ].join('/');
  if (next !== quality) {
    quality = next;
    render();
  }
}, 350);
