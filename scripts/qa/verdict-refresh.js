import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { openTestBrowser } from './chrome.js';

// Only the bridge's market/account snapshots are synthetic. Its normal polling, quote
// validation, age timer, worker calculations and DOM renderer all run in Chrome.
function installTestSource() {
  const feed = (window.__testFeed = {
    sequence: 0,
    stamp: 0,
    paused: false,
    workerDelay: 140,
    accounts: []
  });
  const original = window.fetch.bind(window);
  window.fetch = (resource, init) => {
    const url = new URL(resource instanceof Request ? resource.url : resource, location.href);
    if (url.origin !== location.origin || url.pathname !== '/api/bridge/latest')
      return original(resource, init);
    if (feed.paused) return Promise.resolve(Response.json(null));
    const mark = 100000 + ++feed.sequence * 4;
    feed.stamp = Date.now();
    const asOf = new Date(feed.stamp).toISOString();
    const amount = 10500 + feed.sequence;
    const account = {
      balance: amount,
      equity: amount,
      free: amount,
      used: 0,
      stage: 'challenge',
      positions: [],
      asOf
    };
    return Promise.resolve(
      Response.json({
        assetId: 'btc',
        sequence: feed.sequence,
        receivedAt: asOf,
        snapshot: { symbol: 'BTC', bid: mark - 1, ask: mark + 1, mark, open: true, asOf, account }
      })
    );
  };
  window.Worker = class extends Worker {
    postMessage(...args) {
      const { asset, account } = args[0];
      if (asset?.mixedSource)
        feed.accounts.push([account.vsBalance, account.vsEquity, account.vsFree, account.hypeCash]);
      setTimeout(() => super.postMessage(...args), feed.workerDelay);
    }
  };
}

function observeDesk(allowHistorical = false) {
  const byId = (id) => document.getElementById(id);
  const blocks = ['axis', 'checks', 'scenario-result', 'comparison', 'candidates', 'assumptions'];
  const marks = new Set(),
    triggers = new Set(),
    balances = new Set();
  let frameId,
    frames = 0,
    mutations = 0,
    blank = 0,
    pending = 0,
    bad = 0,
    waitingForLatest = 0,
    staleButtonEnabled = 0,
    historicalSamples = 0;
  let lastUpdate = 0,
    firstFault;
  const begin = performance.now(),
    firstQuote = window.__testFeed.sequence;
  const surface = getComputedStyle(byId('verdict')).backgroundColor;
  const badge = getComputedStyle(byId('verdict').querySelector('h2')).backgroundColor;
  function sample() {
    const card = byId('verdict');
    const h2 = card.querySelector('h2');
    const heading = h2?.textContent.trim() ?? '';
    const historical =
      allowHistorical &&
      heading === '等待新结果' &&
      /快照.*过期/.test(card.textContent) &&
      byId('pin').disabled;
    if (historical) historicalSamples++;
    const empty = blocks.filter((id) => !byId(id).textContent.trim());
    if (
      !heading ||
      !h2.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ||
      !card.querySelector('p')?.textContent.trim() ||
      empty.length
    )
      blank++;
    if (/正在验算/.test(heading)) pending++;
    if (
      (heading !== '匹配可交易' && !historical) ||
      card.matches('.bad, [data-state="bad"]') ||
      getComputedStyle(card).backgroundColor !== surface ||
      (!historical && getComputedStyle(h2).backgroundColor !== badge)
    )
      bad++;
    if (!firstFault && (blank || pending || bad))
      firstFault = { heading, empty, className: card.className };
    const rows = byId('axis').querySelectorAll('tbody tr');
    const source = byId('feed-values').textContent;
    const vs = /VS　BTC　买一 [\d,.]+　卖一 [\d,.]+　标记 ([\d,.]+)/.exec(source);
    const equity = /净值 ([\d,.]+)/.exec(source);
    if (equity) balances.add(Number(equity[1].replaceAll(',', '')));
    const latest = vs ? Number(vs[1].replaceAll(',', '')) : 0;
    for (const row of rows) {
      const value = Number(row.cells[1]?.textContent.trim().replaceAll(',', ''));
      if (!(value > 0)) continue;
      if (row.cells[0].textContent === '当前标记' && latest > value) {
        waitingForLatest++;
        if (!byId('pin').disabled) staleButtonEnabled++;
      }
      if (row.cells[0].textContent === '当前标记' && !marks.has(value)) {
        marks.add(value);
        lastUpdate = performance.now() - begin;
      }
      if (row.cells[0].textContent.includes('考核通过')) triggers.add(value);
    }
  }
  function frame() {
    frames++;
    sample();
    frameId = requestAnimationFrame(frame);
  }
  const observer = new MutationObserver(() => {
    mutations++;
    sample();
  });
  for (const id of ['verdict', ...blocks]) {
    observer.observe(byId(id), { attributes: true, childList: true, characterData: true, subtree: true });
  }
  frame();
  window.__finishVerdictObservation = () => {
    cancelAnimationFrame(frameId);
    observer.disconnect();
    return {
      ms: Math.round(performance.now() - begin),
      frames,
      mutations,
      surface,
      badge,
      blank,
      pending,
      bad,
      firstFault,
      quotes: window.__testFeed.sequence - firstQuote,
      externalBalances: [...balances],
      waitingForLatest,
      staleButtonEnabled,
      historicalSamples,
      marks: [...marks],
      triggers: [...triggers],
      lastUpdateMs: Math.round(lastUpdate)
    };
  };
}

