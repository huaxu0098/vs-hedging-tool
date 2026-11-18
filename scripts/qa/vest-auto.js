import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { extensionBrowser } from './extension-browser.js';

const site = 'https://next.vestmarkets.com';
const btc = site + '/trade/BTC-PERP';
const eth = site + '/trade/ETH-PERP';
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
const done = (message) => console.log('PASS ' + message);

function marketPage(symbol, mark, balance) {
  // Semantic public fields and a synthetic account. No login or production
  // traffic is involved. Values change in-place just like a rendered SPA.
  const field = (key, label, value) => '<dt>' + label + '</dt><dd id="' + key + '">' + value + '</dd>';
  const gross = (mark - 100000) * 0.002;
  return (
    '<!doctype html><html lang="en"><head><title>' +
    symbol +
    ' | Vest QA</title></head><body>' +
    '<main><h1>' +
    symbol +
    '</h1><section aria-label="Market overview"><h2>Market overview</h2><dl>' +
    field('mark', 'Mark Price', fmt(mark)) +
    field('bid', 'Best Bid', fmt(mark - 1)) +
    field('ask', 'Best Ask', fmt(mark + 1)) +
    field('open', 'Market Status', 'Open') +
    '</dl></section>' +
    '<section aria-label="Account overview"><h2>Account overview</h2><dl>' +
    field('balance', 'Balance', fmt(balance)) +
    field('equity', 'Equity', fmt(balance + gross)) +
    field('used', 'Used Margin', '20') +
    field('free', 'Free Margin', fmt(balance + gross - 20)) +
    field('stage', 'Stage', 'Challenge') +
    '</dl></section>' +
    '<section aria-label="Positions"><h2>Positions</h2><table><thead><tr>' +
    ['Symbol', 'Side', 'Size', 'Entry Price', 'Unrealized PnL', 'Margin Used']
      .map((v) => '<th>' + v + '</th>')
      .join('') +
    '</tr></thead><tbody><tr><td>' +
    symbol +
    '</td><td>Long</td><td>0.002</td><td>100,000</td><td id="pnl">' +
    fmt(gross) +
    '</td><td>20</td></tr></tbody></table></section><aside id="decorative"></aside></main></body></html>'
  );
}
async function mutate(tab, mark, balance) {
  const gross = (mark - 100000) * 0.002;
  const patch = {
    bid: fmt(mark - 1),
    ask: fmt(mark + 1),
    mark: fmt(mark),
    balance: fmt(balance),
    equity: fmt(balance + gross),
    free: fmt(balance + gross - 20),
    pnl: fmt(gross)
  };
  await tab.run(
    'Object.entries(' +
      JSON.stringify(patch) +
      ').forEach(([key,value])=>document.getElementById(key).textContent=value)'
  );
}
function deskReply(req) {
  if (new URL(req.url).pathname !== '/api/hype-info') return;
  const { request } = JSON.parse(req.postData);
  const meta = {
    collateralToken: 0,
    universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 20, marginTableId: 20 }]
  };
  const data =
    request.type === 'metaAndAssetCtxs'
      ? [meta, [{ markPx: '100000', oraclePx: '100000', funding: '0' }]]
      : request.type === 'l2Book'
        ? {
            coin: 'BTC',
            time: Date.now(),
            levels: [[{ px: '99999', sz: '3', n: 1 }], [{ px: '100001', sz: '3', n: 1 }]]
          }
        : null;
  return { code: data ? 200 : 400, contentType: 'application/json', body: JSON.stringify(data) };
}

