(() => {
  if (self !== top || location.origin !== 'https://app.hyperliquid.xyz') return;
  const fail = (message) => {
    throw Error('Hype：' + message);
  };
  const check = (ok, message) => {
    if (!ok) fail(message);
  };
  const txt = (el) => el?.textContent?.trim() ?? '';
  const visible = (el) =>
    el?.isConnected &&
    !el.closest('[hidden],[inert],[aria-hidden="true"]') &&
    el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
    el.getClientRects().length;
  const all = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const one = (items, message) => {
    check(items.length === 1, message);
    return items[0];
  };
  const leaves = (root, value) =>
    all(root, 'div,span,a,button').filter((el) => !el.children.length && txt(el) === value);
  const enabled = (el) => !el.disabled && !el.matches('.disabled,[aria-disabled="true"],:disabled');
  let prepared,
    ownedMenu,
    serial = 0;

  function validate(leg) {
    check(
      leg?.venue === 'hype' &&
        /^[A-Za-z0-9]+(?::[A-Za-z0-9]+)?$/.test(leg.symbol) &&
        decodeURIComponent(location.pathname).replace(/\/$/, '') === '/trade/' + leg.symbol &&
        !location.search &&
        !location.hash,
      '打开准确的官方永续合约页面。'
    );
    check(
      typeof leg.unit === 'string' && leg.unit === leg.symbol.split(':').at(-1),
      '未核实实际币量单位。'
    );
    check(
      typeof leg.address === 'string' && /^0x[0-9a-f]{40}$/i.test(leg.address),
      '缺少看板完整的只读钱包地址。'
    );
    check(
      ['buy', 'sell'].includes(leg.side) &&
        typeof leg.quantity === 'string' &&
        /^\d{1,18}(?:\.\d{1,18})?$/.test(leg.quantity) &&
        Number(leg.quantity) > 0 &&
        Number.isFinite(leg.currentQty) &&
        Number.isFinite(leg.leverage) &&
        leg.leverage > 0 &&
        ['cross', 'isolated'].includes(leg.marginMode),
      '缺少仓位、方向、杠杆或保证金模式。'
    );
    check(
      leg.reduceOnly === false && leg.currentQty * (leg.side === 'buy' ? 1 : -1) >= 0,
      '仅支持新开或同向加仓。'
    );
    check(
      !all(
        document,
        'dialog[open],.modal,[aria-modal="true"],[data-testid="device-authentication-lock-screen"]'
      ).length,
      '请本人先处理平台弹窗或解锁。'
    );
  }
  function orderForm(leg) {
    validate(leg);
    const size = one(all(document, '[data-testid="sz-input"]'), '未找到唯一币量输入区。');
    let form = size.parentElement;
    while (form && form.id !== 'root' && !all(form, 'button[color="primary"]').length)
      form = form.parentElement;
    check(
      form && form.id !== 'root' && !form.contains(document.querySelector('a[href="/portfolio"]')),
      '委托表单结构未核实。'
    );
    const tabs = one(all(form, '[data-testid^="tab-selected-"]'), '未找到委托类型。');
    const side = Object.fromEntries(
      ['Buy / Long', 'Sell / Short'].map((label, i) => [
        i ? 'sell' : 'buy',
        one(
          all(form, '[aria-pressed]').filter((el) => txt(el) === label),
          '买卖控件不明确。'
        )
      ])
    );
    const input = one(all(size, 'input'), '实际数量输入框不明确。');
    check(enabled(input) && !input.readOnly, '数量输入框不可编辑。');
    const unitBox = input.nextElementSibling;
    check(visible(unitBox) && leaves(size, 'Size').length === 1, '数量单位结构不明确。');
    const buttons = all(form, 'button');
    check(
      !buttons.some((el) => /^(Connect|Enable Trading|Deposit to Trade)$/i.test(txt(el))),
      '请本人先连接钱包并在官网启用交易。'
    );
    check(
      buttons.filter((el) => txt(el) === (leg.marginMode === 'cross' ? 'Cross' : 'Isolated')).length ===
        1 &&
        buttons.filter(
          (el) => /^\d+(?:\.\d+)?x$/.test(txt(el)) && Number(txt(el).slice(0, -1)) === leg.leverage
        ).length === 1,
      '页面杠杆或逐仓／全仓设置与试算不一致。'
    );
    const pos = one(leaves(form, 'Current Position'), '无法核对当前持仓。').parentElement.lastElementChild;
    const position = /^([+-]?[\d,]+(?:\.\d+)?)\s+(\S+)$/.exec(txt(pos));
    check(position && position[2] === leg.unit, '持仓数量与单位缺少明确标识。');
    let qty = Number(position[1].replaceAll(',', ''));
    if (qty && !/^[+-]/.test(position[1])) {
      // The official desktop position field renders abs(size). Its g3 color
      // mapping is the only side marker in this field; unknown themes fail closed.
      const leaf = one(leaves(pos, txt(pos)).concat(pos.children.length ? [] : [pos]), '持仓方向不明确。');
      const color = getComputedStyle(leaf).color;
      check(['rgb(31, 166, 125)', 'rgb(237, 112, 136)'].includes(color), '无法核实名义持仓的多空方向。');
      if (color === 'rgb(237, 112, 136)') qty = -qty;
    }
    check(qty === leg.currentQty, '官方持仓已变化，与试算原仓不一致。');
    for (const label of ['Reduce Only', 'Take Profit / Stop Loss']) {
      const field = one(leaves(form, label), '缺少 ' + label + ' 状态。');
      let row = field.parentElement;
      while (row && row !== form && !(row.children.length === 2 && row.lastElementChild.contains(field)))
        row = row.parentElement;
      check(
        row &&
          row !== form &&
          row.firstElementChild.tagName === 'DIV' &&
          row.firstElementChild.childNodes.length === 0 &&
          visible(row.firstElementChild),
        '请本人核对并关闭 ' + label + '。'
      );
    }
    const fullMarket = all(document, '.ellipsis').filter(
      (el) =>
        el.children.length === 0 &&
        [leg.unit + '-USDC', leg.unit + '-USDT', leg.unit + '-USDH'].includes(txt(el))
    );
    check(fullMarket.length === 1, '当前显示的永续市场代码不明确。');
    return { tabs, side, input, unitBox, form, market: txt(fullMarket[0]) };
  }

  function walletHeader(leg) {
    const addr = leg.address.toLowerCase(),
      short = addr.slice(0, 6) + '...' + addr.slice(-4);
    const trade = one(
      all(document, 'a[href="/trade"]').filter((e) => txt(e) === 'Trade'),
      '无法核对官方导航栏。'
    );
    let node = trade.parentElement;
    while (node && !node.querySelector('[data-testid="sz-input"]') && node.id !== 'root') {
      if (node.querySelector('a[href="/portfolio"]')) {
        const names = all(node, 'div').filter((e) => !e.children.length && txt(e).toLowerCase() === short);
        if (names.length) {
          const header = one(names, '当前钱包显示不唯一。');
          check(getComputedStyle(header).color !== 'rgb(237, 112, 136)', '页面正在查看只读地址。');
          return header;
        }
      }
      node = node.parentElement;
    }
    fail('需要顶部显示与看板一致的主钱包，无法核实子账户、代管账户或缩写身份。');
  }
  function walletMenu(leg) {
    const menu = one(
      all(document, '#root > .dropper').filter((el) => leaves(el, 'Disconnect').length === 1),
      '账户菜单未就绪。'
    );
    const isMulti = !!leaves(menu, 'Master').length;
    const scope = isMulti
      ? one(
          all(menu, '.selected').filter((el) => leaves(el, 'Master').length === 1),
          '当前交易账户不是已核实的主钱包。'
        )
      : menu;
    const short = txt(walletHeader(leg)).toLowerCase();
    const anchor = one(
      all(scope, 'div').filter((el) => !el.children.length && txt(el).toLowerCase() === short),
      '当前交易账户和地址提示不一致。'
    );
    return { menu, anchor };
  }
  function tooltip() {
    return all(document, '#root > div').filter(
      (el) =>
        /^0x[0-9a-f]{40}$/i.test(txt(el)) &&
        getComputedStyle(el).position === 'fixed' &&
        getComputedStyle(el).pointerEvents === 'none'
    );
  }
  function until(read) {
    return new Promise((resolve, reject) => {
      let error;
      const observer = new MutationObserver(attempt);
      const repaint = setInterval(attempt, 80);
      const timer = setTimeout(() => {
        observer.disconnect();
        clearInterval(repaint);
        reject(error ?? Error('Hype：页面未及时就绪。'));
      }, 2100);
      function attempt() {
        try {
          const value = read();
          if (!value) return;
          observer.disconnect();
          clearInterval(repaint);
          clearTimeout(timer);
          resolve(value);
        } catch (e) {
          error = e;
        }
      }
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });
      attempt();
    });
  }
  async function revealWallet(leg) {
    const header = walletHeader(leg);
    check(!all(document, '#root > .dropper').length, '请先关闭当前菜单。');
    header.click();
    const menu = await until(() => walletMenu(leg));
    ownedMenu = { menu: menu.menu, header };
    check(!tooltip().length, '已有地址提示打开，请收起钱包菜单后重新准备。');
    menu.anchor.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    const proof = await until(() => {
      const tip = one(tooltip(), '等待官方完整地址提示。');
      check(txt(tip).toLowerCase() === leg.address.toLowerCase(), '官网完整地址与看板不符。');
      return tip;
    });
    return { ...menu, proof };
  }
  async function closeOwnMenu() {
    const old = ownedMenu;
    ownedMenu = null;
    if (!old?.menu.isConnected || !old.header.isConnected) return;
    const menus = all(document, '#root > .dropper');
    if (menus.length !== 1 || menus[0] !== old.menu) return;
    old.header.click();
    await until(() => !visible(old.menu));
  }
  function readPrepared(leg) {
    validate(leg);
    const active = walletMenu(leg);
    check(
      prepared &&
        active.menu === prepared.menu &&
        active.anchor === prepared.anchor &&
        one(all(document, '#root > .dropper, .dropper-select-list'), '有其他菜单打开，请重新准备。') ===
          active.menu &&
        one(tooltip(), '近期完整地址无法核实，请重新准备。') === prepared.proof &&
        txt(prepared.proof).toLowerCase() === leg.address.toLowerCase(),
      '钱包已变化，请重新准备。'
    );
    return readOrder(leg);
  }
  function readOrder(leg) {
    const info = orderForm(leg);
    check(
      info.tabs.dataset.testid === 'tab-selected-market' &&
        info.side[leg.side].getAttribute('aria-pressed') === 'true' &&
        info.side[leg.side === 'buy' ? 'sell' : 'buy'].getAttribute('aria-pressed') === 'false',
      '市价或买卖方向已变化。'
    );
    const clean = (v) =>
      v
        .replace(/^0+(?=\d)/, '')
        .replace(/(\.\d*?)0+$/, '$1')
        .replace(/\.$/, '');
    check(
      txt(info.unitBox) === leg.unit && clean(info.input.value) === clean(leg.quantity),
      '实际币量或单位与计划不一致。'
    );
    const submit = one(
      all(info.form, 'button[type="button"][color="primary"]').filter(
        (el) => txt(el) === 'Place Order' && enabled(el)
      ),
      '准确的 Place Order 按钮未启用。'
    );
    const fingerprint = JSON.stringify([
      leg.address.toLowerCase(),
      leg.symbol,
      info.market,
      leg.side,
      leg.quantity,
      leg.unit,
      leg.currentQty,
      leg.leverage,
      leg.marginMode
    ]);
    return { fingerprint, submit };
  }
  globalThis.tradeVenue = Object.freeze({
    async prepare(leg) {
      const id = ++serial;
      prepared = null;
      const live = () => {
        check(id === serial, '已被另一次准备取代。');
        return orderForm(leg);
      };
      live();
      await closeOwnMenu();
      check(!all(document, '#root > .dropper, .dropper-select-list').length, '请先关闭正在操作的菜单。');
      const identity = await revealWallet(leg);
      live();
      await closeOwnMenu();
      await until(() => !visible(identity.menu) && !visible(identity.proof));
      const first = live();
      if (first.tabs.dataset.testid !== 'tab-selected-market') {
        one(leaves(first.tabs, 'Market'), '市价选项未核实。').click();
        await until(() => live().tabs.dataset.testid === 'tab-selected-market');
      }
      const button = live().side[leg.side];
      if (button.getAttribute('aria-pressed') !== 'true') {
        button.click();
        await until(() => live().side[leg.side].getAttribute('aria-pressed') === 'true');
      }
      const field = live();
      if (txt(field.unitBox) !== leg.unit) {
        check(['USDC', 'USDT', 'USDH'].includes(txt(field.unitBox)), '当前数量单位无法核实。');
        one(
          all(field.unitBox, 'div').filter((el) => el.querySelector(':scope > svg')),
          '单位选择器不明确。'
        ).click();
        const option = await until(() =>
          one(
            all(document, '.dropper-select-list [role="listbox"] [role="option"]').filter(
              (el) => txt(el) === leg.unit
            ),
            '找不到官方币量单位。'
          )
        );
        option.click();
        await until(() => txt(live().unitBox) === leg.unit);
      }
      const input = live().input;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, leg.quantity);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const wallet = await revealWallet(leg);
      live();
      prepared = wallet;
      try {
        const result = await until(() => {
          live();
          return readPrepared(leg);
        });
        prepared = { ...wallet, ...result };
        return result.fingerprint;
      } catch (error) {
        prepared = null;
        throw error;
      }
    },
    verify(leg) {
      const result = readPrepared(leg);
      check(
        result.submit === prepared.submit && result.fingerprint === prepared.fingerprint,
        '委托表单已换页或发生变化。'
      );
      return result.fingerprint;
    },
    submit(leg) {
      try {
        this.verify(leg);
        const { submit, fingerprint } = prepared;
        // Closing our own wallet menu must not replace the order button or ticket.
        walletHeader(leg).click();
        ownedMenu = null;
        const current = readOrder(leg);
        check(current.submit === submit && current.fingerprint === fingerprint, '委托已变化，请重新准备。');
        prepared = null;
        submit.click();
      } finally {
        prepared = null;
        ++serial;
      }
    }
  });
})();
