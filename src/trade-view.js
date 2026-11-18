import { number, signed, money } from './format.js';
import { buildTradePreview } from './trade-preview.js';
import { readTradeEvents } from './trade-events.js';
import { liveOrder, orderLeg } from './trade-order.js';
import { liquidationMonitor } from './trade-history.js';

export function mountTradeDesk({ read, current, getSim }) {
  const $ = (id) => document.getElementById(id);
  const controls = $('trade-controls');
  const set = (id, value) => {
    const el = $(id);
    if (el.textContent !== value) el.textContent = value;
  };
  const amount = (value) => (Number.isFinite(value) ? money(value) : '—');
  const pnl = (value) => (Number.isFinite(value) ? signed(value) + ' U' : '—');
  const when = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '');
  const monitor = liquidationMonitor((message, outcome = '') => {
    set('trade-hype-event', message);
    $('trade-hype-event').dataset.outcome = outcome;
  });
  let shown = false;
  function links(asset, snap) {
    const codes = [snap?.vs?.symbol || $('feed-vssym')?.value, snap?.hype?.symbol || $('feed-hsym')?.value];
    // The three built-in crypto templates have a dedicated Vest trading route.
    // This shortcut only opens a website. Live execution always uses the observed symbols.
    if (['btc', 'eth', 'sol'].includes(asset.id) && codes[0] === asset.ticker) codes[0] += '-PERP';
    const urls = [
      typeof codes[0] === 'string' && /^[A-Z0-9._-]+-PERP$/.test(codes[0])
        ? 'https://next.vestmarkets.com/trade/' + encodeURIComponent(codes[0])
        : '',
      typeof codes[1] === 'string' && /^[\w.-]+(?::[\w.-]+)?$/.test(codes[1])
        ? 'https://app.hyperliquid.xyz/trade/' + encodeURIComponent(codes[1])
        : ''
    ];
    for (const [i, v] of ['vs', 'hype'].entries()) {
      const a = $('trade-' + v + '-url');
      if (urls[i]) a.href = urls[i];
      else a.removeAttribute('href');
    }
    controls.dataset.symbols = JSON.stringify(codes);
    $('trade-open').disabled = !urls.every(Boolean);
  }
  function draw() {
    const { display, snapshot, asset } = read();
    if (!asset) return;
    const visible = !$('trade').hidden;
    monitor(snapshot, snapshot?.hype?.symbol, visible);
    if (!visible) {
      shown = false;
      delete controls.dataset.plan;
      delete controls.dataset.intent;
      return;
    }
    if (!shown) {
      shown = true;
      document.dispatchEvent(new Event('trade-probe'));
    }
    const result = display?.asset?.id === asset.id && !display.historical ? display : null;
    const a = result?.asset || asset,
      c = result?.candidate;
    const { reason, plan } = liveOrder(result, snapshot, !!result);
    if (plan) controls.dataset.intent = JSON.stringify(plan);
    else delete controls.dataset.intent;
    if (plan && current()) controls.dataset.plan = controls.dataset.intent;
    else delete controls.dataset.plan;
    links(a, snapshot);
    const extension = controls.dataset.extension === 'ready';
    let receipt;
    try {
      receipt = JSON.parse(controls.dataset.receipt || 'null');
    } catch {}
    $('trade-send').disabled = !plan || !extension || !!receipt || !!controls.dataset.busy;
    set(
      'trade-state',
      snapshot?.mode === 'live' ? '实时行情' : snapshot?.mode === 'frozen' ? '行情冻结' : '离线推演'
    );
    set(
      'trade-why',
      [!extension ? '需要加载双边开仓扩展。' : '', receipt ? '请先核对上一笔委托。' : '', reason]
        .filter(Boolean)
        .join(' ') || '两个官方表单将在点击时核对当前账户、方向和实际数量。'
    );
    set('trade-feedback', controls.dataset.feedback || '');
    $('trade-receipt').hidden = !receipt;
    if (receipt)
      set(
        'trade-receipt-text',
        when(receipt.time) +
          ' · ' +
          receipt.legs
            .map(
              (l) =>
                (l.venue === 'vs' ? 'VS' : 'Hype') +
                ' ' +
                l.symbol +
                ' ' +
                (l.side === 'buy' ? '买' : '卖') +
                l.quantity +
                ' ' +
                l.unit +
                ' · ' +
                l.status
            )
            .join(' ／ ')
      );
    for (const v of ['vs', 'hype']) {
      const l = orderLeg(c, a, v);
      set(
        'trade-' + v + '-qty',
        l ? (l.side === 'buy' ? '买入 ' : '卖出 ') + l.quantity + ' ' + l.unit : '—'
      );
      set('trade-' + v + '-cost', l ? '约 ' + amount(l.notional) : '');
    }
    const preview = buildTradePreview(a, result?.account, result?.config, c);
    const stage = preview.stage === 'funded';
    set('trade-pass-title', stage ? 'VS 达到出金目标' : 'VS 考核通过');
    const choice = $('trade-scenario');
    const title = stage ? 'VS 达到出金目标' : 'VS 考核通过';
    if (choice.options[1].text !== title) choice.options[1].text = title;
    const selected = preview.scenarios[choice.value];
    set('trade-pnl', pnl(selected.profit));
    $('trade-pnl').dataset.sign = selected.profit < 0 ? 'loss' : selected.profit > 0 ? 'profit' : '';
    set('trade-pnl-note', selected.reason || '相对本次开仓前个人净值，已计预计交易费用。');
    set('trade-cash', amount(selected.cash));
    set('trade-total', pnl(selected.totalProfit));
    set('trade-payout', amount(selected.pendingPayout));
    for (const k of ['pass', 'fail', 'liq']) {
      const s = preview.scenarios[k],
        spec = k === 'liq' ? a.hype : a.vs;
      const unit =
        a.priceUnit === '点'
          ? '点'
          : (spec.quote || 'USD') + '/' + (a.priceUnit?.includes('盎司') ? '盎司' : a.ticker);
      set(
        'trade-' + k + '-price',
        Number.isFinite(s.localPrice) ? number(s.localPrice, 5) + ' ' + unit : '—'
      );
      set(
        'trade-' + k + '-result',
        Number.isFinite(s.profit) ? '本次净盈亏 ' + pnl(s.profit) : s.reason || '等待验算'
      );
    }
    const acct = snapshot?.vs?.account,
      e = acct?.outcome;
    const age = Date.now() - Date.parse(e?.asOf);
    const known =
      snapshot?.mode === 'live' &&
      snapshot.mappingVerified &&
      e?.source === 'vest-page' &&
      e.accountContext &&
      e.accountContext === acct.accountContext &&
      e.symbol === snapshot.vs?.symbol &&
      age >= 0 &&
      age <= snapshot.maxAgeMs &&
      ['passed', 'failed'].includes(e.status);
    $('trade-vs-event').dataset.outcome = known ? e.status : '';
    set(
      'trade-vs-event',
      known
        ? (e.status === 'passed' ? '官方页面显示已通过' : '官方页面显示账户失败 / 爆号') +
            ' · ' +
            when(e.asOf)
        : '当前账户尚无可验证的官方通过或失败状态'
    );
    let sim;
    try {
      sim = readTradeEvents(getSim(), asset.id);
    } catch {
      set('trade-sim-event','本地模拟账本暂时无法读取。');
      return;
    }
    const held = sim.positions.map(
      (p) =>
        (p.venue === 'vs' ? 'VS' : 'Hype') +
        ' ' +
        signed(p.qty, 8) +
        ' ' +
        (p.unit || '') +
        ' @ ' +
        number(p.entry, 5)
    );
    const labels = [
      sim.pending?.label,
      sim.latest?.label,
      sim.accountEvent ? '账户结算 · ' + sim.accountEvent.label : '',
      held.join('，')
    ].filter(Boolean);
    set('trade-sim-event', labels.length ? labels.join(' ／ ') : '本品种暂无模拟成交或结算记录。');
  }
  $('trade-open').addEventListener('click', () => {
    if (controls.dataset.extension === 'ready') return;
    $('trade-setup').open = true;
    for (const v of ['vs', 'hype']) {
      const url = $('trade-' + v + '-url').getAttribute('href');
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    }
    set('trade-feedback', '若浏览器拦截第二个标签，请使用下方两个官网链接。');
    controls.dataset.feedback = $('trade-feedback').textContent;
  });
  controls.addEventListener('trade-extension', draw);
  controls.addEventListener('trade-check', draw);
  $('trade-scenario').addEventListener('change', draw);
  if (location.pathname === '/trade.html') {
    fetch('/config/trade-extension-location.json')
      .then((r) => r.json())
      .then((info) => set('trade-extension-path', info.path))
      .catch(() => {});
  }
  return draw;
}
