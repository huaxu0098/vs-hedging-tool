import { calculateCurrent } from './current.js';

self.onmessage = ({ data }) => {
  const { version, r, a, m, rates, t } = data;
  try {
    const start = performance.now();
    const result = calculateCurrent(r, a, m, rates, t, { priorTarget: data.priorTarget });
    result.solveMs = Math.round(performance.now() - start);
    self.postMessage({ version, result });
  } catch (e) {
    self.postMessage({ version, error: e.message });
  }
};
