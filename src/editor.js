const assetGroups = [
  [
    '品种与参考价格',
    [
      ['name', '品种名称', 'text'],
      ['ticker', '品种简称', 'text'],
      ['unit', '标的单位', 'text'],
      ['priceUnit', '价格轴单位', 'text'],
      ['benchmark', '共同跟踪基准', 'text'],
      ['referencePrice', '参考价格', 'positive']
    ]
  ],
  [
    '匹配条件',
    [
      ['minBuffer', '最小强平缓冲（原生价格单位）', 'nonnegative'],
      ['maxBasisPct', '最大基准价格偏离（%）', 'nonnegative'],
      ['maxAgeSec', '报价有效期（秒）', 'positive']
    ]
  ]
];

const legGroups = [
  [
    '合约与基准',
    [
      ['symbol', '合约代码', 'text'],
      ['benchmark', '跟踪基准标识', 'text'],
      ['type', '合约类型', 'select'],
      ['qtyUnit', '下单数量单位', 'text']
    ]
  ],
  [
    '报价与折算',
    [
      ['price', '当前中间价（本地报价单位）', 'positive'],
      ['spread', '完整买卖点差（本地报价单位）', 'nonnegative'],
      ['tick', '最小价格变动', 'positive'],
      ['ratio', '参考价每变动 1 单位对应的报价变动', 'positive'],
      ['quote', '报价币种', 'currency'],
      ['quoteUsd', '1 单位报价币种折合 USD', 'fx'],
      [
        'quoteScale',
        '本地报价对应的原生标的数量',
        'positive',
        '同单位填 1。按克报价、以金衡盎司为原生单位时，填 0.0321507466。'
      ],
      ['settle', '结算币种', 'currency'],
      ['settleUsd', '1 单位结算币种折合 USD', 'fx'],
      ['asOf', '报价时间（本机时间）', 'time'],
      ['open', '市场开市', 'checkbox']
    ]
  ],
  [
    '下单与逐仓保证金',
    [
      ['multiplier', '每单位仓位每报价点价值（结算币）', 'positive'],
      ['minQty', '最小下单量', 'positive'],
      ['step', '数量步长', 'positive'],
      ['minNotional', '最小单笔成交名义额（USD）', 'nonnegative'],
      ['feeRate', '单边手续费率（%）', 'rate'],
      ['leverage', '初始保证金杠杆（倍）', 'leverage'],
      ['mmr', '维持保证金率（%）', 'rate']
    ]
  ]
];

function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function makeButton(label, className) {
  const button = el('button', className, label);
  button.type = 'button';
  return button;
}

function localTime(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
}

function draftFrom(asset, isNew) {
  const draft = structuredClone(asset);
  if (!isNew) return draft;
  draft.id = crypto.randomUUID();
  draft.name = '';
  draft.ticker = '';
  draft.benchmark = '';
  draft.verified = false;
  for (const leg of [draft.vs, draft.hype]) {
    leg.symbol = '';
    leg.benchmark = '';
  }
  return draft;
}

function makeField([key, label, kind, hint], record, section, panelIndex, readers) {
  const wrapper = el('label', 've-field');
  wrapper.append(el('span', 've-label', label));
  const control = el(kind === 'select' ? 'select' : 'input', 've-control');
  const value =
    key === 'quoteScale'
      ? (record.quoteScale ?? 1)
      : key === 'minNotional'
        ? (record.minNotional ?? 0)
        : record[key];
  control.name = section + '.' + key;
  if (kind === 'select') {
    const types = [
      ['linear', '线性合约'],
      ['inverse', '反向合约'],
      ['nonlinear', '非线性合约'],
      ['other', '其他类型']
    ];
    if (value && !types.some(([id]) => id === value)) types.push([value, value]);
    for (const [id, name] of types) {
      const option = el('option', '', name);
      option.value = id;
      control.append(option);
    }
    control.value = value || 'linear';
  } else if (kind === 'checkbox') {
    wrapper.classList.add('ve-check-field');
    control.type = 'checkbox';
    control.checked = !!value;
  } else if (kind === 'text' || kind === 'currency') {
    control.type = 'text';
    control.maxLength = kind === 'currency' ? 16 : 90;
    control.required = true;
    control.value = value ?? '';
  } else if (kind === 'time') {
    control.type = 'datetime-local';
    control.required = true;
    control.step = 'any';
    control.value = localTime(value);
  } else {
    control.type = 'number';
    control.step = 'any';
    control.min = kind === 'leverage' ? '1' : '0';
    if (kind === 'rate' || kind === 'percent') control.max = '100';
    control.required = kind !== 'fx';
    if (kind === 'fx') control.placeholder = '未知时留空';
    control.value = value == null ? '' : kind === 'rate' ? Number((value * 100).toPrecision(12)) : value;
  }
  wrapper.append(control);
  if (hint) {
    const help = el('small', 've-label', hint);
    help.id = 've-help-' + section + '-' + key;
    control.setAttribute('aria-describedby', help.id);
    wrapper.append(help);
  }
  readers.push({
    control,
    panelIndex,
    read() {
      control.setCustomValidity('');
      if (kind === 'checkbox') return control.checked;
      if (kind === 'time') return control.value ? new Date(control.value).toISOString() : '';
      if (kind === 'select') return control.value;
      if (kind === 'text' || kind === 'currency') {
        if (!control.value.trim()) control.setCustomValidity('请填写此项。');
        return kind === 'currency' ? control.value.trim().toUpperCase() : control.value.trim();
      }
      if (!control.value) return null;
      const number = control.valueAsNumber;
      if (kind === 'positive' || kind === 'fx') {
        if (!(number > 0)) control.setCustomValidity('请输入大于 0 的数值。');
      }
      if (kind === 'rate' && number >= 100) control.setCustomValidity('费率应低于 100%。');
      return kind === 'rate' ? number / 100 : number;
    },
    assign(value) {
      record[key] = value;
    }
  });
  return wrapper;
}

