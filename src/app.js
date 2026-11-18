import { escapeHTML as h, number as n, money, stateNames } from './format.js';
import { openEditor } from './editor.js';
import { openSettings } from './settings.js';
import {
  readWorkspace,
  updateWorkspace,
  WORKSPACE_KEY,
  dashboardAccount,
  resolveHeldMarket,
  strategyBackup,
  loadStrategyBackup
} from './workspace-state.js';
import { accountView, getSimulation, SIM_KEY } from './simulation.js';
import { mountSimulation } from './simulation-ui.js';
import { mountFeedUI } from './feed-ui.js';
import { toMarketAsset } from './feeds.js';
import { closePosition, getLedger, LEDGER_KEY } from './ledger.js';
import {
  showVenue,
  showCross,
  showVerdict,
  showAxes,
  showChecks,
  showCandidates,
  showComparison
} from './desk-view.js';

const $ = (id) => document.getElementById(id);
let state,
  id,
  feeds,
  simulation,
  snapshot = null;
let mode = 'auto',
  inspected = null,
  pinned = null,
  scenario = 'passState',
  choices = [];
let display = null,
  generation = 0,
  workerBusy = false,
  pending = null,
  freshness;
let worker;
const current = () => state.assets.find((a) => a.id === id);
const feedCache = new Map();
function allMarkets() {
  const held = getSimulation(state.config).positions;
  const catalog = [...state.assets];
  for (const p of held) if (p.asset && !catalog.some((a) => a.id === p.assetId)) catalog.push(p.asset);
  return catalog.map((a) => {
    const feed = a.id === id ? snapshot : feedCache.get(a.id);
    const candidate = toMarketAsset(a, feed);
    return resolveHeldMarket(candidate, held.find((p) => p.assetId === a.id)?.asset);
  });
}
const market = () => allMarkets().find((a) => a.id === id);
const legacy = () => getLedger();
function notify(text) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}
function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      notify(err.message);
    }
  };
}
function getInputs() {
  const config = state.config,
    old = legacy(),
    assets = allMarkets(),
    asset = assets.find((a) => a.id === id);
  const sim = getSimulation(config);
  const local = accountView(sim, assets, config, old.used);
  const { account, issues } = dashboardAccount(
    local,
    state.manual,
    state.config.useExternalAccounts === false ? null : snapshot,
    asset,
    assets,
    old.used
  );
  const otherIssues = assets
    .filter((a) => a.id !== id && sim.positions.some((p) => p.assetId === a.id))
    .flatMap((a) => a.sourceIssues ?? []);
  if (sim.observation) issues.push('模拟账本已记录尚未结算的首个触线事件，详见账本与回放。');
  asset.sourceIssues = [...(asset.sourceIssues ?? []), ...issues, ...otherIssues];
  return { asset, config, account };
}
function safeOrder() {
  if (!display?.candidate?.requested) throw Error('当前没有可核验的目标仓位，请回到决策工作台。');
  if (display.id !== generation) throw Error('报价或参数已更新，等待重新验算。');
  return { ...display.candidate.requested };
}
function tab() {
  const active = ['feeds', 'sim'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'desk';
  for (const key of ['feeds', 'sim', 'desk']) {
    $(key).hidden = key !== active;
    const link = document.querySelector('nav a[href="#' + key + '"]');
    if (key === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (active === 'sim') {
    simulation?.refresh();
    renderLegacy();
  }
}
function renderLegacy() {
  const entries = legacy().entries;
  $('legacy').hidden = !entries.length;
  $('legacy-entries').innerHTML = entries
    .map(
      (e) =>
        '<div class="pair"><span>' +
        h(e.ticker) +
        ' · ' +
        h(new Date(e.createdAt).toLocaleString()) +
        ' · ' +
        money(e.reserve) +
        '</span>' +
        (e.status === 'closed' ? '已释放' : '<button data-release="' + h(e.id) + '">释放旧版占用</button>') +
        '</div>'
    )
    .join('');
}
function selectedAssets() {
  $('asset').innerHTML = state.assets
    .map((a) => '<option value="' + h(a.id) + '">' + h(a.ticker + ' · ' + a.name) + '</option>')
    .join('');
  $('asset').value = id;
}
function top() {
  const live = snapshot?.mode ?? 'offline';
  $('feed-switch').value = live;
  $('refresh-demo').hidden = live !== 'offline';
  $('ticket').hidden = mode === 'auto';
  $('sort').value = state.config.sortBy;
  document
    .querySelectorAll('[data-mode]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
}
function issueKey() {
  if (!state) return '';
  const assets = allMarkets(),
    asset = assets.find((a) => a.id === id);
  return [
    !!getSimulation(state.config).observation,
    ...assets.flatMap((a) => a.sourceIssues ?? []),
    ...['vs', 'hype'].map((v) => {
      const t = Date.parse(asset[v]?.asOf);
      return Number.isFinite(t) && Date.now() - t <= asset.maxAgeSec * 1000 ? 'ok' : 'expired';
    })
  ].join('|');
}
function dispatch() {
  if (workerBusy || !pending) return;
  const data = pending;
  pending = null;
  workerBusy = true;
  worker.postMessage(data);
}
function invalidate() {
  display = null;
  choices = [];
  $('verdict').className = 'verdict bad';
  $('verdict').innerHTML = '<h2>正在验算</h2>';
  $('pin').disabled = true;
  // No old passing conclusion or scenario survives a disconnected or expired book.
  for (const section of ['checks', 'scenario-result', 'comparison', 'candidates', 'axis', 'assumptions'])
    $(section).replaceChildren();
}
function refresh() {
  invalidate();
  try {
    const { asset, account, config } = getInputs();
    simulation?.observe?.();
    const stamp = ++generation;
    top();
    freshness = issueKey();
    const isManual = !!inspected;
    const request = {
      mode: isManual ? 'manual' : mode,
      vsUsd: $('vs-size').valueAsNumber,
      hypeUsd: $('hype-size').valueAsNumber,
      direction: isManual ? (inspected.vsLong ? 'long' : 'short') : $('direction').value
    };
    $('state-label').textContent =
      (snapshot?.mode === 'live'
        ? 'Hype 公开 API'
        : snapshot?.mode === 'frozen'
          ? '实时快照已冻结'
          : asset.mixedSource
            ? '已确认 VS 报价 / Hype 离线模拟'
            : '离线模拟报价') +
      '　·　' +
      (account.stage === 'funded' ? '出金号' : '考核阶段') +
      '　·　' +
      (config.triggerMode === 'mark' ? '标记净值触线' : '平仓净值触线');
    const errors = asset.sourceIssues ?? [];
    if (errors.length) {
      const r = { ok: false, status: 'unverified', reasons: errors };
      showVerdict(asset, r, { reasons: errors }, config);
    }
    showVenue('vs', asset, account, config, null, null, snapshot);
    showVenue('hype', asset, account, config, null, null, snapshot);
    showCross(asset, null, {}, snapshot);
    pending = { id: stamp, asset, account, config, request, inspected, pinned };
    dispatch();
    if (!$('sim').hidden) simulation?.refresh();
  } catch (err) {
    generation++;
    pending = null;
    notify(err.message);
    $('verdict').textContent = '无法验证 · ' + err.message;
  }
}
function render(data) {
  const { asset, account, config } = getInputs(),
    r = data.result,
    c = data.candidate ?? { status: r.status, reasons: r.reasons };
  display = { ...data, candidate: c };
  showVerdict(asset, c, r, config);
  showVenue('vs', asset, account, config, r.limits, c, snapshot);
  showVenue('hype', asset, account, config, r.limits, c, snapshot);
  showCross(asset, c, r, snapshot);
  showAxes(asset, c, account, config, scenario);
  showChecks(c, asset);
  choices = showCandidates(r, c);
  showComparison(c, data.comparison, asset);
  $('pin').disabled = !c.requested;
  $('candidates-note').textContent =
    '已验算 ' + (r.sampleCount ?? 0) + ' 组 · 合格 ' + (r.matchedCount ?? 0) + ' 组';
  for (const v of ['vs', 'hype']) {
    $(v + '-slider').max = Math.max(
      1,
      Math.ceil(r.limits?.[v]?.maxUsd || 1),
      $(v + '-size').valueAsNumber || 0
    );
    if (!inspected && c.requested && mode !== 'auto') {
      const solved = mode === 'fixedVs' ? 'hype' : 'vs';
      if (v === solved) $(v + '-size').value = c.requested[v + 'Usd'];
    }
    $(v + '-slider').value = $(v + '-size').value;
  }
  $('assumptions').innerHTML =
    '<p class="hint">固定当前方案与摩擦条件比较各首次出金点。考核阶段使用过关结算后剩余现金及已重置的 VS 净值。</p>' +
    '<div class="scroll"><table><thead><tr><th>目标净值</th><th>触线价</th><th>可分金额</th><th>到账前 Hype 现金</th><th>验算</th></tr></thead><tbody>' +
    (data.targets ?? [])
      .map(
        (t) =>
          '<tr><td>' +
          money(t.target) +
          '</td><td>' +
          n(t.price, 5) +
          '</td><td>' +
          money(t.payout) +
          '</td><td>' +
          money(t.cash) +
          '</td><td>' +
          h(t.ok ? '满足' : (t.reason ?? '无法验证')) +
          '</td></tr>'
      )
      .join('') +
    '</tbody></table></div><p class="hint">费用按实际增减与平仓成交额计收；盘口情景平移当前深度，按配置压力滑点估算。基准、非美元汇率、固定回撤、报名费、出金分成和未来成交深度均取决于当前输入。搜索显示已验算离散候选中的最优结果；区间内的每个数值仍需单独验算。资金费率单独展示，未设定持有时间的端点不计未来资金费。</p>';
}
function select(idValue) {
  id = idValue;
  inspected = null;
  pinned = null;
  snapshot = null;
  display = null;
  selectedAssets();
  feeds?.selectAsset(current());
  snapshot = feeds?.getSnapshot() ?? null;
  refresh();
}
function orderFromInputs() {
  return {
    vsUsd: $('vs-size').valueAsNumber,
    hypeUsd: $('hype-size').valueAsNumber,
    vsLong:
      $('direction').value === 'both' ? (display?.candidate?.vsLong ?? true) : $('direction').value === 'long'
  };
}
function inspectEdit(v, slider) {
  if (slider) $(v + '-size').value = $(v + '-slider').value;
  const order = orderFromInputs();
  inspected = order;
  refresh();
}
async function saveSettings(config, manual, asset, previous) {
  if (asset.hype.liqSource === 'manual' && snapshot?.mode === 'live')
    asset.hype.liqScopeId = snapshot.scopeId;
  state = await updateWorkspace((s) => {
    const i = s.assets.findIndex((a) => a.id === asset.id);
    if (i < 0 || JSON.stringify(s.assets[i]) !== JSON.stringify(previous))
      throw Error('合约参数已在另一窗口更改，请重新打开设置。');
    s.config = config;
    s.manual = manual;
    s.assets[i] = asset;
  });
  select(id);
}
async function followSimulation() {
  state = await updateWorkspace((s) => {
    s.manual = null;
    s.config.useExternalAccounts = false;
  });
  refresh();
  notify('看板已跟随本地模拟账本，行情继续使用所选来源。');
}
function editAsset(isNew) {
  const before = current();
  openEditor(before, {
    isNew,
    onSave: async (asset) => {
      state = await updateWorkspace((s) => {
        const i = s.assets.findIndex((a) => a.id === asset.id);
        if (i < 0 && isNew) s.assets.push(asset);
        else if (i >= 0 && !isNew && JSON.stringify(s.assets[i]) === JSON.stringify(before))
          s.assets[i] = asset;
        else throw Error('当前配置已变化，请重新打开合约编辑器。');
      });
      select(asset.id);
    }
  });
}
function setup() {
  state = readWorkspace();
  id = state.assets[0].id;
  worker = new Worker(new URL('./match-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    workerBusy = false;
    if (data.id === generation) {
      if (data.error) {
        invalidate();
        $('verdict').textContent = '无法验证 · ' + data.error;
      } else if (freshness !== issueKey()) {
        refresh();
      } else render(data);
    }
    dispatch();
  };
  worker.onerror = (e) => {
    workerBusy = false;
    invalidate();
    notify('计算模块错误：' + e.message);
  };
  selectedAssets();
  feeds = mountFeedUI($('feed-root'), {
    getAsset: current,
    onUpdate: (next) => {
      if (next.assetId !== id) return;
      snapshot = next;
      feedCache.set(id, next);
      refresh();
    }
  });
  simulation = mountSimulation($('sim-root'), {
    getAsset: market,
    getAssets: allMarkets,
    getConfig: () => state.config,
    getOrder: safeOrder,
    getCandidate: () => display?.candidate,
    getAccount: () => getInputs().account,
    onChange: () => {
      refresh();
      renderLegacy();
    }
  });
  tab();
  refresh();
}
$('export-settings').onclick = guard(() => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(strategyBackup(state), null, 2)], { type: 'application/json' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'vs-hype-settings.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});
$('import-settings').onchange = guard(async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 4000000) throw Error('品种与规则文件过大。');
  const raw = await file.text();
  loadStrategyBackup(structuredClone(state), raw);
  if (!confirm('合并文件内的品种并替换同名配置和当前规则？')) return;
  state = await updateWorkspace((s) => loadStrategyBackup(s, raw));
  select(id);
  notify('品种与规则已恢复，请核对报价时刻及数据接入映射。');
});
$('follow-simulation').onclick = guard(followSimulation);
$('asset').onchange = () => select($('asset').value);
$('asset-new').onclick = () => editAsset(true);
$('contract-edit').onclick = () => editAsset(false);
$('account-edit').onclick = guard(() => {
  const before = current();
  openSettings({
    config: state.config,
    account: getInputs().account,
    manual: state.manual,
    asset: before,
    onSave: (c, a, s) => saveSettings(c, a, s, before)
  });
});
$('feed-switch').onchange = guard((e) => feeds.setMode(e.target.value));
$('auto-open').onclick = guard(() => {
  location.hash = 'feeds';
  tab();
  feeds.focusAuto();
});
$('paste-open').onclick = guard(() => {
  location.hash = 'feeds';
  tab();
  feeds.openPaste();
});
$('refresh-demo').onclick = guard(async () => {
  const asset = structuredClone(current()),
    before = current();
  asset.vs.asOf = asset.hype.asOf = new Date().toISOString();
  state = await updateWorkspace((s) => {
    const i = s.assets.findIndex((a) => a.id === id);
    if (JSON.stringify(s.assets[i]) !== JSON.stringify(before)) throw Error('参数已变更');
    s.assets[i] = asset;
  });
  select(id);
  notify('已用当前模拟价格建立新的离线快照。');
});
document.querySelectorAll('[data-mode]').forEach(
  (b) =>
    (b.onclick = () => {
      mode = b.dataset.mode;
      inspected = null;
      refresh();
    })
);
$('direction').onchange = () => {
  inspected = null;
  refresh();
};
$('sort').onchange = guard(async () => {
  const sort = $('sort').value;
  state = await updateWorkspace((s) => {
    s.config.sortBy = sort;
  });
  refresh();
});
for (const v of ['vs', 'hype']) {
  $(v + '-size').oninput = () => inspectEdit(v, false);
  $(v + '-slider').oninput = () => inspectEdit(v, true);
}
$('solve').onclick = () => {
  inspected = null;
  refresh();
};
$('pin').onclick = () => {
  pinned = { ...display.candidate.requested };
  refresh();
};
$('clear-pin').onclick = () => {
  pinned = null;
  refresh();
};
$('scenario-buttons').onclick = (e) => {
  const key = e.target.closest('[data-scenario]')?.dataset.scenario;
  if (key && display) {
    scenario = key;
    const { asset, account, config } = getInputs();
    showAxes(asset, display.candidate, account, config, key);
  }
};
$('candidates').onclick = (e) => {
  const index = e.target.closest('[data-choice]')?.dataset.choice;
  if (index !== undefined && choices[index]?.requested) {
    inspected = { ...choices[index].requested };
    mode = 'fixedVs';
    $('direction').value = inspected.vsLong ? 'long' : 'short';
    $('vs-size').value = inspected.vsUsd;
    $('hype-size').value = inspected.hypeUsd;
    refresh();
  }
};
$('legacy-entries').onclick = guard(async (e) => {
  const key = e.target.closest('[data-release]')?.dataset.release;
  if (key) {
    await closePosition(key);
    renderLegacy();
    refresh();
  }
});
window.addEventListener('hashchange', tab);
window.addEventListener(
  'storage',
  guard((e) => {
    if (e.key === WORKSPACE_KEY || e.key === null) {
      state = readWorkspace();
      select(state.assets.some((a) => a.id === id) ? id : state.assets[0].id);
    } else if ([SIM_KEY, LEDGER_KEY].includes(e.key)) {
      refresh();
      if (!$('sim').hidden) renderLegacy();
    }
  })
);
setInterval(() => {
  if (state && freshness !== issueKey()) refresh();
}, 200);
try {
  setup();
} catch (e) {
  notify(e.message);
  $('verdict').textContent = '无法验证 · ' + e.message;
}
