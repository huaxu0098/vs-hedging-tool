import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { openTestBrowser } from '../scripts/qa/chrome.js';

const code = await readFile(new URL('../extension/extract.js', import.meta.url), 'utf8');
const market = 'https://next.vestmarkets.com/trade/BTC-PERP';
const area = (title, html) =>
  '<section aria-label="' + title + '"><h2>' + title + '</h2>' + html + '</section>';
const field = (key, value) => '<dt>' + key + '</dt><dd>' + value + '</dd>';
const table = (rows) =>
  '<table><thead><tr>' +
  ['Symbol', 'Side', 'Size', 'Open Price', 'Unrealized PnL', 'Margin Used']
    .map((h) => '<th>' + h + '</th>')
    .join('') +
  '</tr></thead><tbody>' +
  rows +
  '</tbody></table>';
const row = (cols) => '<tr>' + cols.map((c) => '<td>' + c + '</td>').join('') + '</tr>';

test('真实 Chrome 的 Vest 可见 DOM 读数与保守拒识', async (t) => {
  const browser = await openTestBrowser();
  try {
    await browser.send('Page.navigate', { url: 'about:blank' });
    await browser.wait("location.href==='about:blank' && !!document.body");
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false
    });
    await browser.run(code);
    async function read(html, url = market) {
      await browser.run('document.body.innerHTML=' + JSON.stringify(html));
      return browser.run('readVisibleVest(document,new URL(' + JSON.stringify(url) + '))');
    }
    await t.test('双语账户与精确交易对，不将不同价格或表单估值混入盘口', async () => {
      const html =
        '<main><h1>BTC-PERP</h1>' +
        area(
          'Market overview',
          '<dl>' +
            field('Mark Price', '$63,010') +
            field('Best Bid', '63,005 USDT') +
            field('Best Ask', '63,012') +
            field('Market status', 'Open') +
            '</dl>'
        ) +
        area(
          'Account overview',
          '<dl>' +
            field('账户余额', '10,000.25') +
            field('Equity', '$10,012.25') +
            field('Used Margin', '12.00') +
            field('Free Margin', '10,000.25') +
            field('Stage', 'Challenge') +
            '</dl>'
        ) +
        area('Positions', table(row(['BTC-PERP', 'Short', '0.1 BTC', '63,100', '+12.00', '12.00']))) +
        '<form><dl>' +
        field('Mark Price', '5') +
        field('Best Bid', '1') +
        '</dl><input value="99"></form></main>';
      assert.deepEqual(await read(html), {
        symbol: 'BTC-PERP',
        quote: { bid: 63005, ask: 63012, mark: 63010, open: true },
        account: {
          balance: 10000.25,
          equity: 10012.25,
          used: 12,
          free: 10000.25,
          stage: 'challenge',
          positions: [{ symbol: 'BTC-PERP', qty: -0.1, entry: 63100, upnl: 12, marginUsed: 12 }]
        }
      });
    });
    await t.test('Vest 原生盘口首档、账户净值与完整持仓，可见中点不能被当成标记价', async () => {
      const nativeBook =
        '<button type="button" class="order-book-row"><span data-testid="book-bids-price-0">$63,000</span></button>' +
        '<button type="button" class="order-book-row"><span data-testid="book-asks-price-0">$63,004</span></button>' +
        '<span data-testid="book-mark">$63,002</span><span data-testid="market-midPrice">$63,002</span>' +
        '<span data-testid="book-bids-price-1">$62,998</span><span data-testid="account-value">$10,006.00</span>' +
        '<div role="dialog"><span data-testid="account-value">$555,555</span></div><input data-testid="price-input" value="89999">';
      const nativeTable =
        '<button role="tab" aria-selected="true" aria-controls="open" data-testid="account-tab-active-positions">Positions (1)</button>' +
        '<section id="open" role="tabpanel"><table><tbody><tr>' +
        '<td><a href="/trade/BTC-PERP"><p data-testid="position-symbol-a">BTC</p><p data-testid="position-side-a">Short 10x</p></a></td>' +
        '<td data-testid="td-value"><p><span data-testid="position-value-a">$630.00</span></p><p>0.01 BTC</p></td>' +
        '<td><span data-testid="position-entry-a">$63,010</span></td><td><p data-testid="position-pnl-a">+$6.00</p></td>' +
        '</tr></tbody></table></section>';
      let result = await read(nativeBook + nativeTable);
      assert.deepEqual(result.quote, { bid: 63000, ask: 63004 });
      assert.deepEqual(result.account, {
        equity: 10006,
        positions: [{ symbol: 'BTC-PERP', qty: -0.01, entry: 63010, upnl: 6 }]
      });
      result = await read(nativeBook + nativeTable.replace('Positions (1)', 'Positions (3)'));
      assert.deepEqual(result.account, { equity: 10006 });
    });
    await t.test('休市、原始时刻、看不到或无法确定的盘口和空仓', async () => {
      const iso = '2026-11-18T16:30:55.700Z';
      const html =
        area(
          'Market overview',
          '<dl>' +
            field('Mark Price', '40') +
            field('Mark Price', '42') +
            field('Best Bid', '105') +
            field('Best Ask', '100') +
            field('Market status', 'Closed') +
            field('Quote time', iso) +
            '</dl>'
        ) +
        area('Account overview', '<dl style="opacity:0">' + field('Balance', '12345') + '</dl>') +
        area('Positions', table(''));
      assert.deepEqual(await read(html), { symbol: 'BTC-PERP', quote: { open: false, asOf: iso } });
      const empty = await read(area('Positions', table('<tr><td colspan="6">No open positions</td></tr>')));
      assert.deepEqual(empty.account?.positions, []);
      const hidden = await read(
        '<section aria-label="Market overview" hidden><dl>' + field('Mark', '1') + '</dl></section>'
      );
      assert.equal(hidden.quote, undefined);
      assert.equal(hidden.account, undefined);
    });
    await t.test('网址白名单和 SPA 切换期间拒绝其他交易对', async () => {
      const html =
        '<main><h1>ETH-PERP</h1>' +
        area('Market overview', '<dl>' + field('Mark Price', '3000') + '</dl>') +
        '</main>';
      assert.equal((await read(html)).quote, undefined);
      assert.equal((await read(html, market.replace('BTC', 'ETH'))).quote.mark, 3000);
      assert.equal((await read(html, 'https://other.example/trade/ETH-PERP')).symbol, null);
      assert.equal((await read(html, market + '/orders')).symbol, null);
    });
  } finally {
    await browser.close();
  }
});
