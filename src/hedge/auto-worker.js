import { calculateCurrent } from './current.js';

self.onmessage = ({ data }) => {
  const { version, r, a, m, rates, t } = data;
  try {
    self.postMessage({
      version,
      result: calculateCurrent(r, a, m, rates, t, { priorTarget: data.priorTarget })
    });
  } catch (e) {
    self.postMessage({ version, error: e.message });
  }
};
