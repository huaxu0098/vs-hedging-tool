import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const adapter = readFileSync(new URL('../trade-extension/venue-vs.js', import.meta.url), 'utf8');
const newOrder = () => ({
  venue: 'vs',
  symbol: 'BTC-PERP',
  unit: 'BTC',
  side: 'buy',
  quantity: '0.010',
  currentQty: 0,
  stage: 'challenge',
  accountContext: 'opaque-local-account',
  leverage: 10,
  marginMode: 'cross',
  reduceOnly: false
});

// Structural fixture of the public Vest ticket. Login and account identity are
// supplied by the separate installed page reader; no site is loaded by this test.
function fixture() {
  const rows = new Map(),
    clicks = [];
  class Node {
    constructor(id, tagName = 'BUTTON', innerText = '') {
      Object.assign(this, {
        dataset: { testid: id },
        tagName,
        innerText,
        attrs: {},
        type: 'button',
        isConnected: true
      });
      rows.set(id, this);
    }
    querySelectorAll(sel) {
      const id = sel.match(/^\[data-testid="([^"]+)"\]$/)?.[1];
      const found = rows.get(id);
      return found ? [found] : [];
    }
    closest() {
      return null;
    }
    checkVisibility() {
      return true;
    }
    getClientRects() {
      return [1];
    }
    getAttribute(name) {
      return this.attrs[name] ?? null;
    }
    click() {
      clicks.push(this.dataset.testid);
      this.effect?.();
    }
    dispatchEvent(e) {
      this.onEvent?.(e);
    }
  }
  class Input extends Node {
    get value() {
      return this.text ?? '';
    }
    set value(v) {
      this.text = v;
    }
  }
  const doc = new Node('document', 'HTML');
  new Node('order-form', 'DIV');
  new Node('market-info', 'DIV', 'BTC\nBTC Perpetual Future\n50x');
  new Node('leverage-button', 'BUTTON', '10x');
  const market = new Node('ordertype-tab-market');
  market.attrs.role = 'tab';
  market.attrs['aria-selected'] = 'false';
  market.dataset.state = 'inactive';
  market.effect = () => {
    market.attrs['aria-selected'] = 'true';
    market.dataset.state = 'active';
  };
  const unit = new Node('size-unit-toggle', 'BUTTON', 'USD');
  unit.effect = () => {
    unit.innerText = 'BTC';
  };
  const input = new Input('size-input', 'INPUT');
  input.inputMode = 'decimal';
  for (const id of ['tpsl-toggle', 'reduce-only-checkbox']) new Node(id).attrs['aria-checked'] = 'false';
  new Node('tif-select', 'BUTTON', 'IOC');
  for (const id of ['submit-long', 'submit-short']) {
    const button = new Node(id);
    button.type = 'submit';
    button.disabled = true;
  }
  input.onEvent = () => {
    for (const id of ['submit-long', 'submit-short']) rows.get(id).disabled = !input.value;
  };
  const page = {
    symbol: 'BTC-PERP',
    account: { accountContext: 'opaque-local-account', stage: 'challenge', positions: [] }
  };
  const tab = {};
  const ctx = {
    self: tab,
    top: tab,
    URL,
    Event,
    setTimeout,
    document: doc,
    HTMLInputElement: Input,
    location: { href: 'https://next.vestmarkets.com/trade/BTC-PERP' },
    readVisibleVest: () => page
  };
  vm.runInNewContext(adapter, ctx);
  return { venue: ctx.tradeVenue, rows, clicks, page, ctx, input };
}
test('Vest 准备只设置官方市价及原币数量，方向提交仅允许一次', async () => {
  const x = fixture(),
    leg = newOrder();
  const fingerprint = await x.venue.prepare(leg);
  assert.deepEqual(x.clicks, ['ordertype-tab-market', 'size-unit-toggle']);
  assert.equal(x.input.value, '0.010');
  x.input.value = '0.01';
  assert.equal(x.venue.verify(leg), fingerprint);
  x.venue.submit(leg);
  assert.deepEqual(x.clicks, ['ordertype-tab-market', 'size-unit-toggle', 'submit-long']);
  assert.throws(() => x.venue.submit(leg), /重新准备/);
});
test('Vest 准备后账户、阶段、原仓、杠杆、盘口路由、数量或组件变化一律拒绝点击', async () => {
  for (const mutate of [
    (x) => {
      x.page.account.accountContext = 'different';
    },
    (x) => {
      x.page.account.stage = 'funded';
    },
    (x) => {
      x.page.account.positions = [{ symbol: 'BTC-PERP', qty: 0.05 }];
    },
    (x) => {
      x.rows.get('leverage-button').innerText = '25x';
    },
    (x) => {
      x.ctx.location.href = 'https://next.vestmarkets.com/trade/ETH-PERP';
    },
    (x) => {
      x.input.text = '0.0101';
    },
    (x) => {
      x.rows.get('tpsl-toggle').attrs['aria-checked'] = 'true';
    },
    (x) => {
      x.rows.get('reduce-only-checkbox').attrs['aria-checked'] = 'true';
    },
    (x) => {
      x.rows.get('size-unit-toggle').innerText = 'USD';
    },
    (x) => {
      x.rows.get('submit-short').type = 'button';
    },
    (x) => {
      x.rows.get('submit-short').disabled = true;
    },
    (x) => {
      x.rows.delete('submit-short');
    },
    (x) => {
      x.rows.get('order-form').querySelectorAll = () => [];
    },
    (x) => {
      x.rows.get('tif-select').innerText = 'GTC';
    }
  ]) {
    const x = fixture(),
      leg = { ...newOrder(), side: 'sell' };
    await x.venue.prepare(leg);
    mutate(x);
    assert.throws(() => x.venue.submit(leg));
    assert.equal(x.clicks.filter((i) => i.startsWith('submit')).length, 0);
  }
});
test('Vest 不为未知品种、相反现仓、逐仓、未绑定账户或未完整读取的持仓准备', async () => {
  for (const changes of [
    { symbol: 'ETH-PERP' },
    { unit: 'USD' },
    { side: 'sell', currentQty: 1 },
    { accountContext: '' },
    { stage: 'funded' },
    { leverage: 50 },
    { marginMode: 'isolated' },
    { quantity: '0' },
    { quantity: 'NaN' },
    { quantity: '1e-4' },
    { reduceOnly: true }
  ]) {
    const x = fixture();
    await assert.rejects(x.venue.prepare({ ...newOrder(), ...changes }));
    assert.deepEqual(x.clicks, []);
  }
  const x = fixture();
  delete x.page.account.positions;
  await assert.rejects(x.venue.prepare(newOrder()), /完整仓位/);
  assert.deepEqual(x.clicks, []);
});

test('Vest 未确认旧数量已清空时不得将可用的旧提交按钮当作新数量已生效', async () => {
  const x = fixture();
  x.input.value = '1.50';
  x.input.onEvent = () => {};
  x.rows.get('submit-long').disabled = false;
  await assert.rejects(x.venue.prepare(newOrder()), /尚未确认/);
  assert.equal(x.clicks.filter((i) => i.startsWith('submit')).length, 0);
});
