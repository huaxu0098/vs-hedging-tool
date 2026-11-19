import assert from 'node:assert/strict';
import { openTestBrowser } from './chrome.js';
import { calculateCurrent } from '../../src/hedge/current.js';
const b = await openTestBrowser({ current: true });
const { send, run, wait, click, text } = b;
const input = (id, v) => b.set('#' + id, v, 'input');
const ready =
  "document.querySelector('#plan-rows').textContent.includes('最大 PF 仓位') && document.querySelector('#scan-desk').dataset.state==='ready' && document.querySelector('#trace-id').textContent.includes('AUTO-0.21')";
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
      fields:Object.fromEntries(['plan-rows','plan-risk-rows','current-h','target-h','lev-equity-heading','candidate-surplus-heading','cash-bridge','cross-audit','deadline-clock','clock-skew','risk-values','hysteresis','missing-list'].map(k=>[k,document.getElementById(k).textContent]))};
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
  assert.match(fields['plan-rows'], /失败回收优先/);
  assert.match(fields['plan-rows'], /成功留存优先/);
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
