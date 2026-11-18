import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { openTestBrowser } from './chrome.js';

const fixture = fileURLToPath(new URL('../../fixtures/multi-asset-candles.csv', import.meta.url));
const ledger = "JSON.parse(localStorage.getItem('vs-hype:simulation:v2'))";

async function selectFile(browser, selector, filename) {
  const { root } = await browser.send('DOM.getDocument');
  const { nodeId } = await browser.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  assert.ok(nodeId, '找不到文件选择器 ' + selector);
  await browser.send('DOM.setFileInputFiles', { nodeId, files: [filename] });
}

async function downloaded(filename) {
  // Chrome renames the partial download to its final name once it is complete.
  for (let i = 0; i < 80; i++) {
    try {
      return await readFile(filename, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(75);
    }
  }
  throw Error('Chrome 未完成下载 ' + path.basename(filename));
}

export async function runLedgerInteractions() {
  const browser = await openTestBrowser();
  let directory;
  const checks = [];
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'vs-hype-qa-downloads-'));
    const { click, run, send, set, text, wait } = browser;
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
    await click('nav a[href="#sim"]');
    await selectFile(browser, '[data-v="candles"]', fixture);
    await wait("document.querySelector('[data-v=replay]').textContent.includes('9 根')");
    assert.equal(await run("document.querySelectorAll('[data-candle]').length"), 0);

    const series = new Map();
    const rows = (await readFile(fixture, 'utf8')).trim().split(/\r?\n/).slice(1);
    const units = { BTC: '美元/币', XAU: '美元/盎司', US100: '点' };
    for (const [index, line] of rows.entries()) {
      const [, ticker, ...raw] = line.split(',');
      const id = ticker.toLowerCase();
      const count = (series.get(id) ?? 0) + 1;
      series.set(id, count);
      await click('[data-op="step"]');
      await wait("document.querySelector('[data-v=progress]').value===" + (index + 1));
      const candles = await run(
        "Array.from(document.querySelectorAll('[data-candle]'), e=>e.dataset.candle)"
      );
      assert.deepEqual(candles, Array(count).fill(id));
      const shown = await text('.sim-candle-meta');
      assert.ok(shown.includes(ticker + ' · ' + units[ticker]));
      for (const [i, label] of ['开', '高', '低', '收'].entries()) {
        assert.ok(shown.includes(label + ' ' + Number(raw[i]).toLocaleString('zh-CN')), shown);
      }
    }
    await set('[data-v="demo"]', 'ambiguous');
    await click('[data-op="load-demo"]');
    assert.equal(await run("document.querySelector('[data-v=progress]').value"), 0);
    assert.equal(await run("document.querySelectorAll('[data-candle]').length"), 0);
    await click('[data-op="play"]');
    await wait("document.querySelector('[data-v=replay]').textContent.includes('触线顺序不确定')");
    assert.match(await text('[data-v="replay"]'), /最坏情景/);
    assert.equal(await run("document.querySelectorAll('[data-candle]').length"), 2);
    checks.push('K 线 CSV 实际导入、分品种蜡烛与步进、同柱冲突停止');

    assert.equal(await run(ledger), null, '回放不应写入本地成交账本');
    await click('[data-op="target"]');
    await wait(ledger + '?.positions.length===2');
    const opened = await run(ledger);
    await click('[data-op="csv"]');
    await click('[data-op="json"]');
    const backup = path.join(directory, 'vs-hype-ledger.json');
    assert.deepEqual(JSON.parse(await downloaded(backup)), opened);
    const csv = await downloaded(path.join(directory, 'vs-hype-ledger.csv'));
    assert.match(csv, /qty,price,gross,fee/);
    assert.equal(csv.trim().split(/\r?\n/).length, opened.history.length + 1);
    assert.equal([...csv.matchAll(/"开仓"/g)].length, 2);

    await click('[data-op="close"]');
    await wait(ledger + '?.positions.length===0');
    assert.ok((await run(ledger)).fees.hype > opened.fees.hype);
    await selectFile(browser, '[data-v="restore"]', backup);
    await wait(ledger + '?.positions.length===2');
    const restored = await run(ledger);
    assert.ok(restored.revision > opened.revision);
    assert.deepEqual({ ...restored, revision: opened.revision }, opened);
    assert.deepEqual(browser.faults, []);
    checks.push('模拟开平仓、原生 CSV/JSON 下载、从导出文件恢复持仓与流水');
    return checks;
  } finally {
    try {
      await browser.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
