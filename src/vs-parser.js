// Self-contained so the opt-in console collector can parse selected text on the VS page.
export function parseVSText(raw, now = Date.now()) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 24000)
    throw new Error('请粘贴 1 至 24,000 字的报价或账户文本。');
  const a = {
    balance: ['balance', 'accountbalance', '余额', '账户余额', '结余'],
    equity: ['equity', 'netequity', 'accountvalue', '净值', '账户净值'],
    used: ['used', 'usedmargin', 'marginused', '已用保证金', '已占用保证金', '占用保证金'],
    free: ['free', 'freemargin', 'availablemargin', '可用保证金', '剩余可用保证金', '可用余额'],
    stage: ['stage', 'phase', '阶段', '账户阶段'],
    bid: ['bid', 'bestbid', '买一', '买一价', '买价'],
    ask: ['ask', 'bestask', '卖一', '卖一价', '卖价'],
    mark: ['mark', 'markpx', 'markprice', 'lastprice', 'price', '当前价', '最新价', '标记价'],
    symbol: ['symbol', 'ticker', 'instrument', 'coin', '品种', '合约', '合约代码', '标的'],
    asOf: ['asof', 'timestamp', 'quotetime', '报价时间', '时间戳'],
    open: ['open', 'marketopen', 'marketstatus', '市场状态', '开市'],
    side: ['side', 'direction', '方向', '持仓方向'],
    qty: ['qty', 'quantity', 'size', 'lots', 'signedqty', '数量', '手数', '仓位数量'],
    entry: ['entry', 'entryprice', 'entrypx', 'averageprice', '开仓均价', '开仓价', '均价'],
    upnl: ['upnl', 'unrealizedpnl', 'floatingpnl', '未实现盈亏', '浮动盈亏', '浮盈亏', '浮盈'],
    marginUsed: ['positionmargin', '持仓保证金']
  };
  const clean = (s) =>
    String(s)
      .trim()
      .replace(/[（(](?:USD[TC]?|U|BTC|ETH|SOL|手|张)[）)]/gi, '')
      .toLowerCase()
      .replace(/[\s_()（）%]/g, '');
  const keys = {};
  for (const [key, labels] of Object.entries(a)) for (const label of labels) keys[clean(label)] = key;
  const numeric = (value) => {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    let v = String(value)
      .trim()
      .replace(/[$¥,，\s]/g, '')
      .replace(/(?:USD[TC]?|U|手|张|盎司)$/i, '');
    v = v.replace(/^\((.+)\)$/, '-$1');
    if (!/^[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?$/i.test(v)) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  function stamp(v) {
    if (/^\d{10,13}$/.test(String(v))) v = Number(v) * (String(v).length === 10 ? 1000 : 1);
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  }
  const norm = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [keys[clean(k)] || k, v]));
  const fields = {},
    positions = [];
  let accountAsOf;
  function readFields(o) {
    for (const [k, v] of Object.entries(norm(o))) {
      if (['balance', 'equity', 'used', 'free', 'bid', 'ask', 'mark'].includes(k)) {
        const n = numeric(v);
        if (n !== undefined) fields[k] = n;
      } else if (k === 'stage') {
        if (/funded|出金|实盘/i.test(v)) fields.stage = 'funded';
        else if (/challenge|eval|考核/i.test(v)) fields.stage = 'challenge';
      } else if (k === 'symbol' && /^[\w.:/-]{1,64}$/u.test(String(v))) fields.symbol = String(v);
      else if (k === 'asOf') {
        fields.asOf = stamp(v);
        if (!fields.asOf) throw new Error('VS 报价时间格式无效。');
      } else if (
        k === 'open' &&
        (typeof v === 'boolean' || /^(true|false|open|closed|开市|休市|开盘|收盘)$/i.test(String(v)))
      ) {
        fields.open = v === true || /^(true|open|开市|开盘)$/i.test(String(v));
      }
    }
  }
  function readPosition(obj) {
    const row = norm(obj),
      qty = numeric(row.qty),
      entry = numeric(row.entry),
      upnl = numeric(row.upnl);
    if (
      !row.symbol ||
      !/^[\w.:/-]{1,64}$/.test(row.symbol) ||
      qty === undefined ||
      !(entry > 0) ||
      upnl === undefined
    ) {
      throw new Error('持仓需包含合约、带方向的数量、开仓均价及浮盈。');
    }
    const side = String(row.side ?? '').trim();
    if (side && !/^(long|short|buy|sell|多|空|做多|做空|多头|空头)$/i.test(side))
      throw new Error('持仓方向无法识别。');
    const signed = side ? (/short|sell|空/i.test(side) ? -1 : 1) * Math.abs(qty) : qty;
    const margin = numeric(row.marginUsed ?? row.used ?? row.margin);
    positions.push({
      symbol: String(row.symbol),
      qty: signed,
      entry,
      upnl,
      ...(margin !== undefined && { marginUsed: margin })
    });
  }
  const text = raw.trim();
  if (/^[{[]/.test(text)) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error('VS JSON 格式无效。');
    }
    if (Array.isArray(doc)) doc = { positions: doc };
    const { asOf: accountTime, ...accountFields } = norm(doc.account);
    if (accountTime !== undefined) {
      accountAsOf = stamp(accountTime);
      if (!accountAsOf) throw new Error('账户时间格式无效。');
    }
    readFields(doc);
    readFields(accountFields);
    readFields(doc.quote);
    readFields(doc.market);
    const list = doc.positions ?? doc.account?.positions;
    if (list !== undefined && !Array.isArray(list)) throw new Error('positions 需要为持仓数组。');
    for (const p of list ?? []) readPosition(p);
    if (list) fields.hasPositions = true;
  } else {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let headers = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (
        /^(?:positions?|当前持仓|持仓)\s*[:：=]?\s*(?:none|no open positions|无|空仓|0|\[\])$/i.test(l) ||
        /^(?:no (?:open )?positions|暂无持仓|当前无持仓)$/i.test(l)
      ) {
        fields.hasPositions = true;
        continue;
      }
      const cols = l
        .replace(/^\||\|$/g, '')
        .split(/\s*[|\t]\s*| {2,}/)
        .filter(Boolean);
      if (cols.length >= 2 && cols.every((col) => keys[clean(col)])) {
        headers = cols.map((col) => keys[clean(col)]);
        continue;
      }
      if (headers && cols.length === headers.length && !cols.every((col) => /^[-:]+$/.test(col))) {
        const row = Object.fromEntries(headers.map((h, j) => [h, cols[j]]));
        if (headers.includes('qty') && headers.includes('entry')) {
          readPosition(row);
          fields.hasPositions = true;
          continue;
        }
        if (!cols.some((col) => keys[clean(col)])) {
          readFields(row);
          continue;
        }
      }
      headers = null;
      let consumed = false;
      for (const part of l.split(/[;；]/)) {
        const m = part.trim().match(/^(.{1,36}?)\s*[:：=]\s*(.+)$/);
        if (m && keys[clean(m[1])]) {
          readFields({ [m[1]]: m[2].trim() });
          consumed = true;
        }
      }
      if (consumed) continue;
      if (cols.length === 2 && keys[clean(cols[0])]) {
        readFields({ [cols[0]]: cols[1] });
        continue;
      }
      const pair = l.match(
        /^(.+?)\s+([-+$\d][\d,.$+\-]*\s*(?:USD[TC]?|U)?|challenge|funded|考核中|出金阶段)$/i
      );
      if (pair && keys[clean(pair[1])]) {
        readFields({ [pair[1]]: pair[2] });
        continue;
      }
      const key = keys[clean(l)];
      if (key && i + 1 < lines.length && !keys[clean(lines[i + 1])]) {
        readFields({ [key]: lines[++i] });
        continue;
      }
      const p = l.match(
        /^(?:持仓\s*[:：]?\s*)?([\w.:/-]+)\s+((?:long|short|buy|sell|做多|做空|多|空))\s+([+\-\d.,]+)\s+([\d.,]+)\s+([+\-\d.,]+)$/i
      );
      if (p) {
        readPosition({ symbol: p[1], side: p[2], qty: p[3], entry: p[4], upnl: p[5] });
        fields.hasPositions = true;
      }
    }
  }
  if (!Object.keys(fields).length && !positions.length) throw new Error('未识别出 VS 报价、账户或持仓字段。');
  const quote = {},
    account = {};
  for (const key of ['bid', 'ask', 'mark', 'symbol', 'open'])
    if (fields[key] !== undefined) quote[key] = fields[key];
  for (const key of ['balance', 'equity', 'used', 'free', 'stage'])
    if (fields[key] !== undefined) account[key] = fields[key];
  if (fields.hasPositions || positions.length) account.positions = positions;
  if (accountAsOf && Object.keys(account).length) account.asOf = accountAsOf;
  const asOf = fields.asOf ?? new Date(now).toISOString();
  return { ...quote, asOf, timeSource: fields.asOf ? 'source' : 'capture', account };
}

export function captureScript({ origin, token, assetId, baseURL }) {
  const settings = JSON.stringify({ origin, token, assetId, baseURL });
  return `(async()=>{const c=${settings};if(location.origin!==c.origin)throw Error("当前页面与配对来源不符");const selected=String(window.getSelection()).trim();if(!selected)throw Error("请先框选报价、账户或持仓文字");const parse=${parseVSText.toString()};const snapshot=parse(selected);if(!confirm("发送这些已识别字段到本机匹配器？\\n"+JSON.stringify(snapshot,null,2)))return;const r=await fetch(c.baseURL+"/api/vs-snapshot",{method:"POST",credentials:"omit",redirect:"error",referrerPolicy:"no-referrer",headers:{"Content-Type":"application/json","Authorization":"Bearer "+c.token},body:JSON.stringify({assetId:c.assetId,snapshot})});if(!r.ok)throw Error("本机接收失败 "+r.status);console.info("VS 结构化快照已发送");})()`;
}
