import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildTradeExtension } from '../build-trade-extension.js';
import { extensionBrowser } from './extension-browser.js';

const marketURLs = {
  vs: 'https://next.vestmarkets.com/trade/BTC-PERP',
  hype: 'https://app.hyperliquid.xyz/trade/BTC'
};
const wallet = '0x' + '1'.repeat(40);
const json = (value, code = 200) => ({ code, contentType: 'application/json', body: JSON.stringify(value) });

// This adapter is written exclusively into the test browser's temporary extension.
// It requires a fixture-only button, and records clicks on an in-memory document.
function fixtureAdapter() {
  const button = document.getElementById('qa-submit');
  function verify(leg) {
    if (!button || document.body.dataset.fixture !== leg.venue) throw Error('非测试页面');
    return JSON.stringify(leg);
  }
  globalThis.tradeVenue = {
    async prepare(leg) {
      const fingerprint = verify(leg);
      button.dataset.prepares = String(Number(button.dataset.prepares) + 1);
      if (button.dataset.fail === 'prepare') throw Error('测试表单尚未准备');
      const limit = performance.now() + 5000;
      while (button.dataset.hold === 'yes') {
        if (performance.now() > limit) throw Error('测试表单未释放');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return fingerprint;
    },
    verify,
    submit(leg) {
      verify(leg);
      button.click();
      if (button.dataset.fail === 'receipt') throw Error('测试回执未收到');
    }
  };
}

function officialCopyFixture() {
  const button = document.getElementById('qa-copy');
  // Keep the test OS clipboard untouched while exercising Chromium's native copy event.
  document.addEventListener('copy', (e) => e.preventDefault());
  button.onclick = () => {
    const area = button.dataset.stale
      ? document.querySelector('#qa-stale')
      : document.createElement('textarea');
    area.readOnly = true;
    area.tabIndex = -1;
    area.setAttribute('aria-hidden', 'true');
    area.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
    area.value = 'QA-587';
    if (!area.isConnected) document.body.append(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, area.textLength);
    document.execCommand('copy');
    area.remove();
  };
}
function venuePage(venue) {
  const field = (label, value) => '<dt>' + label + '</dt><dd>' + value + '</dd>';
  const ticket = `<section data-testid="market-info">BTC</section><section data-testid="order-form">
    <button data-testid="leverage-button">10x</button><button type="button" role="tab" data-testid="ordertype-tab-market" aria-selected="true" data-state="active">Market</button>
    <button type="button" data-testid="size-unit-toggle">BTC</button><input data-testid="size-input" inputmode="decimal">
    <button data-testid="tpsl-toggle" aria-checked="false">TP/SL</button><button data-testid="reduce-only-checkbox" aria-checked="false">Reduce only</button>
    <button data-testid="tif-select">IOC</button><button type="submit" data-testid="submit-long" disabled>Buy</button><button type="submit" data-testid="submit-short" disabled>Sell</button>
    </section><script>
    const field=document.querySelector('[data-testid=size-input]');
    const submits=[...document.querySelectorAll('[data-testid=order-form] button[type=submit]')];
    field.oninput=()=>submits.forEach(el=>el.disabled=!(Number(field.value)>0));
    for(const el of submits) el.onclick=()=>{const counter=document.querySelector('#qa-submit');counter.dataset.clicks=String(Number(counter.dataset.clicks)+1)};
    </script>`;
  const html =
    '<main><h1>BTC-PERP</h1><section aria-label="Market overview"><dl>' +
    field('Best bid', '99999') +
    field('Best ask', '100001') +
    field('Mark price', '100000') +
    field('Market status', 'Open') +
    '</dl></section><section aria-label="Account overview"><dl>' +
    field('Balance', '10000') +
    field('Equity', '10000') +
    field('Used margin', '0') +
    field('Free margin', '10000') +
    '</dl></section><section aria-label="Positions"><table><thead><tr>' +
    ['Symbol', 'Size', 'Entry Price', 'Unrealized PnL'].map((s) => '<th>' + s + '</th>').join('') +
    '</tr></thead><tbody><tr><td colspan="4">No open positions</td></tr></tbody></table></section></main>';
  return (
    '<!doctype html><meta charset="utf-8"><body data-fixture="' +
    venue +
    '">' +
    (venue === 'vs'
      ? html + ticket +
        '<div role="button" data-testid="account-selector-trigger"><div><span>示例账户</span><button id="qa-copy" type="button" aria-label="Copy">复制</button></div><span data-slot="badge">Evaluation</span></div><script>(' +
        officialCopyFixture.toString() +
        ')()</script>'
      : '') +
    '<button id="qa-submit" data-prepares="0" data-clicks="0" type="button">合成测试按钮</button>' +
    '<script>const button=document.getElementById("qa-submit");button.onclick=()=>button.dataset.clicks=String(Number(button.dataset.clicks)+1)</script></body>'
  );
}

function deskResponse(req, base) {
  const u = new URL(req.url);
  if (u.origin !== base) return json({ error: '隔离外网' }, 403);
  if (u.pathname === '/api/vest-contract')
    return json({ symbol: u.searchParams.get('symbol'), quote: 'USDC' });
  if (u.pathname === '/api/usd-rates') {
    const rate = (currency) => ({
      currency,
      quote: 'USD',
      rate: 1,
      bid: 0.99999,
      ask: 1.00001,
      asOf: new Date().toISOString(),
      source: '合成外汇夹具'
    });
    return json({ rates: { USDC: rate('USDC'), USDT: rate('USDT') }, errors: {} });
  }
  if (u.pathname === '/api/hype-info') {
    const { request: r } = JSON.parse(req.postData);
    const spec = { name: 'BTC', szDecimals: 5, maxLeverage: 20, marginTableId: 20 };
    if (r.type === 'metaAndAssetCtxs')
      return json([
        {
          universe: [spec],
          collateralToken: 0,
          marginTables: [[20, { marginTiers: [{ lowerBound: '0', maxLeverage: 20 }] }]]
        },
        [{ markPx: '100000', oraclePx: '100000', funding: '0' }]
      ]);
    if (r.type === 'l2Book')
      return json({
        coin: r.coin,
        time: Date.now(),
        levels: [[{ px: '99999', sz: '5', n: 1 }], [{ px: '100001', sz: '5', n: 1 }]]
      });
    if (r.type === 'clearinghouseState' && r.user === wallet)
      return json({
        marginSummary: { accountValue: '500', totalMarginUsed: '0' },
        withdrawable: '500',
        assetPositions: [],
        time: Date.now()
      });
    if (r.type === 'userNonFundingLedgerUpdates') return json([]);
    return json({ error: '未声明的只读请求' }, 400);
  }
  if (u.pathname.startsWith('/api/')) return json(null);
}

async function set(tab, selector, value, event = 'change') {
  await tab.run(
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}))})()`
  );
}
async function trade(tab) {
  await tab.run("location.hash='trade'");
  await tab.wait("document.querySelector('#trade') && !document.querySelector('#trade').hidden");
}
const sel = (query) => 'document.querySelector(' + JSON.stringify(query) + ')';

async function main() {
  const browser = await extensionBrowser({
    buildExtension: async (dest, port) => {
      await buildTradeExtension(dest, port);
      await writeFile(path.join(dest, 'venue-hype.js'), '(' + fixtureAdapter.toString() + ')();');
    }
  });
  const pageURL = browser.url + '/trade.html#trade';
  const desk = await browser.tab((req) => deskResponse(req, browser.url));
  try {
    await desk.go(pageURL);
    await desk.wait(
      "document.querySelector('#feed-values')?.textContent && document.querySelector('#feed-switch')?.value==='live'"
    );
    await desk.wait(sel('#trade-why') + ".textContent.includes('扩展')");
    assert.ok(await desk.run(sel('#trade-send') + '.disabled'));
    await set(desk, '#feed-switch', 'offline');
    await trade(desk);
    await desk.wait(sel('#trade-pass-price') + '.textContent.match(/[0-9]/)');
    const original = await desk.text('#trade-pass-price');
    const events = async () => [await desk.text('#trade-vs-event'), await desk.text('#trade-hype-event')];
    const unknown = await events();
    assert.ok(
      unknown.every((s) => /等待|未知|未确认|未连接|尚无可验证/.test(s)),
      unknown.join(' / ')
    );
    assert.ok(await desk.run(sel('#trade-send') + '.disabled'));
    for (const id of ['pass', 'fail', 'liq'])
      assert.match(await desk.text('#trade-' + id + '-price'), /[\d]/);
    await set(desk, '#trade-scenario', 'fail');
    const fail = await desk.text('#trade-pnl');
    await set(desk, '#trade-scenario', 'pass');
    assert.match(fail, /\d/);
    assert.match(await desk.text('#trade-pnl'), /\d/);
    assert.notEqual(await desk.text('#trade-pnl'), fail);
    await set(desk, '#trade-scenario', 'liq');
    assert.match(
      (await desk.text('#trade-pnl-note')) + ' ' + (await desk.text('#trade-pnl')),
      /先触及|清算|待核实|结算|无法|未知|不可达/
    );
    assert.deepEqual(await events(), unknown);
    await set(desk, '#asset', 'eth');
    await desk.wait(
      sel('#trade-pass-price') +
        '.textContent!==' +
        JSON.stringify(original) +
        ' && /[0-9]/.test(' +
        sel('#trade-pass-price') +
        '.textContent) && ' +
        sel('#trade-vs-qty') +
        ".textContent.includes('ETH')"
    );
    await set(desk, '#asset', 'btc');
    await desk.wait(sel('#trade-pass-price') + '.textContent===' + JSON.stringify(original));
    await desk.click('nav a[href="#sim"]');
    await desk.wait("!document.querySelector('#sim').hidden");
    await desk.click('[data-op="target"]');
    await desk.wait("JSON.parse(localStorage.getItem('vs-hype:simulation:v2'))?.positions.length===2");
    await trade(desk);
    await desk.wait('/开仓|持仓|调整仓位/.test(' + sel('#trade-sim-event') + '.textContent)');
    assert.deepEqual(await events(), unknown);
    assert.ok(await desk.run(sel('#trade-send') + '.disabled'));
    await desk.click('nav a[href="#sim"]');
    await desk.wait("!document.querySelector('#sim').hidden");
    await desk.click('[data-op="close"]');
    await desk.wait("JSON.parse(localStorage.getItem('vs-hype:simulation:v2'))?.positions.length===0");
    await trade(desk);
    console.log('PASS 离线三情景、模拟账本与真实平台事件区分、切换品种及无扩展保护');

    await browser.install();
    const venues = {};
    for (const [side, url] of Object.entries(marketURLs)) {
      const page = await browser.tab((req) =>
        req.method === 'GET' && req.url === url
          ? { body: venuePage(side) }
          : json({ error: '仅测试夹具' }, 403)
      );
      await page.go(url);
      await page.wait(sel('#qa-submit') + '!==null');
      venues[side] = page;
    }
    await desk.send('Page.reload', { ignoreCache: true });
    await desk.wait(sel('#trade-controls') + "?.dataset.extension==='ready'");
    await desk.click('nav a[href="#feeds"]');
    await desk.wait("!document.querySelector('#feeds').hidden");
    await set(desk, '#feed-vssym', 'BTC-PERP', 'input');
    await set(desk, '#feed-wallet', wallet, 'input');
    await set(desk, '#feed-age', '60');
    await desk.click('#feed-map-verify');
    await desk.click('#feed-save-map');
    await set(desk, '#feed-auto-url', marketURLs.vs, 'input');
    await desk.run(
      "addEventListener('vs-auto-update',e=>{const m=JSON.parse(e.detail);if(m.type==='snapshot') window.qaAccount=m.snapshot.account})"
    );
    await desk.click('#feed-auto-public');
    await desk.click('#feed-auto-start');
    await desk.wait(
      sel('#feed-values') +
        ".textContent.includes('BTC-PERP') && " +
        sel('#feed-auto-account') +
        ".textContent.includes('已读取')"
    );
    await trade(desk);
    await desk.wait("window.qaAccount && !window.qaAccount.accountContext && " + sel('#trade-send') + ".disabled");
    await venues.vs.click('#qa-copy');
    assert.ok(await desk.run(sel('#trade-send') + '.disabled'));
    await desk.click('#trade-setup summary');
    const authorize = async () => {
      await desk.click('#trade-bind-vs');
      await venues.vs.wait("document.body.innerText.includes('请亲自点当前账户')");
    };
    await authorize();
    await venues.vs.run("document.querySelector('#qa-copy').click()");
    assert.ok(await desk.run(sel('#trade-send') + '.disabled'));
    await venues.vs.run(
      "const t=document.createElement('textarea');t.id='qa-stale';document.body.append(t);document.querySelector('#qa-copy').dataset.stale='yes'"
    );
    await venues.vs.click('#qa-copy');
    assert.ok(!(await venues.vs.text('body')).includes('已核对当前账户'));
    await venues.vs.run("delete document.querySelector('#qa-copy').dataset.stale");
    await venues.vs.click('#qa-copy');
    await venues.vs.wait("document.body.innerText.includes('已核对当前账户')");
    await desk.wait('!' + sel('#trade-send') + '.disabled');
    const firstBinding = await desk.run(
      'JSON.parse(' + sel('#trade-controls') + '.dataset.plan).legs[0].accountContext'
    );
    await venues.vs.click('[data-testid="account-selector-trigger"] > div > span');
    await desk.wait(
      sel('#trade-send') + '.disabled && !window.qaAccount.accountContext'
    );
    await venues.vs.run("document.querySelector('[data-slot=badge]').textContent='Passed'");
    await authorize();
    await venues.vs.click('#qa-copy');
    await desk.wait(sel('#trade-vs-event') + ".textContent.includes('官方页面显示已通过')");
    assert.ok(await desk.run(sel('#trade-send') + '.disabled'));
    for (const [badge, stage] of [
      ['Failed', null],
      ['已失败', null],
      ['Evaluation Failed', 'challenge']
    ]) {
      await venues.vs.run("document.querySelector('[data-slot=badge]').textContent=" + JSON.stringify(badge));
      await desk.wait(sel('#trade-vs-event') + ".textContent.includes('尚无可验证')");
      await authorize();
      await venues.vs.click('#qa-copy');
      await desk.wait(sel('#trade-vs-event') + ".textContent.includes('官方页面显示账户失败')");
      assert.equal(await desk.run('window.qaAccount.stage??null'), stage);
      assert.ok(await desk.run(sel('#trade-send') + '.disabled'));
    }
    for (const badge of ['Raised', 'Order Failed', 'Closed']) {
      await venues.vs.run("document.querySelector('[data-slot=badge]').textContent=" + JSON.stringify(badge));
      await desk.click('#trade-bind-vs');
      await desk.wait(sel('#trade-feedback') + ".textContent.includes('关闭账户菜单')");
      await desk.wait(sel('#trade-vs-event') + ".textContent.includes('尚无可验证')");
      assert.ok(await desk.run(sel('#trade-send') + '.disabled'));
    }
    await venues.vs.run("document.querySelector('[data-slot=badge]').textContent='Evaluation'");
    await desk.wait(sel('#trade-vs-event') + ".textContent.includes('尚无可验证')");
    await authorize();
    await venues.vs.click('#qa-copy');
    try {
      await desk.wait('!' + sel('#trade-send') + '.disabled', 10000);
    } catch (e) {
      throw Error(e.message + ' ' + (await desk.text('#trade-why')) + ' ' + (await desk.text('#verdict')));
    }
    const plan = await desk.run('JSON.parse(' + sel('#trade-controls') + '.dataset.plan)');
    assert.notEqual(plan.legs[0].accountContext, firstBinding);
    assert.doesNotMatch(JSON.stringify(plan), /QA-587/);
    console.log('PASS 本人授权并点击当前账户的复制图标才绑定，切换账号失效，新绑定更新标识');
    const clicks = async () =>
      Promise.all(
        Object.values(venues).map((p) => p.run("Number(document.querySelector('#qa-submit').dataset.clicks)"))
      );
    const toggle = (side, field, value) =>
      venues[side].run(
        sel('#qa-submit') + '.dataset[' + JSON.stringify(field) + ']=' + JSON.stringify(value)
      );
    await toggle('hype', 'fail', 'prepare');
    await desk.click('#trade-send');
    await desk.wait(sel('#trade-feedback') + ".textContent.includes('测试表单尚未准备')");
    assert.deepEqual(await clicks(), [0, 0]);
    assert.ok(!(await desk.run(sel('#trade-controls') + '.dataset.receipt')));
    await toggle('hype', 'fail', 'receipt');
    await toggle('hype', 'hold', 'yes');
    await desk.wait('!' + sel('#trade-send') + '.disabled');
    await desk.click('#trade-send');
    await venues.hype.wait("Number(document.querySelector('#qa-submit').dataset.prepares)>=2");
    assert.deepEqual(await clicks(), [0, 0]);
    await desk.click('#trade-send');
    await toggle('hype', 'hold', 'no');
    await desk.wait(sel('#trade-controls') + ".dataset.receipt?.includes('测试回执未收到')");
    const record = await desk.run('JSON.parse(' + sel('#trade-controls') + '.dataset.receipt)');
    assert.deepEqual(await clicks(), [1, 1]);
    assert.match(record.legs[0].status, /等待官网确认/);
    assert.match(record.legs[1].status, /需查委托记录/);
    assert.ok(await desk.run(sel('#trade-send') + '.disabled'));
    await desk.click('#trade-send');
    await desk.run('window.tradeQABeforeReload=true');
    await desk.send('Page.reload', { ignoreCache: true });
    await desk.wait(
      '!window.tradeQABeforeReload && ' +
        sel('#trade-controls') +
        '?.dataset.receipt?.includes(' +
        JSON.stringify(record.id) +
        ')'
    );
    assert.deepEqual(await clicks(), [1, 1]);
    assert.ok(await desk.run(sel('#trade-send') + '.disabled'));
    assert.deepEqual(browser.faults, []);
    console.log(
      'PASS 准备失败零提交、双边就绪前零点击、重复点击只执行一次、单边回执异常保留记录、重载不会重试'
    );
    console.log(
      JSON.stringify({
        browser: browser.version,
        realAccounts: false,
        network: 'isolated',
        desk: '/trade.html',
        officialVenueAdapters: { vs:'production adapter on isolated venue fixture', hype:'test adapter' }
      })
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
