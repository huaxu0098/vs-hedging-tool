import assert from 'node:assert/strict';
import { openTestBrowser } from './chrome.js';

const b = await openTestBrowser({ current: true });
const { send, run, wait, text, click } = b;
const set = (id, v) => b.set('#' + id, v, 'input');
const val = (id) => run('document.getElementById(' + JSON.stringify(id) + ').value');
const results = {};
const done = (id, evidence) => {
  results[id] = evidence;
  console.log(id, JSON.stringify(evidence));
};
const desk = process.env.CURRENT_URL ?? b.url;
const position = async (pf, hl, extra = {}) => {
  await b.set('#paste-kind', 'both');
  await set(
    'paste',
    JSON.stringify({
      asset: 'BTC',
      pf: { equity: '10000', qty: pf, orders: [] },
      hl: { equity: '409', qty: hl, orders: [], ...extra }
    })
  );
  await click('#parse');
  assert.equal(await run('document.querySelector("#confirm").disabled'), false);
  await click('#confirm');
  await wait("document.querySelector('#legs').textContent.includes('保持 0')");
};
const candidate = "document.querySelector('#legs').rows[1]?.cells[2].textContent.includes('BTC')";
const row = () => run("Array.from(document.querySelector('#legs').rows[1].cells, c=>c.textContent)");
try {
  await send('Page.navigate', { url: desk + '/' });
  await wait("document.querySelector('#calc-status')?.textContent");
  assert.equal(await val('pf-equity'), '');
  assert.equal(await val('hl-qty'), '');
  assert.equal(await val('mode'), 'keepPF');
  assert.doesNotMatch(await run('document.body.innerText'), /模拟开仓|推进回放|默认考核模拟/);
  done('R01', [await run('document.title'), await text('#calc-status')]);
  await set('pf-equity', '10000');
  await set('hl-equity', '409');
  assert.match(await text('#range'), /15.167% – 15.450%/);
  assert.match(await text('#legs'), /未知/);
  done('R02', await text('#bounds-detail'));
  await position('0.08', '-0.005');
  await wait(candidate, 35000);
  assert.equal(await run("document.querySelector('#legs').rows[0].cells[3].textContent"), '保持 0');
  done('R03', {
    h: await text('#current-h'),
    target: await text('#target-h'),
    hl: await row(),
    quotes: await text('#quotes'),
    fx: await text('#fx-source')
  });
  const last = await text('#quotes'),
    anchor = await run("document.querySelector('#pf-meta').textContent.split(' · ')[1]");
  await wait(
    "document.getElementById('quotes').textContent!==" +
      JSON.stringify(last) +
      " && document.getElementById('quotes').textContent.includes('标记')",
    20000
  );
  const oldRange = await text('#bounds-detail');
  await set('B', '505');
  assert.notEqual(await text('#bounds-detail'), oldRange);
  await set('B', '500');
  done('R04', { quotes: await text('#quotes'), times: await text('#times') });
  assert.equal(await run("document.querySelector('#pf-meta').textContent.split(' · ')[1]"), anchor);
  // Accept a new hand-entered anchor while both public marks are available.
  await position('0.08', '-0.005');
  assert.match(await text('#pf-meta'), /手工确认.*按标记价估算/);
  done('R05', await text('#pf-meta'));
  await set('stage', 'funded');
  await set('R', '40');
  await set('hl-equity', '101.50');
  await wait(candidate, 25000);
  assert.equal(await val('ref'), '');
  assert.match(await text('#cash-results'), /缺少本轮起点/);
  assert.match(await text('#bounds-detail'), /整轮利润上限 缺少本轮起点/);
  done('R06', {
    range: await text('#range'),
    target: await text('#target-h'),
    cash: await text('#cash-results')
  });
  await set('stage', 'challenge');
  await set('R', '100');
  await position('0.08', '-0.005', { orders: [{ qty: '-0.002', id: 'manual-check' }] });
  await wait(candidate, 18000);
  const pendingRow = await row();
  assert.match(await text('#order-detail'), /若全部成交 -0.007/);
  const magnitude = (x) => Math.abs(Number(x.match(/[+-][0-9.]+/)?.[0]));
  assert.ok(Math.abs(magnitude(pendingRow[3]) - magnitude(pendingRow[4]) - 0.002) < 1e-8);
  done('R07', pendingRow);
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0
  });
  await wait("document.querySelector('#calc-status').textContent.includes('过期')", 18000);
  assert.match(await text('#quotes'), /标记/);
  assert.match(await text('#previous'), /过期前最后一次/);
  assert.equal((await row())[4], '—');
  done('R08', { last: await text('#previous'), status: await text('#calc-status') });
  await send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1
  });
  await click('#sync');
  await wait(candidate, 30000);
  await set('R', '60'); // Keep sufficient room for the observed inventory's rebalancing fee.
  const user = '0x010461c14e146ac35fe42271bdc1134ee31c703a';
  const req = async (q) => {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(q),
      signal: AbortSignal.timeout(9000)
    });
    assert.equal(res.status, 200);
    return res.json();
  };
  const fills = await req({ type: 'userFills', user });
  const fill = fills.find(
    (f) => f.coin === 'BTC' && f.startPosition != null && Number(f.sz) > 0 && Number(f.sz) < 1
  );
  assert.ok(fill, '公开 HLP 子金库最近返回的 BTC 成交');
  const before = fill.startPosition,
    after = (Number(before) + (fill.side === 'B' ? 1 : -1) * Number(fill.sz)).toFixed(5);
  await position('0.08', before);
  await wait(candidate, 18000);
  const first = await row();
  await position('0.08', after);
  await wait(candidate, 18000);
  const second = await row();
  assert.notEqual(first[1], second[1]);
  assert.notEqual(first[3], second[3]);
  assert.equal(await val('hl-qty'), after);
  const stored = await run(
    "JSON.stringify(JSON.parse(localStorage.getItem('vs-hype:current-snapshots:v1')).assets)"
  );
  await click('#sync');
  assert.equal(
    await run("JSON.stringify(JSON.parse(localStorage.getItem('vs-hype:current-snapshots:v1')).assets)"),
    stored
  );
  done('R09', {
    source: '公开 HLP 子金库真实 BTC 成交前后数量，手工同步；权益按验算输入',
    tid: fill.tid,
    time: new Date(fill.time).toISOString(),
    before: first,
    after: second
  });
  await set('deadline', '2020-01-01T00:00');
  assert.match(await text('#rule-events'), /到期/);
  await set('stage', 'funded');
  await set('pf-equity', '10110');
  await set('receivable', '80');
  assert.match(await text('#rule-events'), /有分成待到账/);
  assert.match(await text('#rule-events'), /参考点/);
  assert.equal(await val('hl-equity'), '409');
  assert.equal(await val('pf-equity'), '10110');
  done('R10', await text('#rule-events'));
  await set('stage', 'challenge');
  await set('deadline', '');
  await set('receivable', '');
  await set('pf-equity', '10000');
  await set('mode', 'joint');
  await set('sizes', '4000,5000');
  await wait(candidate, 20000);
  console.log('联合搜索', await row());
  await b.set('#hl-source', 'api');
  await set('wallet', user);
  await wait("document.querySelector('#sync-status').textContent.includes('返回账户价值')", 25000);
  console.log(
    '公开账户与挂单',
    await text('#sync-status'),
    await val('hl-qty'),
    (await text('#order-detail')).slice(0, 150)
  );
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  });
  assert.ok(await run('document.documentElement.scrollWidth<=innerWidth+1'), 'mobile overflow');
  assert.deepEqual(b.faults, []);
  console.log('已完成', Object.keys(results).length, '项，真实 Chrome 异常 0');
} catch (e) {
  console.error(await text('#reason'), await text('#quotes'), await text('#preview'));
  throw e;
} finally {
  await b.close();
}
