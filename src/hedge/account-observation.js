// Store only the selected labels and figures. The raw accessibility tree stays on the reading Mac.
export const observationKey = 'vs-hype:last-account-observation:v1';

const displayedAmount = /^([+-]?)\s*\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:USD|USDC|USDT)?$/;
function amountAfter(rows, labels) {
  const matches = new Set();
  for (const [i, row] of rows.entries()) {
    if (!labels.includes(row.replace(/[：:]$/, '').toLowerCase())) continue;
    const m = rows[i + 1]?.match(displayedAmount);
    if (m) matches.add(m[1] + m[2].replaceAll(',', ''));
  }
  return matches.size === 1 ? [...matches][0] : null;
}
const clean = (rows) => rows.map((x) => String(x).trim()).filter(Boolean);
export function summarizePages(vsRead, hypeRead) {
  const vs = clean(vsRead.rows),
    hl = clean(hypeRead.rows);
  const disconnected = hl.some((x) =>
    ['connect', 'connect wallet', '连接钱包', '连接錢包'].includes(x.toLowerCase())
  );
  const primary = ['主账户', '主帳戶', 'primary account', 'main account'].includes(
    vsRead.accountLabel?.toLowerCase()
  );
  const emptyPositions = vs.some((x) =>
    /^(未找到持仓|您没有持仓。请下单开始交易。|no open positions|no positions found)\.?$/i.test(x)
  );
  return {
    version: 1,
    vs: {
      symbol: vsRead.symbol,
      at: vsRead.at,
      primary,
      emptyPositions,
      equity: amountAfter(vs, ['账户价值', 'account value', 'account equity', '账户净值']),
      free: amountAfter(vs, ['可用保证金', 'available margin', 'free margin']),
      capacity: amountAfter(vs, ['交易额度', 'trading power', 'buying power']),
      positionMargin: amountAfter(vs, ['仓位占用', 'position margin']),
      orderMargin: amountAfter(vs, ['订单占用', 'order margin'])
    },
    hl: {
      symbol: hypeRead.symbol,
      at: hypeRead.at,
      disconnected,
      // A public page can draw zeros for every private account field before connecting.
      equity: disconnected
        ? null
        : amountAfter(hl, ['投资组合价值', 'portfolio value', '账户价值', 'account value']),
      free: disconnected ? null : amountAfter(hl, ['可用', 'available to trade'])
    }
  };
}

const zero = (v) => typeof v === 'string' && /^[+-]?0+(?:\.0+)?$/.test(v);
export function assessObservation(s) {
  const flatAndBlocked = s.vs.emptyPositions && zero(s.vs.free) && zero(s.vs.capacity);
  const stop = flatAndBlocked || s.vs.primary;
  const tickets = stop ? '$0.00' : '待核算';
  const missing = [];
  if (s.vs.primary)
    missing.push(
      'VS 当前选中主账户。通过／失败情景需要实际考核或 Funded 账户的净值、剩余保证金、持仓和阶段。'
    );
  else if (s.vs.equity == null || s.vs.free == null)
    missing.push('VS 账户净值或可用保证金未完整显示，请展开账户概览。');
  if (!s.vs.primary) missing.push('需核对 VS 当前阶段、完整持仓和合约规格。');
  if (s.hl.disconnected)
    missing.push(
      'Hype 显示 Connect。可在只读接入页填写实际主账户或子账户的公开地址，以读取权益、可用额度和持仓。'
    );
  else missing.push('需核对 Hype 真实账户身份、持仓、挂单占用、抵押币与适用的维持保证金档位。');
  missing.push(
    '通过与失败的个人净盈亏还需要该账户的目标线、失败线、成交费率，以及本轮真实现金基准和已付考核成本。'
  );
  return {
    tickets,
    stop,
    flatAndBlocked,
    missing,
    scenario: s.vs.primary ? '不适用 · 主账户' : '待核算',
    incremental: stop ? '$0.00' : '待核算'
  };
}

export function validateObservation(s) {
  if (s?.version !== 1 || !s.vs || !s.hl) throw Error('无法识别账户快照');
  for (const venue of [s.vs, s.hl]) {
    if (
      !/^[\w.:-]{1,64}$/.test(venue.symbol) ||
      typeof venue.at !== 'string' ||
      !Number.isFinite(Date.parse(venue.at))
    )
      throw Error('快照缺合约或读取时间');
  }
  for (const v of [s.vs.primary, s.vs.emptyPositions, s.hl.disconnected])
    if (typeof v !== 'boolean') throw Error('快照缺账户状态');
  for (const value of [
    s.vs.equity,
    s.vs.free,
    s.vs.capacity,
    s.vs.positionMargin,
    s.vs.orderMargin,
    s.hl.equity,
    s.hl.free
  ])
    if (value !== null && (typeof value !== 'string' || !/^[-+]?\d{1,40}(?:\.\d{1,30})?$/.test(value)))
      throw Error('快照金额无效');
  if (s.hl.disconnected && (s.hl.equity !== null || s.hl.free !== null))
    throw Error('未连接钱包，不能确认 Hype 账户数值');
  return s;
}
