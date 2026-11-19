// Canonical JSON keeps the ID stable across key order and records exactly what the solver received.
const canonical = (value) =>
  JSON.stringify(value, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]])
        )
      : x
  );

function fingerprint(json) {
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < json.length; i++) {
    a = Math.imul(a ^ json.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ json.charCodeAt(i);
  }
  return [a, b].map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
}

export function calculationTrace(rules, accounts, market, rates, at, settings = {}) {
  const model = 'AUTO-0.21';
  const options = Object.fromEntries(
    ['cashSearchBudget', 'priorTarget', 'searchBudget', 'scanRatios']
      .filter((k) => settings[k] != null)
      .map((k) => [k, settings[k]])
  );
  const inputs = canonical({ model, rules, accounts, market, rates, options });
  return {
    model,
    id: fingerprint(at + inputs),
    rulesId: fingerprint(canonical(rules)),
    accountsId: fingerprint(canonical(accounts)),
    marketId: fingerprint(canonical([market, rates])),
    at: new Date(at).toISOString(),
    inputs
  };
}
