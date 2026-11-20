import assert from 'node:assert/strict';
import { openTestBrowser } from './chrome.js';
import { calculateCurrent } from '../../src/hedge/current.js';
const b = await openTestBrowser({ current: true });
const { send, run, wait, click, text } = b;
const input = (id, v) => b.set('#' + id, v, 'input');
const ready =
  "document.querySelector('#plan-columns th[data-point]')?.dataset.point && document.querySelector('#scan-desk').dataset.state==='ready' && document.querySelector('#trace-id').textContent.includes('AUTO-0.21')";
try {
  await send('Page.navigate', { url: (process.env.CURRENT_URL ?? b.url) + '/' });
  await wait("!!document.getElementById('desk-details')");
  await run("document.getElementById('desk-details').open=true");
  await wait("typeof document.querySelector('#plan-cross-flat')?.onchange === 'function'");
  assert.equal(await run("document.getElementById('plan-cross-flat').checked"), true);
  await wait(ready, 45000);
  // Read the result and its exact input together, in one browser event.
  const frame = await run(`(() => {
    const trace=document.querySelector('#trace-inputs').parentElement;
    trace.open=true;trace.ontoggle();
    return {inputs:JSON.parse(document.querySelector('#trace-inputs').textContent),
      at:document.querySelector('#trace-sources').textContent.match(/计算于 (\\S+)/)[1],
      stamp:document.querySelector('#trace-id').textContent,
      versions:[...new Set([...document.querySelectorAll('.frame-key')].map(el=>el.title))],
      fields:Object.fromEntries(['plan-comparison','plan-risk-rows','current-h','target-h','lev-equity-heading','candidate-surplus-heading','cash-bridge','cross-audit','deadline-clock','clock-skew','risk-values','hysteresis','missing-list'].map(k=>[k,document.getElementById(k).textContent]))};
  })()`);
  const { inputs, fields } = frame;
  const x = calculateCurrent(
    inputs.rules,
    inputs.accounts,
    inputs.market,
    inputs.rates,
    Date.parse(frame.at),
    inputs.options
  );
  assert.ok(frame.stamp.endsWith(x.trace.id));
  assert.equal(frame.versions.length, 1);
  assert.match(fields['plan-comparison'], /失败端回收缓冲优先/);
  assert.match(fields['plan-comparison'], /成功端现金留存优先/);
  assert.ok(fields['plan-risk-rows']);
  assert.match(fields['risk-values'], /PF 模拟初始保证金/);
  assert.match(fields['risk-values'], /Hype 其他保证金占用/);
  assert.match(fields['lev-equity-heading'], /基础情景/);
  assert.doesNotMatch(fields['risk-values'], /额外跳价与延迟后的|已配置压力情景标记价/);
  assert.match(fields['cross-audit'], /条件估算.*独立权益与维持保证金交点核对 一致/);
  assert.match(fields['current-h'], /不适用/);
  assert.match(fields['target-h'], /%/);
  assert.match(fields['deadline-clock'], /未配置/);
  assert.match(fields['cash-bridge'], /调仓深度滑点.*调仓手续费.*平仓深度滑点.*平仓手续费.*另设终点摩擦/);
  console.log(
    'OPT_LIVE',
    JSON.stringify({
      at: frame.at,
      stamp: frame.stamp,
      fields,
      comparison: x.comparison,
      complete: [x.maximum.complete, x.conservative.complete]
    })
  );
  await run("document.getElementById('desk-details').open=true;document.getElementById('account-details').open=true");
  await click('#missing-list a[href="#jumpBps"]');
  assert.equal(await run('document.activeElement.id'), 'jumpBps');
  // This assertion targets a rule change with valid books. After the independent
  // replay and focus check above, either exchange may already have timed out.
  await wait(ready + ` && (() => {
    const m=JSON.parse(document.querySelector('#trace-inputs').textContent).market;
    const ttl=Number(document.querySelector('#quoteSecs').value)*1000;
    return [m.pf,m.hl].every(q => [q.bookAt ?? q.asOf,q.markAt ?? q.asOf]
      .every(stamp => Date.now()-Date.parse(stamp)<ttl-500));
  })()`,45000);
  const pending = await run(`(() => {
    const desk=document.querySelector('#scan-desk'), reserve=document.querySelector('#R_success');
    const before=[desk.dataset.resultId,document.querySelector('#scan-fail-cash').textContent];
    reserve.value='98';
    reserve.dispatchEvent(new Event('input',{bubbles:true}));
    return {before,after:[desk.dataset.resultId,document.querySelector('#scan-fail-cash').textContent],
      state:desk.dataset.state, label:document.querySelector('#scan-status').textContent};
  })()`);
  assert.equal(pending.state, 'updating');
  assert.match(pending.label, /输入已变更.*最近成功计算/);
  assert.deepEqual(pending.after, pending.before);
  await wait(ready + " && document.querySelector('#reserve-threshold').textContent.includes('98')",40000);
  assert.equal(await run("!!document.querySelector('#riskPreference')"),false);
  // Edit only this isolated browser's planning rules. A committed frame owns
  // the warning and all three scenario labels, even if a new tick is pending.
  const labels = () => run("Array.from(document.querySelectorAll('#plan-columns small'),el=>el.textContent)");
  for (const [changes, coverage, scenario, incomplete] of [
    [{jumpBps:'0.01'}, '压力未配齐', '部分压力情景', true],
    [{jumpBps:'0',adverseBps:'0',delayBps:'0',fundingDebit:'0'}, '含零压力假设', '基础情景', true],
    [{jumpBps:'0.01',adverseBps:'0.01',delayBps:'0.01',fundingDebit:'0.00001'}, '四项压力已配置', '已配置压力情景', false],
    [{jumpBps:'',adverseBps:'',delayBps:'',fundingDebit:''}, '压力未配置', '基础情景', true]
  ]) {
    for (const [id, value] of Object.entries(changes)) await input(id, value);
    await wait(ready + " && document.getElementById('plan-stress').textContent.includes(" + JSON.stringify(coverage) + ")",45000);
    assert.ok((await run("document.getElementById('plan-stress').textContent")).includes(scenario));
    assert.deepEqual(await labels(),Array(3).fill('失败✓ 成功✓ 初保✓ 路径待验 压力' + (incomplete ? '待验' : '✓')));
    assert.equal(/压力(?:安全性|风险)未验证/.test(await text('#max-risk-title')),incomplete);
    if (!incomplete) {
      const results=await run("Array.from(document.querySelectorAll('#position-list-rows tr'),row=>[row.cells[3].textContent,row.cells[4].textContent])");
      assert.equal(results.length,3);
      for(const path of results.flat()) {
        for (const label of ['基础同步','基差扩大','基差收敛','个人回收（分成到账前）','可用抵押品','深度滑点'])
          assert.ok(path.includes(label),label);
        assert.ok((path.match(/双边平仓价 PF/g)??[]).length>=3);
      }
      console.log('BASIS_PATHS_BROWSER_OK',results.length*2);
    }
  }
  await input('R_success','5000');
  await wait("document.querySelector('#plan-caption').textContent.includes('无合格方案')",45000);
  assert.ok(await run("document.querySelector('#max-risk').hidden && document.querySelector('#plan-comparison').hidden"));
  const empty = await run(`(() => {
    const el = id=>document.getElementById(id);
    return {hidden:el('position-list').hidden, rows:el('position-list-rows').rows.length,
      reason:el('positions-empty').textContent, noteHidden:el('positions-empty').hidden,
      versions:['live-view','positions-view','scale-details'].map(k=>el(k).dataset.snapshotId),
      published:el('scan-desk').dataset.resultId};
  })()`);
  assert.equal(empty.rows,0);
  assert.ok(empty.hidden && !empty.noteHidden);
  assert.match(empty.reason,/没有合格/);
  assert.deepEqual(empty.versions,Array(3).fill(empty.published));
  await input('R_success','98');
  await wait(ready,45000);
  await input('quoteSkewMs', '0');
  await wait(
    "document.querySelector('#auto-search').textContent.includes('AUTO_DATA_BLOCKED') && document.querySelector('#calc-status').textContent.includes('行情熔断')",
    15000
  );
  assert.equal(await text('#hl-summary'), '—');
  assert.equal(await run("document.querySelector('#legs').rows[1].cells[4].textContent"), '—');
  console.log('SKEW_BREAK', await text('#clock-skew'));
  await input('quoteSkewMs', '3000');
  const until = await run(
    'new Date(Date.now()+7200000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)'
  );
  await input('deadline', until);
  await wait(ready, 40000);
  assert.match(await text('#deadline-clock'), /剩余/);
  await b.set('#funding-view', 'account');
  assert.equal(await run("document.querySelector('#hl-equity').value"), '');
  assert.equal(await run("document.querySelector('#pf-qty').value"), '');
  assert.equal(await run("document.querySelector('#deadline').value"), '');
  assert.equal(await run("document.querySelector('#R_success').value"), '100');
  assert.match(await text('#auto-search'), /AUTO_DATA_BLOCKED/);
  await click('#confirm-pf-qty');
  assert.equal(await run("document.querySelector('#pf-qty').value"), '0');
  assert.equal(await run("document.querySelector('#hl-qty').value"), '');
  assert.equal(await run("document.querySelector('#pf-orders').value"), '');
  assert.equal(await run("document.querySelector('#pf-marginMode').value"), '');
  await click('#confirm-hl-orders');
  assert.equal(await run("document.querySelector('#hl-qty').value"), '');
  await click('#confirm-flat');
  for (const [id, v] of [
    ['pf-equity', '10000'],
    ['pf-free', '10000'],
    ['hl-equity', '409'],
    ['hl-free', '409']
  ])
    await input(id, v);
  await wait(ready, 45000);
  assert.match(await text('#funding-banner'), /当前账户快照/);
  assert.match(await text('#margin-detail-title'), /真实账户/);
  await input('rebalanceSteps', '3');
  await wait(ready + " && document.querySelector('#hysteresis').textContent.includes('阈值 3')", 40000);
  // Existing net position and unfilled buy quantity, entered through the actual
  // account form in this isolated browser. All three targets must use both.
  await input('pf-anchor', await text('#scan-pf-price'));
  await input('pf-qty','0.002');
  await input('pf-orders','0.001');
  await wait(ready+" && [...document.querySelectorAll('#position-list-rows tr')].length===3 && document.querySelector('#position-list-rows').textContent.includes('净仓 0.002 · 挂单 0.001')",45000);
  await click('#desk-views button[aria-controls="positions-view"]');
  const actual=await run(`[...document.querySelectorAll('#position-list-rows tr')].map(tr=>tr.cells[1].innerText)`);
  for (const cell of actual) {
    const target=Number(cell.match(/多 ([0-9.]+) BTC/)[1]);
    const remaining=Number(cell.match(/若挂单全成，差额买入 ([0-9.]+) BTC/)[1]);
    assert.ok(Math.abs(target-0.002-0.001-remaining)<1e-12);
  }
  console.log('POSITION_ADJUST_OK', JSON.stringify(actual));
  await click('#scan-config');
  await b.set('#funding-view', 'plan');
  assert.equal(await run("document.querySelector('#R_success').value"), '98');
  assert.equal(await run("document.querySelector('#rebalanceSteps').value"), '2');
  assert.deepEqual(b.faults, []);
  console.log(
    'OPT_BROWSER_OK 三目标仓位、同版来源、现金留存、两日截止、时差熔断、拆分确认、真实与规划隔离、迟滞入口'
  );
} finally {
  await b.close();
}
