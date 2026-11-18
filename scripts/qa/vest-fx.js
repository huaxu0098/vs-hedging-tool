import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { openTestBrowser } from './chrome.js';

const coins = ['USDC', 'USDT'];
const missingRates =
  /(?:USDC|USDT)\s*(?:自动 USD )?汇率(?:缺少|缺失|过期)|Vest 报价币为 USDC，当前 VS 合约设为 USD|请核对报价币和汇率后再匹配/;

// Capture the public rate responses the page actually consumes. The original
// request/response are passed through verbatim; no exchange prices are injected.
function observeRates() {
  const original = window.fetch.bind(window);
  const observed = (window.__vestFxAcceptance = { replies: [], failed: 0 });
  window.fetch = async (...args) => {
    const path = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href).pathname;
    if (path !== '/api/usd-rates') return original(...args);
    try {
      const res = await original(...args);
      if (res.ok) {
        res
          .clone()
          .json()
          .then((body) => {
            observed.replies.push({ time: Date.now(), body });
            if (observed.replies.length > 30) observed.replies.shift();
          })
          .catch(() => {});
      } else observed.failed++;
      return res;
    } catch (error) {
      observed.failed++;
      throw error;
    }
  };
}

function visibleState() {
  const text = (sel) => document.querySelector(sel)?.textContent.trim() ?? '';
  const maxPosition = (id) =>
    [...document.querySelectorAll('#' + id + '-panel .pair')]
      .find((pair) => pair.querySelector('dt')?.textContent === '最大总仓位')
      ?.querySelector('dd')?.textContent;
  return {
    fxMode: document.querySelector('#feed-fx-mode')?.value,
    confirmed: document.querySelector('#feed-map-verify')?.checked,
    spec: text('#feed-auto-spec'),
    health: text('#feed-health'),
    fx: text('#feed-fx-status'),
    rates: Object.fromEntries(
      ['USDC', 'USDT'].map((coin) => [coin, text('#feed-fx-status [data-currency="' + coin + '"]')])
    ),
    verdict: text('#verdict h2'),
    reason: text('#verdict'),
    checks: text('#checks'),
    unit: text('#axis-unit'),
    axis: [...document.querySelectorAll('#axis tbody tr')].map((row) =>
      [...row.cells].map((cell) => cell.textContent)
    ),
    capacities: [maxPosition('vs'), maxPosition('hype')],
    feed: text('#feed-values')
  };
}

function matchedRates(view, replies) {
  if (view.fxMode !== 'auto' || !view.spec.includes('USDC') || missingRates.test(view.health)) return null;
  const out = {};
  for (const coin of coins) {
    const line = view.rates[coin];
    if (/已过期|等待/.test(line)) return null;
    const found = [...replies]
      .reverse()
      .map((r) => r.body.rates?.[coin])
      .find((row) => {
        if (
          row?.currency !== coin ||
          row.quote !== 'USD' ||
          !line.includes(row.asOf) ||
          !line.includes(row.source)
        )
          return false;
        return Array.from(line.matchAll(/\b\d+(?:\.\d+)?\b/g), (m) => Number(m[0])).some(
          (v) => Math.abs(v - row.rate) <= 5.1e-8
        );
      });
    if (
      !found ||
      !Number.isFinite(Date.parse(found.asOf)) ||
      ![found.bid, found.ask, found.rate].every((n) => Number.isFinite(n) && n > 0) ||
      found.bid > found.rate ||
      found.rate > found.ask
    )
      return null;
    out[coin] = found;
  }
  return out;
}

