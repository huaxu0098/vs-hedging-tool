const money = (n) => Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' U';
const clock = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
const delta = (cash, principal) => (Number(cash) >= Number(principal) ? '赚 ' : '亏 ') + money(Math.abs(Number(cash) - Number(principal)));
const titles = { failure: 'VS 已模拟爆号', pass: '首次分成已模拟到账', liquidation: 'Hype 已触及模拟强平线', uncertain: '触线顺序待核实' };

export function showPaper() {
  document.title = 'BTC 实盘行情模拟 · VS × Hype';
  const main = document.querySelector('main');
  main.id = 'account-readout';
  document.querySelector('nav').innerHTML = '<a href="/?simulation=funded">查看上一轮出金推演</a>';
  main.innerHTML = `
    <h1>BTC 实盘行情模拟</h1>
    <p id="paper-account">正在读取出金户模拟账本…</p>
    <p id="paper-state" class="observation-verdict" role="status">正在连接本机模拟服务</p>
    <div class="observation-grid">
      <section class="card"><h2 id="paper-pf-title">VS 模拟仓位</h2><strong class="readout-number" id="paper-pf">等待行情</strong><p id="paper-pf-fill"></p></section>
      <section class="card"><h2 id="paper-hl-title">Hype 模拟仓位</h2><strong class="readout-number" id="paper-hl">等待行情</strong><p id="paper-hl-fill"></p></section>
    </div>
    <h2 class="readout-heading">按当前盘口平仓</h2>
    <div class="observation-grid">
      <section class="card"><h2>VS 扣费后净值</h2><strong class="readout-number" id="paper-equity">等待行情</strong><p id="pf-quote"></p></section>
      <section class="card"><h2>个人扣费后现金</h2><strong class="readout-number" id="paper-cash">等待行情</strong><p id="paper-delta"></p><p id="hl-quote"></p></section>
    </div>
    <h2 class="readout-heading">开仓时的条件推演</h2>
    <div class="observation-grid">
      <section class="card"><h2>VS 净值跌到 8,000 U · 爆号</h2><strong class="readout-number" id="paper-fail">尚未开仓</strong><p id="paper-fail-pnl"></p></section>
      <section class="card"><h2>VS 净值达到 10,100 U · 首次分成到账</h2><strong class="readout-number" id="paper-pass">尚未开仓</strong><p id="paper-pass-pnl"></p></section>
    </div>
    <details><summary>模拟成交和结算口径</summary><p>以 Vest BTC-PERP 和 Hyperliquid BTC 的公开五档盘口模拟成交。个人本金基准为 500 U。双边稳定币按 1 U 等值，单边费用为 VS 0.01%、Hype 0.05%，资金费按零计。保证金采用模拟全仓、最多 20 倍杠杆与 2.5% 维持保证金率，实际账户参数待核实。</p>
    <p>开仓时的两种推演假设两边价格同幅变动，基差与盘口形状保持不变。运行中按两边独立报价采样，以首次观测到的边界和当时的盘口结算。报价超过 5 秒时暂停估值。行情缺口内的路径未经验证，同一次采样有多条触线时保留未决结果。分成记入模拟外部账户。</p></details>`;
  const put = (id, value) => {
    const el = document.getElementById(id);
    if (el.textContent !== value) el.textContent = value;
  };
  function clearValuation(label) {
    put('paper-equity', label);
    put('paper-cash', label);
    put('paper-delta', '');
  }
  let savedEntry;
  async function update() {
    try {
      const r = await fetch('/api/paper-session', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw Error('本机模拟服务未连接');
      const s = await r.json();
      if (s.initialCash != null) put('paper-account', 'VS 出金户起始净值 10,000 U · Hype 承接 ' + money(s.initialCash) + ' · 原始本金 ' + money(s.principal));
      if (s.entry && savedEntry !== s.entry.at) {
        for (const l of s.entry.legs) {
          const name = l.venue === 'pf' ? 'VS' : 'Hype', id = 'paper-' + l.venue;
          put(id + '-title', name + (Number(l.qty) > 0 ? ' 模拟做多' : ' 模拟做空'));
          put(id, money(l.notional));
          put(id + '-fill', Math.abs(Number(l.qty)) + ' BTC · 成交均价 ' + money(l.entry) + '/BTC · ' + clock(s.entry.at));
        }
        put('paper-fail', '剩 ' + money(s.entry.failureCash));
        put('paper-fail-pnl', '相对原始本金 ' + delta(s.entry.failureCash, s.principal));
        put('paper-pass', '剩 ' + money(s.entry.afterPayout));
        put('paper-pass-pnl', '到账前 ' + money(s.entry.beforePayout) + '，预计分成 ' + money(s.entry.payout) + '。相对原始本金 ' + delta(s.entry.afterPayout, s.principal));
        savedEntry = s.entry.at;
      }
      if (s.end) {
        put('paper-state', clock(s.end.at) + ' · ' + titles[s.end.type] +
          (s.end.cash == null ? '，最终现金待核实。' : '，最终个人现金 ' + money(s.end.cash) + '，相对原始本金 ' + delta(s.end.cash, s.principal)) );
        clearValuation('模拟已停止');
        return;
      }
      const stale = !s.quotes || Object.values(s.quotes).some((q) => Date.now() - Date.parse(q.asOf) > 5000);
      for (const [key, q] of Object.entries(s.quotes ?? {}))
        put(key + '-quote', '最近买一 / 卖一 ' + q.bid + ' / ' + q.ask + ' · ' + clock(q.asOf) + ' 上海时间');
      if (stale || s.message || !s.valuation) clearValuation(s.entry ? '等待有效估值' : '尚未开仓');
      else {
        put('paper-equity', money(s.valuation.pf));
        put('paper-cash', money(s.valuation.cash));
        put('paper-delta', '相对开仓前 ' + delta(s.valuation.cash, s.initialCash) + ' · 相对原始本金 ' + delta(s.valuation.cash, s.principal));
      }
      put('paper-state', (s.entry ? '已模拟开仓' : '空仓等待') + ' · ' + (s.message || (stale ? '等待新鲜的双边盘口' : '正在跟踪两边实时报价')));
    } catch (e) {
      put('paper-state', '暂未收到本地服务更新 · ' + e.message);
      clearValuation('估值暂停');
    }
    setTimeout(update, 1000);
  }
  void update();
}
