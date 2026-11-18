import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openTestBrowser } from './qa/chrome.js';
import { runLedgerInteractions } from './qa/ledger-interactions.js';

const ledgerChecks = await runLedgerInteractions();
for (const label of ledgerChecks) console.log('PASS ' + label);
const browser = await openTestBrowser();
const { click, set, wait, run, text, send } = browser;
const report = {
  timestamp: new Date().toISOString(),
  browser: await run('navigator.userAgent'),
  checks: [...ledgerChecks]
};
const done = (label) => {
  report.checks.push(label);
  console.log('PASS ' + label);
};
const matches = async () =>
  wait(
    "document.querySelector('#candidates-note').textContent.includes('组') && !document.querySelector('#verdict').textContent.includes('正在验算')"
  );
const success = () => wait("document.querySelector('#verdict h2')?.textContent==='匹配可交易'");
const axisPass = () =>
  run(
    "Array.from(document.querySelectorAll('#axis tbody tr')).find(r=>r.cells[0].textContent.includes('通过'))?.cells[1].textContent"
  );
try {
  assert.match(await text('#hype-panel'), /409/);
  for (const id of ['btc', 'xau', 'us100']) {
    await set('#asset', id);
    await success();
    assert.match(await text('#checks'), /个人资金/);
    assert.ok(await run("!!document.querySelector('#axis svg')"));
  }
  done('BTC、黄金、US100 的两边取整后模拟仓位与共同价格轴');
  await set('#asset', 'btc');
  await success();
  await click('[data-mode="fixedVs"]');
  await set('#direction', 'long');
  await set('#vs-size', '18000', 'input');
  await set('#hype-size', '3000', 'input');
  await success();
  const first = await axisPass();
  await click('#pin');
  await matches();
  await set('#hype-size', '1200', 'input');
  await matches();
  assert.equal(await axisPass(), first);
  assert.match(await text('#verdict'), /仍差|未收回|不足/);
  assert.match(await text('#comparison'), /固定方案/);
  await click('[data-scenario="failState"]');
  assert.match(await text('#scenario-result'), /结算现金/);
  done('固定 VS、调整 Hype、失败回本对照和两案比较');
  await click('[data-mode="fixedHype"]');
  await set('#vs-size', '15000', 'input');
  await set('#hype-size', '3600', 'input');
  await matches();
  assert.match(await text('#verdict'), /强平/);
  assert.match(await text('#comparison'), /达标前先强平/);
  assert.match(await text('#assumptions'), /本阶段未通过风控/);
  done('提前强平的组合在页面被剔除，跨阶段比较停止');
  await click('#account-edit');
  await set('[name="tiersVerified"]', 'no');
  await run("document.querySelector('dialog.settings-dialog form').requestSubmit()");
  await wait("!document.querySelector('dialog.settings-dialog')");
  await matches();
  assert.match(await text('#verdict'), /无法验证/);
  await click('#account-edit');
  await set('[name="tiersVerified"]', 'yes');
  await run("document.querySelector('dialog.settings-dialog form').requestSubmit()");
  await wait("!document.querySelector('dialog.settings-dialog')");
  done('可编辑风控与缺失强平来源熔断');
  await click('[data-mode="auto"]');
  await success();
  await click('nav a[href="#sim"]');
  await click('[data-op="rounds"]');
  await wait("document.querySelector('[data-v=\"rounds\"]').textContent.includes('5 轮')");
  await click('[data-op="target"]');
  await wait(
    "document.querySelector('[data-v=\"audit\"]').textContent.includes('开仓') || document.querySelector('[data-v=\"audit\"]').textContent.includes('成交')"
  );
  await click('[data-op="day"]');
  await wait("document.querySelector('[data-v=\"audit\"]').textContent.includes('结转')");
  for (const kind of ['challengeFail', 'challengePass', 'payout', 'fundedFail', 'day', 'ambiguous']) {
    await set('[data-v="demo"]', kind);
    await click('[data-op="load-demo"]');
    await click('[data-op="play"]');
    await wait("document.querySelector('[data-v=\"replay\"]').textContent.includes('第 2')", 5000);
    if (kind === 'ambiguous') assert.match(await text('[data-v="replay"]'), /不确定.*|最坏/);
    await click('[data-op="pause"]');
  }
  done('模拟成交、日内结转、多轮成本与六种回放（含同柱冲突）');
  await click('nav a[href="#desk"]');
  await click('#paste-open');
  await set(
    '#vs-paste-text',
    'Symbol: BTC\nBalance: 10037\nEquity: 10037\nUsed Margin: 20\nFree Margin: 10017\nStage: Challenge\nBid: 99999\nAsk: 100001\nMark: 100000\nSymbol\tSide\tQty\tEntry\tUPNL\tUsed Margin\nBTC\tLong\t0.002\t100000\t0\t20',
    'input'
  );
  await click('#vs-parse');
  assert.equal(await run("document.querySelector('#vs-balance').value"), '10037');
  assert.equal(await run("JSON.parse(document.querySelector('#vs-positions').value)[0].qty"), 0.002);
  await run("document.querySelector('#vs-market-open').checked=true");
  await click('#vs-apply');
  await wait("!document.querySelector('#vs-paste-text')");
  done('真实浏览器粘贴 VS 文本与持仓表并确认');
  await set('#feed-age', 60);
  await set('#feed-period', 5000);
  await run("document.querySelector('#feed-map-verify').checked=true");
  await click('#feed-save-map');
  await set('#feed-mode', 'live');
  await wait("document.querySelector('#feed-values').textContent.includes('最大杠杆')", 18000);
  const live = await text('#feed-values'),
    match = live.match(/Hype　BTC　买一 ([\d,.]+)　卖一 ([\d,.]+)　标记 ([\d,.]+)/);
  assert.ok(match, live);
  report.hype = {
    bid: match[1],
    ask: match[2],
    mark: match[3],
    sample: live
      .split('\n')
      .filter((l) => l.includes('源报价时间'))
      .at(-1)
  };
  const book = JSON.parse(await text('#feed-depth')).book;
  assert.equal(book.bids.length, 5);
  assert.equal(book.asks.length, 5);
  await click('#feed-paste-open');
  for (const [key, idx] of [
    ['bid', 1],
    ['ask', 2],
    ['mark', 3]
  ])
    await set('#vs-' + key, match[idx].replaceAll(',', ''), 'input');
  await set(
    '#vs-positions',
    JSON.stringify([
      { symbol: 'BTC', qty: 0.002, entry: Number(match[3].replaceAll(',', '')), upnl: 0, marginUsed: 20 }
    ]),
    'input'
  );
  await click('#vs-now');
  await click('#vs-apply');
  await wait("!document.querySelector('#vs-paste-text')");
  await click('nav a[href="#desk"]');
  await matches();
  assert.match(await text('#vs-panel'), /10,017/);
  assert.match(await text('#cross-panel'), /请求耗时/);
  done('真实 Hyperliquid 主网盘口、标记价和双平台看板联动');
  await click('nav a[href="#feeds"]');
  await set('#feed-wallet', '0x0000000000000000000000000000000000000000', 'input');
  await run("document.querySelector('#feed-map-verify').checked=true");
  await click('#feed-save-map');
  await wait("document.querySelector('#hype-panel').textContent.includes('公开地址同步')", 18000);
  await wait("/最大总仓位[\\d,.]+ U/.test(document.querySelector('#hype-panel').textContent)", 18000);
  report.publicAddressProbe = await text('#hype-panel');
  const received = await text('#feed-values');
  const values = [...received.matchAll(/净值 ([\d,.]+)　已用 ([\d,.]+)　可用 ([\d,.]+)/g)];
  assert.ok(values.length >= 2, '两平台均有账户来源');
  const free = Number(values.at(-1)[3].replaceAll(',', ''));
  const panelFree = await text('#hype-panel .big');
  assert.ok(Math.abs(Number(panelFree.split('U')[0].trim().replaceAll(',', '')) - free) < 0.006);
  report.liveWithdrawable = free;
  done('公开零地址 clearinghouseState 读回，并刷新可用保证金及开仓上限');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/hype-info' }] });
  await click('#feed-refresh');
  await wait("document.querySelector('#feed-health').textContent.includes('报价过期')");
  assert.doesNotMatch(await text('#verdict'), /匹配可交易/);
  await send('Fetch.disable');
  await set('#feed-age', 0.5);
  await wait("document.querySelector('#feed-health').textContent.includes('VS 报价过期')");
  await set('#feed-mode', 'frozen');
  assert.doesNotMatch(await text('#verdict'), /匹配可交易/);
  done('实际浏览器请求超时注入、报价超龄和冻结三种熔断');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  });
  await click('nav a[href="#desk"]');
  assert.ok(await run('document.documentElement.scrollWidth <= innerWidth+1'));
  assert.deepEqual(browser.faults, []);
  done('手机视口和浏览器脚本错误检查');
  if (process.env.QA_REPORT_PATH)
    await writeFile(process.env.QA_REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
} finally {
  await browser.close();
}
