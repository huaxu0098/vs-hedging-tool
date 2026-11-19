import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  await wait("!!document.getElementById('desk-details')");
  await run("document.getElementById('desk-details').open=true");
  await wait("document.querySelector('#calc-status')?.textContent");
  assert.equal(await val('funding-view'), 'plan');
  assert.equal(await run("document.querySelectorAll('#planLeverage,#hl-leverage').length"), 0);
  assert.equal(await run("document.getElementById('plan-cross-flat').checked"), true);
  await run("document.getElementById('trace-inputs').parentElement.open=true");
  // Market ticks can continuously overlap a solve. Check the published frame's
  // actual rules instead of requiring an idle worker between two price ticks.
  const freshFrame = `(() => {
    const el=id=>document.getElementById(id), desk=el('scan-desk');
    const raw=el('trace-inputs').textContent;
    if(!raw || !desk.dataset.resultId || !el('trace-id').textContent.endsWith(desk.dataset.resultId)) return false;
    const rules=JSON.parse(raw).rules;
    return ['ready','updating'].includes(desk.dataset.state) &&
      ['mode','stage','R_success','jumpBps','delayBps','adverseBps','fundingDebit','external','movePct','hlUtil']
        .every(id=>String(rules[id]??'')===el(id).value);
  })()`;
  const hasPlan = freshFrame + " && document.querySelector('#best-two').textContent.includes('第二优 PF')";
  await wait(hasPlan, 40000);
  assert.match(await text('#plan-basis'), /500.00 U.*91.00 U.*409.00 U/);
  assert.match(await text('#summary-status'), /预设规划/);
  assert.match(await text('#stress-assumptions'), /压力未配置/);
  assert.match(await text('#summary-status'), /AUTO_PARTIAL · 条件方案/);
  assert.match(await text('#plan-rows'), /失败回收优先/);
  assert.match(await text('#plan-rows'), /成功留存优先/);
  assert.match(await text('#success-hl'), /考核利润不可分/);
  assert.match(await text('#trace-id'), /AUTO-0.21/);
  const leverageCheck = await run(`(() => {
    const rows = Array.from(document.querySelector('#leverage-grid').rows, r => Array.from(r.cells, c => c.textContent));
    return { rows, suggested: document.getElementById('suggested-leverage').textContent,
      explanation: document.getElementById('leverage-reason').textContent };
  })()`);
  assert.equal(leverageCheck.suggested, leverageCheck.rows.find((row) => row.at(-1).includes('通过'))[0]);
  if (leverageCheck.rows.filter((row) => row.at(-1).includes('通过')).length > 1)
    assert.match(leverageCheck.explanation, /仅释放初始保证金/);
  console.log(
    'SECTION09_LIVE',
    JSON.stringify(
      await run(
        "Object.fromEntries(['trace-id','trace-sources','plan-rows','leverage-reason','fail-summary','fail-parts','pass-summary','success-hl','summary-status'].map(id=>[id,document.getElementById(id).textContent]))"
      )
    )
  );
  console.log(
    'PLAN_LIVE',
    JSON.stringify(
      await run(
        "Object.fromEntries(['pf-quote','hl-quote','best-two','legs','range','target-h','fail-summary','fail-change','pass-summary','pass-change','suggested-leverage','configured-leverage','leverage-cap','leverage-reason','risk-values','times'].map(k=>[k,document.getElementById(k).textContent]))"
      )
    )
  );
  const downloadDir = await mkdtemp(path.join(tmpdir(), 'vs-hl-trace-'));
  try {
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    await click('#trace-panel > summary');
    await click('#trace-download');
    let filename;
    for (let i = 0; i < 50 && !filename; i++) {
      filename = (await readdir(downloadDir)).find((name) => /^hedge-[0-9a-f]+\.json$/.test(name));
      if (!filename) await delay(100);
    }
    assert.ok(filename, '真实浏览器保存核算文件');
    const saved = JSON.parse(await readFile(path.join(downloadDir, filename), 'utf8'));
    assert.equal(filename, 'hedge-' + saved.id + '.json');
    assert.equal(saved.model, 'AUTO-0.21.1');
    assert.equal(saved.inputs.accounts.hl.equity, '409');
    assert.equal(saved.outputs.autoStatus, 'AUTO_PARTIAL');
    assert.ok(saved.outputs.conservative.candidate);
    if (process.env.HEDGE_AUDIT_OUTPUT)
      await writeFile(process.env.HEDGE_AUDIT_OUTPUT, JSON.stringify(saved, null, 2) + '\n');
    console.log('TRACE_DOWNLOAD', filename, saved.at);
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
  for (const [field, value] of Object.entries({
    jumpBps: '1',
    delayBps: '1',
    adverseBps: '1',
    fundingDebit: '0.05'
  }))
    await set(field, value);
  await wait(
    hasPlan + " && document.getElementById('stress-assumptions').textContent.includes('四项非零')",
    40000
  );
  console.log(
    'LEV_STRESS_LIVE',
    JSON.stringify(
      await run(
        "Object.fromEntries(['pf-summary','hl-summary','target-h','leverage-cap','suggested-leverage','configured-leverage','risk-values','leverage-reason','auto-search','quotes','times'].map(id=>[id,document.getElementById(id).textContent]))"
      )
    )
  );
  for (const field of ['jumpBps', 'delayBps', 'adverseBps', 'fundingDebit']) await set(field, '');
  await set('jumpBps', '0');
  await wait(hasPlan + " && document.querySelector('#stress-assumptions').textContent.includes('零压力假设')", 40000);
  assert.match(await text('#stress-assumptions'), /零压力假设.*跳价/);
  await set('stage', 'funded');
  await wait(
    "document.querySelector('#range').textContent.includes('无交集') && document.querySelector('#auto-search').textContent.includes('AUTO_INFEASIBLE')",
    30000
  );
  assert.equal(await text('#pf-summary'), '—');
  console.log('FUNDED_DEFAULT', await text('#bounds-detail'));
  await set('R_success', '40');
  await wait(hasPlan, 30000);
  assert.match(await text('#plan-basis'), /101.50 U/);
  assert.match(await text('#pass-heading'), /到账/);
  console.log(
    'FUNDED_PLAN_LIVE',
    await text('#best-two'),
    await text('#fail-summary'),
    await text('#pass-summary')
  );
  await b.set('#funding-view', 'account');
  assert.equal(await val('pf-equity'), '');
  assert.equal(await val('hl-qty'), '');
  assert.equal(await val('mode'), 'auto');
  assert.doesNotMatch(await run('document.body.innerText'), /模拟开仓|推进回放|默认考核模拟/);
  done('R01', [await run('document.title'), await text('#calc-status')]);
  await set('pf-equity', '10000');
  await set('hl-equity', '409');
  assert.match(await text('#range'), /15.167% – 15.450%/);
  assert.match(await text('#legs'), /未知/);
  done('R02', await text('#bounds-detail'));
  await set('pf-free', '10000');
  await set('hl-free', '409');
  assert.equal(await val('pf-qty'), '');
  assert.equal(await val('hl-qty'), '');
  await click('#confirm-flat');
  await wait(hasPlan, 30000);
  assert.match(await text('#suggested-leverage'), /^[1-9][0-9]*×$/);
  assert.match(await text('#leverage-status'), /LEVERAGE_UNVERIFIED/);
  assert.ok(await run("document.getElementById('leverage-grid').rows.length>1"));
  assert.equal(await val('pf-qty'), '0');
  assert.equal(await val('hl-qty'), '0');
  assert.match(await text('#top-auto'), /淘汰/);
  console.log('QUICK_ACCOUNT', await text('#best-two'), await text('#calc-status'));
  // Fixed-position tests below deliberately start without verified margin settings.
  for (const id of ['pf-marginMode', 'hl-marginMode', 'pf-otherHold', 'hl-otherHold']) await set(id, '');
  await set('mode', 'keepPF');
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
  await set('R_success', '40');
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
  await set('R_success', '100');
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
  await wait("/过期|断开/.test(document.querySelector('#calc-status').textContent)", 18000);
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
  await set('R_success', '60'); // Keep sufficient room for the observed inventory's rebalancing fee.
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
  // Other assets can fill the public vault's entire recent page. Retrieve an observed
  // BTC receipt from mainnet by event time if that happens. Quantities always come from the API.
  const eligible = (f) =>
    f.coin === 'BTC' &&
    f.startPosition != null &&
    Number(f.sz) > 0 &&
    Number(f.sz) < 1 &&
    Math.abs(Number(f.startPosition)) < 1;
  let fill = (await req({ type: 'userFills', user })).find(eligible);
  for (const minutes of [45, 90, 180]) {
    if (fill) break;
    const startTime = Date.now() - minutes * 60000;
    fill = (await req({ type: 'userFillsByTime', user, startTime, endTime: startTime + 15 * 60000 })).find(
      eligible
    );
  }
  for (const receipt of ['2026-11-19T12:41:11.573Z', '2026-11-19T10:01:01.423Z']) {
    if (fill) break;
    const observed = Date.parse(receipt);
    fill = (
      await req({ type: 'userFillsByTime', user, startTime: observed - 1, endTime: observed + 1 })
    ).find(eligible);
  }
  assert.ok(fill, '主网返回的公开 HLP 子金库 BTC 成交');
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
  await wait("document.querySelector('#rule-events').textContent.includes('参考点')", 15000);
  assert.equal(await val('hl-equity'), '409');
  assert.equal(await val('pf-equity'), '10110');
  done('R10', await text('#rule-events'));
  await set('stage', 'challenge');
  await set('deadline', '');
  await set('receivable', '');
  await set('pf-equity', '10000');
  await b.set('#hl-source', 'api');
  await set('wallet', user);
  await wait("document.querySelector('#sync-status').textContent.includes('返回账户价值')", 25000);
  console.log(
    '公开账户与挂单',
    await text('#configured-leverage'),
    await text('#leverage-status'),
    await text('#sync-status'),
    await val('hl-qty'),
    (await text('#order-detail')).slice(0, 150)
  );
  await b.set('#hl-source', 'manual');
  await set('mode', 'keepPF');
  await position('0.08', '-0.005', { leverage: '10' });
  for (const [id, value] of Object.entries({
    'pf-free': '9700',
    'hl-free': '375',
    'pf-otherHold': '0',
    'hl-otherHold': '0',
    'pf-marginMode': 'cross',
    'hl-marginMode': 'cross',

    R_success: '100'
  }))
    await set(id, value);
  const recommended = freshFrame + " && /推荐|基础候选|已验候选/.test(document.querySelector('#target-h').textContent)";
  await wait(recommended, 30000);
  await wait("document.querySelector('#hl-quote').textContent.includes('WebSocket')", 30000);
  assert.match(await text('#verified-range'), /个可行比例/);
  assert.match(await text('#risk-values'), /全仓档位测算/);
  const numeric = "document.querySelector('#legs').rows[0].cells[2].textContent";
  const numericalRisk = "document.querySelector('#risk-values').textContent";
  const beforeRisk = await run(numericalRisk);
  const initial = await run(numeric);
  await wait(numeric + '!==' + JSON.stringify(initial) + ' && ' + recommended, 45000);
  await wait(numericalRisk + '!==' + JSON.stringify(beforeRisk) + ' && ' + recommended, 45000);
  console.log('行情自动重算', initial, await run(numeric), await text('#hl-quote'));
  console.log(
    '固定 VS 验算',
    await text('#current-h'),
    await text('#target-h'),
    await row(),
    await text('#cash-results'),
    await text('#verified-range'),
    await text('#risk-values'),
    await text('#costs')
  );
  await set('hl-qty', '-0.01225');
  await set('mode', 'keepHL');
  await wait(recommended, 20000);
  assert.equal((await row())[3], '保持 0');
  assert.equal(await run("document.querySelector('#costs').rows[1].cells[1].textContent"), '0.00 U');
  console.log('固定 Hype 验算', await text('#target-h'), await text('#legs'));
  const future = await run(
    'new Date(Date.now()+3600000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)'
  );
  await set('deadline', future);
  await set('pf-qty', '0');
  await set('hl-qty', '0');
  await set('mode', 'auto');
  await wait(recommended, 25000);
  assert.match(await text('#auto-search'), /AUTO_PARTIAL/);
  assert.match(await text('#two-day'), /未验证/);
  console.log(
    'AUTO 实时双空仓',
    await text('#auto-search'),
    await text('#legs'),
    await text('#cash-results'),
    await text('#rejected-auto')
  );
  console.log(
    'AUTO_FRAME',
    JSON.stringify(
      await run(
        `Object.fromEntries(['pf-summary','hl-summary','pf-change','hl-change','fail-summary','pass-summary','current-h','range','target-h','verified-range','protect-funds','margin-funds','summary-buffer','auto-search','times'].map(id=>[id,document.getElementById(id).textContent]))`
      )
    )
  );
  if (process.env.DESK_SCREENSHOT) {
    const { writeFile } = await import('node:fs/promises');
    await run('window.scrollTo(0,0)');
    const image = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.DESK_SCREENSHOT, Buffer.from(image.data, 'base64'));
  }
  const free = await text('#margin-funds');
  await set('external', '100');
  await wait(recommended, 25000);
  assert.equal(await text('#margin-funds'), free);
  assert.match(await text('#protect-funds'), /509.00/);
  assert.match(await text('#fail-parts'), /Hype 结算现金.*外部已到账 100.00 U/);
  await set('movePct', '3');
  await wait("document.querySelector('#two-day').textContent.includes('五档') && " + recommended, 25000);
  console.log('AUTO both / 两日', await text('#protect-funds'), free, await text('#two-day'));
  const output = (documentId) =>
    'document.querySelector(' + JSON.stringify('#' + documentId) + ').textContent';
  await set('hlUtil', '1');
  await set('hlUtil', '100');
  await wait(recommended, 25000);
  const beforeFrame = await text('#times'),
    beforeQuote = await text('#quotes');
  await wait(
    output('times') +
      '!== ' +
      JSON.stringify(beforeFrame) +
      ' && ' +
      output('quotes') +
      '!== ' +
      JSON.stringify(beforeQuote) +
      ' && ' +
      recommended,
    25000
  );

  await wait(
    hasPlan + " && document.querySelector('#auto-search').textContent.includes('AUTO_PARTIAL')",
    30000
  );
  console.log('AUTO 杠杆联合排序', await text('#auto-search'), await text('#top-auto'));
  await send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0
  });
  await wait("document.querySelector('#auto-search').textContent.includes('AUTO_DATA_BLOCKED')", 20000);
  assert.equal(await text('#hl-summary'), '—');
  console.log('AUTO 熔断', await text('#auto-search'), await text('#calc-status'));
  await send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1
  });
  await click('#sync');
  await wait(
    hasPlan + " && document.querySelector('#auto-search').textContent.includes('AUTO_PARTIAL')",
    30000
  );
  await set('deadline', '2020-01-01T00:00');
  assert.match(await text('#auto-search'), /AUTO_DEADLINE_EXIT_REQUIRED/);
  assert.match(await text('#rule-events'), /退出/);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  });
  assert.ok(await run('document.documentElement.scrollWidth<=innerWidth+1'), 'mobile overflow');
  // Independent local service keeps the user's active VS pairing untouched.
  await send('Page.navigate', { url: b.url + '/' });
  await wait("!!document.getElementById('desk-details')");
  await run("document.getElementById('desk-details').open=true");
  await wait(
    "document.querySelector('#bridge-pair')?.onclick && document.querySelector('#order-detail').textContent"
  );
  await b.set('#funding-view', 'account');
  await click('#bridge-pair');
  await wait("document.querySelector('#bridge-script').value.length > 0");
  const script = await val('bridge-script');
  const config = JSON.parse(script.match(/const c=(\{.*?\});if\(location/)[1]);
  const received = await fetch(b.url + '/api/vs-snapshot', {
    method: 'POST',
    headers: {
      Origin: config.origin,
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + config.token
    },
    body: JSON.stringify({
      assetId: config.assetId,
      snapshot: {
        symbol: 'BTC-PERP',
        timeSource: 'capture',
        asOf: new Date().toISOString(),
        account: {
          equity: 10010,
          free: 9800,
          positions: [{ symbol: 'BTC-PERP', qty: 0.08, entry: 63000, upnl: 10 }]
        }
      }
    })
  });
  assert.equal(received.status, 202, await received.text());
  await wait("document.getElementById('pf-equity').value === '10010'");
  assert.equal(await val('pf-free'), '9800');
  assert.match(await text('#pf-meta'), /桥接/);
  await click('#bridge-revoke');
  await wait("document.getElementById('bridge-state').textContent.includes('已撤销')");
  console.log('本机桥接', received.status, await text('#pf-meta'));
  await send('Page.navigate', { url: desk + '/dev/replay' });
  await wait("document.getElementById('event')?.textContent.includes('START')");
  await click('#step');
  await wait("document.getElementById('event').textContent.includes('步骤 1')");
  console.log('独立回放页', await text('#event'));
  assert.deepEqual(b.faults, []);
  console.log('已完成', Object.keys(results).length, '项，真实 Chrome 异常 0');
} catch (e) {
  console.error(
    await run(
      "['reason','quotes','preview','risk-status','bridge-state','event'].map(k => document.getElementById(k)?.textContent).filter(Boolean).join(' | ') "
    )
  );
  throw e;
} finally {
  await b.close();
}
