import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { extensionBrowser } from './extension-browser.js';

// The Chrome harness blocks external hosts and serves this fixture at the
// official origin. The two buttons below only increment in-memory counters.
const address = '0x' + '1'.repeat(40);
const leg = {
  venue: 'hype',
  symbol: 'BTC',
  unit: 'BTC',
  side: 'sell',
  quantity: '0.012',
  address,
  leverage: 20,
  marginMode: 'cross',
  currentQty: 0,
  reduceOnly: false
};
const html = `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}.box{display:inline-block;width:12px;height:12px;background:#ccc}.dropper{position:fixed;top:2px;right:10px}</style>
<div id="root"><nav><a href="/trade">Trade</a><a href="/portfolio">Portfolio</a>
<div id="wallet">0x1111...1111</div></nav><div class="ellipsis">BTC-USDC</div>
<section id="order"><div><button>Cross</button><button id="lev">20x</button>
<div id="tabs" data-testid="tab-selected-limit"><div id="market">Market</div><div>Limit</div><div>Pro</div></div>
<div id="sides"><div id="buy" aria-pressed="true">Buy / Long</div><div id="sell" aria-pressed="false">Sell / Short</div></div>
<div><div>Current Position</div><div id="pos"><div>0.00000 BTC</div></div></div>
<div data-testid="sz-input"><div><div>Size</div><input id="amount"><div><div id="units"><div>USDC</div><svg width="9" height="9"></svg></div></div></div></div>
<div><div class="box"></div><div><div>Reduce Only</div></div></div>
<div><div class="box"></div><div><div>Take Profit / Stop Loss</div></div></div></div>
<div><button id="place" type="button" color="primary">Place Order</button></div></section></div>
<script>
const id=k=>document.getElementById(k); window.proofAddress='${address}';
window.orders=0;window.confirms=0;
id('market').onclick=()=>id('tabs').dataset.testid='tab-selected-market';
for(const k of ['buy','sell'])id(k).onclick=()=>{for(const j of ['buy','sell'])id(j).setAttribute('aria-pressed',String(j===k))};
id('units').onclick=()=>{const menu=document.createElement('div');menu.className='dropper-select-list';
 menu.innerHTML='<div role="listbox"><div role="option">USDC</div><div role="option">BTC</div></div>';
 menu.onclick=e=>{id('units').firstElementChild.textContent=e.target.textContent;menu.remove()};id('root').append(menu)};
id('wallet').onclick=()=>{const old=document.querySelector('.dropper');if(old){document.querySelector('#full')?.remove();old.remove();return;}
 const menu=document.createElement('div');menu.className='dropper';
 menu.innerHTML='<div><div>0x1111...1111</div><div>Disconnect</div></div>';
 menu.firstElementChild.firstElementChild.onmousemove=()=>{const tip=document.createElement('div');tip.id='full';tip.style='position:fixed;pointer-events:none';
 tip.textContent=window.proofAddress;id('root').append(tip)};id('root').append(menu)};
id('place').onclick=()=>{window.orders++;const d=document.createElement('dialog');d.innerHTML='<button>Confirm</button>';d.onclick=()=>window.confirms++;document.body.append(d);d.showModal()};
</script>`;

export async function runHypeTradeBrowser() {
  const b = await extensionBrowser(),
    adapter = await readFile(new URL('../../trade-extension/venue-hype.js', import.meta.url), 'utf8');
  try {
    const tab = await b.tab(() => ({ body: html }));
    const reset = async () => {
      await tab.go('https://app.hyperliquid.xyz/trade/BTC');
      await tab.wait("typeof orders==='number' && !document.querySelector('dialog')");
      await tab.run(adapter);
      await tab.run('window.orderLeg=' + JSON.stringify(leg));
    };
    await reset();
    await tab.run("document.querySelector('#place').textContent='Connect'");
    await assert.rejects(tab.run('tradeVenue.prepare(orderLeg)'), /连接钱包/);
    assert.equal(await tab.run('orders'), 0);
    await tab.run(
      "document.querySelector('#place').textContent='Place Order';window.proofAddress='0x1111'+'2'.repeat(32)+'1111'"
    );
    await assert.rejects(tab.run('tradeVenue.prepare(orderLeg)'), /完整地址/);
    assert.equal(await tab.run("document.querySelector('#amount').value"), '');
    await reset();
    const fp = await tab.run('tradeVenue.prepare(orderLeg)');
    assert.equal(fp, await tab.run('tradeVenue.verify(orderLeg)'));
    await tab.run("document.querySelector('#full').textContent='0x1111'+'2'.repeat(32)+'1111'");
    await assert.rejects(tab.run('tradeVenue.verify(orderLeg)'), /钱包已变化/);
    await tab.run("document.querySelector('#full').textContent=orderLeg.address");
    assert.deepEqual(
      await tab.run(
        "[document.querySelector('#tabs').dataset.testid,document.querySelector('#sell').getAttribute('aria-pressed'),document.querySelector('#units').textContent,document.querySelector('#amount').value,orders]"
      ),
      ['tab-selected-market', 'true', 'BTC', '0.012', 0]
    );
    await tab.run("document.querySelector('#lev').textContent='10x'");
    await assert.rejects(tab.run('tradeVenue.verify(orderLeg)'), /杠杆/);
    await tab.run(
      "document.querySelector('#lev').textContent='20x';document.querySelector('#pos div').textContent='0.00100 BTC'"
    );
    await assert.rejects(tab.run('tradeVenue.verify(orderLeg)'), /持仓/);
    await tab.run(
      "document.querySelector('#pos div').textContent='0.00000 BTC';document.querySelector('#amount').value='1'"
    );
    await assert.rejects(tab.run('tradeVenue.submit(orderLeg)'), /币量/);
    assert.equal(await tab.run('orders'), 0);
    await reset();
    await tab.run('tradeVenue.prepare(orderLeg);');
    await tab.run('tradeVenue.submit(orderLeg)');
    await assert.rejects(tab.run('tradeVenue.submit(orderLeg)'));
    assert.deepEqual(await tab.run('[orders,confirms]'), [1, 0]);
    assert.deepEqual(b.faults, []);
    return 'Hype 官网结构夹具通过。核对完整主钱包、市价方向、币量、原仓与杠杆；模拟 Place Order 一次，确认按钮零次。';
  } finally {
    await b.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(await runHypeTradeBrowser());
