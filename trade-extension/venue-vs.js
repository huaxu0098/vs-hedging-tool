// Vest's public BTC/ETH/SOL ticket expresses direction through two separate
// submit buttons. Selecting a direction during preparation would place an order.
(() => {
  if (self !== top) return;
  let prepared = null;
  let generation = 0;
  const units = new Map([
    ['BTC-PERP', 'BTC'],
    ['ETH-PERP', 'ETH'],
    ['SOL-PERP', 'SOL']
  ]);
  const fail = (text) => {
    throw Error('VS：' + text);
  };
  function decimal(raw, signed = false) {
    // Match decimals exactly even if React reformats a quantity with trailing zeros.
    const text = String(raw),
      pattern = signed ? /^-?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/;
    if (text.length > 42 || !pattern.test(text)) return null;
    let [whole, part = ''] = text.replace(/^-/, '').split('.');
    whole = whole.replace(/^0+(?=\d)/, '');
    part = part.replace(/0+$/, '');
    return (text.startsWith('-') && (whole !== '0' || part) ? '-' : '') + whole + (part ? '.' + part : '');
  }
  function visible(node) {
    return (
      node.isConnected &&
      !node.closest('[hidden],[inert],[aria-hidden="true"]') &&
      node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      node.getClientRects().length
    );
  }
  function one(root, id, tag) {
    const found = [...root.querySelectorAll('[data-testid="' + id + '"]')].filter(visible);
    if (found.length !== 1 || (tag && found[0].tagName !== tag)) fail('找不到唯一的官方控件 ' + id + '。');
    return found[0];
  }
  function enabled(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true')
      fail('控件尚未启用 ' + el.dataset.testid + '。');
    return el;
  }
  function guard(leg) {
    const url = new URL(location.href),
      unit = units.get(leg?.symbol);
    if (
      leg?.venue !== 'vs' ||
      url.origin !== 'https://next.vestmarkets.com' ||
      url.username ||
      url.password ||
      !unit ||
      url.pathname.replace(/\/$/, '') !== '/trade/' + leg.symbol ||
      leg.unit !== unit
    )
      fail('官网交易品种或实际数量单位未核实。');
    if (
      !['buy', 'sell'].includes(leg.side) ||
      !['challenge', 'funded'].includes(leg.stage) ||
      typeof leg.accountContext !== 'string' ||
      !leg.accountContext.trim() ||
      typeof leg.quantity !== 'string' ||
      !decimal(leg.quantity) ||
      decimal(leg.quantity) === '0' ||
      decimal(leg.currentQty, true) === null ||
      (leg.reduceOnly !== undefined && typeof leg.reduceOnly !== 'boolean')
    )
      fail('缺少已确认账户、原仓、方向或数量。');
    if (leg.reduceOnly !== false || Number(leg.currentQty) * (leg.side === 'buy' ? 1 : -1) < 0)
      fail('此入口仅可新开或同向加仓。');
    // Vest documents cross margin for all markets. Compare the active order leverage
    // on the actual form, not the unrelated market's maximum leverage.
    if (leg.marginMode !== 'cross' || !Number.isFinite(leg.leverage) || leg.leverage < 1)
      fail('Vest 公开规格为全仓，需要已核实的全仓杠杆。');
    const blockers = [
      ...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')
    ].filter(visible);
    if (blockers.length) fail('官网有待处理的弹窗，请本人检查。');
    const read = globalThis.readVisibleVest;
    if (typeof read !== 'function') fail('当前交易扩展未加载账户读取器。');
    const snapshot = read(document, location),
      account = snapshot?.account;
    if (
      snapshot?.symbol !== leg.symbol ||
      account?.accountContext !== leg.accountContext ||
      account.stage !== leg.stage ||
      account.outcome ||
      !Array.isArray(account.positions)
    )
      fail('当前可见账户标识、阶段或完整仓位与看板不符。');
    const rows = account.positions.filter((row) => row.symbol === leg.symbol);
    if (rows.length > 1 || decimal(rows.length ? rows[0].qty : 0, true) !== decimal(leg.currentQty, true))
      fail('官网现仓与建议使用的原始数量不同，请更新看板。');
    const info = one(document, 'market-info');
    if (!info.innerText.split(/\n/).some((line) => line.trim() === unit))
      fail('官网市场栏尚未切换到所选合约。');
    const panel = one(document, 'order-form');
    const shown = one(panel, 'leverage-button', 'BUTTON')
      .innerText.trim()
      .match(/^(\d+(?:\.\d+)?)\s*[x×]$/i);
    if (!shown || decimal(shown[1]) !== decimal(leg.leverage)) fail('官网订单杠杆与计划不同，请本人核对。');
    return panel;
  }
  const checked = (panel, id) => one(panel, id, 'BUTTON').getAttribute('aria-checked');
  function read(leg) {
    const panel = guard(leg),
      market = one(panel, 'ordertype-tab-market', 'BUTTON');
    if (market.getAttribute('aria-selected') !== 'true' || market.dataset.state !== 'active')
      fail('委托类型尚未确认为市价。');
    if (one(panel, 'size-unit-toggle', 'BUTTON').innerText.trim() !== leg.unit) fail('委托数量单位不匹配。');
    const input = one(panel, 'size-input', 'INPUT');
    if (
      input.inputMode !== 'decimal' ||
      input.readOnly ||
      input.disabled ||
      decimal(input.value) !== decimal(leg.quantity)
    )
      fail('官网输入框中的实际数量与委托不符。');
    if (
      checked(panel, 'tpsl-toggle') !== 'false' ||
      checked(panel, 'reduce-only-checkbox') !== String(leg.reduceOnly === true)
    )
      fail('官网附加止盈止损或仅减仓选项与委托不符。');
    if (one(panel, 'tif-select', 'BUTTON').innerText.trim() !== 'IOC') fail('官网市价单未确认为 IOC。');
    const button = one(panel, leg.side === 'buy' ? 'submit-long' : 'submit-short', 'BUTTON');
    if (button.type !== 'submit') fail('官方方向提交控件已改变。');
    enabled(button);
    const fingerprint = JSON.stringify([
      leg.accountContext,
      leg.stage,
      leg.symbol,
      leg.side,
      leg.unit,
      decimal(leg.quantity),
      decimal(leg.currentQty, true),
      leg.reduceOnly === true,
      'market',
      'IOC',
      leg.marginMode,
      leg.leverage
    ]);
    return { button, fingerprint };
  }
  async function prepare(leg) {
    prepared = null;
    const ticket = ++generation;
    function panel() {
      if (ticket !== generation) fail('这次准备已被更新的委托替代。');
      return guard(leg);
    }
    async function wait(check) {
      for (let i = 0; i < 20; i++) {
        const value = check(panel());
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      fail('官网尚未确认所选委托参数。');
    }
    const market = one(panel(), 'ordertype-tab-market', 'BUTTON');
    if (market.type !== 'button' || market.getAttribute('role') !== 'tab') fail('官网市价标签语义已改变。');
    if (market.getAttribute('aria-selected') !== 'true') {
      enabled(market).click();
      await wait((p) => one(p, 'ordertype-tab-market', 'BUTTON').getAttribute('aria-selected') === 'true');
    }
    const toggle = one(panel(), 'size-unit-toggle', 'BUTTON'),
      unit = toggle.innerText.trim();
    if (unit !== leg.unit) {
      if (unit !== 'USD' || toggle.type !== 'button') fail('当前数量单位无法确认。');
      enabled(toggle).click();
      await wait((p) => one(p, 'size-unit-toggle', 'BUTTON').innerText.trim() === leg.unit);
    }
    if (checked(panel(), 'tpsl-toggle') !== 'false') fail('请先检查并手动关闭附带止盈止损。');
    if (checked(panel(), 'reduce-only-checkbox') !== 'false')
      fail('此开仓委托要求本人核实并取消仅减仓设置。');
    const input = one(panel(), 'size-input', 'INPUT');
    if (input.disabled || input.readOnly || input.inputMode !== 'decimal') fail('数量输入控件无法编辑。');
    const submitId = leg.side === 'buy' ? 'submit-long' : 'submit-short';
    const write = (el, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    // The ticket copies its display value into the official order state in a
    // React effect. Observe the submit button disabling for zero, then enabling
    // for the requested quantity. Reading back the input alone cannot prove this.
    if (input.value !== '') write(input, '');
    await wait((p) => one(p, 'size-input', 'INPUT').value === '' && one(p, submitId, 'BUTTON').disabled);
    write(one(panel(), 'size-input', 'INPUT'), leg.quantity);
    await wait(
      (p) =>
        decimal(one(p, 'size-input', 'INPUT').value) === decimal(leg.quantity) &&
        !one(p, submitId, 'BUTTON').disabled
    );
    const { fingerprint, button } = read(leg);
    prepared = { fingerprint, button };
    return fingerprint;
  }
  function verify(leg) {
    const current = read(leg);
    if (!prepared || prepared.fingerprint !== current.fingerprint || prepared.button !== current.button)
      fail('表单或账户已变化，请重新准备。');
    return current.fingerprint;
  }
  function submit(leg) {
    try {
      verify(leg);
      const { button } = prepared;
      prepared = null;
      ++generation;
      button.click();
    } finally {
      prepared = null;
    }
  }
  globalThis.tradeVenue = Object.freeze({ prepare, verify, submit });
})();
