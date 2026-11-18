import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const script = {};
for (const file of ['config.js', 'service.js', 'vs-content.js', 'desk-content.js', 'manifest.json']) {
  script[file] = await readFile(new URL('../extension/' + file, import.meta.url), 'utf8');
}
const vest = 'https://next.vestmarkets.com/trade/BTC-PERP';
const desk = 'http://127.0.0.1:4178/';
const id = 'testing-extension-id';

function listeners() {
  const handlers = [];
  return {
    addListener(fn) {
      handlers.push(fn);
    },
    fire(value) {
      for (const fn of handlers) fn(value);
    }
  };
}

function port(name, url, frameId = 0) {
  const messages = [];
  return {
    name,
    messages,
    onMessage: listeners(),
    onDisconnect: listeners(),
    closed: false,
    sender: { id, url, frameId, tab: { id: 3 } },
    postMessage(m) {
      messages.push(JSON.parse(JSON.stringify(m)));
    },
    disconnect() {
      if (!this.closed) {
        this.closed = true;
        this.onDisconnect.fire();
      }
    }
  };
}

function service() {
  const onConnect = listeners();
  const ctx = vm.createContext({ chrome: { runtime: { id, onConnect } }, URL });
  ctx.importScripts = (name) => vm.runInContext(script[name], ctx);
  vm.runInContext(script['service.js'], ctx);
  return (name, url, frameId = 0) => {
    const p = port(name, url, frameId);
    onConnect.fire(p);
    return p;
  };
}

function content(file, url, page = {}) {
  const p = port(file === 'desk-content.js' ? 'vs-desk' : 'vs-source', url);
  const window = new EventTarget();
  window.top = window;
  const timers = new Set();
  let clock = Date.parse('2026-01-01T00:00:00Z'),
    reads = 0;
  let raw = {
    symbol: 'BTC-PERP',
    quote: { bid: 99000, ask: 99001, mark: 99000.5, open: true },
    account: { balance: 10000, equity: 10001, positions: [], accountId: 'DO-NOT-TRANSFER' }
  };
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
    static now() {
      return clock;
    }
  }
  const ctx = vm.createContext({
    window,
    CustomEvent,
    Date: Clock,
    location: new URL(url),
    document: {
      title: 'VS × Hype 多品种动态对冲匹配器',
      documentElement: {},
      querySelector: () => ({ content: 'vs-hype-matcher' }),
      ...page
    },
    navigator: { userActivation: { isActive: false } },
    chrome: { runtime: { connect: () => p } },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setInterval: (fn) => {
      timers.add(fn);
      return fn;
    },
    clearInterval: (fn) => timers.delete(fn),
    setTimeout: (fn) => {
      timers.add(fn);
      return fn;
    },
    clearTimeout: (fn) => timers.delete(fn),
    readVisibleVest: () => {
      reads++;
      return raw;
    }
  });
  const updates = [];
  window.addEventListener('vs-auto-update', (e) => updates.push(JSON.parse(e.detail)));
  if (file === 'desk-content.js') vm.runInContext(script['config.js'], ctx);
  vm.runInContext(script[file], ctx);
  return {
    ctx,
    p,
    updates,
    clock: () => clock,
    reads: () => reads,
    change: (r) => {
      raw = r;
    },
    raw: () => raw,
    advance: () => {
      clock += 1000;
      for (const f of [...timers]) f();
    },
    command: (type, symbol) =>
      window.dispatchEvent(new CustomEvent('vs-auto-command', { detail: JSON.stringify({ type, symbol }) })),
    hide: () => window.dispatchEvent(new Event('pagehide'))
  };
}

