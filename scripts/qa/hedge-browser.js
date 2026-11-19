import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openTestBrowser } from './chrome.js';
const chrome = await openTestBrowser({ hedge: true }),
  { send, run, click, set, wait, text } = chrome;
const dir = await mkdtemp(path.join(os.tmpdir(), 'hedge-browser-download-'));
const key = 'vs-hype:dynamic-readonly:v1';
const workspace = () => run('JSON.parse(localStorage.getItem(' + JSON.stringify(key) + '))');
const type = (selector, value) => set(selector, value, 'input');
const clickWait = async (selector, expression) => {
  await click(selector);
  await wait(expression);
};
const by = (id) => 'document.getElementById(' + JSON.stringify(id) + ')';
async function upload(selector, file) {
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
  await send('DOM.setFileInputFiles', { nodeId, files: [file] });
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(os.tmpdir(), 'hedge-' + name + '.png'), Buffer.from(data, 'base64'));
}
try {
  assert.match(await text('#calc-status'), /候选/);
  assert.match(await text('#outcomes'), /失败可回收/);
  const seed = (await workspace()).branches.demo;
  await screenshot('desktop');
  await run("document.querySelector('#desk details').open=true");
  await type('#model', 'budget');
  assert.match(await text('#bounds'), /15.1667% – 15.4500%/);
  await type('#friction', '8');
  assert.equal(await text('#bounds'), '无交集');
  assert.ok(await run(by('simulate') + '.disabled'));
  await type('#friction', '0');
  await type('#model', 'exact');
  await set('#asset', 'us100');
  assert.match(await text('#calc-status'), /未找到/);
  await type('#reserve', '80');
  for (const asset of ['btc', 'xau', 'us100', 'unit']) {
    await set('#asset', asset);
    assert.match(await text('#calc-status'), /候选/);
    assert.ok((await text('#legs')).length > 30);
  }
  await type('#sizing', 'fixedPF');
  await type('#pf-size', '5000');
  await type('#direction', '1');
  assert.equal((await workspace()).branches.demo.events.length, seed.events.length);
  await clickWait('#simulate', by('history') + ".textContent.includes('fill')");
  const held = (await workspace()).branches.demo;
  assert.equal(Object.keys(held.positions).length, 2);
  await set('#asset', 'xau');
  assert.equal(Object.keys((await workspace()).branches.demo.positions).length, 2);
  await clickWait(
    '#close',
    "Object.keys(JSON.parse(localStorage.getItem('" + key + "')).branches.demo.positions).length===0"
  );
  console.log('通过 桌面连续预算、有解/无解、多品种、固定 PF 与差额模拟、共享仓位和平仓');
  await type('#stage', 'funded');
  await clickWait(
    '#demo-stage',
    "JSON.parse(localStorage.getItem('" + key + "')).branches.demo_funded?.stage==='funded'"
  );
  await type('#equity', '10100.000000000000000001');
  await clickWait('#adopt', by('history') + ".textContent.includes('snapshot_edit')");
  await clickWait('#claim', by('book-state') + ".textContent.includes('分成处理中')");
  let b = (await workspace()).branches.demo_funded;
  assert.equal(b.pf, '10000');
  const h = b.hl;
  await clickWait('#receive', by('history') + ".textContent.includes('receipt')");
  b = (await workspace()).branches.demo_funded;
  assert.equal(b.hl, h);
  assert.equal(b.external, '80.0000000000000000008');
  await clickWait('#transfer-out', by('history') + ".textContent.includes('transfer_out')");
  assert.equal((await workspace()).branches.demo_funded.hl, h);
  await clickWait('#transfer-in', by('history') + ".textContent.includes('transfer_in')");
  await clickWait('#new-round', by('book-state') + ".textContent.includes('Funded 进行中')");
  const latest = await workspace();
  assert.equal(latest.branches.demo_funded.round, 2);
  assert.equal(latest.branches.demo.ref, seed.ref);
  console.log('通过 独立阶段副本、毛利润扣款、应收、外部到账、在途、到账、新 C_ref');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  await click('#save-json');
  await click('#save-csv');
  let files = [];
  for (let i = 0; i < 60; i++) {
    files = await readdir(dir);
    if (files.some((x) => x.endsWith('.csv')) && files.some((x) => x.endsWith('.json'))) break;
    await delay(80);
  }
  const backup = path.join(
      dir,
      files.find((x) => x.endsWith('.json'))
    ),
    saved = JSON.parse(await readFile(backup, 'utf8'));
  assert.deepEqual(saved.branches, latest.branches);
  assert.equal(saved.view.branch, 'demo_funded');
  assert.match(
    await readFile(
      path.join(
        dir,
        files.find((x) => x.endsWith('.csv'))
      ),
      'utf8'
    ),
    /10100.000000000000000001/
  );
  await upload('#restore', backup);
  await wait("JSON.parse(localStorage.getItem('" + key + "')).revision>" + saved.revision);
  assert.deepEqual((await workspace()).branches, saved.branches);
  console.log('通过 浏览器下载 CSV/JSON 和文件恢复，保留十进制精度、截止时间与冻结事件');
  await set('#asset', 'unit');
  await set('#mode', 'replay');
  await set('#scenario', 'ambiguous');
  await click('#load-path');
  await click('#step');
  assert.match(await text('#replay-result'), /触线顺序不确定.*最坏/);
  await set('#scenario', 'timeout');
  await click('#load-path');
  await click('#play');
  await wait(by('replay-result') + ".textContent.includes('407.00 U')", 5000);
  await click('#pause');
  await type('#seek', '0');
  assert.match(await text('#replay-result'), /回放起点/);
  await upload('#csv', fileURLToPath(new URL('../../fixtures/hedge-candles.csv', import.meta.url)));
  await wait(by('replay-result') + ".textContent.includes('CSV 导入')");
  await type('#seek', '2');
  assert.match(await text('#replay-result'), /407.00 U/);
  await set('#mode', 'manual');
  await type(
    '#vs-text',
    'Balance: 10,000.25 USD\nEquity: 9,980 USD\nBid: 999\nAsk: 1001\nBTC-PERP short 2 1000 -45'
  );
  await click('#parse');
  assert.match(await text('#vs-preview'), /10000.25/);
  assert.equal((await workspace()).vsSnapshot, null);
  await clickWait('#confirm-vs', by('vs-preview') + ".textContent.includes('快照已确认')");
  assert.equal((await workspace()).vsSnapshot.positions[0].upnl, -45);
  console.log('通过 同柱顺序、两日平价退出、播放暂停、进度回退、CSV 导入及 VS 文本确认');
  await set('#mode', 'live_readonly');
  await wait(by('calc-status') + ".textContent.includes('未验证')");
  assert.equal(await run(by('hl') + '.value'), '');
  assert.equal(await run(by('ledger') + '.hidden'), true);
  if (process.argv.includes('--live')) {
    await type('#wallet', '0x' + '0'.repeat(40));
    await type('#symbol', 'BTC');
    await click('#live');
    await wait(by('api-result') + ".textContent.includes('withdrawable')", 25000);
    const real = JSON.parse(await text('#api-result'));
    assert.ok(Number(real.mark) > 0);
    assert.equal(real.book[0].length, 5);
    assert.ok(real.accountValue);
    console.log('通过 真实浏览器经本地代理读取主网 BTC 盘口和公开查询账户，模式 ' + real.mode);
  }
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/hype-info' }] });
  await type('#symbol', 'BTC');
  await click('#live');
  await wait(by('connection') + ".textContent.includes('API_DISCONNECTED')");
  assert.match(await text('#calc-status'), /未验证/);
  await send('Fetch.disable');
  assert.equal(await run("fetch('/trade.html').then(r=>r.status)"), 404);
  assert.notEqual(
    await run(
      "fetch('/api/hype-info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({network:'mainnet',request:{type:'order'}})}).then(r=>r.status)"
    ),
    200
  );
  console.log('通过 实时隔离、浏览器网络超时、无演示余额回填与只读路由');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  });
  await set('#mode', 'demo');
  await run("window.scrollTo(0,0);document.querySelector('#desk details').open=false");
  await screenshot('mobile');
  assert.ok(await run('document.documentElement.scrollWidth<=innerWidth+1'));
  await type('#reserve', '10000');
  assert.match(await text('#actual'), /无合格/);
  await send('Page.reload');
  await wait(by('calc-status') + '?.textContent.length>0');
  assert.equal((await workspace()).branches.demo.challengeDeadlineAt, seed.challengeDeadlineAt);
  assert.equal(await run(by('reserve') + '.value'), '10000');
  assert.deepEqual(chrome.faults, []);
  console.log('通过 手机 390×844 的重算、宽度、桌面 1390×1040、刷新持久化，浏览器异常 0');
  const ledgerBeforeObservation = await workspace();
  const at = new Date().toISOString();
  const observed = {
    version: 1,
    vs: {
      symbol: 'BTC-PERP',
      at,
      primary: true,
      emptyPositions: true,
      equity: '0.00',
      free: '0.00',
      capacity: '0.00',
      positionMargin: '0.00',
      orderMargin: '0.00'
    },
    hl: { symbol: 'BTC', at, disconnected: true, equity: null, free: null }
  };
  await send('Page.navigate', {
    url: chrome.url + '/?accounts=last#' + new URLSearchParams({ observation: JSON.stringify(observed) })
  });
  await wait("document.querySelector('#account-readout')?.innerText.includes('不适用 · 主账户')");
  assert.match(await text('#account-readout'), /Hype 本次新增名义额\$0.00/);
  assert.match(await text('#account-readout'), /钱包未连接，无法读取/);
  assert.equal(await run('location.hash'), '');
  assert.deepEqual(await workspace(), ledgerBeforeObservation);
  await send('Page.reload');
  await wait("document.querySelector('#account-readout')?.innerText.includes('本次不开仓')");
  assert.ok(await run('document.documentElement.scrollWidth<=innerWidth+1'));
  await click('nav a[href="/?simulation=challenge"]');
  await wait(
    "document.title === '默认考核模拟 · VS × Hype' && document.querySelectorAll('#account-readout .card').length === 4"
  );
  const cards = await run(
    "Array.from(document.querySelectorAll('#account-readout .card'), c => c.textContent)"
  );
  assert.match(cards[0], /VS 做多5,000.00 U.*0.05 BTC/);
  assert.match(cards[1], /Hype 做空766.00 U.*0.00766 BTC/);
  assert.match(cards[2], /VS 通过.*剩 101.50 U.*亏 398.50 U.*VS 1.20 U，Hype 0.92 U/);
  assert.match(cards[3], /VS 失败.*剩 500.06 U.*赚 0.06 U.*VS 0.94 U，Hype 0.72 U/);
  assert.deepEqual(await workspace(), ledgerBeforeObservation);
  await click('nav a[href="/?simulation=funded"]');
  const fundedReady =
    "document.title === '首次出金模拟 · VS × Hype' && document.querySelectorAll('#account-readout .card').length === 4";
  await wait(fundedReady);
  assert.match(
    await text('#account-readout'),
    /承接考核通过后的个人现金 101\.50 U，VS 出金户净值重置为 10,000\.00 U/
  );
  const fundedCards = () =>
    run("Array.from(document.querySelectorAll('#account-readout .card'), c => c.textContent)");
  const firstPayout = await fundedCards();
  assert.match(firstPayout[0], /VS 做空4,998\.86 U.*0\.0357 BTC/);
  assert.match(firstPayout[1], /Hype 做多999\.77 U.*0\.00714 BTC/);
  assert.match(firstPayout[2], /VS 爆号.*8,000\.00 U.*剩 500\.06 U.*赚 0\.06 U.*VS 1\.20 U，Hype 1\.20 U/);
  assert.match(
    firstPayout[3],
    /首次分成到账.*10,100\.00 U.*剩 160\.31 U.*亏 339\.69 U.*到账前 80\.31 U，外部账户收到 80\.00 U.*扣除毛利润 100\.00 U.*平台分得 20\.00 U.*分配后净值 10,000\.00 U.*VS 0\.99 U，Hype 0\.99 U/
  );
  await send('Page.reload');
  await wait(fundedReady);
  assert.deepEqual(await fundedCards(), firstPayout);
  assert.deepEqual(await workspace(), ledgerBeforeObservation);
  console.log('通过 过关余额与模拟价格结转、出金户新仓位、爆号及首次分成到账后的累计净盈亏');
  await click('nav a[href="/?accounts=last"]');
  await wait("document.querySelector('#account-readout')?.innerText.includes('不适用 · 主账户')");
  console.log('通过 独立默认考核模拟仓位、两条触线的扣费剩余现金、500 U 基准盈亏与原账本隔离');
  await click('#account-readout a');
  await wait("document.getElementById('mode')?.value==='live_readonly'");
  assert.deepEqual(chrome.faults, []);
  console.log('通过 账户快照、未连接占位值、盈亏口径、刷新、手机宽度与只读接入');
} finally {
  await chrome.close();
  await rm(dir, { recursive: true, force: true });
}
