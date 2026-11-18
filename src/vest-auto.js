import { subscribeVestMarket, vestMarketSymbol, vestPageURL } from './vest-market.js';

export const vestAutoPanel = `
  <section class="fd-card" id="vs-auto-panel" aria-labelledby="vs-auto-heading">
    <h3 id="vs-auto-heading">自动识别 VS</h3>
    <label>Vest 交易页地址<input type="url" id="feed-auto-url" placeholder="https://next.vestmarkets.com/trade/BTC-PERP"></label>
    <label class="fd-check"><input type="checkbox" id="feed-auto-public" checked>使用 Vest 公开行情读取买一、卖一和标记价</label>
    <div class="fd-row"><button type="button" id="feed-auto-start">开始自动识别</button><button type="button" id="feed-auto-stop" disabled>停止识别</button></div>
    <p id="feed-auto-status" role="status" aria-live="polite"></p>
    <p id="feed-auto-spec"></p><p id="feed-auto-account"></p><p id="feed-auto-outcome">VS 账户结果未知</p>
    <details><summary>同步已登录 VS 页面的余额和持仓</summary>
      <p>在 Chrome 或 Edge 的扩展管理页开启开发者模式，点「加载已解压的扩展程序」，选择本项目的 <code>extension</code> 文件夹。安装一次后，刷新匹配器和 VS 交易页，再点「开始自动识别」。两页需在同一浏览器配置中打开。</p>
      <label>本机扩展位置<input id="feed-extension-path" readonly></label>
    </details>
  </section>`;