test('扩展仅注入指定两站，拒绝外站、子框架、错误本机端口及文档身份', () => {
  const manifest = JSON.parse(script['manifest.json']);
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions ?? [], []);
  assert.deepEqual(manifest.host_permissions ?? [], []);
  assert.deepEqual(manifest.content_scripts.flatMap((s) => s.matches).sort(), [
    'http://127.0.0.1/*',
    'https://next.vestmarkets.com/trade/*'
  ]);
  const connect = service();
  for (const [name, url, frame] of [
    ['vs-source', 'https://other.test/trade/BTC-PERP', 0],
    ['vs-source', vest, 2],
    ['vs-desk', 'http://127.0.0.1:3000/', 0],
    ['vs-desk', desk + 'anything', 0],
    ['vs-source', desk, 0]
  ]) {
    assert.equal(connect(name, url, frame).closed, true);
  }
  const wrong = content('desk-content.js', desk, { title: '另一应用' });
  wrong.command('probe');
  assert.deepEqual(wrong.updates, []);
});

test('看板探测不启动，需用户激活，停止后延迟到达的数据不再送入页面', () => {
  const d = content('desk-content.js', desk);
  d.command('probe');
  assert.equal(d.updates.at(-1).type, 'ready');
  d.command('start', 'BTC-PERP');
  assert.equal(d.updates.at(-1).type, 'error');
  assert.deepEqual(d.p.messages, []);
  d.ctx.navigator.userActivation.isActive = true;
  d.command('start', 'BTC-PERP');
  assert.deepEqual(d.p.messages, [{ type: 'start', symbol: 'BTC-PERP' }]);
  d.p.onMessage.fire({ type: 'waiting', symbol: 'ETH-PERP', message: 'wrong' });
  assert.notEqual(d.updates.at(-1).message, 'wrong');
  d.command('stop', 'BTC-PERP');
  d.p.onMessage.fire({ type: 'snapshot', symbol: 'BTC-PERP' });
  assert.equal(d.updates.at(-1).type, 'stopped');
  assert.equal(d.p.closed, true);
});

test('未启动不读取 VS；报价与账户独立计时，静态页、重启和心跳不刷新旧报价', () => {
  const s = content('vs-content.js', vest);
  const enable = { type: 'enable', token: 1, symbol: 'BTC-PERP' };
  s.advance();
  assert.equal(s.reads(), 0);
  s.p.onMessage.fire(enable);
  const first = s.p.messages.at(-1).snapshot;
  assert.equal(first.timeSource, 'capture');
  assert.ok(!JSON.stringify(first).includes('DO-NOT-TRANSFER'));
  const count = s.p.messages.length;
  s.advance();
  assert.equal(s.p.messages.length, count);
  s.raw().account.equity += 1;
  s.advance();
  const second = s.p.messages.at(-1).snapshot;
  assert.equal(second.asOf, first.asOf);
  assert.equal(second.account.asOf, first.account.asOf);
  assert.equal(second.account.equity, 10002);
  s.raw().quote.bid -= 1;
  s.raw().quote.ask += 1;
  s.raw().quote.mark += 1;
  s.raw().quote.asOf = new Date(s.clock() - 100).toISOString();
  s.advance();
  const third = s.p.messages.at(-1).snapshot;
  assert.equal(third.timeSource, 'source');
  assert.equal(third.asOf, s.raw().quote.asOf);
  assert.equal(third.account.asOf, second.account.asOf);
  s.raw().quote.asOf = new Date(s.clock()).toISOString();
  s.advance();
  assert.equal(s.p.messages.at(-1).snapshot.asOf, third.asOf);
  s.p.onMessage.fire({ type: 'disable', token: 2 });
  const readCount = s.reads();
  s.advance();
  assert.equal(s.reads(), readCount);
  s.p.onMessage.fire({ ...enable, token: 3 });
  assert.equal(s.p.messages.at(-1).snapshot.asOf, third.asOf);
  s.ctx.location = new URL(vest.replace('BTC', 'ETH'));
  s.advance();
  assert.deepEqual(s.p.messages.at(-1), { type: 'route', symbol: 'ETH-PERP' });
  s.hide();
  assert.ok(s.p.closed);
});

