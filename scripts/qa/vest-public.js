import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { openTestBrowser } from './chrome.js';

// Read only the rendered VS rows. Hype updates and the elapsed-age label may
// continue changing independently while the Vest quote is stopped or frozen.
function displayedQuote(values) {
  const lines = values.split('\n');
  const index = lines.findIndex((line) => /^VS\s/.test(line));
  if (index < 0 || lines[index].includes('尚无已确认数据')) return null;
  const row = /^VS\s+BTC-PERP\s+买一\s+([\d.,]+)\s+卖一\s+([\d.,]+)\s+标记\s+([\d.,]+)/.exec(lines[index]);
  const timestamp = /^源报价时间\s+(\S+)/.exec(lines[index + 1] ?? '')?.[1];
  if (!row || !Number.isFinite(Date.parse(timestamp))) return null;
  const [bid, ask, mark] = row.slice(1).map((v) => Number(v.replaceAll(',', '')));
  assert.ok(bid > 0 && ask >= bid && mark > 0, 'Vest 显示的盘口或标记价无效');
  return { symbol: 'BTC-PERP', bid, ask, mark, asOf: timestamp };
}

export async function runVestPublicAcceptance() {
  const browser = await openTestBrowser();
  const read = async () => displayedQuote(await browser.text('#feed-values'));
  async function next(previous) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const q = await read();
      if (q && (!previous || Date.parse(q.asOf) > Date.parse(previous.asOf))) return q;
      await delay(150);
    }
    throw Error('未收到真实 Vest 后续源时间。' + (await browser.text('#feed-auto-status')));
  }
  async function assertHeld(expected) {
    // Span multiple 850-ms flush periods and check throughout the interval.
    for (let i = 0; i < 16; i++) {
      await delay(200);
      assert.deepEqual(await read(), expected);
    }
  }
  try {
    await browser.click('nav a[href="#feeds"]');
    await browser.set('#feed-auto-url', 'https://next.vestmarkets.com/trade/BTC-PERP', 'input');
    assert.equal(await browser.run("document.querySelector('#feed-auto-public').checked"), true);
    await browser.click('#feed-auto-start');
    const first = await next();
    const second = await next(first);
    assert.equal(await browser.run("document.querySelector('#feed-mode').value"), 'live');
    assert.match(await browser.text('#feed-auto-status'), /BTC-PERP/);
    await browser.click('#feed-auto-stop');
    await browser.wait("document.querySelector('#feed-auto-stop').disabled");
    assert.match(await browser.text('#feed-values'), /VS\s+尚无已确认数据/);
    await assertHeld(null);

    await browser.click('#feed-auto-start');
    await next(second);
    await browser.set('#feed-mode', 'frozen');
    await browser.wait("document.querySelector('#feed-auto-stop').disabled");
    const frozen = await read();
    assert.ok(frozen && Date.parse(frozen.asOf) > Date.parse(second.asOf));
    await assertHeld(frozen);
    assert.match(await browser.text('#feed-auto-status'), /冻结/);
    await browser.send('Page.navigate', { url: browser.url + '/?vest=BTC-PERP#feeds' });
    await browser.wait(
      "document.querySelector('#feed-auto-stop')?.disabled===false && location.hash==='#feeds' && !location.search"
    );
    const fromLink = await next(frozen);
    await browser.wait("document.querySelector('#feed-auto-spec').textContent.includes('USDC')");
    await browser.send('Page.reload');
    await browser.wait("document.querySelector('#feed-auto-stop')?.disabled===false");
    const afterReload = await next(fromLink);
    assert.deepEqual(browser.faults, []);
    return { first, second, frozen, fromLink, afterReload };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runVestPublicAcceptance(), null, 2));
}