export function mountVestAuto($, hooks) {
  const url = $('feed-auto-url'),
    publicBox = $('feed-auto-public');
  const status = $('feed-auto-status'),
    account = $('feed-auto-account'),
    stopButton = $('feed-auto-stop');
  const command = (type, symbol) =>
    window.dispatchEvent(
      new CustomEvent('vs-auto-command', {
        detail: JSON.stringify({ type, symbol })
      })
    );
  let active = null,
    extension = false;
  function updatePageNote() {
    if (!active) return;
    account.textContent =
      active.pageNote ||
      (extension
        ? '等待相同合约的 VS 标签页提供可见账户字段。'
        : '网页账户尚未连接。若需读取余额或持仓，请按下方说明启用扩展。');
  }
  function stop(reason = '自动识别已停止。', { retain = false } = {}) {
    const old = active;
    if (!old) return;
    active = null;
    old.disconnect?.();
    clearTimeout(old.lookupTimer);
    command('stop', old.symbol);
    status.textContent = reason;
    account.textContent = '';
    $('feed-auto-spec').textContent = '';
    stopButton.disabled = true;
    hooks.end(retain);
  }
  function eventUpdate(event) {
    if (typeof event.detail !== 'string' || event.detail.length > 50000) return;
    let msg;
    try {
      msg = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      extension = true;
      updatePageNote();
      return;
    }
    const session = active;
    if (!session || !session.page || (msg.symbol && msg.symbol !== session.symbol)) return;
    if (msg.type === 'waiting' || msg.type === 'error' || msg.type === 'stopped') {
      session.pageNote = msg.message || '等待此合约的 VS 页面。';
      if (!session.public) {
        status.textContent = session.pageNote;
        hooks.issue(session.pageNote);
      }
      if (session.hadAccount) hooks.accountLost(session.pageNote);
      updatePageNote();
      return;
    }
    if (msg.type !== 'snapshot' || msg.snapshot?.symbol !== session.symbol) return;
    const snap = msg.snapshot;
    try {
      const hasAccount = !!snap.account && Object.keys(snap.account).some((k) => k !== 'asOf');
      if (!hasAccount && session.hadAccount) {
        session.pageNote = 'VS 页面已不再显示先前的账户字段，请检查当前账户页。';
        hooks.accountLost(session.pageNote);
      }
      if (session.public) {
        if (hasAccount)
          hooks.apply(
            {
              symbol: session.symbol,
              asOf: snap.account.asOf ?? snap.asOf,
              timeSource: snap.timeSource,
              account: snap.account
            },
            'VS 网页自动识别'
          );
      } else {
        hooks.apply(snap, 'VS 网页自动识别');
        hooks.issue('');
        status.textContent = '已自动识别 ' + session.symbol + ' 的可见字段。';
      }
      if (hasAccount) {
        session.hadAccount = true;
        hooks.accountLost('');
        session.pageNote =
          '已读取 VS 页面账户 · ' + new Date(snap.account.asOf ?? snap.asOf).toLocaleTimeString();
      } else if (!session.hadAccount) session.pageNote = '交易页已连接，尚无可辨认的账户字段。';
      updatePageNote();
    } catch (err) {
      session.pageNote = err.message;
      if (!session.public) hooks.issue(err.message);
      if (session.public && snap.account) hooks.accountLost(err.message);
      updatePageNote();
    }
  }
  window.addEventListener('vs-auto-update', eventUpdate);
  function start(publicOnly = false) {
    try {
      const symbol = vestMarketSymbol(url.value.trim());
      const usePublic = publicOnly || publicBox.checked;
      stop();
      hooks.prepare(symbol, usePublic);
      const session = { symbol, public: usePublic, page: !publicOnly, disconnect: null };
      active = session;
      stopButton.disabled = false;
      hooks.issue('正在等待 ' + symbol + ' 的 VS 报价。');
      status.textContent = usePublic ? '正在连接 Vest 公开行情…' : '等待 VS 页面自动识别扩展…';
      updatePageNote();
      if (usePublic || location.pathname === '/trade.html') {
        const lookup = async () => {
          let contract;
          try {
            const r = await fetch('/api/vest-contract?symbol=' + encodeURIComponent(symbol), {
              signal: AbortSignal.timeout(6000)
            });
            if (r.ok) contract = await r.json();
          } catch {}
          if (active !== session) return;
          const msg = hooks.checkQuoteCurrency(symbol, contract);
          $('feed-auto-spec').textContent =
            msg || '已采用 Vest 合约 ' + symbol + ' 的报价币 ' + contract.quote;
          if (!contract) session.lookupTimer = setTimeout(lookup, 15000);
        };
        hooks.checkQuoteCurrency(symbol, null);
        void lookup();
      }
      if (usePublic)
        session.disconnect = subscribeVestMarket(
          symbol,
          (snap) => {
            if (active !== session) return;
            try {
              hooks.apply(snap, 'Vest 公开行情');
              hooks.issue('');
              status.textContent =
                '正在自动识别 ' +
                symbol +
                ' · 买一 ' +
                snap.bid +
                ' · 卖一 ' +
                snap.ask +
                ' · 标记 ' +
                snap.mark +
                ' · ' +
                new Date(snap.asOf).toLocaleTimeString();
            } catch (err) {
              status.textContent = err.message;
              hooks.issue(err.message);
            }
          },
          (reason) => {
            if (active !== session) return;
            status.textContent = reason;
            hooks.issue(reason);
          }
        );
      if (!publicOnly) {
        command('probe', symbol);
        command('start', symbol);
        if (!extension && !usePublic)
          status.textContent = '等待浏览器扩展。请安装后刷新两页并点开始，或勾选公开行情。';
      } else
        session.pageNote = '当前读取公开报价。要同时读取已登录页面的账户，启用扩展后点「开始自动识别」。';
      updatePageNote();
    } catch (err) {
      status.textContent = err.message;
    }
  }
  $('feed-auto-start').onclick = () => start();
  stopButton.onclick = () => stop();
  publicBox.onchange = () => stop('数据来源已更改，点「开始自动识别」应用。');
  url.oninput = () => stop('页面地址已更改，点「开始自动识别」应用。');
  status.textContent = '填入交易页地址后开始，公开报价会持续更新。';
  fetch('/config/extension-location.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((v) => {
      $('feed-extension-path').value = v?.path ?? '项目目录下的 extension 文件夹';
    })
    .catch(() => {
      $('feed-extension-path').value = '项目目录下的 extension 文件夹';
    });
  command('probe');
  return {
    setURL(symbol) {
      url.value = symbol ? vestPageURL(symbol) : '';
    },
    startPublic: () => start(true),
    stop,
    get active() {
      return !!active;
    },
    destroy() {
      stop();
      window.removeEventListener('vs-auto-update', eventUpdate);
    }
  };
}
