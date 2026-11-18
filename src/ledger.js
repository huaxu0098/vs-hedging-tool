import { evaluate } from './engine.js';

export const LEDGER_KEY = 'vs-hype:ledger:v1';

const CAPITAL = 500;
const MICRO = 1_000_000;
const DAMAGED = '共享账本数据损坏，已暂停记账。请检查当前浏览器中的账本数据。';

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validTime(value) {
  return nonempty(value) && Number.isFinite(Date.parse(value));
}

function balance(entries) {
  const ids = new Set();
  let usedMicro = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new Error(DAMAGED);
    const { id, assetId, ticker, createdAt, closedAt, status, reserve } = entry;
    const amounts = [entry.vsQty, entry.hypeQty, entry.vsUsd, entry.hypeUsd,
      entry.vsRequestedUsd, entry.hypeRequestedUsd, reserve];
    if (![id, assetId, ticker, entry.vsUnit, entry.hypeUnit].every(nonempty) ||
        ids.has(id) || !validTime(createdAt) || typeof entry.vsLong !== 'boolean' ||
        !amounts.every(value => Number.isFinite(value) && value > 0)) throw new Error(DAMAGED);
    ids.add(id);

    const held = Math.round(reserve * MICRO);
    if (held / MICRO !== reserve || reserve > CAPITAL) throw new Error(DAMAGED);
    if (status === 'open' && closedAt === null) usedMicro += held;
    else if (status !== 'closed' || !validTime(closedAt)) throw new Error(DAMAGED);
  }
  if (usedMicro > CAPITAL * MICRO) throw new Error(DAMAGED);
  return { capital: CAPITAL, used: usedMicro / MICRO,
    available: (CAPITAL * MICRO - usedMicro) / MICRO, entries };
}

export function getLedger() {
  let raw;
  try {
    raw = globalThis.localStorage.getItem(LEDGER_KEY);
  } catch {
    throw new Error('无法读取本地共享账本，请检查浏览器存储权限。');
  }
  if (raw === null) return balance([]);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(DAMAGED);
  }
  if (data?.version !== 1 || !Array.isArray(data.entries)) throw new Error(DAMAGED);
  return balance(data.entries);
}

function save(entries) {
  const next = balance(entries);
  try {
    globalThis.localStorage.setItem(LEDGER_KEY, JSON.stringify({ version: 1, entries }));
  } catch {
    throw new Error('共享账本写入失败，请检查浏览器存储空间和权限。');
  }
  return next;
}

async function withLedgerLock(change) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) throw new Error('浏览器无法锁定共享账本，请通过 localhost 在支持 Web Locks 的浏览器中打开工具。');
  return locks.request(LEDGER_KEY, { mode: 'exclusive' }, () => change(getLedger()));
}

export async function bookPosition(asset, order) {
  return withLedgerLock(ledger => {
    const now = Date.now();
    const candidate = evaluate(asset, order, ledger.available, now);
    if (!candidate.ok) throw new Error(candidate.reasons.join('；') || '当前候选未通过验算。');
    // Reserve whole micro-units upward; every subsequent balance is integer arithmetic.
    const reserve = Math.ceil(candidate.reserve * MICRO) / MICRO;
    if (!Number.isFinite(reserve) || reserve <= 0 || reserve > ledger.available) {
      throw new Error('共享本金可用余额不足。');
    }
    const entry = {
      id: globalThis.crypto.randomUUID(),
      assetId: asset.id,
      ticker: asset.ticker,
      createdAt: new Date(now).toISOString(),
      closedAt: null,
      status: 'open',
      vsLong: order.vsLong,
      vsUsd: candidate.vs.notional,
      hypeUsd: candidate.hype.notional,
      vsRequestedUsd: order.vsUsd,
      hypeRequestedUsd: order.hypeUsd,
      vsQty: candidate.vs.qty,
      hypeQty: candidate.hype.qty,
      vsUnit: asset.vs.qtyUnit,
      hypeUnit: asset.hype.qtyUnit,
      reserve,
    };
    return save([entry, ...ledger.entries]);
  });
}

export async function closePosition(id) {
  return withLedgerLock(ledger => {
    const entry = ledger.entries.find(item => item.id === id);
    if (!entry) throw new Error('找不到这条流水，请重新载入账本。');
    if (entry.status === 'closed') return ledger;
    const released = { ...entry, status: 'closed', closedAt: new Date().toISOString() };
    return save(ledger.entries.map(item => item.id === id ? released : item));
  });
}