export function openEditor(asset, { isNew = false, onSave }) {
  const draft = draftFrom(asset, isNew);
  const dialog = el('dialog', 've-dialog');
  const form = el('form', 've-form');
  // Select the invalid field's tab before asking the browser to report its error.
  form.noValidate = true;
  const title = el('h2', 've-title', isNew ? '新增自定义品种' : '编辑合约参数');
  title.id = 've-dialog-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const heading = el('header', 've-heading');
  const close = makeButton('×', 've-close');
  close.setAttribute('aria-label', '关闭参数编辑器');
  close.addEventListener('click', () => dialog.close());
  heading.append(title, close);
  const tabs = el('div', 've-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '参数分类');
  const content = el('div', 've-content');
  const panels = [],
    buttons = [],
    readers = [];
  function activate(index, focus = false) {
    panels.forEach((panel, i) => {
      panel.hidden = i !== index;
      buttons[i].setAttribute('aria-selected', String(i === index));
      buttons[i].tabIndex = i === index ? 0 : -1;
    });
    content.scrollTop = 0;
    if (focus) buttons[index].focus();
  }
  const sections = [
    ['asset', '品种与风控', assetGroups, draft],
    ['vs', 'VS 合约', legGroups, draft.vs],
    ['hype', 'Hype 合约', legGroups, draft.hype]
  ];
  sections.forEach(([key, name, groups, record], i) => {
    const tab = makeButton(name, 've-tab');
    tab.id = 've-tab-' + key;
    tab.setAttribute('role', 'tab');
    const panel = el('div', 've-panel');
    panel.id = 've-panel-' + key;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    tab.setAttribute('aria-controls', panel.id);
    tab.addEventListener('click', () => activate(i));
    tab.addEventListener('keydown', (event) => {
      let target;
      if (event.key === 'ArrowRight') target = (i + 1) % sections.length;
      if (event.key === 'ArrowLeft') target = (i + sections.length - 1) % sections.length;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = sections.length - 1;
      if (target === undefined) return;
      event.preventDefault();
      activate(target, true);
    });
    for (const [groupLabel, fields] of groups) {
      const group = el('fieldset', 've-group');
      group.append(el('legend', 've-legend', groupLabel));
      const grid = el('div', 've-grid');
      for (const field of fields) grid.append(makeField(field, record, key, i, readers));
      group.append(grid);
      panel.append(group);
    }
    buttons.push(tab);
    panels.push(panel);
    tabs.append(tab);
    content.append(panel);
  });
  activate(0);

  const checks = el('label', 've-verify');
  const verify = el('input');
  verify.type = 'checkbox';
  verify.name = 'asset.verified';
  verify.checked = !!draft.verified;
  checks.append(verify, el('span', '', '已核对两边跟踪同一标的及线性价格关系'));
  const identityFields = new Set([
    'benchmark',
    'ticker',
    'symbol',
    'ratio',
    'type',
    'quote',
    'settle',
    'quoteScale',
    'quoteUsd',
    'settleUsd',
    'multiplier',
    'unit',
    'priceUnit'
  ]);
  for (const { control } of readers) {
    if (identityFields.has(control.name.split('.')[1]))
      control.addEventListener('input', () => {
        verify.checked = false;
      });
  }
  const actions = el('div', 've-actions');
  const cancel = makeButton('取消', 've-secondary');
  cancel.addEventListener('click', () => dialog.close());
  const save = makeButton(isNew ? '添加品种' : '保存参数', 've-primary');
  save.type = 'submit';
  actions.append(cancel, save);
  const status = el('p', 've-error');
  status.setAttribute('role', 'alert');
  const footer = el('footer', 've-footer');
  footer.append(checks, status, actions);
  form.append(heading, tabs, content, footer);
  dialog.append(form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    for (const reader of readers) {
      const value = reader.read();
      if (!reader.control.checkValidity()) {
        activate(reader.panelIndex);
        reader.control.focus();
        reader.control.reportValidity();
        return;
      }
      reader.assign(value);
    }
    draft.verified = verify.checked;
    save.disabled = true;
    try {
      await onSave(draft);
      dialog.close();
    } catch (error) {
      status.textContent = error.message || '品种参数保存失败，请重试。';
      save.disabled = false;
    }
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  if (isNew) form.elements.namedItem('asset.name').focus();
  return dialog;
}
