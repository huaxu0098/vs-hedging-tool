import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { calculateCurrent } from '../../src/hedge/current.js';
import { presentLedger, sumPostings } from '../../src/hedge/settlement-ledger.js';
import { dec } from '../../src/hedge/math.js';
import { openTestBrowser } from './chrome.js';

const browser = await openTestBrowser({ current: true });
const { run, wait, set, click, send } = browser;
const frames = [];
async function readFrame(label, condition = 'true', feasible = true) {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    const packet = await run(`(() => {
      const el = id => document.getElementById(id), txt = id => el(id).textContent;
      if (!txt('trace-id').startsWith('AUTO-0.14') || !(${condition}) ||
          !txt('auto-search').includes('${feasible ? 'AUTO_PARTIAL' : 'AUTO_INFEASIBLE'}')) return null;
      const detail=el('trace-inputs').parentElement; detail.open=true; detail.ontoggle();
      return { rows:[...el('path-rows').querySelectorAll('tr')].filter(row=>row.dataset.posting||row.dataset.total).map(row=>[row.dataset.posting??'total',...[...row.cells].slice(1).map(c=>c.textContent)]), input:JSON.parse(txt('trace-inputs')), time:txt('trace-sources').match(/计算于 (\\S+)/)[1], id:txt('trace-id'),
        view:Object.fromEntries(['formula-bounds','formula-pair','pf-summary','hl-summary','target-h','suggested-leverage','pass-summary','fail-summary','search-coverage','pass-bridge','clock-skew','auto-search'].map(k=>[k,txt(k)])) };
    })()`);
    if (!packet) {
      await delay(100);
      continue;
    }
    const { rules, accounts, market, rates, options } = packet.input;
    const x = calculateCurrent(rules, accounts, market, rates, Date.parse(packet.time), options);
    assert.ok(packet.id.endsWith(x.trace.id));
    assert.equal(x.autoStatus, feasible ? 'AUTO_PARTIAL' : 'AUTO_INFEASIBLE');
    if (feasible && !x.candidate) {
      if (Date.now() + 1500 >= until)
        throw Error(JSON.stringify({ issues: x.issues, notices: x.notices, data: x.dataState }));
      await delay(150);
      continue;
    }
    if (feasible) {
      assert.ok(x.candidate.funding.valid);
      for (const [i, ledger] of [
        x.paths.fail.pf,
        x.paths.fail.hl,
        x.paths.pass.pf,
        x.paths.pass.hl
      ].entries()) {
        const rows = packet.rows.map((row) => [row[0], row[i + 1]]),
          total = rows.pop();
        const exact = !rows.some((row) => row[0] === 'rounding');
        const expected = exact
          ? ledger.entries
          : { ...presentLedger(ledger).entries, rounding: presentLedger(ledger).rounding };
        assert.deepEqual(Object.fromEntries(rows), expected);
        assert.ok(dec(sumPostings(rows.map((row) => row[1]))).eq(total[1]));
      }
      assert.ok(dec(x.candidate.failureCash).gte(x.funding.B));
      assert.ok(dec(x.candidate.hlBeforePayout).gte(x.funding.R));
      assert.match(packet.view['formula-pair'], /每单位共同价格变化 PF/);
      assert.match(packet.view['pass-bridge'], /起点.*成功路径预计/);
    } else {
      assert.equal(x.adjust, undefined);
      assert.equal(packet.view['pf-summary'], '—');
      assert.match(packet.view['formula-bounds'], /无交集.*缺/);
    }
    const frame = {
      label,
      at: packet.time,
      id: x.trace.id,
      status: x.autoStatus,
      funding: x.funding,
      pf: x.candidate?.vsNotional,
      hype: x.candidate?.hlNotional,
      actual: x.candidate?.actualRatio,
      leverage: x.candidate?.candidateLeverage,
      fail: x.candidate?.failureCash,
      pass: x.candidate?.hlBeforePayout,
      proof: x.candidate?.funding,
      marketSource: market.hl.bookSource,
      quoteClocks: x.timing.clocks,
      search: { complete: x.search?.complete, gridPairs: x.search?.gridPairs, proof: x.search?.proof },
      inputs: packet.input,
      paths: x.paths,
      grid: x.candidate?.leverageGrid,
      ui: packet.view
    };
    frames.push(frame);
    console.log(
      'FORM_FRAME',
      JSON.stringify({
        label,
        at: frame.at,
        lower: frame.funding.lower,
        upper: frame.funding.upper,
        pf: frame.pf,
        hype: frame.hype,
        h: frame.actual,
        lev: frame.leverage,
        fail: frame.fail,
        pass: frame.pass,
        status: frame.status
      })
    );
    return frame;
  }
  throw Error(
    label +
      ' 等待新版本超时 ' +
      (await browser.text('#calc-status')) +
      ' ' +
      (await browser.text('#auto-search'))
  );
}
async function edit(id, value) {
  const pending =
    await run(`(()=>{const field=document.getElementById(${JSON.stringify(id)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));
    return document.querySelector('#pf-summary').textContent;})()`);
  assert.equal(pending, '—', '修改规则后的同一事件必须使旧仓位失效');
}
try {
  await send('Page.navigate', { url: (process.env.CURRENT_URL ?? browser.url) + '/' });
  await wait("typeof document.querySelector('#plan-cross-flat')?.onchange === 'function'");
  await click('#plan-cross-flat');
  const start = await readFrame('预设500/409/100');
  await run("document.querySelector('#ledger-exact').click()");
  await edit('R_free', '100');
  const free = await readFrame(
    '仅改开仓后可用抵押品留存0→100',
    "txt('formula-bounds').includes('R_free 100.00')"
  );
  assert.equal(free.funding.upper, start.funding.upper);
  assert.equal(free.funding.lower, start.funding.lower);
  await edit('R_success', '101');
  const next = await readFrame(
    '仅改留存100→101',
    "txt('formula-inputs').includes('500.00 U') && txt('formula-bounds').includes('101.00')"
  );
  assert.equal(next.funding.lower, start.funding.lower);
  assert.notEqual(next.funding.upper, start.funding.upper);
  assert.ok(next.pf);
  await edit('challengeFloor', '9390');
  const lower = await readFrame('仅改失败线9400→9390', "txt('formula-inputs').includes('9390.00')");
  assert.notEqual(lower.funding.lower, next.funding.lower);
  assert.equal(lower.funding.upper, next.funding.upper);
  await edit('R_success', '180');
  await readFrame('仅改留存101→180，无交集', "txt('formula-bounds').includes('180.00')", false);
  await set('#funding-view', 'account');
  assert.equal(await run("document.querySelector('#hl-equity').value"), '');
  assert.match(await browser.text('#auto-search'), /AUTO_DATA_BLOCKED/);
  await click('#confirm-flat');
  for (const [id, v] of [
    ['pf-equity', '10000'],
    ['hl-equity', '419'],
    ['pf-free', '10000'],
    ['hl-free', '350']
  ])
    await set('#' + id, v, 'input');
  const manual = await readFrame('手工快照＋主网行情', "txt('funding-banner').includes('当前账户快照')");
  assert.equal(manual.funding.C_H, '419');
  await edit('B', '505');
  const newPrincipal = await readFrame(
    '手工快照仅改保护本金500→505',
    "txt('formula-inputs').includes('505.00 U')"
  );
  assert.notEqual(newPrincipal.funding.lower, manual.funding.lower);
  assert.equal(newPrincipal.funding.upper, manual.funding.upper);
  await set('#quoteSkewMs', '5000', 'input');
  await edit('external', '10');
  const external = await readFrame('已到账外部资金0→10', "txt('formula-inputs').includes('已到账 10.00 U')");
  assert.equal(external.funding.C_H, newPrincipal.funding.C_H);
  assert.notEqual(external.funding.lower, newPrincipal.funding.lower);
  await edit('pf-equity', '10050');
  const eq = await readFrame('仅改当前PF权益10000→10050', "txt('formula-inputs').includes('10050.00')");
  assert.equal(eq.funding.loss, '650');
  assert.equal(eq.funding.gain, '1950');
  await edit('challengeTarget', '12010');
  const target = await readFrame('仅改成功线12000→12010', "txt('formula-inputs').includes('12010.00')");
  assert.equal(target.funding.gain, '1960');
  await edit('hl-equity', '418');
  const account = await readFrame('仅改Hype权益419→418', "txt('formula-inputs').includes('418.00')");
  assert.equal(account.funding.C_H, '418');
  assert.ok(manual.marketSource.includes('Hyperliquid'));
  assert.deepEqual(browser.faults, []);
  if (process.env.FORM_EVIDENCE)
    await writeFile(process.env.FORM_EVIDENCE, JSON.stringify(frames, null, 2) + '\n');
  console.log('FORM_BROWSER_OK 资金规则切换、同事件撤回、双边联合重算、无解、资金模式隔离与手工当前快照');
} finally {
  await browser.close();
}
