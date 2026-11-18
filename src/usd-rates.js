const currencies = new Set(['USDC', 'USDT']);
const positive = (n) => Number.isFinite(n) && n > 0;

function validBook(book, currency) {
  return (
    book?.currency === currency &&
    book.quote === 'USD' &&
    positive(book.bid) &&
    positive(book.ask) &&
    book.ask >= book.bid &&
    positive(book.rate) &&
    book.rate >= book.bid &&
    book.rate <= book.ask &&
    typeof book.source === 'string' &&
    book.source.trim() &&
    Number.isFinite(Date.parse(book.asOf)) &&
    Date.parse(book.asOf) <= Date.now()
  );
}

export function mountUsdRates($, onChange) {
  const modeSelect = $('feed-fx-mode'),
    grid = $('feed-fx'),
    status = $('feed-fx-status'),
    confirm = $('feed-fx-confirm');
  modeSelect.value = localStorage.getItem('vs-hype:usd-fx-mode:v1') === 'manual' ? 'manual' : 'auto';
  let bindings = [],
    codes = [],
    signature,
    mode,
    ageMs,
    running,
    active = false;
  let request,
    timer,
    interval,
    revision = 0,
    appliedManual = {},
    rates = {},
    errors = {};
  const manualDraft = new Map();
  let lastRender = '';
  function stop() {
    ++revision;
    clearTimeout(timer);
    request?.abort();
    request = null;
    active = false;
  }
  async function poll() {
    if (!active || request) return;
    const token = revision,
      startedAt = Date.now();
    const controller = new AbortController();
    request = controller;
    try {
      const r = await fetch('/api/usd-rates', {
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)])
      });
      if (!r.ok) throw Error('来源连接失败');
      const reply = await r.json();
      if (revision !== token) return;
      errors = {};
      for (const code of currencies) {
        const row = reply.rates?.[code];
        if (!validBook(row, code)) {
          errors[code] = reply.errors?.[code] || '缺少有效美元盘口';
          continue;
        }
        if (!rates[code] || Date.parse(row.asOf) >= Date.parse(rates[code].asOf))
          rates = { ...rates, [code]: row };
      }
    } catch {
      if (token !== revision) return;
      errors = { USDC: '连接失败', USDT: '连接失败' };
    } finally {
      if (token === revision) {
        request = null;
        timer = setTimeout(poll, Math.max(250, interval - (Date.now() - startedAt)));
        onChange();
      }
    }
  }
  function paintInputs() {
    grid.replaceChildren();
    grid.hidden = confirm.hidden = mode !== 'manual' || !codes.length;
    if (grid.hidden) return;
    for (const code of codes) {
      const label = document.createElement('label'),
        input = document.createElement('input');
      label.textContent = '1 ' + code + ' 折合美元';
      input.type = 'number';
      input.step = 'any';
      input.min = '0';
      input.dataset.currency = code;
      input.value = manualDraft.get(code) ?? appliedManual[code]?.rate ?? '';
      input.oninput = () => {
        manualDraft.set(code, input.value);
        delete appliedManual[code];
        onChange();
      };
      label.append(input);
      grid.append(label);
    }
  }
  function paintStatus() {
    const now = Date.now();
    const rows = codes.map((code) => {
      let text;
      const row = mode === 'manual' ? appliedManual[code] : rates[code];
      if (mode === 'auto' && !currencies.has(code)) text = '暂无此美元直盘，可切换手动确认';
      else if (!row) text = mode === 'manual' ? '等待手动确认' : errors[code] || '等待公开盘口';
      else {
        const fresh = now >= Date.parse(row.asOf) && now - Date.parse(row.asOf) <= ageMs;
        text =
          row.rate.toLocaleString('en-US', { maximumFractionDigits: 8, useGrouping: false }) +
          '　' +
          row.source +
          '　' +
          row.asOf +
          (fresh ? '' : '　已过期');
        if (mode === 'auto' && errors[code]) text += '　' + errors[code];
      }
      return [code, text];
    });
    const heading =
      mode === 'auto' ? '自动美元汇率 · ' + (running ? '现货买卖中点' : '实时订阅已暂停') : '手动美元汇率';
    const key = JSON.stringify([heading, rows]);
    if (key === lastRender) return;
    lastRender = key;
    const title = document.createElement('strong');
    title.textContent = rows.length ? heading : '当前币种均为 USD，无需换汇';
    const elements = rows.map(([code, text]) => {
      const line = document.createElement('div');
      line.dataset.currency = code;
      line.textContent = code + '/USD　' + text;
      return line;
    });
    status.replaceChildren(title, ...elements);
  }
  modeSelect.onchange = () => {
    localStorage.setItem('vs-hype:usd-fx-mode:v1', modeSelect.value);
    onChange();
  };
  confirm.onclick = () => {
    const inputs = [...grid.querySelectorAll('input')];
    if (!inputs.every((i) => positive(i.valueAsNumber))) {
      lastRender = '';
      status.textContent = '请先填写各币种的正数美元汇率。';
      return;
    }
    const asOf = new Date().toISOString();
    for (const input of inputs) {
      appliedManual[input.dataset.currency] = { rate: input.valueAsNumber, asOf, source: '用户确认' };
      manualDraft.delete(input.dataset.currency);
    }
    onChange();
  };
  return {
    configure(nextBindings, shouldPoll, maxAge, pollPeriod) {
      bindings = nextBindings;
      const nextMode = modeSelect.value;
      const nextCodes = [...new Set(bindings.map((b) => b.code).filter((c) => c && c !== 'USD'))].sort();
      const nextSignature = JSON.stringify([nextMode, nextCodes]);
      mode = nextMode;
      codes = nextCodes;
      ageMs = maxAge;
      running = shouldPoll;
      if (nextSignature !== signature) {
        signature = nextSignature;
        paintInputs();
      }
      const nextInterval = Math.max(500, Math.min(pollPeriod, maxAge / 2, 2000));
      const enabled = mode === 'auto' && running && codes.some((c) => currencies.has(c));
      if (enabled !== active || (enabled && interval !== nextInterval)) {
        stop();
        interval = nextInterval;
        active = enabled;
        if (enabled) void poll();
      }
      paintStatus();
    },
    get mode() {
      return modeSelect.value;
    },
    get rates() {
      return rates;
    },
    get manual() {
      const fx = { vs: {}, hype: {} };
      for (const { side, kind, code } of bindings) {
        const r = appliedManual[code],
          leg = fx[side];
        if (!r || code === 'USD') continue;
        leg[kind + 'Currency'] = code;
        leg[kind + 'Usd'] = r.rate;
        if (!leg.asOf || leg.asOf > r.asOf) leg.asOf = r.asOf;
      }
      return fx;
    },
    destroy: stop
  };
}
