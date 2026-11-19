import assert from 'node:assert/strict';
import { openTestBrowser } from './chrome.js';
import { calculateCurrent } from '../../src/hedge/current.js';
const b = await openTestBrowser({ current: true });
const { send, run, wait, click, text } = b;
const input = (id, v) => b.set('#' + id, v, 'input');
const ready =
  "document.querySelector('#plan-tradeoff').textContent.includes('现金缓冲变化') && document.querySelector('#trace-id').textContent.includes('AUTO-0.17')";
try {
  await send('Page.navigate', { url: (process.env.CURRENT_URL ?? b.url) + '/' });
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
      fields:Object.fromEntries(['plan-tradeoff','size-plan','cash-plan','current-h','target-h','lev-equity-heading','candidate-surplus-heading','cash-bridge','cross-audit','deadline-clock','clock-skew','risk-values','hysteresis','missing-list'].map(k=>[k,document.getElementById(k).textContent]))};
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
  assert.match(fields['plan-tradeoff'], /PF 名义仓位减少.*成功端 Hype 现金变化.*现金缓冲变化/);
  assert.match(fields['size-plan'], /已枚举数量网格内最优|最优性待验证/);
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
  await click('#scan-config');
  await click('#missing-list a[href="#jumpBps"]');
  assert.equal(await run('document.activeElement.id'), 'jumpBps');
  const pending = await run(`(() => {const slider=document.querySelector('#riskPreference');slider.value='50';
    slider.dispatchEvent(new Event('input',{bubbles:true}));
    return [document.querySelector('#calc-status').textContent,document.querySelector('#legs').rows[1].cells[4].textContent,document.querySelector('#trace-id').textContent];
  })()`);
  assert.match(pending[0], /暂停/);
  assert.equal(pending[1], '—');
  assert.equal(pending[2], '等待计算');
  await wait(ready + " && document.querySelector('#preference-info').textContent.startsWith('50%')", 40000);
  console.log('PREFERENCE', await text('#preference-info'));
  await input('riskPreference', '100');
  await wait(ready + " && document.querySelector('#preference-info').textContent.startsWith('100%')", 40000);
  const cashView = await run(`(() => {
    const txt=id=>document.getElementById(id).textContent;
    return [txt('pf-summary'),txt('hl-summary'),txt('cash-plan'),txt('risk-tradeoff'),txt('search-coverage')];
  })()`);
  assert.ok(cashView[2].includes(cashView[0]) && cashView[2].includes(cashView[1]));
  assert.match(cashView[3], /最低维持余量.*强平线距离变化.*杠杆变化/);
  assert.match(cashView[4], /网格点.*剪枝次数.*ms/);
  await input('riskPreference', '50');
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
  assert.equal(await run("document.querySelector('#riskPreference').value"), '0');
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
  assert.equal(await run("document.querySelector('#riskPreference').value"), '50');
  assert.equal(await run("document.querySelector('#rebalanceSteps').value"), '2');
  assert.deepEqual(b.faults, []);
  console.log(
    'OPT_BROWSER_OK 双方案、同版来源、风险偏好、两日截止、时差熔断、拆分确认、真实与规划隔离、迟滞入口'
  );
} finally {
  await b.close();
}
