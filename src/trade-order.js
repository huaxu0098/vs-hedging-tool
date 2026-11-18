// Only signed changes in native venue quantities belong in an order ticket.
export function orderLeg(candidate, asset, venue) {
  const pos = candidate?.[venue],
    spec = asset?.[venue];
  if (!pos || !spec || !Number.isFinite(pos.tradeQty) || pos.tradeQty === 0) return null;
  const qty = Math.abs(pos.tradeQty);
  const quantity = qty.toFixed(14).replace(/\.?0+$/, '');
  if (!Number(quantity) || Math.abs(Number(quantity) - qty) > spec.step / 1000000) return null;
  return {
    venue,
    symbol: spec.symbol,
    side: pos.tradeQty > 0 ? 'buy' : 'sell',
    quantity,
    unit: spec.qtyUnit,
    notional: pos.tradeNotional,
    leverage: spec.leverage,
    marginMode: spec.marginMode,
    reduceOnly: false,
    currentQty: candidate?.limits?.[venue]?.currentQty ?? pos.targetQty - pos.tradeQty
  };
}

export function liveOrder(display, snapshot, fresh) {
  const reject = (reason) => ({ reason, plan: null });
  if (snapshot?.mode !== 'live') return reject('开仓需要实时行情，可在上方切换。');
  if (!snapshot.mappingVerified) return reject('请先在行情接入中核对两边的合约映射。');
  if (
    !snapshot.accountAddress ||
    !/^0x[\da-f]{40}$/i.test(snapshot.accountAddress) ||
    !snapshot.hype?.account
  )
    return reject('在行情接入中填写 Hype 公开钱包地址并同步持仓。');
  if (snapshot.endpoint !== 'https://api.hyperliquid.xyz/info')
    return reject('官方交易页使用 Hype 主网，请匹配主网账户与行情。');
  const acct = snapshot.vs?.account;
  if (acct?.accountContext && ['passed', 'failed'].includes(acct.outcome?.status))
    return reject('VS 账户已记录阶段结束，请核对新的交易账户。');
  if (
    !acct?.accountContext ||
    !['challenge', 'funded'].includes(acct.stage) ||
    !Array.isArray(acct.positions)
  )
    return reject('在 Vest 展开当前账户与完整持仓。若页面没有账户编号，在下方「连接交易页与扩展」绑定当前账户。');
  if (!display || display.config.useExternalAccounts === false)
    return reject('在「账户与规则」启用外部只读账户，使用当前双平台余额及持仓。');
  if (!display.candidate?.ok || display.blocked) return reject('当前方案尚未通过双平台资金和风控验算。');
  if (!fresh || display.expires <= Date.now()) return reject('等待最新报价和仓位验算。');
  const legs = ['vs', 'hype'].map((v) => orderLeg(display.candidate, display.asset, v));
  if (
    legs.some(
      (l) =>
        !l ||
        !Number.isFinite(l.notional) ||
        l.notional <= 0 ||
        Math.sign(display.candidate[l.venue].targetQty) !== Math.sign(display.candidate[l.venue].tradeQty) ||
        (display.candidate[l.venue].targetQty - display.candidate[l.venue].tradeQty) *
          display.candidate[l.venue].tradeQty <
          -1e-10 ||
        l.symbol !== snapshot[l.venue]?.symbol
    ) ||
    legs[0].side === legs[1].side
  )
    return reject('当前差额涉及平仓、反手、零数量或合约代码不一致，不能作为双边开仓单。');
  if (
    !['BTC-PERP', 'ETH-PERP', 'SOL-PERP'].includes(legs[0].symbol) ||
    legs[0].symbol !== legs[1].symbol + '-PERP' ||
    legs.some((l) => l.unit !== legs[1].symbol)
  )
    return reject('该合约的官网下单单位尚未验证。目前网页执行支持 BTC、ETH、SOL 的原生币数量。');
  const { vs, hype } = display.asset;
  if (
    snapshot.vestContract?.symbol !== legs[0].symbol ||
    snapshot.vestContract?.quote !== vs.quote ||
    [vs, hype].some(
      (spec) => spec.type !== 'linear' || spec.multiplier !== 1 || (spec.quoteScale ?? 1) !== 1
    ) ||
    vs.settle !== 'USDC' ||
    vs.quote !== 'USDC' ||
    hype.settle !== snapshot.hype.settleCurrency ||
    hype.quote !== snapshot.hype.documentedQuote ||
    hype.settle !== 'USDC'
  )
    return reject(
      '实盘开仓要求原生币线性 1:1 合约，VS 报价及结算为 USDC，Hype 币种与主网规格一致。请核对合约规格。'
    );
  legs[0].accountContext = acct.accountContext;
  legs[0].stage = acct.stage;

  legs[1].address = snapshot.accountAddress.toLowerCase();
  return { reason: '', plan: { assetId: display.asset.id, expires: display.expires, legs } };
}
