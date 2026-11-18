import { escapeHTML as h } from './format.js';

const rules = [
  ['initialCapital', '个人总本金（含首笔报名费）'],
  ['registrationFee', '每次购号报名费'],
  ['vsStart', 'VS 初始 / 重置净值'],
  ['challengeTarget', '考核通过净值'],
  ['challengeFail', '考核固定失败线'],
  ['fundedFail', '出金号固定失败线'],
  ['payoutTarget', '当前首次出金目标净值'],
  ['payoutShare', '提款分成（%）'],
  ['maxMarginPct', '双边保证金占用上限（%）'],
  ['minCash', '最低个人现金留存（U）'],
  ['maxRoundingDriftPct', '步长取整相对计划对冲比例的最大偏差（%）'],
  ['minBuffer', '额外最低强平缓冲（原生单位）'],
  ['basisReserveBps', '压力基差余量（基点）'],
  ['closeSlippageBps', '平仓滑点余量（基点）'],
  ['vsCapUsd', 'VS 美元仓位上限（0 表示不限）'],
  ['hypeCapUsd', 'Hype 美元仓位上限（0 表示不限）']
];
const accountFields = [
  ['vsBalance', 'VS 已结算余额'],
  ['vsEquity', 'VS 标记净值'],
  ['vsUsed', 'VS 已用保证金'],
  ['vsFree', 'VS 剩余可用保证金'],
  ['hypeCash', 'Hype 已结算现金'],
  ['hypeEquity', 'Hype 标记净值'],
  ['hypeUsed', 'Hype 已用保证金'],
  ['hypeFree', 'Hype 可用保证金'],
  ['externalUnrecovered', '尚未体现在余额内的待回收外部成本']
];
const input = (label, name, value, min = 0) =>
  '<label>' +
  h(label) +
  '<input required step="any" type="number" name="' +
  name +
  '" min="' +
  min +
  '" value="' +
  h(value ?? 0) +
  '"></label>';
