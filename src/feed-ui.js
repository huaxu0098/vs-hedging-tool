import { MAINNET, parseEndpoint, readHype, toMarketAsset, documentedQuote } from './feeds.js';
import { parseVSText, captureScript } from './vs-parser.js';
import { mountVestAuto, vestAutoPanel } from './vest-auto.js';
import { mountUsdRates } from './usd-rates.js';
export { toMarketAsset };

const mapKey = (id) => 'vs-hype:feed-map:v1:' + id;
const supported = new Set(['btc', 'eth', 'sol']);
const display = (v) => (v == null ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 8 }));
const message = (e) => e?.message || String(e);
const numberOrNull = (value) => (value.trim() && Number.isFinite(Number(value)) ? Number(value) : null);
function field(id, label, type = 'text') {
  return (
    '<label>' +
    label +
    '<input id="' +
    id +
    '" type="' +
    type +
    '" autocomplete="off"' +
    (type === 'number' ? ' step="any"' : '') +
    '></label>'
  );
}

export function mountFeedUI(container, { getAsset, onUpdate }) {
  if (!document.getElementById('feed-css')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = './feeds.css';
    link.id = 'feed-css';
    document.head.append(link);
  }
  container.classList.add('fd');
  container.innerHTML = `
    <header><div><h2>行情与数据接入</h2><p>Hype 读取公开市场与可选地址。VS 使用已确认的页面数据。</p></div>
      <button type="button" id="feed-paste-open">粘贴识别 VS 页面</button></header>
    ${vestAutoPanel}
    <div class="fd-card"><h3>行情连接</h3><div class="fd-grid">
      <label>数据模式<select id="feed-mode"><option value="offline">离线模拟</option><option value="live">Hype API 实时</option><option value="frozen">冻结实时快照</option></select></label>
      <label>自动轮询<select id="feed-period"><option value="1000">1 秒</option><option value="2000" selected>2 秒</option><option value="5000">5 秒</option></select></label>
      ${field('feed-age', '过期阈值（秒）', 'number')}
      <label>预设端点<select id="feed-network"><option value="">自定义</option><option value="https://api.hyperliquid.xyz/info">主网</option><option value="https://api.hyperliquid-testnet.xyz/info">测试网</option></select></label>
      ${field('feed-endpoint', '只读 /info Endpoint', 'url')}${field('feed-wallet', '公开钱包地址（选填）')}
    </div><div class="fd-row"><button id="feed-refresh" type="button">立即查询</button>
    <button id="feed-clear-vs" type="button">清除当前 VS 快照</button><span id="feed-health" role="status"></span></div></div>
    <div class="fd-card"><h3>品种映射及汇率</h3><p id="feed-target"></p><div class="fd-grid">
      ${field('feed-vssym', 'VS 页面精确代码')}${field('feed-hsym', 'Hype universe 精确代码')}${field('feed-dex', 'HIP-3 DEX（主永续留空）')}${field('feed-live-quote', 'Hype 实际报价币（按合约规格）')}
      <label>拟用 Hype 保证金模式<select id="feed-margin-mode"><option value="cross">全仓</option><option value="isolated">逐仓</option></select></label>
    </div><label>美元汇率来源<select id="feed-fx-mode"><option value="auto">自动 · 美元现货盘口</option><option value="manual">手动确认</option></select></label>
    <div id="feed-fx-status" class="fd-reading"></div><div class="fd-grid" id="feed-fx" hidden></div>
    <button type="button" id="feed-fx-confirm" hidden>确认手动汇率</button>
    <label class="fd-check"><input type="checkbox" id="feed-map-verify">我已核对两边合约的标的、规格、结算币和价格关系</label>
    <button type="button" id="feed-save-map">应用连接与合约映射</button></div>
    <div class="fd-card"><h3>已接收的数据</h3><div class="fd-reading" id="feed-values"></div>
    <details><summary>盘口五档与当前 DEX 公开持仓</summary><pre id="feed-depth"></pre></details></div>
    <details class="fd-card"><summary>手动采集其他 VS 来源（单次推送）</summary><p>输入 VS 页面的 HTTPS 来源，配对当前品种后复制脚本。在该页面框选报价或账户文字，运行脚本并核对将发送的字段。配对有效 10 分钟。</p>
    ${field('feed-origin', 'VS 页面来源（例如 https://trade.example.com）', 'url')}
    <div class="fd-row"><button type="button" id="feed-pair">配对此来源</button><button type="button" id="feed-revoke">撤销配对</button></div>
    <label>本机采集脚本<textarea id="feed-script" rows="3" readonly></textarea></label><button type="button" id="feed-copy">复制脚本</button>
    <p id="feed-bridge-health" role="status"></p></details>`;
  const $ = (id) => container.querySelector('#' + id);
  $('feed-age').value = '5';
  const savedMode = localStorage.getItem('vs-hype:feed-mode:v2');
  let asset = null,
    config = null,
    mode = ['offline', 'frozen'].includes(savedMode) ? savedMode : 'live',
    vs = null,
    hype = null,
    errors = [],
    pending = false,
    dirty = false,
    vestContract = null;
  let auto,
    vsAutoIssue = '',
    vsAutoAccountIssue = '',
    vsAutoSpecIssue = '';
  let scopeId = crypto.randomUUID(),
    publicAddress = '',
    sessionEndpoint = null,
    sharedVSAccount = null;
  let epoch = 0,
    inflight,
    timer,
    dead = false,
    dialog = null,
    bridgeSeq = 0,
    bridgeTimer,
    readingBridge = false,
    lastHealth = '';
  const vsRecords = new Map();
  const usd = mountUsdRates($, () => emit());

  function freshMap(a) {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(mapKey(a.id)) || '{}') || {};
    } catch {
      /* Editable defaults remain available. */
    }
    const defaults = {
      endpoint: MAINNET,
      vsSymbol: a.ticker,
      symbol: supported.has(a.id) ? a.ticker : '',
      dex: '',
      verified: false,
      marginMode: 'cross',
      quoteCurrency: supported.has(a.id) ? 'USDT' : ''
    };
    const endpoint = sessionEndpoint ?? saved.endpoint ?? MAINNET;
    return {
      ...defaults,
      ...saved,
      endpoint,
      address: publicAddress,
      verified: saved.endpoint === endpoint && saved.fingerprint === fingerprint(a) && saved.verified === true
    };
  }
  function fingerprint(a) {
    return JSON.stringify([
      a.benchmark,
      a.priceUnit,
      ...['vs', 'hype'].map((k) => {
        const l = a[k];
        return [
          l.symbol,
          l.type,
          l.benchmark,
          l.ratio,
          l.multiplier,
          l.quoteScale,
          l.quote,
          l.settle,
          l.qtyUnit
        ];
      })
    ]);
  }
  function suggestedVestSymbol() {
    if (supported.has(asset.id) && config.vsSymbol === asset.ticker) return asset.ticker + '-PERP';
    return config.vsSymbol !== asset.ticker || /-PERP$/.test(config.vsSymbol) ? config.vsSymbol : '';
  }
  function stampAccount(leg, expected) {
    if (!leg?.account) return leg;
    const a = leg.account;
    if (Array.isArray(a.positions)) {
      a.positions = a.positions.map((p) => ({
        ...p,
        ...(p.symbol === expected ? { assetId: asset.id } : {})
      }));
      a.position = a.positions.find((p) => p.assetId === asset.id) ?? null;
    }
    return leg;
  }
  function snapshot() {
    const result = {
      assetId: asset.id,
      scopeId,
      mode,
      vs,
      hype,
      errors: [...errors],
      frozen: mode === 'frozen',
      pending,
      maxAgeMs: config.maxAgeMs,
      vsAutoIssue,
      vsAutoAccountIssue,
      vsAutoSpecIssue,
      mappingVerified: config.verified && !dirty,
      updatedAt: new Date().toISOString(),
      addressConfigured: !!config.address,
      marginMode: config.marginMode,
      quoteCurrency: config.quoteCurrency,
      vestContract,
      fxMode: usd.mode,
      usdRates: usd.rates,
      fx: usd.manual
    };
    return result;
  }
  function showHealth(snap) {
    const problems = toMarketAsset(asset, snap).sourceIssues;
    const status =
      mode === 'offline'
        ? (vs?.bid
            ? 'VS 确认报价 / Hype 离线模拟。'
            : vs?.account
              ? 'VS 确认账户 / Hype 离线模拟。'
              : '离线模拟') + problems.join(' ')
        : problems.length
          ? problems.join(' ')
          : pending
            ? '实时连接 · 正在更新'
            : '实时连接';
    $('feed-health').textContent = status;
    const lines = [];
    for (const [label, leg] of [
      ['VS', vs],
      ['Hype', hype]
    ]) {
      if (!leg) {
        lines.push(label + '　尚无已确认数据');
        continue;
      }
      const age = Date.now() - Date.parse(leg.asOf);
      lines.push(
        label +
          '　' +
          (leg.symbol || '') +
          '　买一 ' +
          display(leg.bid) +
          '　卖一 ' +
          display(leg.ask) +
          '　标记 ' +
          display(leg.mark)
      );
      lines.push(
        (leg.timeSource === 'capture' ? '本机采集时间　' : '源报价时间　') +
          (leg.asOf || '—') +
          '　距今 ' +
          (Number.isFinite(age) ? age + ' ms' : '—') +
          (leg.latencyMs != null ? '　请求 ' + leg.latencyMs + ' ms' : '')
      );
      if (leg.receivedAt)
        lines.push(
          '本机收到　' +
            leg.receivedAt +
            (leg.contextReceivedAt ? '　标记价和资金费的时间使用本机接收时间' : '')
        );
      if (leg.account)
        lines.push(
          '净值 ' +
            display(leg.account.equity) +
            '　已用 ' +
            display(leg.account.used) +
            '　可用 ' +
            display(leg.account.free) +
            ' ' +
            (leg.account.currency ?? (label === 'VS' ? 'USD 等值' : 'U'))
        );
    }
    if (hype)
      lines.push(
        'Hype　Oracle ' +
          display(hype.oracle) +
          '　每小时资金费率 ' +
          display(hype.fundingRate * 100) +
          '%　最大杠杆 ' +
          display(hype.maxLeverage) +
          '×'
      );
    $('feed-values').textContent = lines.join('\n');
    return problems.join('|');
  }
  function emit(force = true) {
    if (dead || !asset) return;
    syncFX();
    const s = snapshot(),
      health = showHealth(s);
    if (force || health !== lastHealth) onUpdate(s);
    lastHealth = health;
  }
  function cancel() {
    ++epoch;
    inflight?.abort();
    clearTimeout(timer);
    pending = false;
  }
  function refresh(forceAtStart = true) {
    if (dead || mode !== 'live') return;
    cancel();
    if (dirty) {
      errors = ['连接参数已改，请应用当前映射。'];
      emit();
      return;
    }
    const ticket = epoch,
      controller = new AbortController();
    inflight = controller;
    pending = true;
    emit(forceAtStart);
    readHype({ ...config, signal: controller.signal, proxyBase: location.origin })
      .then((data) => {
        if (dead || ticket !== epoch) return;
        if (
          hype &&
          (Date.parse(data.asOf) < Date.parse(hype.asOf) ||
            (data.account && hype.account && Date.parse(data.account.asOf) < Date.parse(hype.account.asOf)))
        ) {
          throw Error('上游返回早于已接收快照的数据。');
        }
        hype = stampAccount(data, config.symbol);
        errors = [];
      })
      .catch((err) => {
        if (dead || ticket !== epoch) return;
        errors = ['Hype 报价过期，已锁定。' + message(err)];
      })
      .finally(() => {
        if (dead || ticket !== epoch) return;
        pending = false;
        inflight = null;
        $('feed-depth').textContent = JSON.stringify(
          { book: hype?.book ?? null, positions: hype?.account?.positions ?? [], tiers: hype?.tiers ?? null },
          null,
          2
        );
        emit();
        timer = setTimeout(() => refresh(false), config.period);
      });
  }
  function setMode(next) {
    if (!['offline', 'live', 'frozen'].includes(next)) return;
    if (auto?.active && next !== 'live')
      auto.stop(next === 'frozen' ? '已冻结，自动读取已暂停。' : '已切至离线，自动读取已停止。', {
        retain: next === 'frozen'
      });
    cancel();
    mode = next;
    $('feed-mode').value = next;
    localStorage.setItem('vs-hype:feed-mode:v2', next);
    if (next === 'live') {
      errors = [];
      refresh();
    } else {
      emit();
    }
  }
  function syncFX() {
    const liveVest =
      vestContract &&
      vestContract.symbol === config.vsSymbol &&
      (vs?.source === 'Vest 公开行情' || (!vs?.bid && auto?.active));
    const bindings = [
      { side: 'vs', kind: 'quote', code: liveVest ? vestContract.quote : asset.vs.quote },
      { side: 'vs', kind: 'settle', code: asset.vs.settle },
      { side: 'vs', kind: 'account', code: vs?.account?.currency },
      { side: 'hype', kind: 'quote', code: config.quoteCurrency || asset.hype.quote },
      { side: 'hype', kind: 'settle', code: asset.hype.settle }
    ];
    usd.configure(
      bindings,
      mode === 'live' ||
        (mode === 'offline' &&
          (vs?.bid > 0 ||
            (vs?.account?.currency && vs.account.currency !== 'USD') ||
            vs?.account?.positions?.some((item) => item.currency && item.currency !== 'USD'))),
      config.maxAgeMs,
      config.period
    );
  }
  function markDirty() {
    dirty = true;
    cancel();
    $('feed-map-verify').checked = false;
    errors = ['连接参数已改，请重新核对并应用。'];
    emit();
  }
  function selectAsset(next) {
    if (!next) return;
    const old = asset;
    if (old && old.id === next.id && fingerprint(old) === fingerprint(next)) {
      asset = next;
      emit(false);
      return;
    }
    if (auto?.active) auto.stop('已切换品种。');
    cancel();
    dialog?.close();
    if (old) vsRecords.set(old.id, vs);
    scopeId = crypto.randomUUID();
    asset = next;
    config = freshMap(asset);
    sessionEndpoint = config.endpoint;
    const quote = vsRecords.get(asset.id);
    vs = quote || sharedVSAccount ? { ...quote, account: sharedVSAccount } : null;
    hype = null;
    vestContract = null;
    errors = [];
    dirty = false;
    Object.assign(config, {
      period: Number($('feed-period').value),
      maxAgeMs: Number($('feed-age').value) * 1000
    });
    $('feed-vssym').value = config.vsSymbol;
    auto?.setURL(suggestedVestSymbol());
    $('feed-hsym').value = config.symbol;
    $('feed-dex').value = config.dex;
    $('feed-live-quote').value = config.quoteCurrency;
    $('feed-margin-mode').value = config.marginMode;
    $('feed-endpoint').value = config.endpoint;
    $('feed-wallet').value = config.address;
    $('feed-network').value = [...$('feed-network').options].some((o) => o.value === config.endpoint)
      ? config.endpoint
      : '';
    $('feed-map-verify').checked = config.verified;
    $('feed-target').textContent = asset.name + ' · ' + asset.ticker + '，代码区分大小写。';
    $('feed-depth').textContent = '';
    $('feed-script').value = '';
    mode === 'live' ? refresh() : emit();
  }
  function saveConfig() {
    try {
      const endpoint = parseEndpoint($('feed-endpoint').value.trim()),
        address = $('feed-wallet').value.trim();
      if (address && !/^0x[0-9a-fA-F]{40}$/.test(address)) throw Error('公开地址格式无效。');
      const maxAgeMs = numberOrNull($('feed-age').value) * 1000;
      if (!(maxAgeMs >= 500 && maxAgeMs <= 86400000)) throw Error('过期阈值应为 0.5 至 86,400 秒。');
      const vsSymbol = $('feed-vssym').value.trim(),
        symbol = $('feed-hsym').value.trim(),
        dex = $('feed-dex').value.trim();
      const quoteCurrency = $('feed-live-quote').value.trim().toUpperCase(),
        published = documentedQuote(symbol, dex);
      if (
        symbol &&
        (!/^[A-Z0-9._-]{1,16}$/.test(quoteCurrency) || (published && quoteCurrency !== published))
      ) {
        throw Error('请核对 Hype 报价币。' + (published ? '该合约规格使用 ' + published + '。' : ''));
      }
      if (!/^[\w.:/-]{1,64}$/.test(vsSymbol)) throw Error('请输入 VS 精确合约代码。');
      if (
        symbol &&
        (!/^[\w.-]+(?::[\w.-]+)?$/.test(symbol) ||
          (symbol.includes(':') ? symbol.split(':')[0] !== dex : !!dex))
      )
        throw Error('HIP-3 代码前缀必须与 DEX 一致。');
      cancel();
      if (
        config.vsSymbol !== vsSymbol ||
        config.symbol !== symbol ||
        config.endpoint !== endpoint ||
        config.address !== address ||
        config.dex !== dex ||
        config.quoteCurrency !== quoteCurrency ||
        config.marginMode !== $('feed-margin-mode').value
      )
        scopeId = crypto.randomUUID();
      if (config.vsSymbol !== vsSymbol) {
        auto?.stop('VS 映射已更改，自动识别已停止。');
        vs = null;
      }
      if (
        config.symbol !== symbol ||
        config.endpoint !== endpoint ||
        config.address !== address ||
        config.dex !== dex
      )
        hype = null;
      config = {
        ...config,
        endpoint,
        address,
        vsSymbol,
        symbol,
        dex,
        quoteCurrency,
        period: Number($('feed-period').value),
        maxAgeMs,
        verified: $('feed-map-verify').checked,
        marginMode: $('feed-margin-mode').value,
        fingerprint: fingerprint(asset)
      };
      if (!auto?.active) auto?.setURL(suggestedVestSymbol());
      publicAddress = address;
      sessionEndpoint = endpoint;
      const { address: omitAddress, ...saved } = config;
      localStorage.setItem(mapKey(asset.id), JSON.stringify(saved));
      dirty = false;
      errors = [];
      mode === 'live' ? refresh() : emit();
    } catch (err) {
      errors = [message(err)];
      emit();
      $('feed-health').textContent = message(err);
    }
  }
  $('feed-mode').onchange = () => setMode($('feed-mode').value);
  $('feed-network').onchange = () => {
    if ($('feed-network').value) $('feed-endpoint').value = $('feed-network').value;
    markDirty();
  };
  for (const id of [
    'feed-endpoint',
    'feed-wallet',
    'feed-vssym',
    'feed-hsym',
    'feed-dex',
    'feed-margin-mode'
  ])
    $(id).addEventListener('input', markDirty);
  $('feed-live-quote').oninput = markDirty;
  $('feed-map-verify').onchange = () => {
    dirty = true;
    emit();
  };
  $('feed-period').onchange = () => {
    config.period = Number($('feed-period').value);
    if (mode === 'live') refresh();
  };
  $('feed-age').onchange = () => {
    const age = Number($('feed-age').value);
    if (age >= 0.5 && age <= 86400) {
      config.maxAgeMs = age * 1000;
      emit();
    } else markDirty();
  };
  $('feed-save-map').onclick = saveConfig;
  $('feed-refresh').onclick = () => (mode === 'live' ? refresh() : setMode('live'));
  function applyVS(candidate, source, partial = false) {
    if (candidate.symbol && candidate.symbol !== config.vsSymbol)
      throw Error('VS 报价代码 ' + candidate.symbol + ' 与映射 ' + config.vsSymbol + ' 不一致。');
    const hasPrice = [candidate.bid, candidate.ask, candidate.mark].some(Number.isFinite);
    const complete = candidate.bid > 0 && candidate.ask >= candidate.bid && candidate.mark > 0;
    if (
      hasPrice &&
      !complete &&
      (!partial || (candidate.bid != null && candidate.ask != null && candidate.ask < candidate.bid))
    )
      throw Error('请补齐正数买一、卖一、标记价，且卖一不低于买一。');
    const time = Date.parse(candidate.asOf),
      prev = Date.parse(vs?.asOf);
    if (!Number.isFinite(time) || time > Date.now() + 1000 || (hasPrice && time < prev))
      throw Error('快照时间无效或早于已有报价。');
    const acct = candidate.account ?? {};
    for (const key of ['used', 'free'])
      if (acct[key] != null && !(acct[key] >= 0)) throw Error('保证金不可为负。');
    const oldAccount = sharedVSAccount;
    const accountTime = acct.asOf ?? candidate.asOf;
    if (
      Object.keys(acct).length &&
      (!Number.isFinite(Date.parse(accountTime)) ||
        Date.parse(accountTime) > Date.now() + 1000 ||
        Date.parse(oldAccount?.asOf) > Date.parse(accountTime))
    )
      throw Error('账户快照时间无效或早于已确认的数据。');
    const account = Object.keys(acct).length ? { ...acct, asOf: accountTime, source } : oldAccount;
    const base = hasPrice
      ? {
          symbol: candidate.symbol || config.vsSymbol,
          sourceKind: 'page',
          bid: candidate.bid,
          ask: candidate.ask,
          mark: candidate.mark,
          open: candidate.open === true,
          timeSource: candidate.timeSource,
          asOf: candidate.asOf,
          price: complete ? (candidate.ask + candidate.bid) / 2 : null,
          spread: complete ? candidate.ask - candidate.bid : null,
          book: null
        }
      : (vs ?? {});
    vs = stampAccount(
      {
        ...base,
        source: hasPrice ? source : base.source || source,
        receivedAt: new Date().toISOString(),
        account
      },
      config.vsSymbol
    );
    sharedVSAccount = vs.account;
    vsRecords.set(asset.id, vs);
    emit();
  }
  function openPaste() {
    if (dialog?.open) {
      dialog.focus();
      return;
    }
    const d = document.createElement('dialog');
    dialog = d;
    d.className = 'fd fd-dialog';
    d.innerHTML = `<form method="dialog"><header><h2>识别 VS 页面</h2><button aria-label="关闭" value="close">×</button></header></form>
      <p>粘贴报价、账户或持仓文字，也可粘贴 JSON 与表格。在下方确认识别结果。</p>
      <label>VS 页面文字<textarea id="vs-paste-text" rows="4" maxlength="24000" placeholder="Balance: 10000&#10;Free Margin: 9500&#10;Bid: 63180&#10;Ask: 63182"></textarea></label>
      <button type="button" id="vs-parse">识别文字</button><div class="fd-fields"><h3>结构化确认与手动微调</h3><div class="fd-grid">
      ${field('vs-symbol', 'VS 合约代码')}${field('vs-bid', '买一', 'number')}${field('vs-ask', '卖一', 'number')}${field('vs-mark', '标记 / 当前价', 'number')}
      ${field('vs-balance', '账户余额（U）', 'number')}${field('vs-equity', '净值（U）', 'number')}${field('vs-used', '已用保证金（U）', 'number')}${field('vs-free', '可用保证金（U）', 'number')}
      <label>阶段<select id="vs-stage"><option value="">未提供</option><option value="challenge">考核</option><option value="funded">出金</option></select></label>
      ${field('vs-time', '报价或采集时间（ISO）')}
      </div><label class="fd-check"><input id="vs-market-open" type="checkbox">已确认此合约当前开市</label>
      <label>现有持仓（JSON 数组，qty 带方向，确认空仓填 []）<textarea id="vs-positions" rows="3"></textarea></label></div>
      <p id="vs-paste-error" role="status"></p><div class="fd-row"><button type="button" id="vs-now">使用此刻采集时间</button><button type="button" id="vs-apply">确认并更新看板</button></div>`;
    document.body.append(d);
    const q = (id) => d.querySelector('#' + id);
    let timeSource = 'capture',
      accountObservedAt = null,
      accountEdited = false;
    function fill(v, parsed = false) {
      accountObservedAt = parsed && Object.keys(v.account ?? {}).length ? (v.account?.asOf ?? v.asOf) : null;
      accountEdited = false;
      q('vs-symbol').value = v.symbol ?? config.vsSymbol;
      for (const k of ['bid', 'ask', 'mark']) q('vs-' + k).value = v[k] ?? '';
      for (const k of ['balance', 'equity', 'used', 'free', 'stage'])
        q('vs-' + k).value = v.account?.[k] ?? '';
      q('vs-time').value = v.asOf ?? new Date().toISOString();
      timeSource = v.timeSource ?? 'capture';
      q('vs-positions').value = v.account?.positions
        ? JSON.stringify(
            v.account.positions.map(({ assetId, ...position }) => position),
            null,
            2
          )
        : '';
      q('vs-market-open').checked = v.open === true;
    }
    fill(vs ?? {});
    for (const key of ['balance', 'equity', 'used', 'free', 'stage', 'positions'])
      q('vs-' + key).addEventListener('input', () => {
        accountEdited = true;
      });
    q('vs-parse').onclick = () => {
      try {
        const value = parseVSText(q('vs-paste-text').value);
        fill(value, true);
        q('vs-paste-error').textContent = '已识别，请核对代码、时刻、开市状态及账户数值。';
      } catch (err) {
        q('vs-paste-error').textContent = message(err);
      }
    };
    q('vs-now').onclick = () => {
      q('vs-time').value = new Date().toISOString();
      timeSource = 'capture';
    };
    q('vs-time').oninput = () => {
      timeSource = 'source';
    };
    q('vs-apply').onclick = () => {
      try {
        const value = {
          symbol: q('vs-symbol').value.trim(),
          asOf: q('vs-time').value,
          open: q('vs-market-open').checked,
          account: {}
        };
        for (const k of ['bid', 'ask', 'mark']) if (q('vs-' + k).value) value[k] = Number(q('vs-' + k).value);
        for (const k of ['equity', 'balance', 'used', 'free'])
          if (q('vs-' + k).value) value.account[k] = Number(q('vs-' + k).value);
        if (q('vs-stage').value) value.account.stage = q('vs-stage').value;
        if (q('vs-positions').value.trim()) value.account.positions = JSON.parse(q('vs-positions').value);
        if (!Object.keys(value.account).length && ![value.bid, value.ask, value.mark].some(Number.isFinite))
          throw Error('请至少填写报价或账户字段。');
        const parsed = parseVSText(JSON.stringify(value));
        parsed.timeSource = timeSource;
        if (!accountEdited && !accountObservedAt) parsed.account = {};
        else if (Object.keys(parsed.account).length)
          parsed.account.asOf = accountEdited ? new Date().toISOString() : accountObservedAt;
        if (auto?.active) auto.stop('已切换到手工确认的数据。', { retain: true });
        applyVS(parsed, 'VS 确认');
        d.close();
      } catch (err) {
        q('vs-paste-error').textContent = message(err);
      }
    };
    d.addEventListener(
      'close',
      () => {
        d.remove();
        dialog = null;
      },
      { once: true }
    );
    d.showModal();
    q('vs-paste-text').focus();
  }
  $('feed-clear-vs').onclick = () => {
    auto?.stop('自动识别已停止。');
    vs = null;
    sharedVSAccount = null;
    vsRecords.delete(asset.id);
    emit();
  };
  $('feed-paste-open').onclick = openPaste;
  async function local(endpoint, body) {
    const opt =
      body === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch('/api/bridge/' + endpoint, { ...opt, signal: AbortSignal.timeout(3000) });
    const v = await r.json();
    if (!r.ok) throw Error(v?.error || '本地桥请求失败。');
    return v;
  }
  $('feed-pair').onclick = async () => {
    const target = asset.id;
    try {
      const origin = new URL($('feed-origin').value).origin;
      const pair = await local('pair', { origin, assetId: target });
      if (target !== asset.id) return;
      $('feed-script').value = captureScript({ ...pair, baseURL: location.origin });
      $('feed-bridge-health').textContent =
        '已配对 ' + origin + '，有效至 ' + new Date(pair.expires).toLocaleTimeString();
      clearInterval(bridgeTimer);
      bridgeTimer = setInterval(checkBridge, 700);
    } catch (err) {
      $('feed-bridge-health').textContent = message(err);
    }
  };
  $('feed-revoke').onclick = async () => {
    try {
      await local('revoke', {});
      clearInterval(bridgeTimer);
      $('feed-script').value = '';
      $('feed-bridge-health').textContent = '配对已撤销。';
    } catch (err) {
      $('feed-bridge-health').textContent = message(err);
    }
  };
  $('feed-copy').onclick = async () => {
    const script = $('feed-script');
    if (!script.value) return;
    try {
      await navigator.clipboard.writeText(script.value);
      $('feed-bridge-health').textContent = '采集脚本已复制。';
    } catch {
      script.focus();
      script.select();
      $('feed-bridge-health').textContent = '请按系统复制快捷键。';
    }
  };
  async function checkBridge() {
    if (readingBridge || dead) return;
    readingBridge = true;
    const target = asset.id;
    try {
      const record = await local('latest');
      if (!record || dead || target !== asset.id || record.assetId !== target || record.sequence <= bridgeSeq)
        return;
      bridgeSeq = record.sequence;
      if (auto?.active) return;
      applyVS(record.snapshot, 'VS 本机采集');
      $('feed-bridge-health').textContent = '已接收 ' + record.receivedAt;
    } catch (err) {
      $('feed-bridge-health').textContent = message(err);
    } finally {
      readingBridge = false;
    }
  }
  auto = mountVestAuto($, {
    prepare(symbol, usePublic) {
      if (dirty) throw Error('请先应用已修改的合约映射，再开始自动识别。');
      if (symbol !== config.vsSymbol && symbol !== suggestedVestSymbol())
        throw Error('交易页代码 ' + symbol + ' 与所选品种的 VS 映射不一致。请先核对并应用准确的映射。');
      if (config.vsSymbol !== symbol) {
        config.vsSymbol = symbol;
        config.verified = false;
        $('feed-vssym').value = symbol;
        $('feed-map-verify').checked = false;
        scopeId = crypto.randomUUID();
      }
      vs = null;
      vestContract = null;
      sharedVSAccount = null;
      vsRecords.delete(asset.id);
      if (usePublic) localStorage.setItem('vs-hype:vest-public:' + asset.id, symbol);
      else localStorage.removeItem('vs-hype:vest-public:' + asset.id);
      if (mode !== 'live') setMode('live');
    },
    apply(candidate, source) {
      const checked = parseVSText(JSON.stringify(candidate));
      const accountCurrency = candidate.account?.currency;
      if (
        Object.keys(checked.account).length &&
        typeof accountCurrency === 'string' &&
        /^[A-Z0-9]{2,12}$/.test(accountCurrency)
      )
        checked.account.currency = accountCurrency;
      checked.timeSource = candidate.timeSource;
      for (const k of ['mark', 'bid', 'ask'])
        if (checked[k] != null && !(checked[k] > 0)) throw Error('VS 页面报价无效。');
      applyVS(checked, source, true);
    },
    issue(reason) {
      if (vsAutoIssue !== reason) {
        vsAutoIssue = reason;
        emit();
      }
    },
    accountLost(reason) {
      if (vsAutoAccountIssue !== reason) {
        vsAutoAccountIssue = reason;
        emit();
      }
    },
    checkQuoteCurrency(symbol, contract) {
      const valid =
        contract?.symbol === symbol &&
        symbol === config.vsSymbol &&
        typeof contract.quote === 'string' &&
        /^[A-Z0-9._-]{1,16}$/.test(contract.quote);
      const next = valid ? { symbol, quote: contract.quote } : null;
      const reason = valid ? '' : '尚未核实 Vest 公开行情的报价币。';
      const changed = vestContract?.quote !== next?.quote || vestContract?.symbol !== next?.symbol;
      if (changed && vestContract && next && config.verified) {
        config.verified = false;
        $('feed-map-verify').checked = false;
      }
      vestContract = next;
      if (changed || vsAutoSpecIssue !== reason) {
        vsAutoSpecIssue = reason;
        emit();
      }
      return reason;
    },
    end(retain) {
      localStorage.removeItem('vs-hype:vest-public:' + asset.id);
      vsAutoIssue = vsAutoAccountIssue = vsAutoSpecIssue = '';
      if (!retain) {
        vestContract = null;
        vs = null;
        sharedVSAccount = null;
        vsRecords.delete(asset.id);
      }
      if (asset) emit();
    }
  });
  $('feed-mode').value = mode;
  selectAsset(getAsset());
  const launch = new URL(location.href);
  const launchSymbol = launch.searchParams.get('vest');
  if (launchSymbol && launchSymbol === suggestedVestSymbol()) {
    launch.searchParams.delete('vest');
    history.replaceState(history.state, '', launch);
    auto.startPublic();
  } else if (
    mode === 'live' &&
    suggestedVestSymbol() &&
    localStorage.getItem('vs-hype:vest-public:' + asset.id) === suggestedVestSymbol()
  ) {
    auto.startPublic();
  }
  const watch = setInterval(() => {
    if (asset && (mode !== 'offline' || vs)) emit(false);
  }, 200);
  return {
    selectAsset,
    setMode,
    refresh,
    openPaste,
    getSnapshot: () => snapshot(),
    focusAuto: () => {
      $('feed-auto-url').scrollIntoView({ block: 'center' });
      $('feed-auto-start').focus({ preventScroll: true });
    },
    destroy() {
      dead = true;
      usd.destroy();
      auto?.destroy();
      cancel();
      clearInterval(watch);
      clearInterval(bridgeTimer);
      dialog?.close();
    }
  };
}