export async function runVestFxAcceptance() {
  const b = await openTestBrowser();
  const view = () => b.run('(' + visibleState.toString() + ')()');
  async function until(label, check, ms = 35000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const v = await view(),
        result = await check(v);
      if (result) return result;
      await delay(160);
    }
    throw Error(
      label +
        '。最后页面状态 ' +
        JSON.stringify(await view()) +
        '。最近公开回复 ' +
        JSON.stringify(await b.run('window.__vestFxAcceptance.replies.at(-1)?.body ?? null'))
    );
  }
  const liveRates = async (v) => matchedRates(v, await b.run('window.__vestFxAcceptance.replies'));
  let intercepting = false;
  try {
    await b.run('(' + observeRates.toString() + ')()');
    await b.click('nav a[href="#feeds"]');
    await b.set('#feed-auto-url', 'https://next.vestmarkets.com/trade/BTC-PERP', 'input');
    assert.equal(await b.run("document.querySelector('#feed-auto-public').checked"), true);
    await b.click('#feed-auto-start');
    const { initial, guarded } = await until('没有同时取得并显示真实 USDC、USDT 美元报价', async (v) => {
      const rates = await liveRates(v);
      return rates &&
        /VS\s+BTC-PERP\s+买一\s+[\d,]/.test(v.feed) &&
        /Hype\s+BTC\s+买一\s+[\d,]/.test(v.feed) &&
        /尚未确认.*映射/.test(v.health)
        ? { initial: rates, guarded: v }
        : null;
    });
    assert.equal(guarded.confirmed, false);
    assert.match(guarded.health, /尚未确认.*映射/);
    assert.doesNotMatch(guarded.verdict, /匹配可交易/);
    assert.doesNotMatch(guarded.spec, /当前 VS 合约设为 USD[。\s]/);

    await b.click('#feed-map-verify');
    await b.click('#feed-save-map');
    const calculated = await until('已确认映射但尚未产生可核验的双平台仓位与触线价格', (v) => {
      const available = v.capacities.every(
        (value) =>
          /^([\d,.]+) U\s*\/\s*([\d,.]+) BTC$/.test(value ?? '') &&
          (value.match(/[\d,.]+/g) ?? []).every((x) => Number(x.replaceAll(',', '')) > 0)
      );
      const numericTriggers = v.axis.filter(
        (row) =>
          /固定失败|考核通过/.test(row[0]) && row.slice(1, 3).every((x) => Number(x.replaceAll(',', '')) > 0)
      ).length;
      return v.confirmed &&
        !/尚未确认.*映射/.test(v.health) &&
        !missingRates.test(v.health) &&
        available &&
        numericTriggers === 2 &&
        /美元/.test(v.unit) &&
        ['匹配可交易', '仅单边满足', '不匹配'].includes(v.verdict)
        ? v
        : null;
    });
    const chosen = /VS ([\d,.]+) U（([\d,.]+) BTC），Hype ([\d,.]+) U（([\d,.]+) BTC）/.exec(
      calculated.reason
    );
    assert.ok(
      chosen && chosen.slice(1).every((x) => Number(x.replaceAll(',', '')) > 0),
      '候选美元额与两侧整步币数缺失：' + calculated.reason
    );
    const oldMark = calculated.axis.find((row) => row[0] === '当前标记');
    const repriced = await until('源报价变化后价格轴未重新计值', (v) => {
      const mark = v.axis.find((row) => row[0] === '当前标记');
      return mark && v.axis.length > 1 && mark[1] !== oldMark[1] && Number(mark[1].replaceAll(',', '')) > 0
        ? mark
        : null;
    });

    await b.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/usd-rates*', requestStage: 'Request' }] });
    intercepting = true;
    const stale = await until('汇率请求中断并自然过期后未出现风控提示', async (v) => {
      const failed = await b.run('window.__vestFxAcceptance.failed');
      return failed > 0 &&
        /汇率/.test(v.health) &&
        /过期|失效|缺少|无法|不可用/.test(v.health) &&
        v.verdict !== '匹配可交易'
        ? { health: v.health, status: v.fx, failed }
        : null;
    });
    const releasedAt = Date.now();
    await b.send('Fetch.disable');
    intercepting = false;
    const recovered = await until('恢复公开汇率后未重新计算', async (v) => {
      if (/过期|缺少|不可用/.test(v.health) || v.axis.length < 2) return null;
      const replies = await b.run('window.__vestFxAcceptance.replies');
      return matchedRates(
        v,
        replies.filter((r) => r.time > releasedAt)
      );
    });
    // Alter only this disposable profile's simulated Hype cash, after the live
    // recovery check. Good FX data does not imply a funded trade is possible.
    await b.click('#account-edit');
    await b.set('[name="source"]', 'manual');
    for (const field of ['hypeCash', 'hypeEquity', 'hypeFree'])
      await b.set('[name="' + field + '"]', 1, 'input');
    await b.run("document.querySelector('dialog.settings-dialog form').requestSubmit()");
    await b.wait("!document.querySelector('dialog.settings-dialog')");
    if (await b.run("document.querySelector('#feed-auto-stop').disabled")) await b.click('#feed-auto-start');
    if (!(await b.run("document.querySelector('#feed-map-verify').checked"))) {
      await b.click('#feed-map-verify');
      await b.click('#feed-save-map');
    }
    const insufficient = await until('未验证低余额下的合法无解', async (v) => {
      return v.confirmed &&
        v.verdict === '不匹配' &&
        /保证金|可用资金|最低现金/.test(v.reason) &&
        !missingRates.test(v.health) &&
        (await liveRates(v))
        ? v.reason
        : null;
    });
    assert.deepEqual(b.faults, []);
    return {
      initial,
      mappingGuard: guarded.health,
      capacities: calculated.capacities,
      unit: calculated.unit,
      verdict: calculated.reason,
      axis: calculated.axis,
      repriced,
      stale,
      recovered,
      insufficient
    };
  } finally {
    try {
      if (intercepting) await b.send('Fetch.disable');
    } finally {
      await b.close();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runVestFxAcceptance(), null, 2));
}
