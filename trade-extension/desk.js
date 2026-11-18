(() => {
  if (self !== top || location.origin !== 'http://127.0.0.1:' + globalThis.vsAutoConfig.deskPort || location.pathname !== '/trade.html') return;
  const desk = () => document.getElementById('trade-controls');
  const route = () => ['', '#trade'].includes(location.hash) && !!desk();
  const read = key => { try { return JSON.parse(desk()?.dataset[key] || 'null'); } catch { return null; } };
  const report = (message, value) => {
    if (!desk()) return;
    desk().dataset.extension = 'ready';
    const bind = document.getElementById('trade-bind-vs');
    if (bind) bind.disabled = !Array.isArray(read('symbols')) || desk().dataset.busy === 'true';
    if (value !== undefined) desk().dataset.receipt = value ? JSON.stringify(value) : '';
    if (message) desk().dataset.feedback = message;
    desk().dispatchEvent(new Event('trade-extension'));
  };
  const terms = plan => JSON.stringify([plan.assetId,...plan.legs.map(l =>
    [l.venue,l.symbol,l.quantity,l.unit,l.side,l.currentQty,l.accountContext,l.stage,l.address,l.leverage,l.marginMode])]);
  async function currentPlan(intent) {
    if (!intent) return null;
    const deadline = Math.min(intent.expires,Date.now()+650);
    while (route() && Date.now()<deadline) {
      desk().dispatchEvent(new Event('trade-check'));
      const proposed = read('intent');
      if (!proposed || terms(proposed)!==terms(intent)) return null;
      const fresh = read('plan');
      if (fresh && terms(fresh)===terms(intent)) return {...fresh,expires:Math.min(fresh.expires,intent.expires)};
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    return null;
  }
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (m.type === 'confirm-plan' && sender.id === chrome.runtime.id) {
      currentPlan(read('intent')).then(reply,()=>reply(null));
      return true;
    }
  });
  async function status() {
    if (!route()) return;
    try { const r = await chrome.runtime.sendMessage({ type:'status' }); report('', r?.receipt); }
    catch { if (desk()) delete desk().dataset.extension; }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.lastDualOrder && route()) report('',changes.lastDualOrder.newValue || null);
  });
  addEventListener('hashchange',status);
  document.addEventListener('trade-probe',status);
  document.addEventListener('click', async e => {
    const action = e.target.closest('#trade-open,#trade-send,#trade-ack,#trade-bind-vs');
    if (!e.isTrusted || !route() || !action || action.disabled) return;
    const type = { 'trade-open':'open', 'trade-send':'execute', 'trade-ack':'ack', 'trade-bind-vs':'bind' }[action.id];
    const intent = read('intent');
    if (type === 'execute' && !intent) return report('当前方案已改变，等待重新验算。');
    const receiptId = read('receipt')?.id;
    if (type === 'ack' && !confirm('已在两个官方账户核对委托、成交和持仓，继续准备下一笔？')) return;
    desk().dataset.busy = 'true';
    report(type === 'execute' ? '正在核对两个网页的账户、方向和数量…' : '');
    try {
      const plan = type === 'execute' ? await currentPlan(intent) : null;
      if (type === 'execute' && !plan) return report('等待期间报价或仓位变化，请按最新方案重新点击。');
      const r = await chrome.runtime.sendMessage({type, plan, symbols:read('symbols'), receiptId});
      report(r?.message || '', r?.receipt);
    } catch { report('扩展通讯中断。请在两个官网核对委托，重新加载交易页查看记录。'); }
    finally { delete desk().dataset.busy; report(''); }
  }, true);
  status();
})();
