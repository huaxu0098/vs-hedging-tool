import { defaults } from './workspace.js';
import { createBook } from './book.js';
import { solve, demoMarket } from './solver.js';
import { applyTargets, atPrice, settleBoundary } from './replay.js';
import { fundedPreviewLimits } from './sizing-parameters.js';

const challengeParameters = {
  target: '10100', R: '100', g: '0', k: '0', mode: 'auto', sizes: ['5000', '10000', '15000'],
  sort: 'gain', directions: [1, -1]
};
export const fundedParameters = { ...challengeParameters, ...fundedPreviewLimits };

export function simulateStage(book, market, parameters, at) {
  const result = solve(book, market, parameters, { now: at });
  if (!result.selected) return { result, book, market, parameters };
  const { vsTargetQuantity: pf, hlTargetQuantity: hl, lines } = result.selected;
  const opened = applyTargets(book, market, { pf, hl }, at, book.stage + '/open');
  const settle = (event, shift) => {
    const exitMarket = atPrice(market, shift);
    return { ...settleBoundary(opened, exitMarket, event, at, book.stage + '/' + event), market: exitMarket };
  };
  return {
    result,
    book,
    market,
    parameters,
    pass: settle('pass', lines.pass),
    fail: settle('failure', lines.fail)
  };
}

export function defaultChallenge(at) {
  return simulateStage(
    createBook({ ...defaults, id: 'challenge-preview', pf: defaults.baseline, time: at }),
    demoMarket('btc'), challengeParameters, at
  );
}