async function main() {
  const browser = await extensionBrowser();
  const checks = [];
  const pass = (label) => {
    checks.push(label);
    done(label);
  };
  try {
    async function openMarket(url, mark, balance) {
      const page = await browser.tab((req) => {
        if (new URL(req.url).origin !== site) return;
        return req.url === url
          ? { body: marketPage(new URL(url).pathname.split('/').at(-1), mark, balance) }
          : { code: 404, body: '' };
      });
      await page.go(url);
      await page.wait("document.querySelector('#mark')?.textContent===" + JSON.stringify(fmt(mark)));
      return page;
    }
    await browser.install();
    const first = await openMarket(btc, 100000, 10937);
    const desk = await browser.tab(deskReply);
    await desk.go(browser.url);
    await desk.wait("document.querySelector('#feed-auto-start') && document.querySelector('#feed-values')");
    const set = async (sel, value, event = 'change') =>
      desk.run(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
    const check = async (sel, on) =>
      desk.run(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw Error('Missing '+${JSON.stringify(sel)});
      if(el.checked!==${Boolean(on)})el.click();})()`);
    const feed = () => desk.text('#feed-values');
    const waitForQuote = async (mark) =>
      desk.wait(
        `(()=>{const first=document.querySelector('#feed-values')?.textContent.split(String.fromCharCode(10)).find(row=>row.startsWith('VS　'));
      return first?.includes('BTC-PERP') && first.replaceAll(',','').includes('标记 '+${String(mark)});})()`,
        12000
      );
    const waitForEquity = async (equity) =>
      desk.wait(
        "document.querySelector('#vs-panel')?.textContent.replaceAll(',','').includes(" +
          JSON.stringify(String(equity)) +
          ')',
        10000
      );
    const quoteTime = () =>
      desk.run(
        "document.querySelector('#feed-values').textContent.split('\\n').find(s=>s.includes('报价时间')||s.includes('采集时间'))?.match(/\\d{4}-[^　 ]+/)?.[0]"
      );
    const neverShows = async (mark, ms = 1600) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const row = (await feed()).split('\n').find((x) => x.startsWith('VS　')) ?? '';
        assert.ok(!row.replaceAll(',', '').includes('标记 ' + mark), '错误来源更新了可见 VS 报价 ' + row);
        await delay(100);
      }
    };
    await desk.run(
      "window.qaAutoEvents=[];window.addEventListener('vs-auto-update',e=>{try{window.qaAutoEvents.push(JSON.parse(e.detail))}catch{}})"
    );
    await desk.run('document.querySelector(\'nav a[href="#feeds"]\').click()');
    await set('#feed-vssym', 'BTC-PERP', 'input');
    await set('#feed-age', '2');
    await check('#feed-map-verify', true);
    await desk.click('#feed-save-map');
    await set('#feed-auto-url', btc, 'input');
    await check('#feed-auto-public', false);
    await desk.click('#feed-auto-start');
    await waitForQuote(100000);
    await waitForEquity(10937);
    assert.match(await desk.text('#vs-panel'), /10,917/);
    const seen = await desk.run("window.qaAutoEvents.filter(e=>e.type==='snapshot').at(-1)?.snapshot");
    assert.equal(seen.account.positions[0].symbol, 'BTC-PERP');
    assert.equal(seen.account.positions[0].qty, 0.002);
    pass('看板真实点击启动，已打开的 BTC-PERP 标签自动传入初始报价、账户净值和剩余保证金');
    await mutate(first, 100041, 10940);
    await waitForQuote(100041);
    await waitForEquity(10940.08);
    const at = await quoteTime();
    assert.ok(at, 'VS 快照应显示采集或来源时间');
    pass('SPA 原地更新到 100,041，账户净值与浮盈同步到左侧看板');
    await first.run(
      "window.qaTicker=setInterval(()=>document.querySelector('#decorative').textContent=String(performance.now()),200)"
    );
    await desk.wait("document.querySelector('#feed-health').textContent.includes('VS 报价过期')", 9000);
    assert.equal(await quoteTime(), at, '无关 DOM 重绘不得重签报价时间');
    assert.doesNotMatch(await desk.text('#verdict'), /匹配可交易/);
    await first.run('clearInterval(window.qaTicker)');
    pass('装饰区域持续刷新而盘口静止，原报价时间保持不变并熔断');
    await mutate(first, 100041, 10942);
    await waitForEquity(10942.08);
    assert.equal(await quoteTime(), at, '账户字段改变不能刷新已过期的独立行情');
    assert.match(await desk.text('#feed-health'), /VS 报价过期/);
    pass('单独变化的账户净值到达看板，原行情继续保持过期');
    await first.close();
    const wrong = await openMarket(eth, 222222, 88888);
    await neverShows(222222);
    assert.doesNotMatch(await desk.text('#vs-panel'), /88,888/);
    pass('错品种 ETH-PERP 的哨兵报价及账户没有进入 BTC 看板');
    await wrong.close();
    const later = await openMarket(btc, 100053, 10953);
    await waitForQuote(100053);
    await waitForEquity(10953.11);
    pass('采集运行中后打开的 BTC-PERP 标签自动接力，无需刷新或粘贴');
    await later.run("document.querySelector('h1').textContent='ETH-PERP'");
    await mutate(later, 177777, 77777);
    await neverShows(177777);
    assert.doesNotMatch(await desk.text('#vs-panel'), /77,777/);
    await later.run("document.querySelector('h1').textContent='BTC-PERP'");
    await mutate(later, 100059, 10959);
    await waitForQuote(100059);
    pass('BTC 路径显示 ETH 标题时中止采集；标题与路径重新一致后恢复');
    await desk.click('#feed-auto-stop');
    await mutate(later, 100064, 10964);
    await neverShows(100064);
    pass('停止后真实标签仍有更新，新的报价没有进入看板');
    await desk.click('#feed-auto-start');
    await mutate(later, 100072, 10972);
    await waitForQuote(100072);
    await set('#feed-mode', 'frozen');
    await mutate(later, 100088, 10988);
    await neverShows(100088);
    assert.doesNotMatch(await desk.text('#verdict'), /匹配可交易/);
    pass('冻结阻止后续报价生效，交易结论锁定');
    assert.deepEqual(browser.faults, [], '真实页面运行异常');
    console.log(
      JSON.stringify({
        browser: browser.version,
        checks: checks.length,
        fixtureOrigin: site,
        realAccount: false
      })
    );
  } finally {
    await browser.close();
  }
}

await main();