test('独立报价时间保留静态盘口；字段暂缺及同值重现不能假造新鲜度', () => {
  const s = content('vs-content.js', vest);
  s.p.onMessage.fire({ type: 'enable', token: 1, symbol: 'BTC-PERP' });
  const latest = () => s.p.messages.at(-1).snapshot;
  const initial = latest().asOf;
  s.raw().quote.mark++;
  s.advance();
  assert.equal(latest().asOf, initial);
  const bid = s.raw().quote.bid;
  delete s.raw().quote.bid;
  s.raw().quote.ask++;
  s.advance();
  assert.equal(latest().bid, undefined);
  assert.equal(latest().asOf, initial);
  s.raw().quote.bid = bid;
  s.advance();
  assert.equal(latest().asOf, initial);
  s.raw().quote.bid--;
  s.advance();
  assert.ok(latest().asOf > initial); // all three cells now have observed changes
  const latestTime = latest().asOf;
  delete s.raw().quote.mark;
  s.advance();
  assert.equal(latest().asOf, latestTime);
});

test('账户部分更新不会续时消失字段，全账户源时间只确认本次可见的数值', () => {
  const s = content('vs-content.js', vest);
  s.p.onMessage.fire({ type: 'enable', token: 1, symbol: 'BTC-PERP' });
  const account = () => s.p.messages.at(-1).snapshot.account;
  const start = account().asOf;
  delete s.raw().account.balance;
  s.raw().account.equity += 4;
  s.advance();
  assert.equal(account().asOf, start);
  assert.equal(account().balance, undefined);
  s.raw().account.asOf = new Date(s.clock()).toISOString();
  s.advance();
  assert.equal(account().asOf, start); // the missing balance still has the old clock
  s.raw().account.balance = 10000;
  delete s.raw().account.asOf;
  s.advance();
  assert.equal(account().asOf, start);
  const source = new Date(s.clock()).toISOString();
  s.raw().account.asOf = source;
  s.advance();
  assert.equal(account().asOf, source);
  assert.equal(account().timeSource, 'source');
});

test('可见页被登录／访问检查覆盖时传递原因，并拒绝误用其他品种', () => {
  const s = content('vs-content.js', vest);
  s.change({ symbol: 'BTC-PERP', reason: '页面当前显示访问检查' });
  s.p.onMessage.fire({ type: 'enable', token: 9, symbol: 'BTC-PERP' });
  assert.match(s.p.messages.at(-1).message, /访问检查/);
  assert.equal(s.p.messages.at(-1).snapshot, undefined);
  s.change({ symbol: 'ETH-PERP', quote: { mark: 100 } });
  s.advance();
  assert.equal(s.p.messages.at(-1).type, 'waiting');
  assert.equal(s.p.messages.at(-1).snapshot, undefined);
});

test('中继按启动文档、路由和代次隔离；重复来源锁住，关闭看板撤销订阅', () => {
  const connect = service(),
    d = connect('vs-desk', desk),
    other = connect('vs-desk', desk);
  const v = connect('vs-source', vest),
    duplicate = connect('vs-source', vest);
  v.onMessage.fire({ type: 'route', symbol: 'BTC-PERP' });
  d.onMessage.fire({ type: 'start', symbol: 'BTC-PERP' });
  const subscribed = v.messages.at(-1);
  assert.equal(subscribed.type, 'enable');
  const data = {
    type: 'snapshot',
    token: subscribed.token,
    symbol: 'BTC-PERP',
    snapshot: { symbol: 'BTC-PERP', mark: 888 }
  };
  v.onMessage.fire(data);
  assert.equal(d.messages.at(-1).snapshot.mark, 888);
  assert.deepEqual(other.messages, []);
  duplicate.onMessage.fire({ type: 'route', symbol: 'BTC-PERP' });
  assert.match(d.messages.at(-1).message, /多个/);
  v.onMessage.fire(data);
  assert.equal(d.messages.at(-1).type, 'waiting');
  duplicate.disconnect();
  assert.equal(v.messages.at(-1).type, 'enable');
  v.onMessage.fire(data);
  assert.equal(d.messages.at(-1).type, 'waiting'); // Previous subscription token.
  d.disconnect();
  assert.equal(v.messages.at(-1).type, 'disable');
});