export async function runVerdictRefresh() {
  const b = await openTestBrowser();
  const title = "document.querySelector('#verdict h2')?.textContent";
  const mark = "Number(document.querySelector('#axis tbody tr')?.cells[1]?.textContent.replaceAll(',',''))";
  try {
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + installTestSource + ')()' });
    await b.send('Page.reload', { ignoreCache: true });
    await b.wait("window.__testFeed && document.querySelector('#feed-switch')?.value==='offline'");
    await b.set('#feed-fx-mode', 'manual');
    await b.set('#feed-age', 4);
    await b.click('#feed-map-verify');
    await b.click('#feed-save-map');
    await b.set('#feed-origin', 'https://fixture.example', 'input');
    await b.click('#feed-pair');
    await b.wait("document.querySelector('#feed-bridge-health').textContent.includes('已接收')");
    await b.wait(title + "==='匹配可交易' && " + mark + ' > 100000');
    await b.run('(' + observeDesk + ')()');
    await delay(3650);
    const external = await b.run('window.__finishVerdictObservation()');
    const externalJobs = await b.run('window.__testFeed.accounts');
    assert.ok(external.quotes >= 4 && external.marks.length >= 4 && external.externalBalances.length >= 4);
    assert.ok(
      !external.blank && !external.pending && !external.bad && !external.staleButtonEnabled,
      '采用外部账户时，小幅变动的有效余额引起闪烁或旧结果可操作：' + JSON.stringify(external)
    );
    assert.ok(new Set(externalJobs.map(([balance]) => balance)).size >= 4);
    assert.ok(
      externalJobs.every(
        ([balance, equity, free]) => balance > 10500 && balance === equity && equity === free
      )
    );
    await b.click('nav a[href="#sim"]');
    await b.click('#follow-simulation');
    await b.wait("document.querySelector('#notice').textContent.includes('已跟随本地模拟账本')");
    await b.click('nav a[href="#desk"]');
    await b.set('#feed-age', 2);
    await b.wait(
      title + "==='匹配可交易' && document.querySelector('#vs-panel .big').textContent.includes('10,000')"
    );
    await b.run('window.__testFeed.accounts.length=0');
    // Quotes arrive every 700 ms. A one-second job can finish while another
    // quote is waiting, and an earlier display can expire during that job.
    await b.run('window.__testFeed.workerDelay=1000');
    await b.run('(' + observeDesk + ')(true)');
    await delay(8150);
    const trace = await b.run('window.__finishVerdictObservation()');
    assert.ok(
      trace.waitingForLatest > 50 && trace.staleButtonEnabled === 0,
      '计算追赶最新报价时旧结果不能操作：' + JSON.stringify(trace)
    );
    assert.ok(trace.externalBalances.length >= 7 && trace.externalBalances.every((n) => n > 10500));
    const accounts = await b.run('window.__testFeed.accounts');
    assert.ok(accounts.length >= 5, '真实 worker 应持续收到已选本地账本的输入');
    for (const account of accounts) assert.deepEqual(account, [10000, 10000, 10000, 409]);
    assert.match(await b.text('#vs-panel .big'), /10,000/);
    await b.run('window.__testFeed.workerDelay=140');
    await b.wait(title + "==='匹配可交易' && !document.querySelector('#pin').disabled");

    // Force one computation out to beyond the displayed quote's lifetime while
    // the bridge continues sending fresh quotes. The expired result is read-only.
    await b.run('window.__testFeed.workerDelay=2700');
    await b.wait(title + "==='等待新结果'", 5000);
    const historicalMark = await b.run(mark);
    assert.ok(historicalMark > 100000);
    assert.match(await b.text('#verdict'), /上次验算.*快照.*过期/);
    assert.doesNotMatch(await b.text('#feed-health'), /过期/);
    assert.equal(await b.run("document.querySelector('#pin').disabled"), true);
    const initialSeq = await b.run('window.__testFeed.sequence');
    await b.wait('window.__testFeed.sequence >= ' + (initialSeq + 2));
    assert.equal(await b.run(title), '等待新结果');
    assert.equal(await b.run(mark), historicalMark);
    assert.ok(
      await b.run(
        "['checks','axis','scenario-result','candidates','comparison','assumptions'].every(id=>document.getElementById(id).textContent.trim())"
      )
    );
    await b.click('nav a[href="#sim"]');
    const audit = await b.text('[data-v="audit"]');
    await b.click('[data-op="target"]');
    assert.match(await b.text('[data-v="message"]'), /报价或参数已更新|等待重新验算/);
    assert.equal(await b.text('[data-v="audit"]'), audit);
    await b.click('nav a[href="#desk"]');
    await b.run('window.__testFeed.workerDelay=140');
    await b.wait(
      title +
        "==='匹配可交易' && !document.querySelector('#pin').disabled && " +
        mark +
        ' > ' +
        historicalMark,
      6500
    );
    const lastStamp = await b.run('(window.__testFeed.paused=true, window.__testFeed.stamp)');
    await b.wait(
      title + "==='无法验证' && document.querySelector('#verdict').textContent.includes('报价过期')",
      5000
    );
    const stale = await b.run(
      "({at:Date.now(), text:document.querySelector('#verdict').textContent, locked:document.querySelector('#pin').disabled, surface:getComputedStyle(document.querySelector('#verdict')).backgroundColor, badge:getComputedStyle(document.querySelector('#verdict h2')).backgroundColor})"
    );
    assert.equal(stale.surface, trace.surface, '过期时横幅底色应保持稳定');
    assert.notEqual(stale.badge, trace.badge, '过期状态标签应突出显示');
    const late = stale.at - lastStamp - 2000;
    assert.ok(
      late >= 0 && late < 650 && stale.locked,
      '报价超龄后应在下一轮页面检查即锁定：' + JSON.stringify({ late, stale })
    );
    await delay(400);
    assert.equal(await b.run(title), '无法验证', '过期报价等待期间不应恢复旧结论');
    const nextMark = await b.run(
      '(window.__testFeed.paused=false, 100000 + (window.__testFeed.sequence + 1) * 4)'
    );
    await b.wait(title + "==='匹配可交易' && " + mark + ' >= ' + nextMark, 5000);
    assert.ok(
      trace.ms >= 8000 && trace.frames >= 40 && trace.mutations >= 4 && trace.quotes >= 7,
      JSON.stringify(trace)
    );
    assert.ok(
      trace.marks.length >= 4 && trace.triggers.length >= 3 && trace.lastUpdateMs >= 6000,
      '没有持续呈现新行情的实际验算结果：' + JSON.stringify(trace)
    );
    assert.ok(!trace.blank && !trace.pending && !trace.bad, '正常报价更新时闪烁：' + JSON.stringify(trace));
    assert.deepEqual(b.faults, []);
    return {
      ...trace,
      external: {
        quotes: external.quotes,
        frames: external.frames,
        balances: external.externalBalances,
        blank: external.blank
      },
      workerAccount: accounts.at(-1),
      historicalMark,
      staleDelayMs: late,
      stale: stale.text,
      recoveredMark: await b.run(mark)
    };
  } finally {
    await b.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await runVerdictRefresh(), null, 2));
