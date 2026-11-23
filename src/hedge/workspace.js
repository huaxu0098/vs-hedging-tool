import { createBook, restoreBook } from './book.js';
import { demoMarket } from './solver.js';
import { dec } from './math.js';
export const KEY = 'vs-hype:dynamic-readonly:v1';
export const defaults = {
  id: '用户模型 · 固定回撤',
  profileVersion: 1,
  source: 'user_provided',
  verification: 'assumed',
  verifiedAt: null,
  B: '1000',
  purchaseFee: '142.50',
  baseline: '10000',
  challengeTarget: '11000',
  challengeFloor: '9400',
  fundedFloor: '9400',
  share: '0.8',
  hours: '48',
  passTrigger: 'net_settlement',
  failureTrigger: 'net_settlement',
  additionalRules: []
};
export function workspace(now = new Date().toISOString()) {
  const markets = Object.fromEntries(
    ['unit', 'btc', 'eth', 'sol', 'xau', 'us100'].map((k) => [k, demoMarket(k)])
  );
  return {
    version: 1,
    revision: 0,
    profile: { ...defaults },
    markets,
    branches: { demo: createBook({ ...defaults, id: crypto.randomUUID(), time: now }) },
    vsSnapshot: null
  };
}
export function restore(raw) {
  const w = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
  if (
    w?.version !== 1 ||
    !Number.isSafeInteger(w.revision) ||
    !w.profile ||
    !w.branches?.demo ||
    !w.markets?.unit
  )
    throw Error('INVALID_BACKUP');
  for (const s of Object.values(w.branches)) restoreBook(s);
  for (const [id, m] of Object.entries(w.markets)) {
    if (id !== m.id || !m.pf || !m.hl) throw Error('INVALID_MARKET');
    for (const l of [m.pf, m.hl])
      for (const k of ['mark', 'step', 'multiplier', 'factor', 'fx', 'rate']) dec(l[k]);
  }
  return w;
}
export function read() {
  const raw = localStorage.getItem(KEY);
  if (raw) return restore(raw);
  const w = workspace();
  localStorage.setItem(KEY, JSON.stringify(w));
  return w;
}
export async function write(revision, change) {
  return navigator.locks.request(KEY, () => {
    const w = read();
    if (w.revision !== revision) throw Error('其他窗口已更新；已重新读取，请核对后再操作');
    const currentRevision = w.revision;
    const next = restore(change(w) ?? w);
    next.revision = currentRevision + 1;
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  });
}
export function eventCSV(s) {
  const keys = [
    'id',
    'attemptId',
    'roundId',
    'occurredAt',
    'receivedAt',
    'source',
    'type',
    'currency',
    'pfBalance',
    'hlBalance',
    'pfEquity',
    'personalEquity',
    'external',
    'C_ref',
    'payload'
  ];
  const escape = (x) => {
    let t = typeof x === 'object' ? JSON.stringify(x) : String(x ?? '');
    if (/^[=+@\t\r]/.test(t) || /^-\D/.test(t)) t = "'" + t;
    return '"' + t.replaceAll('"', '""') + '"';
  };
  return [keys.join(','), ...s.events.map((e) => keys.map((k) => escape(e[k])).join(','))].join('\r\n');
}
