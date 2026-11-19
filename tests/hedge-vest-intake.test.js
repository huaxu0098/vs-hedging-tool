import test from 'node:test';
import assert from 'node:assert/strict';
import { vestContract, hypeContract } from '../src/hedge/contract-currencies.js';
import { applyVestConfirmation, confirmVestSpec } from '../src/hedge/vest-confirmation.js';
import { currencyMapping } from '../src/hedge/quote-currencies.js';

const at = '2026-11-19T20:00:00Z';
const raw = {
  symbol: 'BTC-PERP',
  base: 'BTC',
  quote: 'USDC',
  asset: 'crypto',
  sizeDecimals: 4,
  capitalInitMarginRatio: '0.04',
  maintMarginRatio: '0.01'
};
const market = {
  asset: 'BTC',
  pf: { symbol: raw.symbol },
  spec: { ...raw, contract: vestContract(raw) },
  hl: { symbol: 'BTC', contract: hypeContract({ name: 'BTC' }, '', 0) },
  errors: {}
};
const input = {
  symbol: 'BTC-PERP',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  settleAsset: 'USDC',
  quantityUnit: 'BTC',
  contractMultiplier: '1'
};
const saved = confirmVestSpec('BTC', input, at);

test('Vest exchangeInfo 字段与官方结算规格分别标明证据，未知报价保持缺失', () => {
  const c = vestContract(raw);
  assert.deepEqual(
    [c.baseAsset, c.quoteAsset, c.settleAsset, c.contractMultiplier],
    ['BTC', 'USDC', 'USDC', '1']
  );
  assert.equal(c.evidence.quoteAsset, 'exchangeInfo.quote');
  assert.match(c.evidence.settleAsset, /官方/);
  assert.equal(vestContract({ ...raw, quote: undefined }).quoteAsset, null);
  assert.equal(vestContract({ ...raw, quoteAsset: 'USDT' }).metadataConflict, true);
});
test('缺失的本机确认字段按准确合约补入，冲突、无效乘数、下架和其他品种都不能通过', () => {
  const partial = { ...raw, quote: null },
    missing = { ...market, spec: { ...partial, contract: vestContract(partial) } };
  const corrected = applyVestConfirmation(missing, saved, 'challenge');
  assert.equal(corrected.spec.contract.quoteAsset, 'USDC');
  assert.match(corrected.spec.contract.evidence.quoteAsset, /本机手工确认/);
  assert.ok(!corrected.errors.spec);
  assert.equal(missing.spec.contract.quoteAsset, null);
  assert.match(
    applyVestConfirmation(market, { ...saved, quoteAsset: 'USDT' }, 'challenge').errors.spec,
    /冲突/
  );
  assert.match(
    applyVestConfirmation({ ...market, asset: 'ETH' }, saved, 'challenge').errors.spec,
    /不符|核对/
  );
  assert.throws(() => confirmVestSpec('BTC', { ...input, contractMultiplier: '0' }, at));
  const unlisted = { ...market, spec: null, specStatus: 'unlisted', errors: { spec: '未挂牌' } };
  assert.equal(applyVestConfirmation(unlisted, saved, 'challenge'), unlisted);
});
test('整份规格离线时需有已确认的数量和保证金规则，合约身份不能代替保证金', () => {
  const unavailable = {
    ...market,
    spec: null,
    specStatus: 'unavailable',
    errors: { spec: '离线', hl: '过期' }
  };
  assert.match(applyVestConfirmation(unavailable, saved, 'challenge').errors.specRisk, /sizeDecimals/);
  const params = confirmVestSpec(
    'BTC',
    { ...input, sizeDecimals: '4', capitalInitMarginRatio: '0.04', maintMarginRatio: '0.01' },
    at
  );
  const recovered = applyVestConfirmation(unavailable, params, 'challenge');
  assert.equal(recovered.spec.sizeDecimals, 4);
  assert.deepEqual(recovered.errors, { hl: '过期' });
  assert.match(applyVestConfirmation(unavailable, params, 'funded').errors.specRisk, /fundedInitMarginRatio/);
});
test('Vest 规格缺失时 Hype 的原生每点盈亏仍可独立识别', () => {
  const result = currencyMapping({ ...market, spec: null }, {}, Date.parse(at), 5000);
  assert.equal(result.ok, false);
  assert.match(result.error, /QUOTE_CURRENCY_UNVERIFIED/);
  assert.equal(result.legs.hl.pointToLedger.mid, '1');
  assert.equal(result.hypeToVest, undefined);
});
