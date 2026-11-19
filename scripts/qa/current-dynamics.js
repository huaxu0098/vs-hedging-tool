// Compare the visible DOM with the exact worker result, then recompute the
// captured public snapshot independently after changing only planning inputs.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { calculateCurrent } from '../../src/hedge/current.js';
import { inspectRatio } from '../../src/hedge/ratio-scan.js';
import { dec } from '../../src/hedge/math.js';
import { openTestBrowser } from './chrome.js';

const chrome = await openTestBrowser({ current: true });
const { send, run, set, click } = chrome;
const origin = process.env.CURRENT_URL || chrome.url;
const reports = [];
const number = (x, places) => dec(String(x)).toFixed(places);
const install = `(() => {
  window.published = new Map();
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(job,...args) {
    if (job.m && !this.observing) {
      this.observing=true;
      this.addEventListener('message', ({data})=>{
        const result=data.result, scan=result?.ratioScan;
        if(!scan?.analysis)return;
        const rows=scan.analysis.neighbors;
        window.published.set(result.trace.id,{
          time:result.trace.at,id:result.trace.id, input:JSON.parse(result.trace.inputs),
          funding:result.funding, representative:scan.representative?.row.h,
          boundary:scan.analysis.boundary, neighbors:rows,
          counts:scan.buckets.map(b=>b.both), total:scan.sets.both.count,
          comparison:result.priceComparison,
          ranges:Object.fromEntries(['protect','survive','both','profit'].map(k=>[k,[scan.sets[k].min?.h,scan.sets[k].max?.h]]))
        });
        if(window.published.size>12)window.published.delete(window.published.keys().next().value);
      });
    }
    return post.call(this,job,...args);
  };
})()`;
async function read(label, condition = 'true') {
  const expression = `(() => {
    const el=id=>document.getElementById(id), desk=el('scan-desk'), f=window.published?.get(desk?.dataset.resultId);
    if(!f || !( ${condition} ) || !['ready','updating'].includes(desk.dataset.state)) return null;
    return {...f,visible:{
      objective:el('ratio-objective').textContent,theory:el('ratio-theory').textContent,
      change:el('ratio-change').textContent, boundary:el('ratio-boundary').textContent,counts:el('ratio-counts').textContent,
      neighbors:[...el('ratio-neighbors').rows].map(r=>[...r.cells].map(c=>c.innerText)),
      profit:el('scan-profit').textContent, cash:[el('scan-fail-cash').textContent,el('scan-pass-cash').textContent]
    }};
  })()`;
  let frame;
  const until = Date.now() + 55000;
  while (!frame && Date.now() < until) {
    frame = await run(expression);
    if (!frame) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!frame)
    throw Error(
      label +
        ' 等待完整输入超时 ' +
        JSON.stringify(
          await run(`({
    status:document.querySelector('#scan-status')?.textContent, fee:document.querySelector('#registration')?.value,
    frames:[...window.published.values()].slice(-2).map(x=>[x.funding.B,x.funding.C_H,x.id])
  })`)
        ) +
        ' ' +
        chrome.faults.join(' / ')
    );
  const { input, neighbors, boundary, counts, total, visible } = frame;
  const check = calculateCurrent(
    input.rules,
    input.accounts,
    input.market,
    input.rates,
    Date.parse(frame.time),
    input.options
  );
  const scan = check.ratioScan;
  assert.equal(check.trace.id, frame.id);
  assert.equal(
    total,
    counts.reduce((a, b) => a + b, 0)
  );
  assert.equal(total, scan.sets.both.count);
  if (boundary) {
    assert.ok(boundary.both);
    assert.ok(
      visible.boundary.includes(boundary.fraction) &&
        visible.boundary.includes(boundary.pf) &&
        visible.boundary.includes(boundary.hl)
    );
    assert.ok(
      visible.counts.includes(
        counts
          .filter(Boolean)
          .map((n) => n.toLocaleString('en-US'))
          .join(' + ')
      )
    );
  }
  assert.deepEqual(scan.analysis.neighbors, neighbors);
  assert.equal(neighbors.length, visible.neighbors.length);
  assert.ok(neighbors.length >= 2);
  for (const [i, row] of neighbors.entries()) {
    const cells = visible.neighbors[i],
      r = inspectRatio(scan.ctx, row);
    assert.ok(cells[0].includes(number(dec(r.h).times(100), 6) + '%'));
    for (const [index, q, n] of [
      [1, r.pf, r.pfValue],
      [2, r.hl, r.hypeValue]
    ]) {
      assert.ok(cells[index].includes(q + ' BTC') && cells[index].includes(number(n, 2) + ' U'));
    }
    for (const [index, value, stop] of [
      [3, r.fail, r.failStop],
      [4, r.success, r.passStop]
    ])
      assert.equal(cells[index], stop || number(value, 4) + ' U');
    assert.ok(cells[5].includes(number(r.initial, 2) + ' U'));
    if (r.buffer != null) assert.ok(cells[6].includes(number(r.buffer, 2)));
  }
  reports.push({ label, ...frame });
  console.log(
    label,
    frame.time,
    frame.funding.lower,
    frame.funding.upper,
    frame.representative,
    counts.join('+') + '=' + total
  );
  return frame;
}
try {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: install });
  await send('Page.navigate', { url: origin });
  const baseline = await read('预设资金与真实主网');
  assert.ok(
    await run(
      "!document.querySelector('#desk-details').open && !document.querySelector('#ratio-analysis').hidden"
    )
  );
  assert.ok(baseline.visible.theory.includes('91.00 U') && baseline.visible.theory.includes('309.00 U'));
  const refresh = await read(
    '后一行情帧',
    'f.id!==' + JSON.stringify(baseline.id) + " && el('ratio-change').textContent.includes('理论界限未变')"
  );
  assert.equal(refresh.funding.lower, baseline.funding.lower);
  await click('#scan-config');
  await click('#account-details > summary');
  await set('#B', '490', 'input');
  const capital = await read('保护本金 500 → 490', "f.funding.B==='490' && f.funding.C_H==='409'");
  assert.equal(capital.funding.upper, baseline.funding.upper);
  assert.notEqual(capital.funding.lower, baseline.funding.lower);
  assert.notEqual(capital.representative, baseline.representative);
  await set('#B', '500', 'input');
  await set('#registration', '90', 'input');
  const wallet = await read('保护本金恢复 500，规划 Hype 权益 409 → 410', "f.funding.B==='500' && f.funding.C_H==='410'");
  assert.notEqual(wallet.funding.upper, baseline.funding.upper);
  assert.notEqual(wallet.funding.lower, baseline.funding.lower);
  // Hold the captured prices, depth, model and time still to isolate changes
  // from the live browser above, where a new market tick can arrive at any time.
  const frozen = structuredClone(baseline.input);
  const recalc = () =>
    calculateCurrent(
      frozen.rules,
      frozen.accounts,
      frozen.market,
      frozen.rates,
      Date.parse(baseline.time),
      frozen.options
    );
  frozen.rules.B = '490';
  const budgetOnly = recalc();
  assert.notEqual(budgetOnly.ratioScan.representative.row.h, baseline.representative);
  assert.deepEqual(
    [budgetOnly.funding.lower, budgetOnly.funding.upper],
    [capital.funding.lower, capital.funding.upper]
  );
  for (const k of ['bid', 'ask']) frozen.rates.USDT[k] = dec(String(frozen.rates.USDT[k])).times('0.99').toString();
  const fxOnly = recalc();
  assert.notEqual(fxOnly.priceComparison.diff, budgetOnly.priceComparison.diff);
  assert.deepEqual(fxOnly.ratioScan.representative.row.paths, budgetOnly.ratioScan.representative.row.paths);
  assert.deepEqual(fxOnly.ratioScan.analysis.neighbors, budgetOnly.ratioScan.analysis.neighbors);
  reports.push({
    label: '同一主网快照的单因素复算',
    source: baseline.id,
    B: budgetOnly.funding.B,
    theory: budgetOnly.ratioScan.analysis.theory,
    h: budgetOnly.ratioScan.representative.row.h,
    reference: [budgetOnly.priceComparison.diff, fxOnly.priceComparison.diff],
    identicalNativeLedgers: true
  });
  assert.deepEqual(chrome.faults, []);
  if (process.env.DYN_EVIDENCE)
    await writeFile(process.env.DYN_EVIDENCE, JSON.stringify(reports, null, 2) + '\n');
  console.log('DYNAMICS_BROWSER_OK', origin);
} finally {
  await chrome.close();
}
