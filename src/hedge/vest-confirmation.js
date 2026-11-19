import { dec, out } from './math.js';
import { vestContract } from './contract-currencies.js';

export const riskFields = [
  'sizeDecimals',
  'capitalInitMarginRatio',
  'fundedInitMarginRatio',
  'maintMarginRatio'
];
const codes = new Set(['USD', 'USDC', 'USDT']);

export function confirmVestSpec(asset, input, confirmedAt) {
  if (input.symbol !== asset + '-PERP' || input.baseAsset !== asset || !['BTC', 'ETH', 'SOL'].includes(asset))
    throw Error('请核对当前 Vest 永续合约代码和标的');
  if (!codes.has(input.quoteAsset) || !codes.has(input.settleAsset))
    throw Error('请核对报价币和结算币，目前支持 USD、USDC、USDT');
  if (![asset, 'contract'].includes(input.quantityUnit)) throw Error('请确认平台的下单数量单位');
  if (
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(input.contractMultiplier)) ||
    !dec(String(input.contractMultiplier)).gt(0)
  )
    throw Error('请填写大于零的合约乘数');
  if (!Number.isFinite(Date.parse(confirmedAt))) throw Error('缺少本次规格确认时间');
  const result = {
    symbol: input.symbol,
    baseAsset: asset,
    quoteAsset: input.quoteAsset,
    settleAsset: input.settleAsset,
    contractMultiplier: out(dec(String(input.contractMultiplier))),
    quantityUnit: input.quantityUnit,
    confirmedAt
  };
  for (const k of riskFields) {
    const raw = input[k];
    if (raw == null || raw === '') continue;
    if (k === 'sizeDecimals') {
      if (!/^\d{1,2}$/.test(String(raw)) || Number(raw) > 16) throw Error('数量小数位须为 0 至 16 的整数');
      result[k] = Number(raw);
    } else {
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(raw)) || !dec(String(raw)).gt(0) || dec(String(raw)).gt(1))
        throw Error('保证金率请按大于 0、至多为 1 的小数填写');
      result[k] = out(dec(String(raw)));
    }
  }
  return result;
}

// A manual declaration belongs to one exact Vest perpetual. It may complete
// missing metadata, never approve an unlisted symbol or erase a live conflict.
export function applyVestConfirmation(market, saved, stage) {
  if (!saved || market.specStatus === 'unlisted' || !market.pf) return market;
  const asset = market.asset,
    raw = market.spec;
  const blocked = (why) => ({ ...market, errors: { ...market.errors, spec: why } });
  try {
    const m = confirmVestSpec(asset, saved, saved.confirmedAt);
    if (market.pf.symbol !== m.symbol || (raw && raw.symbol !== m.symbol))
      return blocked('Vest 实时报价或规格的合约代码与本机确认不符');
    if (!raw && market.specStatus !== 'unavailable') return market;
    for (const [key, aliases] of [
      ['baseAsset', ['base', 'baseAsset']],
      ['quoteAsset', ['quote', 'quoteAsset']],
      ['settleAsset', ['settleAsset']]
    ]) {
      if (aliases.some((k) => raw?.[k] && raw[k] !== m[key]))
        return blocked('Vest 官方规格与手工确认冲突 · ' + key + '，请核对或撤销确认');
    }
    const remote = raw?.contract ?? vestContract(raw ?? { symbol: m.symbol });
    if (
      (remote.productType && remote.productType !== 'perpetual') ||
      (remote.payoffType && remote.payoffType !== 'linear') ||
      (remote.settlement && remote.settlement !== 'linear')
    )
      return blocked('Vest 合约类型与已确认的线性永续规格不符');
    const contract = { ...remote, evidence: { ...remote.evidence } };
    let manualTerms = !raw;
    for (const k of ['baseAsset', 'quoteAsset', 'settleAsset', 'contractMultiplier', 'quantityUnit']) {
      if (contract[k] != null && contract[k] !== '') {
        const agrees = k === 'contractMultiplier' ? dec(String(contract[k])).eq(m[k]) : contract[k] === m[k];
        if (!agrees) return blocked('Vest 官方规格与手工确认冲突 · ' + k + '，请核对或撤销确认');
      } else {
        contract[k] = m[k];
        contract.evidence[k] = '本机手工确认 ' + m.confirmedAt;
        manualTerms = true;
      }
    }
    const spec = { ...raw, symbol: m.symbol, contract };
    for (const k of riskFields)
      if (spec[k] == null && m[k] != null) {
        spec[k] = m[k];
        manualTerms = true;
        contract.evidence[k] = '本机手工确认 ' + m.confirmedAt;
      }
    if (manualTerms || !contract.settlement) {
      contract.settlement = 'linear';
      contract.source = [raw && remote.source, 'Vest 线性永续 · 本机手工确认 ' + m.confirmedAt]
        .filter(Boolean)
        .join(' / ');
    }
    const errors = { ...market.errors };
    if (!raw && market.specStatus === 'unavailable') delete errors.spec;
    const needed = [
      'sizeDecimals',
      stage === 'funded' ? 'fundedInitMarginRatio' : 'capitalInitMarginRatio',
      'maintMarginRatio'
    ];
    if (needed.some((k) => spec[k] == null))
      errors.specRisk = 'Vest 币种已核对，仓位计算还缺 ' + needed.filter((k) => spec[k] == null).join('、');
    return { ...market, spec, errors };
  } catch (e) {
    return blocked('Vest 本机确认无效 · ' + e.message);
  }
}
