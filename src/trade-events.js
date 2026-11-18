const fillLabels = new Set(['开仓', '加仓', '减仓', '反向调仓', '平仓']);
const settlementLabels = new Map([
  ['考核达标，遗留仓位已结算', 'challenge-pass'],
  ['取得出金号，VS 重置', 'challenge-pass'],
  ['考核失败', 'challenge-fail'],
  ['出金号爆号', 'funded-fail'],
  ['首次出金到账，本轮结束', 'payout'],
  ['Hype 触及强平线，终止推演', 'liquidation'],
  ['日内未到线平仓／结转', 'day-close'],
  ['明确放弃本轮账户', 'abandoned']
]);
const isVenue = (v) => v === 'vs' || v === 'hype';
const amount = (v) => (Number.isFinite(v) ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);
function timeOf(value) {
  const time =
    typeof value === 'number' ? new Date(value) : new Date(typeof value === 'string' ? value : NaN);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}
function isFill(row) {
  return (
    row &&
    fillLabels.has(row.label) &&
    isVenue(row.venue) &&
    row.assetId &&
    Number.isFinite(row.qty) &&
    row.qty !== 0
  );
}
function fillDetail(row) {
  const gross = amount(row.gross),
    fee = amount(row.fee);
  return {
    venue: row.venue,
    label: row.label,
    qty: row.qty,
    price: amount(row.price),
    gross,
    fee,
    net: gross !== null && fee !== null ? gross - fee : null
  };
}
function eventDetail(row, fills = []) {
  return {
    kind: settlementLabels.get(row.label) ?? 'fill',
    label: row.label,
    assetId: row.assetId || null,
    time: timeOf(row.time),
    cycle: amount(row.cycle),
    day: amount(row.day),
    stage: row.stage ?? null,
    status: row.status ?? null,
    fills,
    vsNet: fills.find((f) => f.venue === 'vs')?.net ?? null,
    hypeNet: fills.find((f) => f.venue === 'hype')?.net ?? null,
    receipt: settlementLabels.get(row.label) === 'payout' ? amount(row.receipt) : null,
    hypeCash: amount(row.hypeCash),
    vsBalance: amount(row.vsBalance)
  };
}

function latestForAsset(rows, assetId) {
  // Append order also works for restored ledgers and replay clocks. Pair only
  // adjacent complementary fills with the same recorded label and timestamp.
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.assetId !== assetId) continue;
    if (settlementLabels.has(row.label)) return eventDetail(row);
    if (!isFill(row)) continue;
    const fills = [fillDetail(row)];
    const prev = rows[i - 1];
    if (
      isFill(prev) &&
      prev.venue !== row.venue &&
      prev.assetId === assetId &&
      prev.label === row.label &&
      timeOf(row.time) &&
      prev.time === row.time &&
      prev.cycle === row.cycle &&
      prev.day === row.day &&
      prev.stage === row.stage
    )
      fills.unshift(fillDetail(prev));
    return eventDetail(row, fills);
  }
  return null;
}

function pendingForAsset(sim, assetId) {
  const record = sim?.observation;
  if (
    !record ||
    (sim.status && sim.status !== 'active') ||
    (record.revision != null && sim.revision != null && record.revision !== sim.revision)
  )
    return null;
  const proofs = list(record.proofs).filter((p) =>
    ['success', 'failure', 'liquidation'].includes(p?.event)
  );
  if (!proofs.length) return null;
  // Proof assets identify which positions the observed portfolio covered. They
  // cannot identify an individual instrument as the cause of an account breach.
  const assetIds = [...new Set(proofs.flatMap((p) => list(p.assets).map((a) => a?.id)).filter(Boolean))];
  if (assetIds.length && !assetIds.includes(assetId)) return null;
  const events = [...new Set(proofs.map((p) => p.event))];
  const ambiguous = events.length > 1,
    waitingForQuote = record.pending === true;
  const names = { success: 'VS 达标', failure: 'VS 失败线', liquidation: 'Hype 强平线' };
  const label = ambiguous
    ? '已观察到多条触线，先后未定，待结算'
    : '已观察到' + names[events[0]] + (waitingForQuote ? '，待另一侧报价确认' : '，待结算');
  return {
    label,
    time:
      proofs
        .map((p) => timeOf(p.time))
        .filter(Boolean)
        .sort()[0] ?? null,
    events,
    ambiguous,
    waitingForQuote,
    assetIds
  };
}

// Read only the persisted simulation supplied by the caller. The shared
// account's final cash and receipts are never allocated to a product by time
// proximity; version-one reservations carry no executed fills or realized P&L.
export function readTradeEvents(sim, assetId, legacy = null) {
  const rows = list(sim?.history);
  const settled = rows.findLast((e) => e && settlementLabels.has(e.label));
  const positions = list(sim?.positions)
    .filter((p) => p?.assetId === assetId && isVenue(p.venue) && Number.isFinite(p.qty) && p.qty !== 0)
    .map((p) => ({
      assetId,
      venue: p.venue,
      qty: p.qty,
      entry: amount(p.entry),
      margin: amount(p.margin),
      unit: p.asset?.[p.venue]?.qtyUnit ?? null,
      openedAt: timeOf(p.openedAt)
    }));
  const legacyReservations = list((legacy ?? sim)?.entries)
    .filter((e) => e?.assetId === assetId && ['open', 'closed'].includes(e.status))
    .map((e) => ({
      assetId,
      id: e.id ?? null,
      status: e.status,
      reserve: amount(e.reserve),
      label: e.status === 'open' ? '旧账本预留占用' : '旧账本已释放占用',
      createdAt: timeOf(e.createdAt),
      closedAt: timeOf(e.closedAt)
    }));
  return {
    positions,
    latest: latestForAsset(rows, assetId),
    pending: pendingForAsset(sim, assetId),
    accountEvent: settled ? eventDetail(settled) : null,
    legacyReservations
  };
}
