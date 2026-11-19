import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dec } from '../../src/hedge/math.js';
import { openTestBrowser } from './chrome.js';

const browser = await openTestBrowser({ current: true });
const { send, run, wait, set } = browser;
const completed =
  "!document.getElementById('scan-results').hidden && !document.getElementById('scan-results').inert && document.getElementById('scan-desk').dataset.state==='ready'";
const evidence = [];
async function capture(asset) {
  await wait(
    completed + " && document.getElementById('scan-hl-unit').textContent.endsWith('/" + asset + "')",
    65000
  );
  const frame = await run(`(()=>{const e=id=>document.getElementById(id),box=e('trace-inputs').parentElement;
    box.open=true;box.ontoggle();return {trace:e('trace-id').textContent, clock:e('scan-clock').textContent,
    basis:e('scan-basis').textContent, metadata:e('fx-source').textContent, position:e('scan-position').textContent,
    failure:e('scan-fail-cash').textContent,success:e('scan-pass-cash').textContent,profit:e('scan-profit').textContent,
    status:e('scan-status').textContent,source:e('scan-source').textContent, input:JSON.parse(e('trace-inputs').textContent)}})()`);
  const { market: m, rates } = frame.input;
  assert.equal(m.asset, asset);
  assert.equal(m.spec.contract.quoteAsset, 'USDC');
  assert.equal(m.hl.contract.quoteAsset, 'USDT');
  assert.equal(m.hl.contract.collateralEvidence.name, 'USDC');
  const mid = (q) => dec(String(q.bid)).plus(String(q.ask)).div(2);
  const fx = mid(rates.USDT).div(mid(rates.USDC));
  const spread = dec(m.hl.mark).times(fx).minus(String(m.pf.mark));
  assert.ok(frame.basis.startsWith(spread.toFixed(3) + ' USDC'), frame.basis);
  const entry = dec(m.hl.levels[0][0][0])
    .times(String(rates.USDT.bid))
    .div(String(rates.USDC.ask))
    .minus(m.pf.levels[1][0][0]);
  const exit = dec(m.hl.levels[1][0][0])
    .times(String(rates.USDT.ask))
    .div(String(rates.USDC.bid))
    .minus(m.pf.levels[0][0][0]);
  assert.ok(frame.metadata.includes(entry.toFixed(5)) && frame.metadata.includes(exit.toFixed(5)));
  assert.ok(frame.status.includes(frame.trace.split(' / ')[1]));
  assert.match(frame.status, /AUTO_PARTIAL/);
  assert.match(frame.source, /预设资金规划/);
  evidence.push({
    asset,
    trace: frame.trace,
    clock: frame.clock,
    rates,
    vest: m.spec.contract,
    hype: m.hl.contract,
    pfMark: m.pf.mark,
    hlMark: m.hl.mark,
    basis: frame.basis,
    entry: entry.toFixed(5),
    exit: exit.toFixed(5),
    position: frame.position,
    failure: frame.failure,
    success: frame.success,
    profit: frame.profit,
    status: frame.status
  });
}
try {
  await send('Page.navigate', { url: process.env.CURRENT_URL || browser.url });
  await wait("!!document.getElementById('desk-details')");
  await run("document.getElementById('desk-details').open=true");
  await capture('BTC');
  await set('#asset', 'ETH');
  await capture('ETH');
  await set('#asset', 'BTC');
  await capture('BTC');
  // The live frames above are unmodified. Change one public response in this
  // disposable Chrome profile solely to exercise revocation and recovery.
  await run(`(()=>{const upstream=window.fetch; window.fxFault='stale';
    window.fetch=async(...args)=>{const r=await upstream(...args), u=String(args[0]);
      if(!window.fxFault || !r.ok) return r;
      if(window.fxFault==='stale' && u.includes('/api/usd-rates')){const x=await r.json();if(x.rates.USDT)x.rates.USDT.asOf='2000-01-01T00:00:00Z';return Response.json(x)}
      if(window.fxFault==='missing' && u.includes('/api/current-market')){const x=await r.json();if(x.hl?.contract)x.hl.contract.quoteAsset=null;return Response.json(x)}
      return r}})()`);
  for (const [fault, expected] of [
    ['stale', 'FX_STALE'],
    ['missing', 'QUOTE_CURRENCY_UNVERIFIED']
  ]) {
    await run('window.fxFault=' + JSON.stringify(fault));
    await wait(
      "document.getElementById('scan-basis').textContent===" +
        JSON.stringify(expected) +
        " && !document.getElementById('scan-focus').hidden && document.getElementById('scan-results').inert && document.getElementById('scan-desk').dataset.state==='paused'",
      35000
    );
    evidence.push({ injectedFault: fault, state: expected, oldResultsWithdrawn: true });
  }
  await run('window.fxFault=null');
  await capture('BTC');
  assert.deepEqual(browser.faults, []);
  if (process.env.FX_EVIDENCE)
    await writeFile(process.env.FX_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    'FX_BROWSER_OK',
    evidence[0].basis,
    evidence[0].trace,
    evidence[0].position,
    evidence[0].failure,
    evidence[0].success
  );
} finally {
  await browser.close();
}
