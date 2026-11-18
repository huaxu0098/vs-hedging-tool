import { createTemplates } from './assets.js';
import { drawChart } from './chart.js';
import { openEditor } from './editor.js';
import { evaluate } from './engine.js';
import { bookPosition, closePosition, getLedger, LEDGER_KEY } from './ledger.js';

const $ = id => document.getElementById(id);
const ASSETS_KEY = 'vs-hype:assets:v1';
const icons = new Map([['btc', '₿'], ['eth', '♦'], ['sol', '≋'], ['xau', 'Au'], ['us100', 'N']]);
const drafts = new Map();
let assets = [];
let selectedId = '';
let order = { vsUsd: 2000, hypeUsd: 2000, vsLong: true };
let ledger, ledgerError, result, busy = false;

const fmt = (value, places = 4) => {
  if (!Number.isFinite(value)) return '—';
  if (value && Math.abs(value) < 10 ** -places) return value.toExponential(2);
  return value.toLocaleString('zh-CN', { maximumFractionDigits: places });
};
const signed = (value, places = 4) => (value > 0 ? '+' : '') + fmt(value, places);
const money = value => Number.isFinite(value) ? '$' + fmt(value, 4) : '—';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));
function time(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—';
}
function notify(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}
function readAssets() {
  const raw = localStorage.getItem(ASSETS_KEY);
  if (raw === null) {
    const initial = createTemplates();
    localStorage.setItem(ASSETS_KEY, JSON.stringify(initial));
    return initial;
  }
  const list = JSON.parse(raw);
  if (!Array.isArray(list) || !list.length || list.some(a =>
    typeof a?.id !== 'string' || !a.ticker || !a.name || !a.vs || !a.hype)) {
    throw new Error('本地品种配置无法读取，请检查浏览器存储。');
  }
  return list;
}
function current() { return assets.find(a => a.id === selectedId); }
async function saveAsset(asset, previous) {
  if (!navigator.locks) throw new Error('当前浏览器无法锁定本地配置，请通过支持 Web Locks 的浏览器访问本地服务。');
  await navigator.locks.request(ASSETS_KEY, () => {
    const list = readAssets();
    const index = list.findIndex(a => a.id === asset.id);
    if (JSON.stringify(list[index]) !== JSON.stringify(previous)) {
      throw new Error('此品种已在其他标签页更改，请重新打开参数。');
    }
    if (index < 0) list.push(asset);
    else list[index] = asset;
    localStorage.setItem(ASSETS_KEY, JSON.stringify(list));
    assets = list;
  });
  selectAsset(asset.id);
}
function refreshLedger() {
  ledgerError = '';
  try {
    ledger = getLedger();
  } catch (error) {
    ledger = null;
    ledgerError = error.message;
  }
}
function renderAssetList() {
  $('assets').innerHTML = assets.map(a => {
    const tokenClass = icons.has(a.id) ? 't-' + a.id : '';
    const label = a.id === 'xau' && a.ticker === 'XAU' ? 'XAU/USD' : a.ticker;
    return '<button type="button" class="asset" data-id="' + esc(a.id) + '" aria-pressed="' + (a.id === selectedId) + '">' +
      '<span class="token ' + tokenClass + '" aria-hidden="true">' + esc(icons.get(a.id) ?? a.ticker.slice(0, 1)) + '</span>' +
      '<span><b>' + esc(label) + '</b><small>' + esc(a.name) + '</small></span></button>';
  }).join('');
}
function selectAsset(id) {
  if (selectedId) drafts.set(selectedId, { ...order });
  selectedId = assets.some(a => a.id === id) ? id : assets[0].id;
  order = drafts.get(selectedId) ?? { vsUsd: 2000, hypeUsd: 2000, vsLong: true };
  $('vs-amount').value = Number.isFinite(order.vsUsd) ? order.vsUsd : '';
  $('hype-amount').value = Number.isFinite(order.hypeUsd) ? order.hypeUsd : '';
  renderAssetList();
  render();
}
function showMetric(id, value, unit, title) {
  $(id).innerHTML = esc(value) + (unit ? '<small>' + esc(unit) + '</small>' : '');
  $(id).title = title;
}
function thresholds(a, r) {
  const lines = [['VS 失败价', r.fail, '#a26f52'], ['VS 通过价', r.pass, '#508663'], ['Hype 强平价', r.liq, '#ac822e']];
  return lines.map(([label, value, color]) => {
    const distance = Number.isFinite(value) ? value - a.referencePrice : null;
    const move = distance === null ? '—' : signed(distance) + ' ' + a.priceUnit + ' · ' + signed(distance / a.referencePrice * 100, 3) + '%';
    const relation = label === 'VS 失败价' ? r.failRelation : '';
    return '<div class="threshold"><span><i class="tag-dot" style="background:' + color + '"></i>' + label +
      '</span><b>' + (relation ? esc(relation) + ' ' : '') + fmt(value) + '</b><small>' + esc(move) + '</small></div>';
  }).join('');
}
function details(a, r) {
  const legValues = (leg, pos) => [
    leg.symbol,
    fmt(leg.price) + ' ' + leg.quote + ' / ' + leg.settle,
    fmt(leg.spread) + ' / ' + fmt(leg.tick),
    fmt(leg.multiplier) + ' ' + leg.settle,
    fmt(leg.minQty, 8) + ' / ' + fmt(leg.step, 8) + ' ' + leg.qtyUnit,
    fmt(pos?.qty, 8) + ' ' + leg.qtyUnit + ' · ' + money(pos?.notional),
    signed(pos?.delta, 7) + ' USD',
    signed(Number.isFinite(pos?.delta) ? -pos.delta : null, 7) + ' USD',
    fmt(leg.feeRate * 100) + '% / ' + fmt(leg.leverage) + '× / ' + fmt(leg.mmr * 100) + '%',
  ];
  const labels = ['合约代码', '中间价 · 报价 / 结算币', '买卖点差 / 价格步长', '每单位仓位每报价点价值',
    '最小量 / 数量步长', '取整后仓位 · 名义金额', '上涨 1 ' + a.priceUnit + ' 盈亏',
    '下跌 1 ' + a.priceUnit + ' 盈亏', '单边费率 / 杠杆 / 维持率'];
  const vs = legValues(a.vs, r.vs), hype = legValues(a.hype, r.hype);
  const tr = labels.map((label, i) => '<tr><td>' + esc(label) + '</td><td>' + esc(vs[i]) + '</td><td>' + esc(hype[i]) + '</td></tr>').join('');
  return '<div class="details-scroll"><table><thead><tr><th>参数</th><th>VS · ' + (order.vsLong ? '多' : '空') +
    '</th><th>Hype · ' + (order.vsLong ? '空' : '多') + '</th></tr></thead><tbody>' + tr + '</tbody></table></div>';
}
function renderWorkbench() {
  const a = current();
  const r = evaluate(a, order, ledger?.available ?? 0);
  result = r;
  const reasons = ledgerError ? [ledgerError, ...r.reasons] : r.reasons;
  const ok = r.ok && !ledgerError;
  $('direction-long').setAttribute('aria-pressed', String(order.vsLong));
  $('direction-short').setAttribute('aria-pressed', String(!order.vsLong));
  for (const side of ['vs', 'hype']) {
    const pos = r[side], leg = a[side];
    const qty = Number.isFinite(pos?.qty) ? fmt(pos.qty, 8) : '—';
    const sensitivity = Number.isFinite(pos?.delta) ? signed(pos.delta, 7) + ' USD' : '—';
    $(side + '-quantity').textContent = '取整后 ' + qty + ' ' + leg.qtyUnit +
      '　·　每涨 1 ' + a.priceUnit + '：' + sensitivity;
  }
  $('match-status').textContent = ok ? '通过模拟验算' : '暂不匹配';
  $('match-status').className = 'status ' + (ok ? '' : 'warn');
  $('reasons').hidden = !reasons.length;
  $('reasons').innerHTML = '<ul>' + reasons.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul>';
  showMetric('match-value', fmt(r.matchPct, 3), '%', '两边绝对美元敏感度之小值除以大值');
  showMetric('delta-value', signed(r.netDelta, 6), 'USD', '标的上涨 1 ' + a.priceUnit + ' 时两边盈亏变化之和');
  showMetric('buffer-value', fmt(r.buffer), a.priceUnit, '沿 VS 盈利方向从通过价到 Hype 强平价的距离');
  $('buffer-percent').textContent = '参考价的 ' + fmt(r.bufferPct, 4) + '%';
  $('plot-sub').textContent = '相对参考价 ' + fmt(a.referencePrice) + ' ' + a.priceUnit + ' 的盈亏变化（USD）';
  drawChart($('chart'), a, r);
  $('price-lines').innerHTML = thresholds(a, r);
  $('asset-benchmark').textContent = a.benchmark;
  $('details').innerHTML = details(a, r);
  const reserved = Number.isFinite(r.reserve) ? Math.ceil(r.reserve * 1e6) / 1e6 : null;
  $('reserve').textContent = fmt(reserved, 6) + ' U';
  $('book').disabled = busy || !ok;
  $('available').textContent = fmt(ledger?.available, 6);
  $('used').textContent = fmt(ledger?.used, 6) + ' U';
  $('capital-fill').style.width = ledger ? 100 * ledger.available / ledger.capital + '%' : '0%';
  $('snapshot').textContent = '模拟快照　VS ' + time(a.vs.asOf) + '　/　Hype ' + time(a.hype.asOf) +
    '　·　报价有效期 ' + fmt(a.maxAgeSec) + ' 秒。通过价、失败价与逐仓强平价均为模拟估算。';
}
function renderLedger() {
  const chosen = $('ledger-filter').value;
  const filters = new Map(assets.map(a => [a.id, a.ticker + ' · ' + a.name]));
  for (const e of ledger?.entries ?? []) if (!filters.has(e.assetId)) filters.set(e.assetId, e.ticker);
  $('ledger-filter').innerHTML = '<option value="">全部品种</option>' +
    Array.from(filters, ([id, name]) => '<option value="' + esc(id) + '">' + esc(name) + '</option>').join('');
  $('ledger-filter').value = filters.has(chosen) ? chosen : '';
  $('ledger-summary').innerHTML = [['共享本金', ledger?.capital], ['已占用', ledger?.used], ['可用本金', ledger?.available]]
    .map(([label, value]) => '<div><small>' + label + '</small><b>' + fmt(value, 4) + ' U</b></div>').join('');
  const entries = (ledger?.entries ?? []).filter(e => !chosen || e.assetId === chosen);
  $('entry-count').textContent = entries.length + ' 笔记录';
  if (!entries.length || ledgerError) {
    $('entries').innerHTML = '<div class="empty">' + esc(ledgerError || '暂无模拟占用记录') + '</div>';
    return;
  }
  const rows = entries.map(e => {
    const position = (qty, unit, usd, long) => (long ? '多 ' : '空 ') + fmt(qty, 8) + ' ' + esc(unit) + '<small>' + money(usd) + '</small>';
    const release = e.status === 'closed' ? '<span title="' + esc(time(e.closedAt)) + '">已释放</span>' :
      '<button class="text-button" type="button" data-release="' + esc(e.id) + '">释放占用</button>';
    return '<tr><td><b>' + esc(e.ticker) + '</b><small>' + esc(time(e.createdAt)) + '</small></td><td>' +
      position(e.vsQty, e.vsUnit, e.vsUsd, e.vsLong) + '</td><td>' + position(e.hypeQty, e.hypeUnit, e.hypeUsd, !e.vsLong) +
      '</td><td>' + fmt(e.reserve, 6) + ' U</td><td>' + release + '</td></tr>';
  });
  $('entries').innerHTML = '<div class="details-scroll"><table><thead><tr><th>品种 / 记录时间</th><th>VS 实际仓位</th><th>Hype 实际仓位</th>' +
    '<th>预留资金</th><th>状态 / 操作</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
}
function render() {
  refreshLedger();
  const isLedger = location.hash === '#ledger';
  $('ledger').hidden = !isLedger;
  $('workbench').hidden = isLedger;
  for (const [id, active] of [['to-ledger', isLedger], ['to-workbench', !isLedger]]) {
    if (active) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  if (isLedger) renderLedger();
  else renderWorkbench();
}
function edit(isNew) {
  const previous = current();
  openEditor(previous, { isNew, onSave: asset => saveAsset(asset, isNew ? undefined : previous) });
}
function load() {
  assets = readAssets();
  selectAsset(selectedId || assets[0].id);
}
function guarded(callback) {
  return async event => {
    try { await callback(event); } catch (error) { notify(error.message); }
  };
}
$('assets').addEventListener('click', event => {
  const button = event.target.closest('[data-id]');
  if (button) { notify(''); selectAsset(button.dataset.id); }
});
for (const side of ['vs', 'hype']) {
  $(side + '-amount').addEventListener('input', event => {
    order[side + 'Usd'] = event.target.valueAsNumber;
    notify(''); render();
  });
}
for (const side of ['long', 'short']) {
  $('direction-' + side).addEventListener('click', () => { order.vsLong = side === 'long'; notify(''); render(); });
}
$('edit-asset').addEventListener('click', guarded(() => edit(false)));
$('add-asset').addEventListener('click', guarded(() => edit(true)));
$('refresh').addEventListener('click', guarded(async () => {
  const before = current();
  const next = structuredClone(before);
  next.vs.asOf = next.hype.asOf = new Date().toISOString();
  await saveAsset(next, before);
  notify(next.ticker + ' 已按设定价格重放模拟报价。');
}));
$('book').addEventListener('click', guarded(async () => {
  if (busy || !result?.ok) return;
  busy = true;
  $('book').disabled = true;
  try {
    const snapshot = current();
    const chosenOrder = { ...order };
    if (!navigator.locks) throw new Error('当前浏览器无法锁定共享账本，请用支持 Web Locks 的浏览器打开本地服务。');
    await navigator.locks.request(ASSETS_KEY, async () => {
      const latest = readAssets().find(a => a.id === snapshot.id);
      if (JSON.stringify(latest) !== JSON.stringify(snapshot)) throw new Error('品种参数已更改，请按新参数重新验算。');
      await bookPosition(snapshot, chosenOrder);
    });
    notify(snapshot.ticker + ' 模拟占用已记录，可在资金流水中查看。');
  } finally { busy = false; render(); }
}));
$('entries').addEventListener('click', guarded(async event => {
  const button = event.target.closest('[data-release]');
  if (!button || button.disabled) return;
  button.disabled = true;
  try { await closePosition(button.dataset.release); notify('该笔模拟占用已释放。'); }
  finally { render(); }
}));
$('ledger-filter').addEventListener('change', renderLedger);
window.addEventListener('hashchange', () => { notify(''); if (assets.length) render(); });
window.addEventListener('storage', guarded(event => {
  if (event.key === ASSETS_KEY || event.key === null) load();
  else if (event.key === LEDGER_KEY && assets.length) render();
}));
document.addEventListener('visibilitychange', guarded(() => { if (!document.hidden) load(); }));
setInterval(() => {
  if (!current() || document.hidden || $('workbench').hidden || !result) return;
  const a = current();
  const expired = [a.vs, a.hype].some(leg => Date.now() - Date.parse(leg.asOf) > a.maxAgeSec * 1000);
  if (expired && !result.reasons.some(reason => reason.includes('报价过期'))) render();
}, 1000);
try { load(); } catch (error) { notify(error.message); }
