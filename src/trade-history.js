import { MAINNET } from './feeds.js';

export function lastLiquidation(rows, symbol) {
  if (!Array.isArray(rows)) throw Error('强平记录格式无法识别');
  const relevant = rows.filter(
    (row) =>
      row?.delta?.type === 'liquidation' &&
      Number.isSafeInteger(row.time) &&
      row.time > 0 &&
      row.time <= Date.now() &&
      Array.isArray(row.delta.liquidatedPositions) &&
      row.delta.liquidatedPositions.some(
        (p) => p.coin === symbol && Number.isFinite(Number(p.szi)) && Number(p.szi) !== 0
      )
  );
  return relevant.reduce((last, r) => (!last || r.time > last.time ? r : last), null);
}

// Look up actual account ledger events independently of estimated liquidation lines.
export function liquidationMonitor(draw) {
  let key,
    timer,
    request,
    epoch = 0;
  return function follow(snapshot, symbol, visible) {
    const address = snapshot?.accountAddress;
    const next =
      visible &&
      snapshot?.mode === 'live' &&
      snapshot.endpoint === MAINNET &&
      symbol &&
      /^0x[\da-f]{40}$/i.test(address || '')
        ? address.toLowerCase() + '/' + symbol
        : '';
    if (next === key) return;
    key = next;
    clearTimeout(timer);
    request?.abort();
    const version = ++epoch;
    if (!key) {
      draw('等待主网公开钱包与合约');
      return;
    }
    draw('正在核对平台账户记录');
    async function poll() {
      request = new AbortController();
      try {
        const response = await fetch('/api/hype-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(6000)]),
          body: JSON.stringify({
            network: 'mainnet',
            request: { type: 'userNonFundingLedgerUpdates', user: address, startTime: Date.now() - 86400000 }
          })
        });
        if (!response.ok) throw Error('平台记录查询失败');
        const event = lastLiquidation(await response.json(), symbol);
        if (version === epoch)
          draw(
            event
              ? symbol + ' 已发生平台强平 · ' + new Date(event.time).toLocaleString('zh-CN')
              : '最近 24 小时返回的账户记录中未见本品种强平',
            event ? 'liquidated' : ''
          );
      } catch {
        if (version === epoch) draw('平台记录暂不可用，强平状态未知');
      } finally {
        if (version === epoch) timer = setTimeout(poll, 5000);
      }
    }
    void poll();
  };
}
