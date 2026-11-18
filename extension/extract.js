// Re-running the content script replaces this reader. It never changes the Vest page.
(() => {
  'use strict';
  const fields = {
    bid: ['best bid', 'bid price', 'bid', '买一价', '买一', '最佳买价'],
    ask: ['best ask', 'ask price', 'ask', '卖一价', '卖一', '最佳卖价'],
    mark: ['mark price', 'mark', '标记价格', '标记价'],
    open: ['market status', 'trading status', '市场状态', '交易状态'],
    quoteTime: ['quote time', 'quote timestamp', 'market data time', '报价时间', '行情时间'],
    balance: ['account balance', 'wallet balance', 'cash balance', 'balance', '账户余额', '钱包余额', '余额'],
    equity: ['account equity', 'net equity', 'equity', 'account value', '账户净值', '净值'],
    free: ['available margin', 'free margin', 'available collateral', '可用保证金', '剩余可用保证金'],
    used: ['used margin', 'margin used', '已占用保证金', '已用保证金'],
    stage: ['account stage', 'account phase', 'stage', 'phase', '账户阶段', '考核阶段'],
    accountTime: [
      'account updated at',
      'account timestamp',
      'account snapshot time',
      '账户更新时间',
      '账户时间'
    ]
  };
  const columns = {
    symbol: ['symbol', 'market', 'instrument', 'pair', 'contract', '品种', '合约', '交易对'],
    side: ['side', 'direction', '方向', '持仓方向'],
    qty: ['size', 'position size', 'quantity', 'qty', 'lots', '数量', '手数', '仓位大小'],
    entry: ['entry price', 'entry', 'open price', 'avg entry price', '开仓均价', '开仓价'],
    upnl: [
      'unrealized pnl',
      'unrealized p&l',
      'unrealized profit and loss',
      'floating pnl',
      'upnl',
      '浮动盈亏',
      '未实现盈亏'
    ],
    marginUsed: ['used margin', 'margin used', 'position margin', '持仓保证金', '已用保证金']
  };
  const groupNames = {
    quote:
      /^(?:market (?:overview|data|stats|statistics|details|summary|price)|market ticker|price (?:stats|summary)|ticker(?: (?:header|stats))?|行情(?:概览|数据|统计)?|市场(?:概览|数据|统计))$/,
    book: /^(?:order[ -]?book(?: (?:panel|depth))?|market depth|depth of market|盘口(?:深度)?|订单簿|市场深度)$/,
    account:
      /^(?:account(?: (?:overview|summary|details|stats|information|info|metrics|balance))?|margin (?:overview|summary)|portfolio(?: (?:overview|summary))?|账户(?:概览|总览|摘要|详情|信息|资产|余额)?|保证金(?:概况|概览))$/,
    positions: /^(?:(?:all |open |current )?positions?|(?:当前|全部|未平)?持仓)(?:[ （(]*\d+[ ）)]*)?$/,
    excluded:
      /^(?:trade history|order history|orders|open orders|closed positions|position history|trades|recent trades|watchlist|favorites|all markets|markets|order entry|order form|place order|new order|buy[ /]+sell|成交历史|历史持仓|订单历史|下单|自选|市场列表)$/
  };
  const marketFields = new Set(['bid', 'ask', 'mark', 'open', 'quoteTime']);
  const unsafe =
    'script,style,template,noscript,head,form,input,textarea,select,nav,[role="dialog"],dialog,[contenteditable]:not([contenteditable="false"]),[hidden],[inert],[aria-hidden="true"]';
  const norm = (s) =>
    (s || '')
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[：:]$/, '')
      .trim();
  const fieldMap = new Map(
    Object.entries(fields).flatMap(([key, labels]) => labels.map((label) => [norm(label), key]))
  );
  const columnMap = new Map(
    Object.entries(columns).flatMap(([key, labels]) => labels.map((label) => [norm(label), key]))
  );
  const direct = (e) =>
    Array.from(e.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.nodeValue)
      .join(' ')
      .trim();
  const parseNumber = (text, assetUnit) => {
    if (typeof text !== 'string' || text.length > 100) return undefined;
    let literal = text
      .trim()
      .replace(/\u2212/g, '-')
      .replace(/\u00a0/g, ' ');
    if (assetUnit) literal = literal.replace(new RegExp('\\s+' + assetUnit + '$', 'i'), '');
    const match = literal.match(
      /^([+-]?)\s*(?:USD[TC]?\s*|US\$|\$)?\s*([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s*(?:USD[TC]?|US\$|\$))?$/i
    );
    if (!match || (match[1] && match[2])) return undefined;
    const value = Number((match[1] || match[2]) + match[3].replace(/,/g, '') + (match[4] || ''));
    return Number.isFinite(value) ? value : undefined;
  };

  function readVisibleVest(doc, location) {
    let url;
    try {
      url = new URL(location.href);
    } catch {
      return { symbol: null, reason: '无效页面地址。' };
    }
    const route = url.pathname.match(/^\/trade\/([A-Za-z0-9][A-Za-z0-9._-]{0,62})\/?$/);
    if (url.origin !== 'https://next.vestmarkets.com' || !route || url.username || url.password)
      return { symbol: null, reason: '请打开 Vest Markets 的交易品种页。' };
    const symbol = route[1];
    if (!doc.body || !doc.defaultView) return { symbol, reason: '交易页尚未显示数据。' };
    const win = doc.defaultView,
      seen = new WeakMap(),
      groupCache = new WeakMap();
    function visible(e) {
      if (!e || e.nodeType !== 1 || e.closest(unsafe)) return false;
      if (seen.has(e)) return seen.get(e);
      const r = e.getBoundingClientRect();
      let left = Math.max(r.left, 0),
        top = Math.max(r.top, 0),
        right = Math.min(r.right, win.innerWidth),
        bottom = Math.min(r.bottom, win.innerHeight);
      let ok = right - left >= 2 && bottom - top >= 2;
      for (let p = e; ok && p && p !== doc.documentElement; p = p.parentElement) {
        const c = win.getComputedStyle(p);
        if (
          c.visibility === 'hidden' ||
          c.visibility === 'collapse' ||
          c.display === 'none' ||
          c.contentVisibility === 'hidden' ||
          Number(c.opacity) === 0
        ) {
          ok = false;
          break;
        }
        if (p !== e && p !== doc.body) {
          const box = p.getBoundingClientRect();
          if (/^(?:clip|hidden|auto|scroll)$/.test(c.overflowX)) {
            left = Math.max(left, box.left);
            right = Math.min(right, box.right);
          }
          if (/^(?:clip|hidden|auto|scroll)$/.test(c.overflowY)) {
            top = Math.max(top, box.top);
            bottom = Math.min(bottom, box.bottom);
          }
          ok = right - left >= 2 && bottom - top >= 2;
        }
      }
      seen.set(e, ok);
      return ok;
    }
    function shortText(e) {
      if (!visible(e) || e.querySelector('input, select, textarea, [contenteditable="true"]')) return '';
      let text = '';
      const walker = doc.createTreeWalker(e, 4);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeValue.trim() && visible(n.parentElement)) text += ' ' + n.nodeValue.trim();
        if (text.length > 110) return '';
      }
      return text.trim();
    }
    function group(e) {
      if (groupCache.has(e)) return groupCache.get(e);
      const names = [e.getAttribute('aria-label'), e.getAttribute('data-testid')];
      for (const child of e.children) {
        if (child.matches('h1,h2,h3,h4,h5,h6,caption,legend,[role="heading"]') && visible(child))
          names.push(shortText(child));
        if (child.tagName === 'HEADER') {
          const h = child.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
          if (h && visible(h)) names.push(shortText(h));
        }
      }
      const matches = Object.keys(groupNames).filter((k) => names.some((s) => groupNames[k].test(norm(s))));
      const value = matches.length > 1 ? 'excluded' : matches[0];
      groupCache.set(e, value);
      return value;
    }
    const primary = Array.from(
      doc.querySelectorAll('main h1, [role="main"] h1, [data-testid="market-symbol"]')
    )
      .filter(visible)
      .map((e) => shortText(e).toUpperCase())
      .filter((s) => /^[A-Z0-9._]+-PERP$/.test(s));
    if (primary.some((s) => s !== symbol.toUpperCase()))
      return { symbol, reason: '交易页显示的品种与地址不一致。' };
    function scope(node) {
      for (let e = node; e && e !== doc.body; e = e.parentElement) {
        if (e.matches('table,[role="table"],[role="grid"]')) return 'table';
        const kind = group(e);
        if (kind) return kind;
        if (
          e.childElementCount <= 8 &&
          Array.from(e.children).some((x) => x.matches('input,select,textarea,[contenteditable="true"]'))
        )
          return 'excluded';
      }
      return null;
    }
    // Compact unlabeled panels are accepted only when neighboring financial labels establish their context.
    function pairContext(label, field) {
      const market = marketFields.has(field),
        kind = scope(label.parentElement);
      if (kind) return market ? kind === 'quote' || kind === 'book' : kind === 'account';
      const row = label.parentElement,
        block = row?.parentElement;
      if (
        !block ||
        block === doc.body ||
        block.childElementCount > 20 ||
        block.querySelector('form,input,select,textarea,table,[role="table"]')
      )
        return false;
      const names = new Set();
      for (const n of block.querySelectorAll('dt,span,p,label,small,div')) {
        if (n.childElementCount <= 1 && visible(n)) {
          const text = norm(direct(n));
          if (text && text.length < 45) names.add(text);
        }
        if (names.size > 70) return false;
      }
      if (market) {
        return (
          [...names].some((t) =>
            /^(?:index price|oracle price|funding rate|24h (?:volume|change)|指数价|资金费率)$/.test(t)
          ) ||
          (names.has('best bid') && names.has('best ask'))
        );
      }
      return (
        [...names].filter((t) => ['balance', 'equity', 'free', 'used'].includes(fieldMap.get(t))).length >= 2
      );
    }
    const values = new Map();
    function put(field, value) {
      if (value === undefined) return;
      if (!values.has(field)) values.set(field, new Set());
      values.get(field).add(value);
    }
    function fieldValue(k, text) {
      if (k === 'stage') {
        if (/^(?:funded(?: account)?|出金(?:阶段|账户)?)$/i.test(text)) return 'funded';
        if (/^(?:challenge|evaluation|考核(?:中|账户|阶段)?)$/i.test(text)) return 'challenge';
        return;
      }
      if (k === 'open') {
        if (/^(?:open|trading|开市|交易中)$/i.test(text)) return true;
        if (/^(?:closed|suspended|halted|休市|暂停交易)$/i.test(text)) return false;
        return;
      }
      if (k.endsWith('Time')) {
        // The clock must carry its timezone. A displayed "14:30" is not a source timestamp.
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/i.test(text)) return;
        const time = Date.parse(text);
        return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
      }
      const n = parseNumber(text);
      if (n === undefined || (marketFields.has(k) && n <= 0) || (['used', 'free'].includes(k) && n < 0))
        return;
      return n;
    }
    // The production "book-mark" and "market-midPrice" display the midpoint. Only the two
    // first displayed depth prices and the explicitly defined account equity are used here.
    for (const [id, key] of [
      ['book-bids-price-0', 'bid'],
      ['book-asks-price-0', 'ask'],
      ['account-value', 'equity']
    ]) {
      for (const node of doc.querySelectorAll('[data-testid="' + id + '"]')) {
        if (visible(node)) put(key, fieldValue(key, shortText(node)));
      }
    }
    for (const label of doc.querySelectorAll('dt,span,p,div,label,small,strong,b,th,td,[role="rowheader"]')) {
      if (label.childElementCount > 2) continue;
      const field = fieldMap.get(norm(direct(label)));
      if (
        !field ||
        label.closest('a,button,[role="button"]') ||
        !visible(label) ||
        !pairContext(label, field)
      )
        continue;
      let anchor = label;
      // A styled label can wrap its text in an extra span. Only walk a short, exclusively-label chain.
      for (let depth = 0; depth < 3 && anchor; depth++, anchor = anchor.parentElement) {
        const next = anchor.nextElementSibling;
        if (next && !next.matches('a,button,[role="button"]') && visible(next)) {
          const value = fieldValue(field, shortText(next));
          if (value !== undefined) {
            put(field, value);
            break;
          }
        }
        const parent = anchor.parentElement;
        if (!parent || parent.childElementCount !== 1 || parent === doc.body) break;
      }
    }
    const take = (k) => (values.get(k)?.size === 1 ? [...values.get(k)][0] : undefined);
    const quote = {},
      account = {};
    for (const k of [
      'bid',
      'ask',
      'mark',
      'open',
      'quoteTime',
      'balance',
      'equity',
      'used',
      'free',
      'stage',
      'accountTime'
    ]) {
      const val = take(k);
      if (val !== undefined) (marketFields.has(k) ? quote : account)[k.endsWith('Time') ? 'asOf' : k] = val;
    }
    if (quote.ask !== undefined && quote.bid !== undefined && quote.ask < quote.bid) {
      delete quote.ask;
      delete quote.bid;
    }

    function positions(table) {
      let area = table;
      for (; area && area !== doc.body; area = area.parentElement) {
        if (group(area)) break;
      }
      if (!area || group(area) !== 'positions' || !visible(table)) return;
      const rows = Array.from(table.querySelectorAll('tr,[role="row"]'));
      const header = rows.find((r) => r.querySelector('th,[role="columnheader"]'));
      if (!header || !visible(header)) return;
      const cells = Array.from(header.querySelectorAll('th,[role="columnheader"]'));
      const keys = cells.map((e) =>
        columnMap.get(norm(shortText(e)).replace(/\s*[（(](?:usd[tc]?|u)[）)]$/, ''))
      );
      if (!['symbol', 'qty', 'entry', 'upnl'].every((k) => keys.filter((c) => c === k).length === 1)) return;
      const data = rows.filter((r) => r !== header),
        found = [];
      for (const r of data) {
        if (!visible(r)) return;
        const cols = Array.from(
          r.querySelectorAll(':scope > td,:scope > [role="cell"],:scope > [role="gridcell"]')
        );
        if (
          cols.length === 1 &&
          data.length === 1 &&
          /^(?:no (?:open )?positions|暂无持仓|当前无持仓)$/i.test(shortText(cols[0]))
        )
          return [];
        if (cols.length !== cells.length) return;
        const row = Object.fromEntries(keys.map((k, i) => [k, shortText(cols[i])]));
        const s = row.symbol.toUpperCase();
        if (!/^[A-Z0-9][A-Z0-9._-]{0,48}$/.test(s)) return;
        const unit = s.replace(/-PERP$/, '').replace(/[^A-Z0-9]/g, '');
        let qty = parseNumber(row.qty, unit);
        const entry = parseNumber(row.entry),
          upnl = parseNumber(row.upnl);
        if (!Number.isFinite(qty) || !qty || !(entry > 0) || !Number.isFinite(upnl)) return;
        if (row.side) {
          if (/^(?:short|sell|空|做空|空头)$/i.test(row.side)) qty = -Math.abs(qty);
          else if (/^(?:long|buy|多|做多|多头)$/i.test(row.side) && qty > 0) qty = Math.abs(qty);
          else return;
        } else if (!/^[+-]/.test(row.qty.trim())) return;
        const position = { symbol: s, qty, entry, upnl };
        const used = parseNumber(row.marginUsed);
        if (used !== undefined && used >= 0) position.marginUsed = used;
        found.push(position);
      }
      // An empty table may still be loading. Only an explicit empty-state row above can confirm no holdings.
      if (!found.length) return;
      const total = table.getAttribute('aria-rowcount');
      if (total && Number(total) !== found.length + 1) return;
      return found;
    }
    function vestPositions() {
      const tabs = Array.from(doc.querySelectorAll('[data-testid="account-tab-active-positions"]')).filter(
        (el) =>
          visible(el) &&
          (el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-state') === 'active')
      );
      if (tabs.length !== 1) return;
      const tab = tabs[0],
        panel = doc.getElementById(tab.getAttribute('aria-controls'));
      if (!visible(panel)) return;
      const count = shortText(tab).match(/[（(](\d+)[）)]/);
      const symbols = Array.from(panel.querySelectorAll('tr [data-testid^="position-symbol-"]'));
      if (!symbols.length) {
        const empty = Array.from(panel.querySelectorAll('p,h3,h4,td,span')).some(
          (e) =>
            visible(e) && /^(?:no positions yet|no (?:open )?positions|暂无持仓|当前无持仓)$/i.test(direct(e))
        );
        return empty && (!count || Number(count[1]) === 0) ? [] : undefined;
      }
      // The visible active-tab counter verifies that virtualized or clipped rows are not silently lost.
      if (!count || Number(count[1]) !== symbols.length) return;
      const all = [];
      for (const sym of symbols) {
        const tr = sym.closest('tr'),
          abbr = shortText(sym),
          anchor = sym.closest('a[href]');
        if (!anchor || !/^[a-z0-9._-]{1,40}$/i.test(abbr)) return;
        let href;
        try {
          href = new URL(anchor.getAttribute('href'), url.origin);
        } catch {
          return;
        }
        const path = href.pathname.match(/^\/trade\/([A-Za-z0-9][A-Za-z0-9._-]{0,62})\/?$/);
        if (href.origin !== url.origin || !path) return;
        const side = shortText(tr.querySelector('[data-testid^="position-side-"]'));
        const direction = side.match(
          /^(long|short|做多|做空|多头|空头)(?:\s*(?:[x×]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*[x×]))?$/i
        );
        const entry = parseNumber(shortText(tr.querySelector('[data-testid^="position-entry-"]')));
        const upnl = parseNumber(shortText(tr.querySelector('[data-testid^="position-pnl-"]')));
        const amounts = Array.from(tr.querySelectorAll('[data-testid="td-value"] p'))
          .map(shortText)
          .filter((t) => t.toUpperCase().endsWith(' ' + abbr.toUpperCase()));
        const qty =
          amounts.length === 1
            ? parseNumber(amounts[0], abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            : undefined;
        if (!direction || !(qty > 0) || !(entry > 0) || !Number.isFinite(upnl)) return;
        all.push({ symbol: path[1], qty: /short|空/i.test(direction[1]) ? -qty : qty, entry, upnl });
      }
      return all;
    }
    const nativeList = vestPositions();
    const lists = Array.isArray(nativeList)
      ? [nativeList]
      : Array.from(doc.querySelectorAll('table,[role="table"],[role="grid"]'))
          .map(positions)
          .filter(Array.isArray);
    if (lists.length === 1) account.positions = lists[0];
    const result = { symbol };
    if (Object.keys(quote).length) result.quote = quote;
    if (Object.keys(account).length) result.account = account;
    if (!result.quote && !result.account) result.reason = '当前可见区域尚未显示能确认的报价或账户字段。';
    return result;
  }
  globalThis.readVisibleVest = readVisibleVest;
})();
