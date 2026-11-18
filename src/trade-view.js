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
  const show = (id, visible) => {
    $(id).hidden = !visible;
  };
  function setPnl(id, value, fallback) {
    set(id, Number.isFinite(value) ? pnl(value) : fallback);
    $(id).dataset.sign = value > 0 ? 'profit' : value < 0 ? 'loss' : '';
    $(id).classList.toggle('text-result', !Number.isFinite(value));
  }
  function showProjection(asset, result, historical, issue, synced, feedMode) {
    const candidate = result?.blocked ? null : result?.candidate;
    const preview = buildTradePreview(asset, result?.account, result?.config, candidate);
    const { pass, fail, close, liq } = preview.scenarios;
    const funded = preview.stage === 'funded';
    const target = funded ? 'VS 达到出金目标' : 'VS 考核通过';
    const hasPayout =
      funded && Number.isFinite(pass.pendingPayout) && Number.isFinite(pass.profitAfterPayout);
    set('trade-pass-label', hasPayout ? '若首次出金到账' : target);
    set('trade-pass-title', target);
    set(
      'trade-profit-stage',
      preview.stage ? (funded ? '出金' : '考核') + (synced ? ' · 双边账户' : ' · 含本地账户') : ''
    );
    const available = Object.values(preview.scenarios).some((s) => s.status !== 'unverified');
    show('trade-profit-body', available);
    show('trade-profit-wait', !available);
    const expiredDemo = feedMode === 'offline' && /过期|超龄|时间异常/.test(issue || fail.reason);
    const hasAction = feedMode === 'offline' ? expiredDemo : historical || issue || !!result;
    show('trade-profit-actions', !available && hasAction);
    set('trade-demo', expiredDemo ? '重放模拟报价' : '用离线报价试算');
    if (!available) {
      set(
        'trade-profit-wait',
        historical
          ? '报价已过期，等待新报价重新估算。'
          : issue || result
            ? '暂时无法估算。' + (issue || fail.reason)
            : '正在等待有效行情与仓位验算。'
      );
    }
    if (available) {
      for (const [key, row] of Object.entries({ pass, fail })) {
        const label =
          row.status === 'simultaneous'
            ? '触线顺序待定'
            : row.status === 'preempted'
              ? row.first === 'liq'
                ? 'Hype 会先强平'
                : '其他规则先触发'
              : '金额待核实';
        const paid = key === 'pass' && hasPayout;
        setPnl('trade-' + key + '-pnl', paid ? row.profitAfterPayout : row.profit, label);
        let detail = row.reason;
        const cash = paid ? row.cashAfterPayout : row.cash;
        const cycleProfit = paid ? row.totalProfitAfterPayout : row.totalProfit;
        if (Number.isFinite(cash)) {
          detail = (paid ? '到账后个人现金 ' : '结算后个人现金 ') + amount(cash);
          if (Number.isFinite(cycleProfit))
            detail +=
              ' · ' +
              (cycleProfit >= 0 ? '超过回本线 ' + amount(cycleProfit) : '距回本还差 ' + amount(-cycleProfit));
        }
        set('trade-' + key + '-detail', detail);
      }
      show('trade-payout-detail', hasPayout);
      if (hasPayout)
        set(
          'trade-payout-detail',
          '仅达标平仓时，本次净盈亏 ' +
            pnl(pass.profit) +
            '，个人现金 ' +
            amount(pass.cash) +
            '。预计首笔分成 ' +
            amount(pass.pendingPayout) +
            ' 尚待到账。'
        );
      setPnl('trade-close-pnl', close.profit, close.reason || '金额待核实');
      let risk = liq.reason;
      if (liq.status === 'preempted' && liq.first) {
        const first = preview.scenarios[liq.first];
        const event = liq.first === 'pass' ? target : 'VS 触及失败线';
        risk = '按当前路径，' + event + '先于 Hype 强平。';
        if (Number.isFinite(first.profit)) risk += '届时平仓的个人净盈亏为 ' + pnl(first.profit) + '。';
      } else if (liq.status === 'conditional') {
        risk =
          'Hype 会先强平。' +
          (Number.isFinite(liq.positionGross)
            ? '触发时这笔 Hype 持仓的预计浮盈亏为 ' + pnl(liq.positionGross) + '。'
            : '') +
          '实际结算盈亏取决于处置成交价、费用和返还的抵押额。';
      }
      set('trade-liq-note', risk);
      $('trade-liq-note').dataset.warning = String(
        liq.status === 'conditional' || liq.status === 'simultaneous'
      );
      set(
        'trade-accounting-note',
        '均为条件推演。个人盈亏按开仓前净值' +
          (Number.isFinite(preview.startingEquity) ? ' ' + amount(preview.startingEquity) : '') +
          ' 计算，含预计成交与平仓费用。' +
          (funded ? '未到账分成单列。' : '考核通过时没有提款收入。')
      );
    }
    for (const [key, row] of Object.entries({ pass, fail, liq })) {
      const spec = key === 'liq' ? asset.hype : asset.vs;
      const mark = spec.mark ?? spec.price;
      const unit =
        asset.priceUnit === '点'
          ? '点'
          : (spec.quote || 'USD') +
            '/' +
            (asset.priceUnit?.includes('盎司') ? '盎司' : asset.unit || asset.ticker);
      const hasPrice = !result?.blocked && Number.isFinite(row.localPrice) && row.localPrice > 0;
      set(
        'trade-' + key + '-price',
        hasPrice
          ? number(row.localPrice, 5) + ' ' + unit
          : key === 'liq' && row.localPrice === 0 && available
            ? '正价格区间无触发点'
            : '待验证'
      );
      const movement = row.localPrice - mark;
      set(
        'trade-' + key + '-distance',
        hasPrice && mark > 0
          ? '距当前标记价 ' +
              signed(movement, 5) +
              ' ' +
              unit +
              '（' +
              signed((100 * movement) / mark) +
              '%）'
          : ''
      );
    }
    const buffer = available && liq.localPrice > 0 && Number.isFinite(candidate?.buffer);
    set(
      'trade-buffer',
      buffer
        ? '达标时的强平缓冲 ' +
            signed(candidate.buffer, 5) +
            ' ' +
            asset.priceUnit +
            '（' +
            signed(candidate.bufferPct) +
            '%） · ' +
            candidate.liqSource
        : ''
    );
  }
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
    const { display, snapshot, asset, projectionIssue } = read();
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
    const hasMargin =
      !result?.blocked && c?.checks?.capital && ['vs', 'hype'].every((v) => Number.isFinite(c[v]?.freeAfter));
    show('trade-funds', hasMargin);
    if (hasMargin)
      set('trade-funds-values', 'VS ' + amount(c.vs.freeAfter) + ' ／ Hype ' + amount(c.hype.freeAfter));
    showProjection(
      a,
      result,
      display?.historical,
      projectionIssue,
      snapshot?.mode === 'live' &&
        result?.config.useExternalAccounts !== false &&
        a.vs.account &&
        a.hype.account,
      snapshot?.mode
    );
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
      set('trade-sim-event', '本地模拟账本暂时无法读取。');
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
  if (location.pathname === '/trade.html') {
    fetch('/config/trade-extension-location.json')
      .then((r) => r.json())
      .then((info) => set('trade-extension-path', info.path))
      .catch(() => {});
  }
  return draw;
}
