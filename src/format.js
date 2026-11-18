export const escapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );
export function number(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  if (value !== 0 && Math.abs(value) < 10 ** -digits) {
    return value.toLocaleString('zh-CN', { maximumSignificantDigits: 3 });
  }
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}
export const money = (value) => number(value) + ' U';
export const signed = (value, digits = 2) => (value > 0 ? '+' : '') + number(value, digits);
export const stateNames = {
  matched: '匹配可交易',
  'one-sided': '仅单边满足',
  unmatched: '不匹配',
  unverified: '无法验证'
};
