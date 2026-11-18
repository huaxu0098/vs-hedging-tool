(() => {
  const page = 'http://127.0.0.1:' + globalThis.vsAutoConfig.deskPort + '/trade.html';
  const venues = ['vs','hype'];
  const key = 'lastDualOrder';
  let busy = false;
  function urlFor(venue, symbol) {
    const valid = venue === 'vs' ? /^[A-Z0-9][A-Z0-9._-]{0,47}-PERP$/ : /^[\w.-]+(?::[\w.-]+)?$/;
    if (typeof symbol !== 'string' || !valid.test(symbol) || symbol.length > 70) throw Error('缺少已映射的官方合约代码。');
    return (venue === 'vs' ? 'https://next.vestmarkets.com/trade/' : 'https://app.hyperliquid.xyz/trade/') + encodeURIComponent(symbol);
  }
  function deskURL(url) {
    try { return new URL(url).origin + new URL(url).pathname === page; } catch { return false; }
  }
  async function venueTab(venue, symbol, open) {
    const url = urlFor(venue, symbol);
    const tabs = await chrome.tabs.query({url: new URL(url).origin + '/trade/*'});
    const exact = tabs.filter(t => new URL(t.url).pathname.replace(/\/$/,'') === new URL(url).pathname);
    if (exact.length > 1) throw Error(venue + ' 有多个同合约标签页，请保留一个。');
    if (exact.length) return exact[0];
    if (!open) throw Error(venue + ' 官方交易页尚未打开。');
    return chrome.tabs.create({url,active:false});
  }
  function clean(plan) {
    if (!plan || !Array.isArray(plan.legs) || plan.legs.length !== 2 ||
      !Number.isFinite(plan.expires) || plan.expires <= Date.now()) throw Error('仓位或报价已过期。');
    for (const [i,l] of plan.legs.entries()) {
      if (l?.venue !== venues[i] || !['buy','sell'].includes(l.side) ||
        !/^(0|[1-9]\d*)(\.\d+)?$/.test(l.quantity) || !Number.isFinite(+l.quantity) || +l.quantity <= 0 ||
        !l.unit || !Number.isFinite(l.notional) || l.notional <= 0) throw Error('目标方向或实际下单数量无效。');
      urlFor(l.venue,l.symbol);
    }
    const [vs,hype] = plan.legs;
    if (!vs.accountContext || !['challenge','funded'].includes(vs.stage) || !/^0x[\da-f]{40}$/i.test(hype.address) || vs.side === hype.side)
      throw Error('双边账户、阶段或对冲方向未核实。');
    return plan;
  }
  const identity = plan => JSON.stringify([plan.assetId, ...plan.legs.map(l =>
    [l.venue,l.symbol,l.side,l.quantity,l.unit,l.accountContext,l.stage,l.address,l.currentQty,l.leverage,l.marginMode])]);
  const last = async () => (await chrome.storage.local.get(key))[key] || null;
  const save = record => chrome.storage.local.set({[key]:record});
  async function both(fn) {
    const replies = await Promise.allSettled(venues.map((v,i)=>fn(v,i)));
    const errors = replies.flatMap((r,i)=>r.status === 'rejected' ? [venues[i] + ' · ' + r.reason.message] : []);
    if (errors.length) throw Error(errors.join(' / '));
    return replies.map(r => r.value);
  }
  async function run(m,sender) {
    if (m.type === 'status') return {receipt:await last()};
    if (busy) throw Error('上一项操作仍在进行。');
    busy = true;
    try {
      if (!deskURL((await chrome.tabs.get(sender.tab.id)).url)) throw Error('开仓工具已经关闭。');
      if (m.type === 'open') {
        await both((v,i)=>venueTab(v,m.symbols?.[i],true));
        return {message:'两个官方交易页已打开。请在各页登录并选择正确账户。', receipt:await last()};
      }
      if (m.type === 'bind') {
        const tab = await venueTab('vs',m.symbols?.[0],false);
        await chrome.tabs.update(tab.id,{active:true});
        const result = await chrome.tabs.sendMessage(tab.id,{type:'bind-vest-account', symbol:m.symbols[0]},{frameId:0});
        if (!result?.ok) throw Error(result?.reason || 'Vest 页面尚未就绪，请刷新官网和开仓页。');
        return {message:'请在 Vest 官网点击当前账户名称旁的复制图标，然后返回本页。', receipt:await last()};
      }
      if (m.type === 'ack') {
        const seen = await last();
        if (!seen || m.receiptId !== seen.id) throw Error('其他窗口已更新委托，请核对最新记录。');
        await chrome.storage.local.remove(key);
        return {receipt:null,message:'已确认上一笔委托状态。'};
      }
      if (m.type !== 'execute') throw Error('未知操作。');
      if (await last()) throw Error('请先在两个官网核对上一笔委托和持仓。');
      const plan = clean(m.plan), id = crypto.randomUUID();
      const tabs = await both((v,i)=>venueTab(v,plan.legs[i].symbol,false));
      const send = async (i,type) => {
        const r = await chrome.tabs.sendMessage(tabs[i].id, {type,id,leg:plan.legs[i],expires:plan.expires},{frameId:0});
        if (!r?.ok) throw Error(r?.reason || '官方页面未响应。');
      };
      await both((v,i)=>send(i,'prepare'));
      await both((v,i)=>send(i,'verify'));
      async function checkDesk() {
        const fresh = clean(await chrome.tabs.sendMessage(sender.tab.id,{type:'confirm-plan'},{documentId:sender.documentId}));
        if (identity(fresh) !== identity(plan)) throw Error('等待期间方向、数量或账户变化，请重新核对。');
        clean(plan);
      }
      await checkDesk();
      // Persist an uncertain receipt before either click. A worker/browser restart must never retry it.
      const record = {id,assetId:plan.assetId,time:new Date().toISOString(),legs:plan.legs.map(l=>({
        venue:l.venue,symbol:l.symbol,side:l.side,quantity:l.quantity,unit:l.unit,status:'提交结果待核对'
      }))};
      await save(record);
      try { await checkDesk(); } catch (error) { await chrome.storage.local.remove(key); throw error; }
      const results = await Promise.allSettled(venues.map((v,i)=>send(i,'submit')));
      results.forEach((r,i)=>{ record.legs[i].status = r.status === 'fulfilled' ? '已点击委托，等待官网确认' : '需查委托记录 · ' + r.reason.message; });
      await save(record);
      return {receipt:record,message:'请查看两边的官方委托和成交记录。'};
    } finally { busy = false; }
  }
  chrome.runtime.onMessage.addListener((m,sender,reply) => {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab || !deskURL(sender.url)) return;
    run(m,sender).then(reply,async error=>reply({message:error.message,receipt:await last()}));
    return true;
  });
  chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:page}));
})();