function choice(name, vals, value) {
  return (
    '<select name="' +
    name +
    '">' +
    vals
      .map(
        ([v, label]) =>
          '<option value="' + v + '" ' + (v === value ? 'selected' : '') + '>' + h(label) + '</option>'
      )
      .join('') +
    '</select>'
  );
}
function jsonField(label, name, value) {
  return (
    '<label class="full">' +
    h(label) +
    '<textarea spellcheck="false" rows="5" name="' +
    name +
    '">' +
    h(JSON.stringify(value, null, 2)) +
    '</textarea></label>'
  );
}
function readNumber(form, key) {
  const v = form.elements.namedItem(key).valueAsNumber;
  if (!Number.isFinite(v)) throw Error('请填写有效数值。');
  return v;
}
export function openSettings({ config, account, asset, manual, onSave }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'settings-dialog';
  const form = document.createElement('form');
  const c = config,
    a = account;
  const controls = rules
    .map(([key, label]) => input(label, key, key === 'payoutShare' ? c[key] * 100 : c[key]))
    .join('');
  const balances = accountFields.map(([key, label]) => input(label, key, a[key])).join('');
  form.innerHTML =
    '<header><h2>账户与规则</h2><button type="button" class="dismiss" aria-label="关闭">×</button></header>' +
    '<div class="settings-body"><details><summary>从规则文件填写</summary><p><a href="/config/example.json" download="example.json">下载示例配置</a></p><label>导入规则 JSON <input type="file" name="rulesFile" accept=".json,application/json"></label></details><fieldset><legend>固定回撤与现金模型</legend><div class="field-grid">' +
    controls +
    '<label>候选排序' +
    choice(
      'sortBy',
      [
        ['worst', '最差情景最优'],
        ['success', '达标剩余现金'],
        ['buffer', '强平缓冲'],
        ['margin', '较低保证金']
      ],
      c.sortBy
    ) +
    '</label><label>触线口径' +
    choice(
      'triggerMode',
      [
        ['settled', '平仓可结算净值'],
        ['mark', '标记净值']
      ],
      c.triggerMode
    ) +
    '</label>' +
    '<label>并排比较的首次出金净值（逗号隔开）<input name="targetList" value="' +
    h((c.targets ?? [c.payoutTarget]).join(', ')) +
    '"></label></div></fieldset>' +
    '<fieldset><legend>账户起点</legend><label>本地预览来源' +
    choice(
      'source',
      [
        ['ledger', '跟随双账本'],
        ['manual', '采用下方手工账户快照']
      ],
      manual ? 'manual' : 'ledger'
    ) +
    '</label>' +
    '<label>外部只读账户' +
    choice(
      'useExternalAccounts',
      [
        ['yes', '已确认的快照优先'],
        ['no', '使用本地账户，行情继续更新']
      ],
      c.useExternalAccounts === false ? 'no' : 'yes'
    ) +
    '</label>' +
    '<p>导入模拟账本需要单独确认。模拟成交后可在账本页切换为跟随本地余额。</p>' +
    '<div class="field-grid"><label>账户阶段' +
    choice(
      'stage',
      [
        ['challenge', '考核'],
        ['funded', '出金号']
      ],
      a.stage
    ) +
    '</label>' +
    balances +
    jsonField(
      '已有仓位数组（assetId、venue、带符号 qty、entry、margin、upnl）',
      'positions',
      a.positions ?? []
    ) +
    '</div></fieldset><fieldset><legend>' +
    h(asset.ticker) +
    ' · Hype 强平依据</legend><p>档位名义额和扣减额以 USD 计。手工强平价只适用于相同净仓、均价、保证金模式和抵押金额。</p><div class="field-grid">' +
    '<label>保证金模式' +
    choice(
      'marginMode',
      [
        ['cross', '全仓'],
        ['isolated', '逐仓']
      ],
      asset.hype.marginMode ?? 'cross'
    ) +
    '</label>' +
    '<label>档位来源' +
    choice(
      'tiersVerified',
      [
        ['yes', '已核对参数（离线为模拟假设）'],
        ['no', '尚未核实']
      ],
      asset.hype.tiersVerified ? 'yes' : 'no'
    ) +
    '</label>' +
    jsonField('维持保证金档位（lowerBound、mmr、deduction、maxLeverage）', 'tiers', asset.hype.tiers ?? []) +
    '<label>手工精确强平价' +
    choice(
      'liqSource',
      [
        ['model', '按已核实档位计算'],
        ['manual', '当前候选专用手工价']
      ],
      asset.hype.liqSource === 'manual' ? 'manual' : 'model'
    ) +
    '</label>' +
    input('Hype 强平标记价（本腿报价单位）', 'liqPrice', asset.hype.liqPrice) +
    input('对应带符号总仓位', 'liqQty', asset.hype.liqQty, -1e15) +
    input('对应总仓均价', 'liqEntry', asset.hype.liqEntry) +
    input('对应抵押额（USD）', 'liqCollateral', asset.hype.liqCollateral) +
    '<label>精确价核对时间（含时区 ISO）<input name="liqAsOf" value="' +
    h(asset.hype.liqAsOf ?? new Date().toISOString()) +
    '"></label></div></fieldset></div>' +
    '<footer><span class="error" role="alert"></span><button class="dismiss" type="button">取消</button><button class="primary">保存设置</button></footer>';
  form.elements.namedItem('rulesFile').onchange = async (event) => {
    try {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 100000) throw Error('规则文件过大。');
      const obj = JSON.parse(await file.text());
      if (obj.version !== 1 || !obj.rules || typeof obj.rules !== 'object')
        throw Error('需要 version 1 的规则配置。');
      for (const [key] of rules) {
        if (!Object.hasOwn(obj.rules, key)) continue;
        const value = obj.rules[key];
        if (!Number.isFinite(value)) throw Error('参数数值无效：' + key);
        form.elements.namedItem(key).value = key === 'payoutShare' ? value * 100 : value;
      }
      if (Array.isArray(obj.rules.targets))
        form.elements.namedItem('targetList').value = obj.rules.targets.join(', ');
      if (['worst', 'success', 'buffer', 'margin'].includes(obj.rules.sortBy))
        form.elements.namedItem('sortBy').value = obj.rules.sortBy;
      if (obj.rules.triggerMode) form.elements.namedItem('triggerMode').value = obj.rules.triggerMode;
      if (typeof obj.rules.useExternalAccounts === 'boolean')
        form.elements.namedItem('useExternalAccounts').value = obj.rules.useExternalAccounts ? 'yes' : 'no';
      form.querySelector('.error').textContent = '规则已填入，保存后生效。';
    } catch (err) {
      form.querySelector('.error').textContent = err.message;
    }
  };
  form.querySelectorAll('.dismiss').forEach((b) => (b.onclick = () => dialog.close()));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const get = (k) => form.elements.namedItem(k).value;
    try {
      const conf = { ...c };
      for (const [key] of rules) conf[key] = readNumber(form, key);
      conf.payoutShare /= 100;
      conf.sortBy = get('sortBy');
      conf.triggerMode = get('triggerMode');
      conf.useExternalAccounts = get('useExternalAccounts') === 'yes';
      conf.targets = [
        ...new Set(
          get('targetList')
            .split(/[,，\s]+/)
            .filter(Boolean)
            .map(Number)
        )
      ];
      if (!(
        conf.initialCapital >= conf.registrationFee &&
        conf.vsStart > conf.challengeFail &&
        conf.vsStart > conf.fundedFail &&
        conf.challengeTarget > conf.vsStart &&
        conf.payoutTarget > conf.vsStart &&
        conf.targets.length > 0 &&
        conf.targets.every((t) => Number.isFinite(t) && t > conf.vsStart) &&
        conf.payoutShare <= 1 &&
        conf.maxMarginPct > 0 &&
        conf.maxMarginPct <= 100
      ))
        throw Error('请核对本金、固定失败线、目标净值、分成和占用率。');
      let override = null;
      if (get('source') === 'manual') {
        override = { stage: get('stage'), positions: JSON.parse(get('positions')) };
        for (const [key] of accountFields) override[key] = readNumber(form, key);
        if (
          !Array.isArray(override.positions) ||
          override.positions.some(
            (p) =>
              !p.assetId ||
              !['hype', 'vs'].includes(p.venue) ||
              !Number.isFinite(p.qty) ||
              !(p.entry > 0) ||
              !(p.margin >= 0)
          )
        )
          throw Error('已有仓位缺少品种、平台、带符号数量、均价或保证金。');
        if (override.vsFree > override.vsEquity || override.hypeFree > override.hypeEquity)
          throw Error('可用保证金不能超过当前账户净值。');
      }
      const modified = structuredClone(asset),
        leg = modified.hype;
      leg.marginMode = get('marginMode');
      leg.tiersVerified = get('tiersVerified') === 'yes';
      leg.tiers = JSON.parse(get('tiers'));
      if (
        !Array.isArray(leg.tiers) ||
        leg.tiers.some(
          (row) => !(row.lowerBound >= 0) || !(row.mmr > 0 && row.mmr < 1) || !(row.deduction >= 0)
        )
      )
        throw Error('请检查维持保证金档位。');
      leg.liqSource = get('liqSource');
      leg.liqMarginMode = leg.marginMode;
      for (const key of ['liqPrice', 'liqQty', 'liqEntry', 'liqCollateral']) leg[key] = readNumber(form, key);
      leg.liqAsOf = get('liqAsOf');
      if (
        leg.liqSource === 'manual' &&
        (!(leg.liqPrice > 0) ||
          !leg.liqQty ||
          !(leg.liqEntry > 0) ||
          !(leg.liqCollateral > 0) ||
          !Number.isFinite(Date.parse(leg.liqAsOf)))
      )
        throw Error('手工强平价需要完整的候选仓位指纹及时间。');
      await onSave(conf, override, modified);
      dialog.close();
    } catch (err) {
      form.querySelector('.error').textContent = err.message;
    }
  });
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}
