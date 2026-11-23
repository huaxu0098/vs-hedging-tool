import { quoteSnapshotId } from './trace.js';
import { closeEvaluation, fundedStatement, observeFunded, settleFunded } from './account-stages.js';
import { resolveFundedTotalRule } from './loss-limits.js';
import {workbenchStorage} from './workbench-storage.js';
import {initializeExam,localExamInput,examTimestamp} from './exam-clock.js';
import { dec, out, nonnegative, positive, normalizeExposure } from './math.js';
import {
  rules,
  splitReserves,
  calculateCurrent,
  fresh,
  quoteClock, subscriptionHealthy,
  fieldTime,
  stressFields,
  reason as constraintReason
} from './current.js';
import { targetsWithinExam } from './reachability.js';
import { scanKeys, refreshDelay, changedQuotes } from './scan-refresh.js';
import { ratioChanges } from './ratio-analysis.js';
import { createSolutionSnapshot, displayHistory } from './display-history.js';
import { applyVestConfirmation, confirmVestSpec, riskFields } from './vest-confirmation.js';
import { renderScan, setupScan } from './ratio-ui.js';
import { drawCandidateSet, reprojectCandidateSet, setCandidateActionable, setCandidateNotice } from './candidate-ui.js';
import { ledgerLabels, presentLedger } from './settlement-ledger.js';
import { captureScript } from '../vs-parser.js';
import {termReader} from './term-reference.js';
import { manualVs } from './adapters.js';
import { accountSnapshot, manualAccount, presetAccount } from './current-account.js';

const $ = (id) => document.getElementById(id);
const calculatorPage=document.documentElement.dataset.view==='calculator';
const key = 'vs-hype:current-snapshots:v1';
const now = () => new Date().toISOString();
const unsaved=new Set();
const storage=workbenchStorage((field,ok)=>{
  if(ok) unsaved.delete(field); else unsaved.add(field);
  const note=$('storage-note');
  note.hidden=!unsaved.size;
  note.textContent=unsaved.size?'浏览器本地存储受限，'+(unsaved.has(key)?'当前设置':'最新展示快照')+'暂未保存。':'';
});
let saved;
try {
  saved = JSON.parse(storage.getItem(key));
} catch {
  /* Keep the original until a user edit. */
}
const state = saved?.version === 1 ? saved : { version: 1, asset: 'BTC', rules: {}, assets: {}, shared: {} };
if (state.autoVersion !== 12) {
  state.rules = { ...state.rules, mode: 'auto' };
  state.autoVersion = 12;
}
// v1.2 persisted UI defaults even when the user never entered a pressure value.
if (state.stressVersion !== 1) {
  for (const k of Object.keys(stressFields)) if (state.rules[k] === '0') delete state.rules[k];
  state.stressVersion = 1;
}
// Official purchase-page confirmed Vest account presets (user can still override any field freely; never hardcoded in solver).
const ACCOUNT_PRESETS = {
  gold: {
    label: 'Gold（10,000U / 目标11,000 / 底线9,400 / 80% / 142.50U）',
    planPF: '10000',
    baseline: '10000',
    resetBaseline: '10000',
    challengeTarget: '11000',
    challengeFloor: '9400',
    challengeDailyMode: 'none',
    challengeDailyFloor: '',
    fundedLossMode: 'floor',
    fundedFloor: '9400',
    fundedMaxLoss: '600',
    fundedDailyMode: 'none',
    fundedDailyFloor: '',
    share: '0.8',
    platformShare: '0.2',
    registration: '142.50'
  },
  silver: {
    label: 'Silver（5,000U / 目标5,500 / 底线4,700 / 80% / 71.25U）',
    planPF: '5000',
    baseline: '5000',
    resetBaseline: '5000',
    challengeTarget: '5500',
    challengeFloor: '4700',
    challengeDailyMode: 'none',
    challengeDailyFloor: '',
    fundedLossMode: 'floor',
    fundedFloor: '4700',
    fundedMaxLoss: '300',
    fundedDailyMode: 'none',
    fundedDailyFloor: '',
    share: '0.8',
    platformShare: '0.2',
    registration: '71.25'
  }
};
function detectAccountPreset(profile) {
  if (profile.accountPreset === 'custom') return 'custom';
  for (const [id, p] of Object.entries(ACCOUNT_PRESETS)) {
    const pfMatch = String(profile.planPF ?? profile.baseline ?? '') === p.planPF;
    const baseMatch = String(profile.baseline ?? '') === p.baseline;
    const targetMatch = String(profile.challengeTarget ?? '') === p.challengeTarget;
    const cFloorMatch = String(profile.challengeFloor ?? '') === p.challengeFloor;
    const fFloorMatch = String(profile.fundedFloor ?? '') === p.fundedFloor;
    const shareMatch = String(profile.share ?? '') === p.share;
    const regMatch = !profile.registration || Number(profile.registration) === Number(p.registration);
    const cDailyMatch = (profile.challengeDailyMode ?? 'none') === p.challengeDailyMode && String(profile.challengeDailyFloor ?? '') === p.challengeDailyFloor;
    const fDailyMatch = (profile.fundedDailyMode ?? 'none') === p.fundedDailyMode && String(profile.fundedDailyFloor ?? '') === p.fundedDailyFloor;
    if (pfMatch && baseMatch && targetMatch && cFloorMatch && fFloorMatch && shareMatch && regMatch && cDailyMatch && fDailyMatch) return id;
  }
  return 'custom';
}
const planDefaults = {
  planCrossFlat: true,
  planCapital: '500',
  planPF: '10000',
  planFundedCash: '',
  challengeTarget: '11000',
  challengeFloor: '9400',
  challengeDailyMode: 'none',
  fundedLossMode: 'floor',
  fundedFloor: '9400',
  fundedMaxLoss: '600',
  fundedDailyMode: 'none',
  fundedTarget: '',
  baseline: '10000',
  resetBaseline: '10000',
  share: '0.8',
  platformShare: '0.2',
  registration: '142.50'
};
const planning = () => state.fundingView === 'plan';
state.fundingView ??= 'plan';
state.rules = { ...rules, challengeDailyMode: 'missing', fundedDailyMode: 'missing', ...splitReserves(state.rules), riskPreference: '0' };
state.planRules = { ...rules, ...planDefaults, ...splitReserves(state.planRules), riskPreference: '0' };
if (state.r11LossVersion !== 1) {
  if (!['none', 'provided', 'missing'].includes(state.planRules.challengeDailyMode)) state.planRules.challengeDailyMode = 'none';
  if (!['none', 'provided', 'missing'].includes(state.planRules.fundedDailyMode)) state.planRules.fundedDailyMode = 'none';
  if (state.planRules.fundedTarget === '10100') state.planRules.fundedTarget = '';
  state.r11LossVersion = 1;
}
if (state.r12RuleRespectVersion !== 1) {
  for (const profile of [state.rules, state.planRules]) {
    if (!['floor', 'max_loss'].includes(profile.fundedLossMode)) profile.fundedLossMode = 'floor';
  }
  if (state.planRules.planCapital) state.planRules.B = state.planRules.planCapital;
  state.r12RuleRespectVersion = 1;
}
// V1.0 rule migration: disable legacy exam_target default & upgrade untouched legacy 12000/8000/91 defaults to confirmed Gold 80% baseline.
if (state.r14VestRuleVersion !== 1) {
  for (const profile of [state.rules, state.planRules]) {
    if (profile.fundedLossMode === 'exam_target') profile.fundedLossMode = 'floor';
  }
  const pr = state.planRules;
  if (pr.challengeTarget === '12000' && pr.fundedFloor === '8000' && pr.registration === '91') {
    Object.assign(pr, {
      planPF: '10000',
      baseline: '10000',
      resetBaseline: '10000',
      challengeTarget: '11000',
      challengeFloor: '9400',
      fundedFloor: '9400',
      fundedMaxLoss: '600',
      registration: '142.50',
      share: '0.8',
      platformShare: '0.2'
    });
  }
  state.r14VestRuleVersion = 1;
}
let r = planning() ? state.planRules : state.rules;
const save = () => storage.setItem(key, JSON.stringify(state));
function initializeProfile(profile) {
  initializeExam(profile);
  if (!['challenge', 'funded'].includes(profile.stage)) profile.stage = 'challenge';
  if (profile === state.planRules && profile.planCapital) profile.B = profile.planCapital;
}
for(const profile of [state.rules,state.planRules]) initializeProfile(profile);
save();
// Display stage is strictly a UI projection in calculator planning mode; it never mutates account rules/storage.
let displayStage = r.stage === 'funded' ? 'funded' : 'challenge';
const planningProjectionMode = () => calculatorPage && planning() && !r.evaluationClose;
const viewStage = () => (planningProjectionMode() ? displayStage : r.stage);
const fmt = (x, n = 2) => {
  if (x == null || x === '') return '—';
  try {
    return dec(String(x)).toFixed(n);
  } catch {
    return '待填写';
  }
};
const money = (x) => (x == null ? '—' : fmt(x) + ' U');
const pct = (x) => {
  if (x == null || x === '') return '—';
  try {
    return dec(x).times(100).toFixed(3) + '%';
  } catch {
    return '待填写';
  }
};
const signed = (x) => (x == null ? '未验证' : (dec(x).gt(0) ? '+' : '') + out(dec(x)));
const checkNumber = (x, unit) => {
  if (x == null) return '—';
  return unit === 'U' && dec(x).abs().gte('0.01') ? fmt(x) : dec(x).toSignificantDigits(8).toString();
};
const signedMoney = (x) => (x == null ? '—' : (dec(x).gt(0) ? '+' : '') + money(x));
const clock = (t) =>
  t && Number.isFinite(Date.parse(t)) ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '未确认';
const put = (id, str) => {
  if ($(id).textContent !== str) $(id).textContent = str;
};
const asset = () => state.asset;
const local = () => (state.assets[asset()] ??= { pf: {}, hl: {} });
const ruleFields = {
  pfUtil: 'VS 最大保证金占权益（%）',
  hlUtil: 'Hype 最大保证金占权益（%）',
  twoDayUpPct:'48 小时最大上行幅度（相对起始价，%）',
  twoDayDownPct:'48 小时最大下行幅度（相对起始价，%）',
  challengeStart:'考核开始时间（本地）',
  examEquityFloor:'额外考核最低标记权益（U，触及即终止，选填）',
  holdHours:'假设最长持仓时间（小时）',
  dailyUpPct:'24 小时最大上行幅度假设（相对起始价，%）',
  dailyDownPct:'24 小时最大下行幅度假设（相对起始价，%）',
  widenBps:'独立基差扩大（溢价或折价绝对值增加，bp）',
  narrowBps:'独立基差收敛（向零收敛的幅度，bp）',
  vestJumpBps:'Vest 跳过数学触线价的幅度（起始价 bp）',
  hypeJumpBps:'Hype 单边不利跳价（按起始标记价，bp）',
  vestFirstBps:'Vest 先平仓的独立变幅（bp）',
  hypeFirstBps:'Hype 先平仓的独立变幅（bp）',
  exitDelaySeconds:'先后平仓预留延迟（秒）',
  exitLagBps:'先后平仓共用变幅（bp，可由分方向设置覆盖）',
  movePct: '假定两日内有利价格变动（%，选填）',
  jumpBps: '不利跳价（基点）',
  asyncBps: '双边不同步时 Hype 单边不利变动（基点）',
  delayBps: 'Hype 调仓延迟期间不利变动（基点）',
  fundingDebit: '整个持仓期的资金费预算（U）',
  fundingRatesBps: '各结算期的不利资金费率（基点，逗号分隔）',
  adverseBps: 'Hype 不利基差变动（基点，1 基点 = 0.01%）',

  recoveryBuffer: '失败端额外回收缓冲 B_buffer（U，选填）',
  successBuffer: '成功端额外留存缓冲 R_buffer（U，选填）',
  registration: '本金中已支付的报名费（U）',
  investedCapital: '净收益核算的实际总投入（含报名费及已投入的外部资金，U）',
  outsideCosts: '本金之外另需收回的历史成本（U）',
  minMaintenanceSurplus: 'Hype 路径最低维持保证金余量（U）',
  minBuffer: '成功线到 Hype 强平线的最低价格距离',
  challengeFloor: '考核总止损底线（U，必填）',
  challengeDailyFloor: '考核日止损底线（U）',
  challengeTarget: '考核通过净值（U）',
  fundedFloor: 'Funded 总止损底线（U，必填）',
  fundedMaxLoss: 'Funded 总允许亏损额（U）',
  fundedDailyFloor: 'Funded 日止损底线（U）',
  fundedTarget: 'Funded 首次出金目标权益（U，留空自动求 W）',
  passCost: '待回收通关成本（U，选填，留空按本金与结余推算）',
  fundedDrawdown: 'Funded 最大回撤（距本轮已记录权益高点，U，选填）',
  baseline:'PF 提现基准线（U）',
  minimumProfit:'最低可提现利润（扣费前，U）',
  withdrawalFee:'单次领取/转账费 T_k（每轮扣一次，U）',
  platformShare:'平台分成比例（0 至 1）',
  share:'个人分成比例（0 至 1）',
  resetBaseline:'提现后 PF 重置基准（U）',

  deadlineMark: '截止时 PF 标记价（明确压力终点，按当前品种与截止时间）',
  k: '额外终点摩擦预算（U，已计成交费勿重复填）',
  ref: '本轮起点 C_ref（未知留空）',
  g: '本轮最低收益要求（U）',
  roundIn: '本轮外部净入本金（U）',
  roundOut: '本轮已取出本金（U）',
  pfFee: 'VS 单边费率（小数）',
  hlFee: 'Hype 手工单边费率（小数）',
  deadline: '考核实际截止时间（本地）',
  quoteSecs: '报价有效期（秒，双边盘口及标记最多 3 秒）',
  accountSecs: '账户确认有效期（秒）',
  quoteSkewMs: '行情最大时间差（毫秒）',
  accountSkewSecs: '账户快照最大时间差（秒）',
  rebalanceSteps: '最小调仓变动（两边各自数量步长，0 为关闭）',
  depegAlertBps: '稳定币偏离美元告警阈值（基点）'
};
const legFields = {
  maxQty: '平台另设总数量上限（如有）',
  anchor: '权益对应的标记价',
  free: '剩余可开仓保证金（U）',
  otherHold: '其他仓位与挂单保留额（U，未知留空）',
  orders: '未成交订单（剩余有符号数量，逗号分隔；无单填 0）'
};
function input(box, id, label, type = 'text') {
  const l = document.createElement('label'),
    e = document.createElement('input');
  l.textContent = label;
  e.id = id;
  e.type = type;
  if (type==='datetime-local') e.step='any';
  if (type === 'text' && id!=='fundingRatesBps') e.inputMode = 'decimal';
  l.append(e);
  $(box).append(l);
}
const planFields = {
  planCapital: '个人起始本金（U）',
  planPF: 'Evaluation 当前已平仓权益（U，初始 10,000）',
  planFundedCash: '通过后 Hype 结余（U）'
};
for (const [k, label] of Object.entries(planFields)) input('plan-fields', k, label);
for (const [k, label] of Object.entries(ruleFields))
  input(
    ['fundedFloor','fundedMaxLoss','fundedDailyFloor','fundedTarget','passCost','fundedDrawdown','baseline','minimumProfit','withdrawalFee','share','platformShare','resetBaseline'].includes(k) ? 'withdrawal-fields' : k in stressFields || ['fundingRatesBps','widenBps','narrowBps','vestJumpBps','hypeJumpBps','vestFirstBps','hypeFirstBps','exitDelaySeconds','exitLagBps'].includes(k) ? 'stress-fields' : ['quoteSecs','quoteSkewMs','depegAlertBps'].includes(k) ? 'clock-fields' : 'rule-fields',
    k,
    label,
    ['deadline','challengeStart'].includes(k) ? 'datetime-local' : 'text'
  );
$('fundedTarget').placeholder = '留空自动求 W';
$('challengeFloor').placeholder = '必填，如 9400 / 4700';
$('fundedFloor').placeholder = '必填，固定底线 L = S − D（如 9400 / 4700）';
$('fundedMaxLoss').placeholder = '最大允许回撤 D（如 600 / 300）';
$('challengeDailyFloor').placeholder = '当日底线，如 9700';
$('fundedDailyFloor').placeholder = '当日底线，如 9500';
$('passCost').placeholder = '留空自动推算';
{
  const label = document.createElement('label'), select = document.createElement('select');
  label.textContent = 'Funded 总止损方式';
  select.id = 'fundedLossMode';
  for (const [value, name] of [['floor', '固定权益止损底线 L'], ['max_loss', '按最大允许回撤 D（L = S − D）']])
    select.add(new Option(name, value));
  label.append(select);
  $('withdrawal-fields').append(label);
}
for (const [id, title, box] of [
  ['challengeDailyMode', '考核日止损', 'rule-fields'],
  ['fundedDailyMode', 'Funded 日止损', 'withdrawal-fields']
]) {
  const label = document.createElement('label'), select = document.createElement('select');
  label.textContent = title;
  select.id = id;
  for (const [value, name] of [['none', '无日止损'], ['provided', '有日止损'], ['missing', '未确认']])
    select.add(new Option(name, value));
  label.append(select);
  $(box).append(label);
}
for (const side of ['pf', 'hl'])
  for (const [k, label] of Object.entries(legFields))
    if (k !== 'free') input('leg-settings', side + '-' + k, (side === 'pf' ? 'VS ' : 'Hype ') + label);
for (const side of ['pf', 'hl']) {
  const label = document.createElement('label'),
    select = document.createElement('select');
  label.textContent = (side === 'pf' ? 'VS' : 'Hype') + ' 保证金模式';
  select.id = side + '-marginMode';
  for (const [value, name] of [
    ['', '待核实'],
    ['cross', '已确认全仓'],
    ['isolated', '逐仓（需另核实）']
  ])
    select.add(new Option(name, value));
  label.append(select);
  $('quick-margin').append(label);
}
// Place the essential controls & inputs on the calculator page, folding secondary rules cleanly.
if(calculatorPage) {
  const controls=$('home-controls');
  {
    const label=document.createElement('label'), select=document.createElement('select');
    label.textContent='规格';
    select.id='account-preset';
    select.add(new Option('Gold · 10,000U (80%)', 'gold'));
    select.add(new Option('Silver · 5,000U (80%)', 'silver'));
    select.add(new Option('自定义规则', 'custom'));
    select.onchange=()=>{
      if(select.value==='custom') {
        r.accountPreset='custom';
        if($('calc-rules-fold')) $('calc-rules-fold').open=true;
        r.editedAt=now();
        save(); inputs(); render();
        return;
      }
      const preset=ACCOUNT_PRESETS[select.value];
      if(!preset) return;
      Object.assign(r, {
        accountPreset: select.value,
        planPF: preset.planPF,
        baseline: preset.baseline,
        resetBaseline: preset.resetBaseline,
        challengeTarget: preset.challengeTarget,
        challengeFloor: preset.challengeFloor,
        challengeDailyMode: preset.challengeDailyMode,
        challengeDailyFloor: preset.challengeDailyFloor,
        fundedLossMode: preset.fundedLossMode,
        fundedFloor: preset.fundedFloor,
        fundedMaxLoss: preset.fundedMaxLoss,
        fundedDailyMode: preset.fundedDailyMode,
        fundedDailyFloor: preset.fundedDailyFloor,
        share: preset.share,
        platformShare: preset.platformShare,
        registration: preset.registration
      });
      r.editedAt=now();
      save(); inputs(); render();
    };
    label.append(select);
    controls.append(label);
  }
  for(const [id,title] of [['stage','阶段'],['asset','标的'],['funding-view','来源']]) {
    const label=$(id).closest('label');
    label.firstChild.textContent=title;
    controls.append(label);
  }
  const mount=(container,items)=>{
    for(const [id,title,source,stageScope] of items) {
      const label=$(id).closest('label');
      label.firstChild.textContent=title;
      if(source!=='both') label.dataset.source=source;
      if(stageScope!=='both') label.dataset.stage=stageScope;
      container.append(label);
    }
  };
  mount($('home-fund-fields'),[
    ['planCapital','个人本金 (U)','plan','both'],
    ['registration','买号/报名费 (U)','plan','challenge'],
    ['planFundedCash','Funded 实盘结余 (U)','plan','funded'],
    ['planPF','PF 权益 (U)','plan','both'],
    ['pf-equity','PF 账户权益 (U)','account','both'],
    ['hl-equity','实盘权益 (U)','account','both'],
    ['investedCapital','个人本金 (U)','account','both'],
    ['deadline','考核截止时间','both','challenge'],
    ['fundedTarget','出金目标权益 (U)','both','funded']
  ]);
  mount($('home-more-fields'),[
    ['challengeTarget','考核通过线 (U)','both','challenge'],
    ['challengeFloor','考核总止损底线 (U，必填)','both','challenge'],
    ['challengeDailyMode','考核日止损','both','challenge'],
    ['challengeDailyFloor','考核日止损底线 (U)','both','challenge'],
    ['fundedLossMode','Funded 总止损方式','both','both'],
    ['fundedFloor','Funded 总止损底线 (U，必填)','both','both'],
    ['fundedMaxLoss','Funded 允许总亏损额 (U)','both','both'],
    ['fundedDailyMode','Funded 日止损','both','both'],
    ['fundedDailyFloor','Funded 日止损底线 (U)','both','both'],
    ['passCost','待回收通关成本 (U，选填)','both','funded'],
    ['baseline','分成基准线 (U)','both','both'],
    ['share','个人分成比例','both','both']
  ]);
}
function action(q, d) {
  if (d == null || q == null) return '—';
  const change = dec(d),
    before = dec(q),
    after = before.plus(change);
  if (change.isZero()) return '保持 0';
  const label = before.times(after).lt(0) ? '反向调仓' : after.abs().gt(before.abs()) ? '增仓' : '减仓';
  return label + ' ' + signed(d) + ' ' + asset();
}
let previous = null;
let feed = {},
  rates = {},
  api = null,
  apiError = '',
  quoteError = '',
  pending = null,
  feedVersion = 0,
  accountVersion = 0;
let quoteTimer, rateTimer,
  accountTimer,
  lastCalculation = '',
  manualPrices = null;
let hypeApiStatus = null,
  hypeApiError = '',
  hypeProbeAccount = null,
  hypeProbeError = '';
const shortAddr = (addr) => (addr && addr.length === 42 ? addr.slice(0, 6) + '…' + addr.slice(-4) : addr || '—');
const useAPI = () => !planning() && $('hl-source').value === 'api';
const readTermReference=termReader();
function market() {
  const data = quoteMarket();
  if(r.stage==='challenge' && !r.evaluationClose) data.termReference=readTermReference(data.asset,r.deadline);
  return applyVestConfirmation(data, state.vestSpecs?.[asset()], r.stage);
}
function quoteMarket() {
  if ($('quote-source').value !== 'manual') return { ...feed, asset:asset(), source: 'Vest / Hyperliquid 公开行情' };
  return {
    ...feed,
    asset: asset(),
    source: '手工确认盘口',
    pf: manualPrices?.pf,
    hl: manualPrices?.hl && { ...feed.hl, ...manualPrices.hl, contract: feed.hl?.contract },
    errors: { spec: feed.errors?.spec ?? (feed.errors?.hl ? 'Hype 合约规格当前未核实' : null) }
  };
}
function account(side) {
  if (planning()) return presetAccount(r, side);
  if (side === 'hl' && useAPI())
    return { ...api,accountId:$('wallet').value.trim().toLowerCase(),error:apiError || (api?'':'等待 Hype 账户同步') };
  return {...manualAccount(state, asset(), side),accountId:'manual'};
}
function approvedOrders(v) {
  if (!Array.isArray(v)) throw Error('orders 须为数组，未知请省略');
  const ids = new Set();
  return v.map((o) => {
    const qty = out(dec(String(o.qty)));
    if (dec(qty).isZero()) throw Error('未成交剩余数量须非零，无挂单请填 []');
    if (o.id != null && ids.has(String(o.id))) throw Error('挂单 ID 重复');
    if (o.id != null) ids.add(String(o.id));
    return {
      qty,
      id: o.id == null ? null : String(o.id),
      conditional: !!o.conditional,
      reduceOnly: !!o.reduceOnly
    };
  });
}
function inputs() {
  const src=planning()?'plan':'account';
  const vs=viewStage();
  const isPlanProj=planningProjectionMode();
  $('home-fund-fields').dataset.source=src;
  $('home-fund-fields').dataset.stage=isPlanProj?'challenge':vs;
  if ($('home-more-fields')) {
    $('home-more-fields').dataset.source=src;
    $('home-more-fields').dataset.stage=vs;
    // In Challenge view show fundedTarget inside more-fields; in Funded view show it in primary row.
    const ft=$('fundedTarget').closest('label');
    if (calculatorPage) {
      if (vs==='funded') {
        ft.dataset.stage=isPlanProj?'challenge':'funded';
        $('home-fund-fields').append(ft);
      } else {
        delete ft.dataset.stage;
        $('home-more-fields').append(ft);
      }
    }
  }
  if ($('home-fund-summary')) {
    if (planning()) {
      const hlStart=account('hl');
      const totalIn=fmt(r.planCapital,0);
      if (isPlanProj && vs==='funded') {
        put('home-fund-summary', 'Funded 规划投影 · B='+totalIn+' U（F='+fmt(r.registration,2)+' U）· 各行独立承接 H_pass');
      } else {
        put('home-fund-summary', vs==='funded'
          ? 'Funded · B='+totalIn+' U · 实盘 '+(hlStart.error?'待填':fmt(hlStart.equity,2)+' U')
          : '规划模式 · B='+totalIn+' U（F='+fmt(r.registration,2)+' U）· H₀='+(hlStart.error?'待核':fmt(hlStart.equity,2)+' U'));
      }
    } else {
      const basis=r.investedCapital!==''&&r.investedCapital!=null?r.investedCapital:r.B;
      put('home-fund-summary', (vs==='funded'?'实盘快照 · Funded':'实盘快照 · 考核')+(basis?' · B='+fmt(basis,0)+' U':''));
    }
  }
  const fTotalRule=resolveFundedTotalRule(r, r.resetBaseline ?? r.baseline ?? '10000');
  if ($('calc-rules-summary')) {
    const sharePct=r.share?fmt(dec(r.share).times(100),0)+'/'+fmt(dec('1').minus(r.share).times(100),0):'80/20';
    const dailyLabel=(mode,floor)=>mode==='none'?'无日止损':mode==='provided'?(floor!==''&&floor!=null?'日止损 '+fmt(floor,0)+' U':'日止损未填'):'日止损未确认';
    const totalLabel=v=>v!==''&&v!=null?'总止损 '+fmt(v,0)+' U':'总止损未填(必填)';
    const fTotalText=fTotalRule.state==='provided'
      ? '总止损 '+fmt(fTotalRule.floor,0)+' U'+(fTotalRule.derivedFrom==='exam_target'?'（'+fTotalRule.sourceLabel+'）':fTotalRule.derivedFrom==='max_loss'?'（'+fTotalRule.sourceLabel+'）':'')
      : fTotalRule.state==='invalid' ? '总止损无效' : '总止损未填(必填)';
    const ftLabel=r.fundedTarget!==''&&r.fundedTarget!=null?'出金目标 '+fmt(r.fundedTarget,0)+' U':'自动求 W';
    put('calc-rules-summary', vs==='funded'
      ? '更多规则：Funded '+fTotalText+' · '+dailyLabel(r.fundedDailyMode??'missing',r.fundedDailyFloor)+' · 基准 '+fmt(r.baseline,0)+' U · 分成 '+sharePct+' · '+ftLabel
      : '更多规则：考核 通过 '+fmt(r.challengeTarget,0)+' / '+totalLabel(r.challengeFloor)+' / '+dailyLabel(r.challengeDailyMode??'missing',r.challengeDailyFloor)+' · Funded '+fTotalText+' / '+dailyLabel(r.fundedDailyMode??'missing',r.fundedDailyFloor)+' / '+ftLabel);
  }
  const fMode = r.fundedLossMode || 'floor';
  $('fundedFloor').closest('label').hidden = fMode !== 'floor';
  $('fundedMaxLoss').closest('label').hidden = fMode !== 'max_loss';
  $('challengeDailyFloor').closest('label').hidden = r.challengeDailyMode !== 'provided';
  $('fundedDailyFloor').closest('label').hidden = r.fundedDailyMode !== 'provided';
  $('plan-cross-flat').checked = r.planCrossFlat === true;
  $('funding-view').value = state.fundingView;
  if ($('account-preset')) $('account-preset').value = detectAccountPreset(r);
  $('plan-settings').hidden = !planning();
  $('investedCapital').parentElement.hidden = planning();
  for (const id of ['hl-source', 'wallet', 'paste', 'bridge-pair', 'leg-settings']) {
    const el = $(id);
    const wrapper = ['wallet','hl-source'].includes(id) ? el.closest('label') :
      el.closest('details:not(.desk-group):not(#desk-details)') ?? el.closest('.form');
    if (wrapper) wrapper.hidden = planning();
  }
  put('sync', planning() ? '立即刷新双边行情' : '立即刷新行情与账户');
  $('flat-entry').hidden = $('confirm-balances').hidden = $('quick-margin').hidden = planning();
  for (const k of Object.keys(planFields)) if ($(k)!==document.activeElement) $(k).value = r[k] ?? '';
  $('deadlineMark').parentElement.hidden = vs === 'funded';
  $('planPF').parentElement.hidden=!!r.evaluationClose;
  // In calculator planning projection mode, never expose single planFundedCash in Funded projection view
  $('planFundedCash').parentElement.hidden=!(planning() && !isPlanProj && r.stage==='funded');
  $('asset').value = asset();
  for (const k of [
    'mode',
    'stage',
    'challengeDailyMode',
    'fundedLossMode',
    'fundedDailyMode',
    'B',
    'R_success',
    'R_free',
    'hardDepthD',

    ...Object.keys(ruleFields)
  ])
    if (!['challengeFloor','challengeDailyFloor','challengeTarget','fundedFloor','fundedMaxLoss','fundedDailyFloor','fundedTarget'].includes(k) || $(k)!==document.activeElement) $(k).value =
      k === 'stage'
        ? vs
        : k === 'deadlineMark' && (r.deadlineAsset !== asset() || r.deadlineBound !== r.deadline)
        ? ''
        : ['deadline','challengeStart'].includes(k)?localExamInput(r[k]):(r[k] ?? '');

  for (const side of ['pf', 'hl']) {
    const a = account(side);
    for (const k of ['equity', 'qty', ...Object.keys(legFields), 'leverage', 'marginMode']) {
      const el = $(side + '-' + k);
      if (!el) continue;
      const value =
        k === 'orders' ? a.orders?.map((o) => o.qty).join(',') || (a.orders ? '0' : '') : (a[k] ?? '');
      if (el !== document.activeElement || (side === 'hl' && useAPI())) el.value = value;
      if (el.tagName === 'SELECT') el.disabled = planning() || (side === 'hl' && useAPI());
      else el.readOnly = planning() || (side === 'hl' && useAPI());
    }
  }
}
function updateLeg(side, fields, stamp = now(), source = '手工确认') {
  const leg = local()[side];
  if (('qty' in fields && fields.qty !== '0') || fields.otherPositions) leg.allFlatAt = null;
  if ('orders' in fields && fields.orders?.length !== 0) leg.noOrdersAt = null;
  leg.origins ??= {};
  for (const k of Object.keys(fields)) leg.origins[k] = { at: stamp, source };
  if (
    ('qty' in fields && fields.qty !== '0') ||
    (fields.orders && fields.orders.length) ||
    fields.otherPositions
  )
    leg.flatConfirmedAt = null;
  if ('equity' in fields) {
    state.shared[side] = { asset: asset(), equity: fields.equity, at: stamp, source };
    leg.equityAt = stamp;
    leg.anchor =
      fields.anchor ??
      (fresh(market()[side]?.asOf, Date.parse(stamp), Number(r.quoteSecs) * 1000)
        ? String(market()[side].mark)
        : null);
  }
  if ('qty' in fields) {
    if (!('equity' in fields) && fields.qty !== leg.qty && leg.qtyAt && leg.equityAt && leg.qtyAt !== stamp)
      leg.anchor = null;
    leg.qtyAt = stamp;
  }
  Object.assign(leg, fields);
}
function cellRow(values) {
  const row = document.createElement('tr');
  for (const value of values) {
    const td = document.createElement('td');
    td.textContent = value;
    row.append(td);
  }
  return row;
}
function renderPairs(id, pairs) {
  const dl = [];
  for (const [k, v] of pairs) {
    const dt = document.createElement('dt'),
      dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dl.push(dt, dd);
  }
  if ($(id).textContent !== dl.map((el) => el.textContent).join('')) $(id).replaceChildren(...dl);
}
function renderRisk(result, accounts, market) {
  const c = result.candidate;
  put(
    'risk-status',
    c
      ? result.riskMissing.length
        ? '仍需确认：' + result.riskMissing.join('、')
        : (result.audit?.status ?? '条件估算') + ' · 已按全仓维持保证金档位计算两条基础路径。'
      : '等待可测算的候选仓位。'
  );
  const audit = result.audit;
  put(
    'cross-audit',
    audit
      ? [
          audit.status,
          '独立权益与维持保证金交点核对 ' +
            (audit.mathMatches == null ? '无法验证' : audit.mathMatches ? '一致' : '不一致'),
          '目标仓模型 ' + fmt(audit.model) + ' / 独立数值解 ' + fmt(audit.independent),
          '交易所核验 · ' + audit.exchangeCheck,
          '现仓模型 ' + fmt(audit.currentModel) + ' / 平台现仓参考 ' + fmt(audit.reference),
          '现仓维持要求 模型 ' + money(audit.currentMaintenance) + ' / 平台 ' + money(audit.apiMaintenance),
          ...audit.gaps
        ].join(' · ')
      : '清算条件估算待核实 · 需要全仓权益、所有持仓、费率及维持档位'
  );
  const sources = [];
  if (market.spec)
    sources.push('VS 保证金规格 · Vest exchangeInfo' + (market.specAt ? ' ' + clock(market.specAt) : ''));
  if (market.hl?.tiersAt) sources.push('Hype 档位 · 主网 meta ' + clock(market.hl.tiersAt));
  sources.push('VS 单边费率 ' + pct(r.pfFee || null) + '（本机设置）');
  sources.push(
    'Hype 单边费率 ' +
      pct(accounts.hl.fee ?? (r.hlFee || null)) +
      (accounts.hl.fee != null ? '（公开账户 API）' : '（本机设置）')
  );
  put('cost-sources', sources.join(' ｜ '));
  const paths = ['fail','pass'].map(key => fmt(c?.paths?.[key]?.pf.exitMark));
  const margin = (key) => money(c?.constraints.find((x) => x.code === key + '_INITIAL_MARGIN')?.required);
  renderPairs('risk-values', [
    ['VS 失败价 / 成功价' + (c ? '（PF ' + (dec(c.vsTargetQuantity).gt(0) ? '多 ' : '空 ') + dec(c.vsTargetQuantity).abs() + '）' : ''), paths.join(' / ')],
    ['Hype 在 VS 成功线的映射标记价', fmt(c?.pressureMark)],
    [
      'Hype 目标仓强平标记价',
      c?.liqMark
        ? fmt(c.liqMark) + ' · ' + c.liqSource + ' · ' + (result.audit?.status ?? '条件估算')
        : c && dec(c.hlTargetQuantity).isZero()
          ? 'Hype 空仓，无强平价'
          : c && c.buffer != null
            ? '模型内无正价格强平点'
            : '未验证'
    ],
    [
      '当前仓平台参考强平价',
      accounts.hl.liquidation ? fmt(accounts.hl.liquidation) + ' · API 当前持仓' : '未提供'
    ],
    [
      '成功线到强平线的距离',
      c?.priceBuffer != null
        ? fmt(c.priceBuffer) + ' 价格单位 · ' + pct(out(dec(c.priceBuffer).div(c.pressureMark)))
        : '—'
    ],
    ['Hype 目标仓初始保证金', money(c?.requiredInitialMargin)],
    ['Hype 目标仓当前维持保证金', money(c?.maintenanceMargin)],
    ...(result.stress?.positive.length
      ? [
          ['已配置压力情景标记价 / 强平价', fmt(c?.stressPressureMark) + ' / ' + fmt(c?.stressLiqMark)],
          ['已配置压力下的清算缓冲', fmt(c?.stressPriceBuffer)]
        ]
      : []),
    [
      '最小余量处的权益 / 维持保证金',
      money(c?.stressedEquity ?? c?.baseEquity) + ' / ' + money(c?.stressedMaintenance ?? c?.baseMaintenance)
    ],
    ['路径最低 Hype 维持保证金余量', money(c?.stressedSurplus ?? c?.buffer)],
    [
      '有效杠杆（目标名义额 ÷ Hype 权益）',
      c?.effectiveLeverage != null ? fmt(c.effectiveLeverage, 3) + '×' : '—'
    ],
    ['PF 模拟初始保证金（含其他占用）', margin('pf')],
    ['Hype 其他保证金占用', money(c?.otherInitialMargin)],
    ['Hype 调仓后的可用抵押品（含已留存金额）', money(c?.availableAfter)]
  ]);
  const rows = ['pf', 'hl'].map((k) => {
    const t = result.costs?.[k],
      pair = (side) => (t ? money(t[side].fee) + ' / ' + money(t[side].impact) : '—');
    return cellRow([
      k === 'pf' ? 'VS' : 'Hype',
      money(t?.entry.fee),
      money(t?.entry.impact),
      pair('fail'),
      pair('pass')
    ]);
  });
  if ($('costs').textContent !== rows.map((el) => el.textContent).join(''))
    $('costs').replaceChildren(...rows);
}
function freshnessLabel(at, seconds) {
  if (!at) return '未确认';
  return fresh(at, Date.now(), Number(seconds) * 1000) ? '有效' : '过期';
}
const history = displayHistory(storage);
const runLog=[];
function renderRunLog() {
  if (!$('solve-details').open) return;
  const rows=runLog.filter(record=>record.scope===scanScope());
  put('solve-log',rows.map(({scope,...record})=>JSON.stringify(record)).join('\n'));
}
$('solve-details').ontoggle=renderRunLog;
let workerContext = null, worker = null, running = null, completed = null, lastGood = null, failure = null;
let interruptedScope = null;
let lastSolveMs=0;
let version = 0, wantedKey = null, lastStart = -Infinity, wakeTimer, workerTimer;
function scanScope() {
  return JSON.stringify([calculatorPage?'opening-capacity':'separate-funded',r.attemptStartedAt??'',asset(), state.fundingView, useAPI() ? $('wallet').value.trim().toLowerCase() : 'manual', r.stage]);
}
function cancelAuto(keepIdleWorker=false) {
  clearTimeout(workerTimer);
  clearTimeout(wakeTimer);
  if (!keepIdleWorker || running) {
    worker?.terminate();
    worker = workerContext = null;
  }
  if (running) Object.assign(running.log,{status:'已取消',finishedAt:now()});
  running = completed = failure = wantedKey = null;
  version++;
}
function currentFrame(a, m, t) {
  const scope = scanScope();
  if (lastGood && lastGood.scope !== scope) { cancelAuto(); lastGood = null; }
  const base = calculateCurrent(r, a, m, rates, t, { deferAuto: true, openingCapacity:calculatorPage });
  const retained = lastGood?.result;
  const paused = () => ({ ...base, retained, frameState:'paused' });
  if (!base.needsSearch || base.timing?.quoteSkew > base.timing?.quoteLimit) {
    interruptedScope = scope;
    if (running || completed || failure || wantedKey) cancelAuto(true);
    return paused();
  }
  const {context, key} = scanKeys(r, a, m, rates, [scope, $('quote-source').value, m.source,
    base.currencies?.hypeToVest?.mid ?? null]);
  if (running && running.context !== context) cancelAuto();
  wantedKey = key;
  // A later observation of identical prices may reuse the previous solve only
  // while that solve's own two books and marks are still fresh.
  if (completed?.key === key && (r.stage!=='challenge' || t-completed.checkedAt<1000) && targetsWithinExam(completed.result,t) && ['pf','hl'].every(side =>
    quoteClock(completed.result.calculationMarket[side], t, base.timing.quoteTTL).ok)) {
    // The book may return to the last completed inputs while a different tick
    // is still in flight. Keep that validated result and discard the older job.
    if (running && running.key !== key) {
      const valid = completed;
      cancelAuto();
      completed = valid;
    }
    return { ...completed.result, observed:base, frameState:'ready' };
  }

  const trigger = !lastGood ? '首次扫描' : lastGood.context !== context ? '账户或规则已变更' : '行情更新';
  const waiting = (state, reason) => {
    // Retain the entire last publication until the current request completes.
    if (state === 'updating' && interruptedScope === scope)
      return { ...base, retained, frameState:'recovering', trigger, refreshPending:true };
    return { ...base, retained, frameState:state, trigger, refreshPending:state === 'updating',
      issues:[reason], priorError:state === 'failed' ? reason : null };
  };
  if (failure?.context === context && performance.now() < failure.retryAt) return waiting('failed', failure.message);
  if (!running) {
    const delay = lastGood?.context === context && !failure ?
      refreshDelay(lastGood.result.calculationMarket, m, performance.now()-lastStart) : 0;
    clearTimeout(wakeTimer);
    if (delay > 0) {
      wakeTimer = setTimeout(render, delay + 1);
      return waiting('updating', '行情更新，正在合并连续报价');
    }
    const revision = ++version, frameRates = rates;
    lastStart = performance.now();
    failure = null;
    const log={scope,solverRunId:crypto.randomUUID(),quoteSnapshotId:quoteSnapshotId(m,frameRates),
      quoteTimes:['pf','hl'].map(k=>({book:m[k].bookAt??m[k].asOf,mark:m[k].markAt??m[k].asOf})),
      startedAt:now(),status:'求解中',finishedAt:null,h:null,q_pf:null,q_hype:null,M_eval:null,
      executionCost:null,margin:null,leverage:null};
    runLog.unshift(log);
    if (runLog.length>60) runLog.pop();
    running = { version:revision, context, key, log };
    if (!worker) worker = new Worker('/src/hedge/auto-worker.js', { type: 'module' });
    const finish = (result, error) => {
      if (revision !== version || running?.version !== revision) return;
      clearTimeout(workerTimer);
      running = null;
      if(result?.solveMs!=null) lastSolveMs=result.solveMs;
      log.finishedAt=result?.finishedAt??now();
      log.status=error?'求解失败':'输入已更新';
      const plans=result?.ratioScan?.plans;
      const solved=plans?.decision?plans.decision.action:plans?.pressure?.row;
      if (solved && result.trace?.marketId===log.quoteSnapshotId) {
        const cost=path=>out([path.pf,path.hl].reduce((sum,leg)=>sum.plus(leg.executionCost).plus(leg.fees),dec('0')));
        Object.assign(log,{h:solved.notionalRatio,q_pf:solved.pf,q_hype:solved.hl,leverage:solved.leverage,M_eval:solved.pressureSummary.M_eval,
          margin:solved.pressureSummary.maxMarginUsed?.value,
          executionCost:{fail:cost(solved.paths.fail),pass:cost(solved.paths.pass)}});
      }
      // A superseded delivery cannot publish a snapshot or a failure for a newer book.
      if (wantedKey !== key) { render(); return; }
      if (result && result.trace?.marketId!==log.quoteSnapshotId) error='求解结果的行情快照不一致';
      if (error || !result?.ratioScan || !plans?.collection && [result.ratioScan.plans?.pressure,result.ratioScan.plans?.cashPriority].some(search=>search?.status==='incomplete') && !result.ratioScan.plans.pending) {
        interruptedScope = scope;
        log.status=error?'求解失败':'核验不完整';
        const message = error || [result?.ratioScan?.plans?.pressure,result?.ratioScan?.plans?.cashPriority].find(search=>search?.status==='incomplete')?.reason || result?.issues?.join(' · ') || '本帧缺少完整计算结果';
        failure = { context, message, retryAt:performance.now()+2000 };
        wakeTimer = setTimeout(render, 2010);
      } else {
        const publication = { context, key, scope, checkedAt:Date.now(), result: {
          ...result, solverRunId:log.solverRunId, stateVersion:revision, calculatedAt:result.finishedAt, calculationMarket:m,
          calculationRates:frameRates, trigger, frameState:'ready'
        } };
        // Recheck the original clocks, account and eligibility before publication.
        // A long worker task may have crossed a deadline or a quote TTL.
        const now = Date.now();
        const fresh = calculateCurrent(r, a, m, frameRates, now, {deferAuto:true,openingCapacity:calculatorPage});
        const live = market();
        const accounts = {pf:account('pf'), hl:account('hl')};
        const latest = calculateCurrent(r, accounts, live, rates, now, {deferAuto:true,openingCapacity:calculatorPage});
        if (latest.needsSearch && scanKeys(r,accounts,live,rates,[scanScope(),$('quote-source').value,
            live.source,latest.currencies?.hypeToVest?.mid ?? null]).key !== key) {
          render();
          return;
        }
        if (scope === scanScope() && fresh.needsSearch && latest.needsSearch && targetsWithinExam(result,now) &&
            !(latest.timing.quoteSkew > latest.timing.quoteLimit)) {
          try {
            publication.result.ratioScan.analysis.change = ratioChanges(lastGood?.result, publication.result);
            const changes=lastGood?changedQuotes(lastGood.result.calculationMarket,m):[];
            publication.result.solveCause=changes.join('、') || (lastGood?.context===context?'行情时钟、汇率或剩余期限更新':trigger);
            publication.result.solutionSnapshot = createSolutionSnapshot(publication.result,lastGood?.result.solutionSnapshot ?? history.read(scope));
            const row=solved;
            log.status=row?'本帧最优':'无解';
            completed = lastGood = publication;
            interruptedScope = null;
            history.record(scope, publication.result.solutionSnapshot);
          } catch (e) {
            completed = null;
            interruptedScope = scope;
            failure = {context, message:e.message, retryAt:performance.now()+2000};
            wakeTimer = setTimeout(render, 2010);
          }
        }
        else { completed = null; interruptedScope = scope; }
      }
      render();
    };
    workerTimer = setTimeout(() => {
      if (revision !== version) return;
      worker.terminate(); worker = workerContext = null;
      finish(null, '求解超过 10 秒，已超时；保留上次结果');
    }, 10000);
    worker.onmessage = ({data}) => {
      if (data.version === revision) finish(data.result, data.error && constraintReason(data.error));
    };
    worker.onerror = () => {
      if (revision !== version) return;
      worker.terminate(); worker = workerContext = null;
      finish(null, '后台求解失败，保留上次结果');
    };
    const reprice = workerContext === context;
    workerContext = context;
    worker.postMessage({version:revision, reprice, openingCapacity:calculatorPage, r, a, m, rates:frameRates, t,
      priorTarget:
      lastGood?.context === context ? retained.advice?.pair : null});
  }
  return waiting('updating', trigger + '，后台重算中');
}
const autoLabels = {
  AUTO_FEASIBLE: '有可行仓位',
  AUTO_PARTIAL: '部分可算',
  AUTO_DATA_BLOCKED: '数据待补或过期',
  AUTO_INFEASIBLE: '完整搜索无解',
  AUTO_DEADLINE_EXIT_REQUIRED: '考核已到期，待退出',
  AUTO_HOLD: '保持现仓'
};
function updateDeadline() {
  if (r.stage !== 'challenge') return put('deadline-clock', '出金阶段');
  const end = Date.parse(r.deadline);
  if (!Number.isFinite(end)) return put('deadline-clock', '实际截止时间未配置');
  const seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000));
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  put(
    'deadline-clock',
    clock(r.deadline) +
      (seconds ? ' · 剩余 ' + [h, m, s].map((v) => String(v).padStart(2, '0')).join(':') : ' · 已到期')
  );
}
setInterval(updateDeadline, 1000);
const frameCards = document.querySelectorAll(
  '.desk-summary article, .desk-ratios, .dual-plans > div, [aria-labelledby="result-heading"], #risk, #cash-results, #funding-formula'
);
for (const el of frameCards) {
  const stamp = document.createElement('small');
  stamp.className = 'frame-key';
  (el.id === 'cash-results' ? el.parentElement : el).append(stamp);
}
function renderFunding(result, a, m, plan) {
  const f = result.funding,
    c = result.candidate,
    v = c?.funding;
  put(
    'formula-inputs',
    f?.lower == null
      ? '等待有效的资金快照、阶段和边界。'
      : '保护本金及额外历史成本 B ' +
          money(f.B) +
          ' · Hype 当前权益 ' +
          money(f.C_H) +
          '（' +
          (a.hl.source ?? '手工快照') +
          '）' +
          ' = 保护资金 ' +
          money(f.C_P) +
          '。PF 权益 ' +
          money(f.E) +
          '（' +
          (a.pf.source ?? '手工快照') +
          '），失败线 ' +
          money(f.F) +
          '，成功线 ' +
          money(f.T) +
          '。'
  );
  put(
    'formula-bounds',
    f?.lower == null
      ? ''
      : '理论保护下限 max(0, (' +
          fmt(f.B) +
          ' − ' +
          fmt(f.C_P) +
          ' + ' +
          fmt(f.failCost) +
          ') ÷ ' +
          fmt(f.loss) +
          ') = ' +
          pct(f.lower) +
          '；成功提现前上限 (' +
          fmt(f.C_H) +
          ' − ' +
          fmt(f.R??f.R_success) +
          ' − ' +
          fmt(f.passCost) +
          ') ÷ ' +
          fmt(f.gain) +
          ' = ' +
          pct(f.upper) +
          '。理论区间仅含另设的终点摩擦预算。开仓后可用抵押品另须达到 R_free ' +
          money(f.R_free) +
          '。' +
          (f.code === 'NO_CASH_INTERSECTION'
            ? '理论无交集。取下限时成功端缺 ' +
              money(f.successShortfallAtLower) +
              (f.failureShortfallAtUpper == null
                ? '；零对冲亦缺留存 ' + money(f.reserveShortfallAtZero)
                : '；取上限时失败保护缺 ' + money(f.failureShortfallAtUpper)) +
              '。'
            : '')
  );
  put(
    'formula-pair',
    v
      ? '风险偏好目标 PF ' + c.vsTargetQuantity + ' / Hype ' + c.hlTargetQuantity + '（多正空负）。每单位共同价格变化 PF ' +
          fmt(v.Kpf, 7) +
          ' U、Hype ' +
          fmt(v.Kh, 7) +
          ' U。目标 h = |Hype / PF| = ' +
          pct(v.h) +
          '。实际成交成本折算到对冲端，失败 ' +
          money(v.failCost) +
          '、成功 ' +
          money(v.passCost) +
          '；代入本候选成本的现金下限 ' +
          pct(v.lower) +
          '，上限 ' +
          pct(v.upper) +
          '。' +
          (v.stress
            ? '计入已配置压力，保护下限 ' + pct(v.stress.lower) + '，留存上限 ' + pct(v.stress.upper) + '。'
            : '')
      : result.refreshPending
        ? '资金、规则或行情已更新，等待本版仓位核算。'
        : '当前没有可逐笔核对的 AUTO 候选。'
  );
  const paths = result.paths;
  const cols = ['fail', 'pass'].flatMap((s) => ['pf', 'hl'].map((k) => paths?.[s]?.[k]));
  const exact = $('ledger-exact').checked;
  const views = cols.map((x) => x && (exact ? { entries: x.entries, total: x.settled } : presentLedger(x)));
  const rows = [];
  if (paths) {
    for (const [key, label] of Object.entries(ledgerLabels)) {
      const row = cellRow([label, ...views.map((v) => v?.entries[key] ?? '—')]);
      row.dataset.posting = key;
      rows.push(row);
    }
    if (!exact) {
      const row = cellRow(['逐项显示舍入差（U）', ...views.map((v) => v?.rounding ?? '—')]);
      row.dataset.posting = 'rounding';
      rows.push(row);
    }
    const total = cellRow(['结算权益（以上逐项相加）', ...views.map((v) => v?.total ?? '—')]);
    total.dataset.total = 'settled';
    rows.push(total);
    for (const [field, label] of Object.entries({
      difference: '与按成交均价独立复算差额（U）',
      target: '平仓数量（有符号目标仓）',
      adjustment: '本次调仓数量（有符号差额）',
      mark: '当前标记价',
      entryPrice: '调仓成交均价',
      exitMark: '边界映射标记价',
      exitPrice: '预计平仓成交均价',
      entryNominal: '调仓计费名义额（U）',
      exitNominal: '平仓计费名义额（U）',
      rate: '单边费率',
      multiplier: '合约乘数',
      fx: '每原生报价点的 USDC 账本价值（单位标的）',
      factor: '原生报价变动 / 每单位 Vest 报价变动',
      step: '数量步长'
    }))
      rows.push(cellRow([label, ...cols.map((x) => x?.[field] ?? '—')]));
  }
  const table = $('path-rows');
  table.dataset.snapshotId = paths ? (result.trace?.id ?? '') : '';
  if (table.textContent !== rows.map((row) => row.textContent).join('')) table.replaceChildren(...rows);
  put(
    'settlement-note',
    paths
      ? '本表目标 · PF ' + (paths.fail?.pf?.target ?? '未知') + ' / Hype ' + (paths.fail?.hl?.target ?? '未知') +
          '（多正空负）。基础路径账本 · 快照 ' + (result.trace?.id ?? '未知') + '。正数增加权益，负数减少权益。初始保证金单列为占用。独立复算容差 0.000000000001 U。终点按当前可见盘口平移至 VS 触线时的预计成交均价。表内价差、深度滑点和手续费各计一次。PF 模拟利润留在 PF 账本。成功时预计可分 ' +
          money((c ?? result.heldCash)?.expectedUserPayout) +
          '，分成单列于 Hype 权益之外。'
      : ''
  );
  put(
    'path-mapping',
    paths
      ? ['fail', 'pass']
          .map((k) => {
            const legs = paths[k],
              change = dec(legs.pf.exitMark).div(legs.pf.mark).minus(1);
            return (
              (k === 'fail' ? '失败' : '成功') +
              ' · PF 标记价变化 ' +
              pct(change) +
              '，Hype 映射标记价 ' +
              fmt(legs.hl.exitMark, 5)
            );
          })
          .join(' ｜ ') +
          '。两日内是否触线未知。按本帧映射系数、固定汇率和平移盘口结算；有其他仓位时假定其权益贡献不变。'
      : ''
  );
  const pass = paths?.pass;
  put(
    'pass-bridge',
    pass
      ? 'Hype 起点 ' +
          money(pass.hl.start) +
          ' → 成功路径预计 ' +
          money(pass.hl.settled) +
          '；Hype 标记盈亏 ' +
          signedMoney(pass.hl.move) +
          '。'
      : ''
  );
  put(
    'frame-times',
    result.trace
      ? '行情 · VS ' +
          clock(m.pf?.bookAt ?? m.pf?.asOf) +
          ' / Hype ' +
          clock(m.hl?.asOf) +
          ' ｜ 账户 · ' +
          (plan
            ? '预设资金规划'
            : 'VS ' + clock(fieldTime(a.pf, 'equity')) + ' / Hype ' + clock(fieldTime(a.hl, 'equity'))) +
          ' ｜ 规则 · ' +
          (r.editedAt ? clock(r.editedAt) : '初始配置') +
          ' ｜ 计算 · ' +
          clock(result.trace.at)
      : '等待同一版本的计算结果'
  );
  const s = result.search;
  put(
    'search-coverage',
    s?.pruned
      ? '数量上限与深度分段后共 ' +
          s.gridPairs +
          ' 对网格点。分支定界，实际核算 ' +
          s.exactPairs +
          ' 对与 ' +
          s.leverageRows +
          ' 个杠杆档次，访问 ' +
          s.nodes +
          ' 个分支（预算 ' +
          s.budget +
          '）。剪枝次数 · 仓位上界 ' +
          s.pruned.sizeBound +
          '、价格失效 ' +
          s.pruned.invalidPrice +
          '、现金上下界 ' +
          s.pruned.cashBound +
          '、已知更优解 ' +
          s.pruned.incumbentBound +
          '。' +
          (s.proof
            ? '最优目标下界 ' +
              (s.proof.lower ?? '未知') +
              ' U，上界 ' +
              (s.proof.upper ?? '未知') +
              ' U，最优性容差 ' +
              s.proof.optimalityTolerance +
              ' U。'
            : '') +
          (s.complete && s.proof?.complete
            ? '仅在本帧给定约束和合法网格内证明。'
            : '搜索或条件不完整，最优性未证实。') +
          (s.stoppedByBudget ? '已用尽预算。' : '') +
          (result.solveMs == null ? '' : '本帧联合求解 ' + result.solveMs + ' ms。')
      : ''
  );
  if ($('bound-details').open)
    put('bound-witness', s?.proof ? JSON.stringify(s.proof, null, 2) : '等待同一快照的搜索证明');
}
function renderConditions(result, a, m, plan) {
  renderFunding(result, a, m, plan);
  put(
    'funding-banner',
    plan
      ? '预设资金规划 · 账户权益、空仓与抵押品按规划条件计算'
      : '当前账户快照 · 权益与可用抵押品按平台读取或手工确认'
  );
  $('funding-banner').classList.toggle('account', !plan);
  put('margin-detail-title', plan ? 'Hype 规划初始保证金' : 'Hype 真实账户 · 目标初始保证金');
  const actualStress = !!result.stress?.positive.length;
  const scenario = actualStress ? '已配置压力情景' : '基础情景（未计额外压力）';
  put('lev-equity-heading', scenario + '权益');
  put('candidate-surplus-heading', scenario + '最低维持余量');
  put('candidate-cash-heading', scenario + '最差个人现金');
  const t = (result.observed ?? result).timing;
  const age = (n) => (n == null ? '未知' : (n / 1000).toFixed(1) + ' 秒');
  put(
    'clock-skew',
    t
      ? 'VS 盘口 ' +
          (t.clocks.pf.bookAt ?? '未取得') +
          '，年龄 ' +
          age(t.quoteAges.pf) +
          ' / Hype 盘口 ' +
          (t.clocks.hl.bookAt ?? '未取得') +
          '，年龄 ' +
          age(t.quoteAges.hl) +
          ' · 标记年龄 VS ' +
          age(t.clocks.pf.markAge) +
          ' / Hype ' +
          age(t.clocks.hl.markAge) +
          ' · 盘口与标记有效期 ' +
          age(t.quoteTTL) +
          ' · 盘口与标记最大时差 ' +
          (t.quoteSkew ?? '—') +
          ' / 允许 ' +
          t.quoteLimit +
          ' 毫秒 · ' +
          (plan
            ? '预设账户无实时快照'
            : 'VS 权益 ' +
              (fieldTime(a.pf, 'equity') ?? '未取得') +
              '，年龄 ' +
              age(t.accountAges.pf) +
              ' / Hype 权益 ' +
              (fieldTime(a.hl, 'equity') ?? '未取得') +
              '，年龄 ' +
              age(t.accountAges.hl) +
              ' · 账户字段最大时差 ' +
              age(t.accountSkew) +
              ' / 允许 ' +
              age(t.accountLimit))
      : ''
  );
  const h = result.advice;
  put(
    'hysteresis',
    h
      ? (h.source === 'existing'
          ? '变化低于最小调仓阈值，建议保持现仓'
          : h.source === 'previous'
            ? '变化低于最小调仓阈值，沿用已复核的上一目标'
            : '按本帧目标计算差额') +
          ' · 阈值 ' +
          h.threshold +
          ' 个数量步长 · 建议目标 PF ' +
          signed(h.pair[0]) +
          ' / Hype ' +
          signed(h.pair[1]) +
          ' ' +
          asset() +
          ' · 建议档位 ' +
          (h.leverage ? h.leverage + '×' : '无敞口')
      : ''
  );
  const missing = $('missing-list'),
    fields = result.missingFields ?? [];
  const key = JSON.stringify([plan, fields]);
  if (missing.dataset.key !== key) {
    missing.dataset.key = key;
    missing.replaceChildren(
      ...fields.map(({ id, label }) => {
        const link = document.createElement('a');
        let el = $(id);
        if (plan && (id === 'hl-source' || el?.closest('#snapshot'))) el = $('funding-view');
        if (!el) el = $('rules');
        link.href = '#' + el.id;
        link.textContent = label;
        link.onclick = (event) => {
          event.preventDefault();
          for (let n = el; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
          el.scrollIntoView({ block: 'center' });
          if (!el.matches('input,select,button')) el.tabIndex = -1;
          el.focus({ preventScroll: true });
        };
        return link;
      })
    );
  }
  const tr = result.trace;
  const stamp = tr ? '行情 ' + clock(m.hl?.asOf) + ' · 核算 ' + clock(tr.at) : '等待同帧核算';
  for (const el of document.querySelectorAll('.frame-key')) {
    if (el.textContent !== stamp) el.textContent = stamp;
    el.title = tr ? [tr.marketId, tr.accountsId, tr.rulesId, tr.model, tr.id].join(' / ') : stamp;
  }
  updateDeadline();
}
let traceViewId;
function renderTrace(snapshot, result) {
  const trace = snapshot?.trace ?? result.trace;
  const raw = [result, result.retained].find(frame => frame?.trace?.id === trace?.id && frame?.trace?.inputs);
  const viewId = [trace?.id,raw?.trace?.id].join('/');
  if (viewId === traceViewId) return;
  traceViewId = viewId;
  const source = raw && JSON.parse(raw.trace.inputs);
  put('trace-id', trace ? trace.model + ' / ' + trace.id : '等待计算');
  put(
    'trace-sources',
    trace
      ? [
          '计算于 ' + trace.at,
          '规则 ' + (trace.rulesId ?? '旧快照未记录'),
          '账户 ' + (trace.accountsId ?? '旧快照未记录'),
          '行情 ' + (trace.marketId ?? '旧快照未记录'),
          snapshot && '计算完成于 ' + snapshot.calculatedAt,
          snapshot?.prices && 'VS 盘口 ' + snapshot.prices.pf.bookAt + ' / Hype 盘口 ' + snapshot.prices.hl.bookAt,
          ...['pf','hl'].map(side => {
            const account = source?.accounts?.[side];
            const at = account && fieldTime(account,'equity');
            return account && (side === 'pf' ? 'VS' : 'Hype') + ' 资金 ' + (account.source ?? '未确认') + (at ? ' ' + at : '');
          })
        ].filter(Boolean).join(' · ')
      : ''
  );
  $('trace-download').disabled = !raw;
  $('trace-download').onclick = () => {
    if (!raw) return;
    const { inputs, ...identity } = raw.trace;
    const { trace: _, solutionSnapshot, calculationRates, calculationMarket, retained, observed, ...outputs } = raw;
    const payload = JSON.stringify(
      { ...identity, ...(snapshot && {snapshotId:snapshot.snapshotId, quoteSnapshotId:snapshot.quoteSnapshotId,
        accountSnapshotId:snapshot.accountSnapshotId, rulesVersion:snapshot.rulesVersion,
        solverVersion:snapshot.solverVersion, calculatedAt:snapshot.calculatedAt}), inputs: JSON.parse(inputs), outputs },
      (_, v) => (typeof v === 'bigint' ? String(v) : v),
      2
    );
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'hedge-' + trace.id + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const detail = $('trace-inputs').parentElement;
  const showInputs = () =>
    put('trace-inputs', source && detail.open ? JSON.stringify(source, null, 2) : '');
  detail.ontoggle = showInputs;
  showInputs();
}
let lastAdvancedFrame;
function renderStage() {
  const closed=r.evaluationClose, f=r.fundedAccount;
  $('current').dataset.stageClosed=String(!!closed);
  const fRuleStage=resolveFundedTotalRule(r, r.resetBaseline ?? r.baseline ?? '10000');
  put('phase-status',closed
    ? (closed.status==='passed'?'Evaluation → 通过 → Funded 结算节点':'Evaluation · 考核失败')+(planning()?'（规划模拟）':'（账户快照）')
    : r.stage==='funded'
      ? 'Funded 阶段 · 动态联合求解（总止损 '+(fRuleStage.floor!=null?fmt(fRuleStage.floor,0)+' U':'未填')+' · 首次分成目标 '+(r.fundedTarget?fmt(r.fundedTarget,0)+' U':'自动求解')+'）'
      : 'Evaluation · 考核阶段（通过线 '+fmt(r.challengeTarget,0)+' U · 失败线 '+fmt(r.challengeFloor,0)+' U）');
  $('scan-focus').hidden=!!closed;
  $('size-report').hidden=!!closed;
  for (const el of document.querySelectorAll('.live-opt,.live-targets,.live-margin')) el.hidden=!!closed;
  $('evaluation-record').hidden=!closed;
  $('plan-exit-entry').hidden=!planning() || !closed || closed.hype!=null;
  $('funded-summary').hidden=!(closed?.status==='passed' && f);
  $('restart-eval').hidden=!closed || !planning();
  if ($('enter-funded-solver')) $('enter-funded-solver').disabled=!(closed?.status==='passed' && (closed.hype!=null || !planning()));
  if (!closed) return;
  put('account-heading',planning()?'规划账户':'Evaluation 结算账户快照');
  put('scan-status','考核已结算 · Evaluation 仓位求解已结束');
  put('closed-funds',(closed.status==='passed'?'考核通过':'考核失败')+' · PF 权益 '+money(closed.pf)+
    ' · 考核提现 0 U · Hype 退出资金 '+money(closed.hype)+' · 个人资金 '+money(closed.personal)+
    (closed.personal==null?' · 等待 Hype 全部平仓后的权益快照':closed.investment==null?' · 回本待核，缺少个人投入本金':' · 相对投入 '+money(closed.investment)+' 的盈亏 '+signedMoney(out(dec(closed.personal).minus(closed.investment)))));
  if ($('funded-summary').hidden) return;
  put('funded-origin','Funded 新账户起点 '+money(f.initial)+' · 当前权益 '+money(f.equity));
  try {
    const s=fundedStatement(r);
    put('funded-values','合格可分利润（扣费后） '+money(s.qualified)+' · 个人 '+pct(r.share)+' '+money(s.user)+
      ' · 平台 '+pct(r.platformShare)+' '+money(s.platform)+' · 提现后 PF 基准 '+money(s.reset));
    put('funded-total','累计个人提现 '+money(s.userTotal)+' · 累计平台分成 '+money(s.platformTotal)+
      ' · 考核通过时 Hype 资金与累计个人提现合计 '+money(s.personal));
    put('funded-risk',(s.failed?'已触及 Funded 风险线':'Funded 风险线 '+(s.floor==null?'未配置':money(s.floor)))+
      ' · 已记录权益高点 '+money(f.peak)+(r.fundedDrawdown?'':' · 回撤限制未配置'));
    $('settle-funded').disabled=s.failed || !dec(s.qualified).gt(0);
    $('record-funded').disabled=s.failed;
  } catch(e) {
    put('funded-values',e.message); put('funded-total','—'); put('funded-risk','—');
    $('record-funded').disabled=$('settle-funded').disabled=true;
  }
  put('funded-rounds',f.rounds.map((row,i)=>'第 '+(i+1)+' 轮 · 权益 '+money(row.equity)+' · 个人 '+money(row.user)+
    ' · 平台 '+money(row.platform)+' · 重置 '+money(row.reset)).join('\n') || '尚无已结算轮次');
}
$('record-plan-exit').onclick=()=>{
  if (!planning() || !r.evaluationClose || r.evaluationClose.hype!=null) return;
  try {
    const cash=out(dec($('plan-exit-cash').value.trim()));
    r.evaluationClose={...r.evaluationClose,hype:cash,personal:cash};
    r.planFundedCash=cash;
    $('plan-exit-cash').value=''; put('plan-exit-error','');
    save(); render();
  } catch(e) { put('plan-exit-error',e.message); }
};
function updateFunded(settle) {
  try {
    r.fundedAccount=settle?settleFunded(r,now()):observeFunded(r,$('funded-observation').value.trim());
    $('funded-observation').value='';
    put('funded-error','');
    save(); render();
  } catch(e) { put('funded-error',e.message); }
}
$('record-funded').onclick=()=>updateFunded(false);
$('settle-funded').onclick=()=>updateFunded(true);
if ($('enter-funded-solver')) $('enter-funded-solver').onclick=()=>{
  if (r.evaluationClose?.status!=='passed') return;
  const carry=r.evaluationClose.hype;
  const pfStart=r.fundedAccount?.equity ?? r.resetBaseline ?? r.baseline ?? '10000';
  (r.closedEvaluations??=[]).push({evaluation:r.evaluationClose,funded:r.fundedAccount});
  delete r.evaluationClose;
  delete r.fundedAccount;
  r.stage='funded';
  displayStage='funded';
  if (carry!=null) r.planFundedCash=carry;
  r.planPF=pfStart;
  r.editedAt=now();
  cancelAuto(); lastGood=null;
  save(); inputs(); render();
};
$('restart-eval').onclick=()=>{
  if (!planning() || !r.evaluationClose) return;
  (r.closedEvaluations??=[]).push({evaluation:r.evaluationClose,funded:r.fundedAccount});
  delete r.evaluationClose; delete r.fundedAccount;
  r.stage='challenge'; r.planPF='10000';
  displayStage='challenge';
  r.challengeStart=now(); r.attemptStartedAt=r.challengeStart; r.deadline=new Date(Date.parse(r.challengeStart)+48*3600000).toISOString();
  r.deadlineMark=''; r.editedAt=now();
  save(); inputs(); render();
};
function render() {
  if (calculatorPage && !r.evaluationClose) {
    renderStage();
    if (lastBackendTicker) renderHypeApiStatusFromTicker(lastBackendTicker);
    scheduleBackendSync();
    return;
  }
  const live = market();
  let m = live;
  const a = { pf: account('pf'), hl: account('hl') };
  let result;
  try {
    result = currentFrame(a, m, Date.now());
    if (result.evaluationClose && !r.evaluationClose) {
      Object.assign(r,closeEvaluation(r,result.evaluationClose));
      cancelAuto(); lastGood=null;
      save(); inputs();
      return render();
    }
    if (r.evaluationClose && r.evaluationClose.hype==null && result.evaluationClose?.hype!=null) {
      r.evaluationClose=result.evaluationClose;
      r.planFundedCash=result.evaluationClose.hype;
      save();
    }
    if (result.calculationMarket) m = result.calculationMarket;
  } catch (e) {
    cancelAuto();
    interruptedScope = scanScope();
    result = {
      autoStatus: r.mode === 'auto' ? 'AUTO_DATA_BLOCKED' : null,
      retained: lastGood?.scope === scanScope() ? lastGood.result : null,
      frameState: 'paused',
      issues: [e.message],
      notices: [],
      cash: {},
      qty: { pf: null, hl: null },
      currentNotional: {}
    };
  }
  const c = result.candidate,
    b = result.range,
    stale = result.issues.some((x) => /过期|请求失败|断开|未连接|熔断/.test(x));
  const status = result.autoStatus
    ? (result.flatHold ? '无可行非零仓位，保持空仓' : (result.dataState ?? autoLabels[result.autoStatus])) +
      ' · ' +
      (result.issues[0] ?? result.notices.at(-1) ?? '按当前资金和保证金规则计算')
    : c
      ? '按当前现金规则计算，' +
        (c.code === 'MARGIN_UNVERIFIED' || result.audit?.gaps.length
          ? '保证金条件估算'
          : '已验算所设保证金条件')
      : result.issues[0] || result.notices.at(-1) || '等待当前快照';
  const plan = planning();
  const solutionSnapshot = r.evaluationClose ? null : result.solutionSnapshot ?? result.retained?.solutionSnapshot ?? history.read(scanScope());
  if ($('home-ticker')) {
    const pfObj = live.pf?.mark != null ? live.pf : lastBackendTicker?.pf;
    const hlObj = live.hl?.mark != null ? live.hl : lastBackendTicker?.hl;
    const pfP = pfObj?.mark != null ? fmt(pfObj.mark, 1) : (pfObj?.error ? '行情未就绪(' + pfObj.error + ')' : '行情未就绪');
    const hlP = hlObj?.mark != null ? fmt(hlObj.mark, 1) : (hlObj?.error ? '行情未就绪(' + hlObj.error + ')' : '行情未就绪');
    const spreadTxt =
      pfObj?.mark != null && hlObj?.mark != null
        ? ' · 价差 ' + (Number(hlObj.mark) - Number(pfObj.mark) > 0 ? '+' : '') + (Number(hlObj.mark) - Number(pfObj.mark)).toFixed(1)
        : '';
    const remMs = r.stage === 'challenge' && r.deadline ? Math.max(0, Date.parse(r.deadline) - Date.now()) : null;
    const remText =
      remMs != null && Number.isFinite(remMs)
        ? ' · 剩余 ' + Math.floor(remMs / 3600000) + 'h' + String(Math.floor((remMs % 3600000) / 60000)).padStart(2, '0') + 'm'
        : '';
    put('home-ticker', asset() + ' 永续 · Vest ' + pfP + ' / Hype ' + hlP + spreadTxt + remText);
  }
  renderHypeApiStatus(live);
  renderScan(result, live, r, plan, status, solutionSnapshot);
  renderStage();
  if ($('vest-spec-details').open) showVestSpec(live);
  renderRunLog();
  renderTrace(solutionSnapshot, result);
  if (!$('desk-details').open) return;
  if (result.retained && result.frameState === 'updating' &&
      (!result.ratioScan || lastAdvancedFrame === result.trace?.id)) return;
  lastAdvancedFrame = result.trace?.id;
  renderConditions(result, a, m, plan);
  const leverage = c?.candidateLeverage;
  const configured =
    useAPI() && !a.hl.error && fresh(a.hl.at, Date.now(), Number(r.accountSecs) * 1000)
      ? a.hl.configuredLeverage
      : null;
  put('suggested-leverage', leverage ? leverage + '×' : c?.hlTargetQuantity === '0' ? '空仓' : '—');
  put('configured-leverage', configured ? configured + '×' : '未知');
  put(
    'leverage-cap',
    (c?.exchangeMaxLeverage
      ? '该仓位档位上限 ' + c.exchangeMaxLeverage + '× · 合约上限 ' + c.contractMaxLeverage + '×'
      : '合约上限 ' + (m.hl?.maxLeverage ? m.hl.maxLeverage + '×' : '待核实')) +
      ' · 档位读取 ' +
      clock(m.hl?.tiersAt)
  );
  put(
    'leverage-status',
    (plan
      ? '规划资金 · LEVERAGE_UNVERIFIED · 候选调档额度未经交易所确认'
      : configured
        ? 'Hyperliquid 只读快照 · ' +
          clock(a.hl.at) +
          (result.leverageStatus === 'LEVERAGE_UNVERIFIED' ? ' · LEVERAGE_UNVERIFIED' : '')
        : '账户设置未读取 · LEVERAGE_UNVERIFIED') +
      (configured != null && leverage === configured ? ' · 按当前档额度' : ' · 目标档额度待核实')
  );
  const grid = c?.leverageGrid ?? [];
  const lower = grid.find((row) => row.leverage === leverage - 1);
  const higher = grid.findLast((row) => row.leverage > leverage && row.status === 'pass');
  const gap = lower?.constraint;
  const why = leverage
    ? [
        leverage + '× 是该仓位的最低可行档位，初始保证金 ' + money(c.requiredInitialMargin) + '。',
        lower &&
          lower.leverage +
            '× ' +
            constraintReason(lower.reason) +
            (gap?.shortfall != null ? '，缺 ' + checkNumber(gap.shortfall, gap.unit) + ' ' + gap.unit : '') +
            '。',
        higher &&
          '升至 ' +
            higher.leverage +
            '× 仅释放初始保证金 ' +
            money(out(dec(c.requiredInitialMargin).minus(higher.initial))) +
            '；两端现金、维持保证金、情景权益与强平距离均相同。'
      ]
        .filter(Boolean)
        .join(' ')
    : c?.hlTargetQuantity === '0'
      ? 'Hype 目标为空仓。'
      : '';
  put('effective-level', c?.effectiveLeverage == null ? '—' : fmt(c.effectiveLeverage, 3) + '×');
  put('initial-needed', '目标初始 ' + money(c?.requiredInitialMargin));
  const used =
    !plan && !a.hl.error && fresh(fieldTime(a.hl, 'used'), Date.now(), Number(r.accountSecs) * 1000)
      ? a.hl.used
      : null;
  const withdrawable =
    !plan && !a.hl.error && fresh(a.hl.at, Date.now(), Number(r.accountSecs) * 1000)
      ? a.hl.withdrawable
      : null;
  put(
    'already-used',
    (plan ? '当前占用按规划估算' : '当前账户占用 ' + money(used)) +
      ' · 交易所可提金额 ' +
      (withdrawable == null ? '未核实' : money(withdrawable))
  );
  put('leverage-reason', why);
  const levRows = grid.map((x) =>
    cellRow([
      x.leverage ? x.leverage + '×' : '空仓',
      money(x.initial),
      money(x.postEntryEquity),
      money(x.marginUsed),
      money(x.freeAfter) + ' / ' + money(x.freeFloor),
      money(x.successEquity) + ' / ' + money(result.funding?.R??r.R_success),
      money(x.maintenance),
      money(x.stressedEquity ?? x.baseEquity),
      money(x.surplus),
      !x.leverage
        ? '空仓'
        : (x.liquidation == null ? '无正价交点' : fmt(x.liquidation)) +
          ' · ' +
          (result.audit?.status ?? '条件估算'),
      x.status === 'pass'
        ? x.leverage === leverage
          ? '通过所设条件 · 最低可行'
          : '通过所设条件'
        : constraintReason(x.reason) +
          (x.reason === 'hl_FREE_RESERVE' ? ' · R_free 缺 ' + money(x.constraint.shortfall) : '')
    ])
  );
  if ($('leverage-grid').textContent !== levRows.map((x) => x.textContent).join(''))
    $('leverage-grid').replaceChildren(...levRows);

  $('deadlineMark').parentElement.hidden = r.stage === 'funded';
  $('planPF').parentElement.hidden=!!r.evaluationClose;
  $('planFundedCash').parentElement.hidden=!(planning() && r.stage==='funded');
  put('account-heading',r.evaluationClose?'Evaluation 结算账户快照':plan ? '规划起点与计算条件' : '当前账户与持仓');
  put('protection-label', plan ? '规划个人保护资金' : '已确认个人保护资金');
  put('margin-label', plan ? 'Hype 规划可用保证金' : 'Hype 可用抵押品');
  put(
    'plan-basis',
    plan
      ? (r.stage === 'funded'
          ? '出金阶段沿用通过后结余 ' + money(a.hl.equity)
          : '个人本金 ' +
            money(r.planCapital) +
            ' − 报名费 ' +
            money(r.registration) +
            ' = Hype 起始资金 ' +
            money(a.hl.equity)) +
          (r.planCrossFlat ? '。按规划全仓、空仓且无挂单计算。' : '。请确认下方规划条件以计算目标。')
      : ''
  );
  put('plan-heading', r.stage === 'funded' ? '本轮分成资金规划' : '开考前资金规划');
  const coverage = result.stress?.label ?? '';
  const directional = (qty, amount) =>
    (dec(qty).gt(0) ? '多 ' : dec(qty).lt(0) ? '空 ' : '空仓 ') + money(amount);

  const msg = [
    c && result.autoStatus === 'AUTO_PARTIAL' ? 'AUTO_PARTIAL · 条件方案' : status,
    ...(result.unverified ?? []),
    c && !result.unverified && result.leverageStatus === 'LEVERAGE_UNVERIFIED' && '条件方案 · 账户设置未验证',
    c && !result.unverified?.includes(coverage) && coverage
  ]
    .filter(Boolean)
    .join(' · ');
  put('calc-status', (plan ? '预设规划 · ' : '') + msg);
  const gaps = result.inputGaps ?? [];
  const checklist = [
    ...gaps.map((g) => g.text),
    ...result.issues.filter((v) => !gaps.some((g) => g.text === v) && !v.includes('持仓数量未录入'))
  ];
  put(
    'quick-status',
    plan && !r.planCrossFlat
      ? '请先确认资金规划的账户模式、空仓与挂单条件'
      : [...new Set(checklist)].join(' · ') || (c ? '已按当前输入计算' : status)
  );
  put('quick-entry', plan ? '调整预设参数' : '快速录入当前账户');
  $('quick-entry').onclick = () => {
    if (plan) {
      $('funds-details').open = true;
      $('planCapital').focus();
      return;
    }
    const el = gaps.map((g) => $(g.id)).find((el) => el && !el.readOnly && !el.disabled) ?? $('pf-equity');
    for (let n=el; n; n=n.parentElement) if (n.tagName === 'DETAILS') n.open=true;
    el.focus();
    el.scrollIntoView({ block: 'center' });
  };
  for (const button of $('separate-confirm').children)
    button.disabled = planning() || (useAPI() && button.id.startsWith('confirm-hl-'));
  $('confirm-flat').disabled =
    useAPI() &&
    (!a.hl.at ||
      !!a.hl.error ||
      !fresh(a.hl.at, Date.now(), Number(r.accountSecs) * 1000) ||
      a.hl.qty !== '0' ||
      a.hl.otherPositions ||
      a.hl.orders?.length !== 0 ||
      a.hl.marginMode !== 'cross' ||
      a.hl.otherHold !== '0');
  put(
    'fund-source',
    'Hype ' +
      (result.cash.hl == null ? '待确认' : money(result.cash.hl)) +
      '（' +
      (a.hl.source ?? '账户未接入') +
      '，' +
      clock(fieldTime(a.hl, 'equity')) +
      '）' +
      (result.cash.hl == null && a.hl.equity != null && a.hl.equity !== ''
        ? '。上次录入 ' + money(a.hl.equity) + '，未计入'
        : '')
  );
  put(
    'collateral-source',
    (a.hl.source ?? '账户未接入') +
      (fieldTime(a.hl, 'free')
        ? ' · ' +
          clock(fieldTime(a.hl, 'free')) +
          ' · ' +
          freshnessLabel(fieldTime(a.hl, 'free'), r.accountSecs)
        : ' · 可用保证金未确认')
  );

  if (plan) {
    put(
      'fund-source',
      '预设 Hype 权益 ' + money(result.cash.hl)
    );
    put('collateral-source', r.planCrossFlat ? '按全仓空仓规划计算' : '等待确认规划起点');
  }
  put(
    'summary-status',
    result.autoStatus
      ? (plan ? '预设规划 · ' : '') + msg
      : c
        ? (c.code === 'FEASIBLE' && !result.audit?.gaps.length
            ? '当前规则已验算'
            : '条件测算 · 保证金待验证') +
          ' · ' +
          coverage +
          ' · 两种现金结果均假设先触及对应 VS 边界'
        : status + (result.heldCash ? ' · 现金按现仓保持不动计算' : '')
  );
  for (const [key, qty, delta, amount] of [
    ['pf', c?.vsTargetQuantity, c?.vsDeltaQuantity, c?.vsNotional],
    ['hl', c?.hlTargetQuantity, c?.hlDeltaQuantity, c?.hlNotional]
  ]) {
    const q = qty == null ? null : dec(qty);
    const adj = result.adjust?.[key];
    let hint = '待核对挂单';
    if (adj?.remaining != null)
      hint = dec(adj.remaining).isZero()
        ? dec(delta).isZero()
          ? '保持现仓'
          : '挂单已覆盖差额'
        : action(adj.projected ?? result.qty[key], adj.remaining);
    if (result.advice?.source === 'existing') hint = '变化低于最小调仓阈值，建议保持';
    if (result.advice?.source === 'previous') hint = '沿用经本帧复核的调整 · ' + hint;
    put(key + '-summary', q == null ? '—' : (q.isZero() ? '空仓 ' : q.gt(0) ? '多 ' : '空 ') + money(amount));
    put(key + '-change', q == null ? '' : q.abs().toString() + ' ' + asset() + ' · ' + hint);
  }
  const projection = c ?? result.heldCash;
  const bridge = result.bridge;
  put(
    'cash-bridge',
    bridge
      ? '失败路径 Hype（U） · ' +
          Object.entries(ledgerLabels)
            .map(([k, label]) => label + ' ' + fmt(bridge.entries[k], 4))
            .join('，') +
          '，预计结算 ' +
          fmt(bridge.settled, 4) +
          '。显示舍入差 ' +
          presentLedger(bridge).rounding +
          ' U。'
      : ''
  );
  put('protect-funds', money(result.protect));
  put(
    'margin-funds',
    Array.isArray(result.marginHL)
      ? '买 ' + money(result.marginHL[0]) + ' / 卖 ' + money(result.marginHL[1])
      : money(result.marginHL)
  );
  put('success-hl', money(projection?.expectedUserPayout));
  put(
    'fail-parts',
    projection?.failureHypeCash == null
      ? ''
      : 'Hype 结算现金 ' +
          money(projection.failureHypeCash)
  );
  put(
    'summary-margin',
    projection?.pressureCashAfter != null
      ? '按规则提现后，个人资金合计 ' + money(projection.pressureCashAfter)
      : ''
  );
  put(
    'summary-buffer',
    c?.priceBuffer != null
      ? '强平距离 ' + fmt(c.priceBuffer) + ' 价格单位'
      : c && dec(c.hlTargetQuantity).isZero()
        ? 'Hype 空仓，无强平价'
        : ''
  );
  const goalReached = result.stressedEquity != null && dec(result.stressedEquity).gte(r.challengeTarget);
  put(
    'reach-label',
    r.stage === 'funded'
      ? '出金阶段'
      : result.stressedEquity == null
        ? '未验证'
        : goalReached
          ? '条件下达到'
          : '条件下未到'
  );
  const stressNote =
    r.stage === 'funded'
      ? '两日考核压力仅用于考核阶段。'
      : !result.deadline
        ? '实际截止时间未配置，两日可达性未验证。'
        : !r.movePct
          ? '未验证两日触线可达性。'
          : !result.pressure
            ? '等待可计算的当前快照。'
            : '条件情景：假设实际截止前走完所填幅度，不按剩余时间外推波幅。有利变动 ' +
              r.movePct +
              '%。' +
              [1, -1]
                .map(
                  (d) =>
                    (d === 1 ? '做多' : '做空') +
                    '至少需 ' +
                    money(result.pressure[d]?.amount) +
                    '（' +
                    result.pressure[d]?.source +
                    '）'
                )
                .join('，') +
              (result.maximum?.amount
                ? '。' +
                  (result.maximum.complete ? '当前网格内最大可行 PF ' : '本次已验 PF 候选 ') +
                  money(result.maximum.amount)
                : '') +
              (c
                ? '。所选 PF ' +
                  money(c.vsNotional) +
                  '，条件净结算权益 ' +
                  money(result.stressedEquity) +
                  '。'
                : '');
  put('two-day', stressNote);
  $('alternatives').hidden = r.mode !== 'auto';
  const rowsAuto = (result.top ?? []).map((c, i) =>
    cellRow([
      (i === 0 ? '首选' : i === 1 ? '第二优' : '候选 ' + (i + 1)) +
        ' · ' +
        signed(c.vsTargetQuantity) +
        ' / ' +
        money(c.vsNotional),
      signed(c.hlTargetQuantity) + ' / ' + money(c.hlNotional),
      pct(c.actualRatio),
      c.candidateLeverage ? c.candidateLeverage + '×' : '空仓',
      money(c.requiredInitialMargin),
      money(c.stressedSurplus ?? c.baseSurplus),
      money(c.worstCash),
      fmt(c.priceBuffer),
      money(c.initialMargin[0]),
      (c.funding
        ? '失败 / 成功成本 ' + money(c.funding.failCost) + ' / ' + money(c.funding.passCost) + ' · '
        : '') +
        '基础约束通过 · 失败端 ' +
        money(c.failureCash) +
        ' / 成功端 Hype ' +
        money(c.hlBeforePayout) +
        ' · 最低维持余量 ' +
        money(c.buffer)
    ])
  );
  for (const bad of result.rejections ?? [])
    rowsAuto.push(
      cellRow([
        '淘汰 · ' + signed(bad.pf) + ' / ' + money(bad.candidate?.vsNotional),
        signed(bad.hl) + ' / ' + money(bad.candidate?.hlNotional),
        pct(bad.candidate?.actualRatio),
        bad.candidate?.candidateLeverage ? bad.candidate.candidateLeverage + '×' : '—',
        money(bad.candidate?.requiredInitialMargin),
        money(bad.candidate?.stressedSurplus ?? bad.candidate?.baseSurplus),
        money(bad.candidate?.worstCash),
        fmt(bad.candidate?.priceBuffer),
        money(bad.candidate?.initialMargin?.[0]),
        (bad.candidate?.funding
          ? '失败 / 成功成本 ' +
            money(bad.candidate.funding.failCost) +
            ' / ' +
            money(bad.candidate.funding.passCost) +
            ' · '
          : '') +
          bad.why +
          (bad.check
            ? '，实算 ' +
              checkNumber(bad.check.actual, bad.check.unit) +
              ' / 要求 ' +
              checkNumber(bad.check.required, bad.check.unit) +
              '，差 ' +
              checkNumber(bad.check.shortfall, bad.check.unit) +
              ' ' +
              bad.check.unit
            : '') +
          (bad.gaps?.length > 1
            ? ' ｜ ' +
              bad.gaps
                .filter((gap) => gap.code !== bad.check?.code)
                .map(
                  (gap) =>
                    constraintReason(gap.code) +
                    (gap.shortfall == null
                      ? ' 待核实'
                      : ' 缺 ' + checkNumber(gap.shortfall, gap.unit) + ' ' + gap.unit)
                )
                .join('、')
            : '')
      ])
    );
  const maximum = result.maximum,
    runner = result.top?.[1];
  put(
    'best-two',
    [
      maximum?.amount
        ? (maximum.complete ? '当前网格内最大可行 PF ' : '已找到的 PF 候选 ') +
          directional(maximum.candidate.vsTargetQuantity, maximum.amount) +
          ' / Hype ' +
          directional(maximum.candidate.hlTargetQuantity, maximum.candidate.hlNotional) +
          ' · ' +
          pct(maximum.candidate.actualRatio)
        : '',
      runner
        ? '第二优 PF ' +
          directional(runner.vsTargetQuantity, runner.vsNotional) +
          ' / Hype ' +
          directional(runner.hlTargetQuantity, runner.hlNotional) +
          ' · ' +
          pct(runner.actualRatio)
        : result.search
          ? '未找到第二个可行候选'
          : '',
      result.leverageStatus === 'LEVERAGE_UNVERIFIED' ? '账户设置未验证' : ''
    ]
      .filter(Boolean)
      .join(' ｜ ')
  );
  if ($('top-auto').textContent !== rowsAuto.map((x) => x.textContent).join(''))
    $('top-auto').replaceChildren(...rowsAuto);
  put(
    'flat-option',
    result.waiting?.personalCash != null
      ? '双边目标均为零时，按当前盘口平掉现仓后的个人现金 ' +
          money(result.waiting.personalCash) +
          '，其中 Hype ' +
          money(result.waiting.hlCash) +
          '；VS / Hype 差额成交费 ' +
          result.waiting.deltaFees.map(money).join(' / ') +
          '。空仓等待期间没有 VS 触线目标。'
      : ''
  );
  const rejected = result.eliminated;
  put(
    'rejected-auto',
    rejected
      ? '淘汰：PF ' +
          signed(rejected.pf) +
          '，Hype ' +
          signed(rejected.hl) +
          ' · ' +
          rejected.why +
          (rejected.check
            ? '，实算 ' +
              checkNumber(rejected.check.actual, rejected.check.unit) +
              ' / 要求 ' +
              checkNumber(rejected.check.required, rejected.check.unit) +
              '，差 ' +
              checkNumber(rejected.check.shortfall, rejected.check.unit) +
              ' ' +
              rejected.check.unit +
              '（' +
              rejected.check.source +
              '）'
            : '')
      : result.issues.join(' · ')
  );
  put('stress-assumptions', coverage + '。基础结果已计盘口成交费用。');
  put(
    'auto-search',
    result.search
      ? (result.search.complete
          ? c
            ? '当前输入与配置、五档深度、双边合法数量和杠杆网格内最优'
            : '当前输入与配置的合法网格搜索完成'
          : '搜索未穷尽，仅展示已验证候选') +
          ' · 精算 ' +
          result.search.evaluations +
          ' 组 · ' +
          result.autoStatus +
          ' · 版本 ' +
          result.stateVersion +
          ' · ' +
          (result.domain ?? [])
            .map(
              (x) =>
                (x.pfSide > 0 ? 'PF 多/Hype 空' : 'PF 空/Hype 多') +
                '：PF ' +
                (x.pf ? x.pf.min + '–' + x.pf.max + '（步长 ' + x.pf.step + '）' : '空集') +
                ' / Hype ' +
                (x.hl ? x.hl.min + '–' + x.hl.max + '（步长 ' + x.hl.step + '）' : '空集')
            )
            .join(' ｜ ')
      : (result.autoStatus ?? '')
  );
  if (result.flatHold)
    for (const k of ['pf', 'hl']) {
      put(k + '-summary', '空仓 0.00 U');
      put(k + '-change', '保持等待');
    }
  put('fail-summary', money(projection?.failureCash));
  put('pass-summary', money(projection?.hlBeforePayout));
  for (const [id, diff] of [
    ['fail', result.failVsPrincipal],
    ['pass', result.passVsPrincipal]
  ])
    put(
      id + '-change',
      diff == null
        ? ''
        : (id === 'pass' ? '按规则提现后，' + '个人合计' : '') +
            '相对保护本金及额外成本 ' +
            signedMoney(diff)
    );
  put(
    'current-h',
    result.currentH == null
      ? result.qty.pf === '0'
        ? result.qty.hl === '0'
          ? '不适用 / 双边无现仓'
          : 'VS 空仓 · 比例无定义'
        : '—'
      : pct(result.currentH) + (result.sameDirection ? ' · 同向敞口' : '')
  );
  put('range', b?.min == null ? '—' : dec(b.max).lt(b.min) ? '无交集' : pct(b.min) + ' – ' + pct(b.max));
  const budgetOnly =
    !stale &&
    !result.refreshPending &&
    !c &&
    !result.heldCash &&
    b?.selected &&
    !result.notices.some((n) => /已到期|待平台/.test(n));
  put(
    'target-h',
    c
      ? pct(c.actualRatio) +
          (c.code === 'FEASIBLE' && result.autoStatus !== 'AUTO_PARTIAL'
            ? result.search && !result.search.complete
              ? ' · 已验候选'
              : result.stress?.missing.length || result.stress?.zero.length
                ? ' · 基础候选'
                : result.leverageStatus === 'LEVERAGE_UNVERIFIED'
                  ? ' · 条件推荐'
                  : ' · 推荐'
            : c.code === 'FEASIBLE'
              ? ' · 基础候选（条件方案）'
              : ' · 待验证')
      : '—'
  );
  const verified = result.verified;
  put(
    'verified-range',
    verified
      ? '本次搜索已验证的离散比例 ' +
          pct(verified.min) +
          ' 至 ' +
          pct(verified.max) +
          '，共 ' +
          verified.count +
          ' 个可行比例'
      : '本次搜索已验证的可行比例：' + (c ? '保证金参数待补' : '暂无')
  );
  $('ratio-points').hidden = !verified;
  put('points', (result.points ?? []).map((x) => dec(x).times(100).toFixed(5) + '%').join('、'));
  put(
    'basis',
    r.mode === 'auto'
      ? '在现金留存与风险约束内比较 PF 仓位、最差现金和强平缓冲，同等风险选最低可行杠杆。'
      : '固定所选一侧的已成交仓位，在可行候选中优先成功端剩余现金。'
  );
  put(
    'profile-source',
    '来源：' +
      (r.editedAt ? '本机规则，最近编辑 ' + clock(r.editedAt) : '初始规则，待按平台确认') +
      '。保护本金中含报名费 ' +
      money(r.registration) +
      '，本金外需收回 ' +
      money(r.outsideCosts) +
      '。当前权益按账户快照计入。'
  );
  put(
    'bounds-detail',
    b?.min != null
      ? '保护下限 ' +
          pct(b.min) +
          ' · 成功提现前现金上限 ' +
          pct(b.cashMax) +
          ' · Hype 初始保证金按每对目标数量和候选档位单独核验' +
          (r.stage === 'funded'
            ? ' · 整轮利润上限 ' + (b.profitMax == null ? '缺少本轮起点' : pct(b.profitMax))
            : '') +
          (b.code !== 'FEASIBLE'
            ? ' · 按最低保护比例，成功端现金 ' +
              money(b.atMinimum.hlBefore) +
              '，要求留存 ' +
              money(result.funding?.R??r.R_success)
            : '')
      : '资金范围只需两边当前权益和已设规则。'
  );
  put(
    'bound-formula',
    b?.min != null && result.protect != null
      ? '失败保护下限 = max(0, (保护本金及额外历史成本 − 个人保护资金 + 额外摩擦预算) ÷ VS 到失败线的净值距离) = max(0, (' +
          fmt(dec(r.B).plus(r.outsideCosts)) +
          ' − ' +
          fmt(result.protect) +
          ' + ' +
          fmt(r.k) +
          ') ÷ ' +
          fmt(b.failureUnit) +
          ') = ' +
          pct(b.min) +
          '。成功端现金上限 = (Hype 权益 − 最低留存 − 额外摩擦预算) ÷ VS 到成功线的净值距离 = (' +
          fmt(result.cash.hl) +
          ' − ' +
          fmt(result.funding?.R??r.R_success) +
          ' − ' +
          fmt(r.k) +
          ') ÷ ' +
          fmt(b.successUnit) +
          ' = ' +
          pct(b.cashMax) +
          '。实际比例为两边目标仓位每单位价格变动的美元盈亏绝对值之比。取整后逐笔验算成交成本、可用保证金和维持保证金。'
      : '需要双方有效权益及阶段规则，才能代入上下限公式。'
  );
  const rows = [],
    orders = [];
  for (const [s, name, target, delta, notional] of [
    ['pf', 'VS / PF', c?.vsTargetQuantity, c?.vsDeltaQuantity, c?.vsNotional],
    ['hl', 'Hype', c?.hlTargetQuantity, c?.hlDeltaQuantity, c?.hlNotional]
  ]) {
    const q = result.qty[s],
      adj = result.adjust?.[s],
      u = ' ' + asset();
    const amt = (x) =>
      x == null ? '未知' : dec(x).eq(0) ? '空仓' : (dec(x).gt(0) ? '多 ' : '空 ') + dec(x).abs() + u;
    rows.push(
      cellRow([
        name,
        amt(q) + (result.currentNotional[s] != null ? ' · ' + money(result.currentNotional[s]) : ''),
        target == null
          ? ((r.mode === 'keepPF' && s === 'pf') || (r.mode === 'keepHL' && s === 'hl')) && q != null
            ? '保持 ' + amt(q)
            : '—'
          : amt(target) + ' · ' + money(notional),
        action(q, delta) +
          (delta != null && !dec(delta).isZero()
            ? ' · ' +
              money(
                out(
                  dec(delta)
                    .abs()
                    .times(String(m[s].mark))
                    .times(result.currencies.legs[s].multiplier)
                    .times(result.currencies.legs[s].pointToLedger.mid)
                )
              )
            : ''),
        adj
          ? adj.remaining == null
            ? '待核对挂单'
            : dec(adj.remaining).isZero()
              ? '保持 / 已覆盖'
              : action(adj.projected ?? q, adj.remaining)
          : '—'
      ])
    );
    const list = a[s].orders;
    const orderSummary =
      list == null
        ? '挂单未知'
        : !list.length
          ? '无挂单'
          : list
              .map((o) => signed(o.qty) + (o.conditional ? ' 触发单' : '') + (o.reduceOnly ? ' 只减仓' : ''))
              .join('、');
    orders.push(
      name +
        ' ' +
        orderSummary +
        (adj?.projected != null ? '；若全部成交 ' + signed(adj.projected) + u + ' · ' + adj.text : '')
    );
    const rawAccount = a[s].unsupported
      ? '该资金池待核实 · API 原始权益 ' + money(a[s].rawEquity) + '。'
      : '';
    put(
      s + '-capacity',
      rawAccount +
        (a[s].directionalFree
          ? 'API 可用保证金 · 买入 ' +
            money(a[s].directionalFree[0]) +
            ' / 卖出 ' +
            money(a[s].directionalFree[1])
          : '')
    );
    $(s + '-free').hidden = !!a[s].directionalFree;
    $(s + '-free').parentElement.hidden = !!a[s].directionalFree;
    const origin = a[s].source || '手工确认';
    put(
      s + '-meta',
      origin +
        ' · ' +
        clock(fieldTime(a[s], 'equity')) +
        ' · ' +
        freshnessLabel(fieldTime(a[s], 'equity'), r.accountSecs) +
        (result.cash[s] != null
          ? ' · ' + (a[s].anchor ? '按标记价估算 ' : '权益快照 ') + money(result.cash[s])
          : '')
    );
  }
  if (plan)
    for (const s of ['pf', 'hl'])
      put(
        s + '-meta',
        '预设起始权益 ' + money(a[s].equity) + (r.planCrossFlat ? ' · 规划空仓' : ' · 起始持仓待确认')
      );
  if ($('legs').textContent !== rows.map((row) => row.textContent).join(''))
    $('legs').replaceChildren(...rows);
  put('order-detail', orders.join(' ｜ '));
  const context = JSON.stringify([r, asset(), useAPI(), a.pf.at, a.pf.qty, a.hl.at, a.hl.qty]);
  if (c) previous = { context, asOf: now(), delta: c.hlDeltaQuantity, h: c.actualRatio };
  put(
    'previous',
    stale && previous?.context === context
      ? '过期前最后一次计算（仅供核对） ' +
          clock(previous.asOf) +
          ' · h ' +
          pct(previous.h) +
          ' · Hype 差额 ' +
          signed(previous.delta) +
          ' ' +
          asset()
      : ''
  );
  put(
    'reason',
    [...new Set([...result.issues, ...(c ? ['差额按五档盘口计费；已有仓位保持时开仓费为零。'] : [])])].join(
      ' · '
    )
  );
  const budget =
    !stale && budgetOnly && !result.issues.some((x) => /无解|没有满足|没有可行/.test(x)) ? b.atMinimum : null;
  const lines = [
    ['失败端 Hype 结算现金', money(projection?.failureHypeCash)],
    ['失败端个人保护资金合计', money(projection?.failureCash ?? budget?.fail)],
    ['成功端提现前 Hype 现金', money(projection?.hlBeforePayout)],
    ['成功端提现前个人资金', money(projection?.cashBeforePayout ?? budget?.before)],
    ['成功端按规则提现后个人合计', money(projection?.pressureCashAfter ?? budget?.after)],
    ['失败端相对保护本金及额外成本', money(result.failVsPrincipal)],
    ['成功端按规则提现后，相对保护本金及额外成本', money(result.passVsPrincipal)],
    ['按规则提现后的现金变化', money(result.forward)],
    ['整轮条件净收益', r.ref ? money(result.round) : '缺少本轮起点'],
    ['成功路径 PF 个人预计提现', money(projection?.expectedUserPayout)]
  ];
  renderPairs('cash-results', lines);
  renderRisk(result, a, m);
  put(
    'rule-events',
    [...(budget ? ['仅按资金参考比例估算，具体成交成本待验算'] : []), ...result.notices].join(' · ')
  );
  if (stale) lastCalculation = '当前时间 ' + clock(now()) + ' · 过期，暂停调整量';
  else
    lastCalculation =
      '计算于 ' + clock(result.calculatedAt ?? now()) + (result.refreshPending ? ' · 新行情正在重算' : '');
  put(
    'times',
    lastCalculation +
      (plan
        ? ' · 资金来自预设，行情时间见双边报价'
        : ' · PF 快照 ' + clock(a.pf.at) + ' · Hype 快照 ' + clock(a.hl.at))
  );
  const qs = ['pf', 'hl'].map((s) => {
    const q = m[s];
    return (
      (s === 'pf' ? 'Vest' : 'Hyperliquid') +
      ' ' +
      (q
        ? '标记 ' +
          q.mark +
          ' · 买/卖 ' +
          q.levels?.[0]?.[0]?.[0] +
          ' / ' +
          q.levels?.[1]?.[0]?.[0] +
          ' · ' +
          clock(q.asOf)
        : '等待报价')
    );
  });
  for (const [i, k] of ['pf', 'hl'].entries()) {
    const q = m[k],
      manual = $('quote-source').value === 'manual';
    put(
      k + '-quote',
      qs[i] +
        (q
          ? ' · ' +
            (manual ? '手工盘口' : k === 'pf' ? 'Vest WebSocket' : q.bookSource) +
            ' · ' +
            freshnessLabel(q.asOf, r.quoteSecs) +
            (q.markAt ? ' · 标记价 ' + clock(q.markAt) + ' ' + freshnessLabel(q.markAt, r.quoteSecs) : '')
          : '')
    );
  }
  put(
    'field-sources',
    plan
      ? '来源为规划参数。已保存的真实账户读数可在当前账户快照中查看。'
      : ['pf', 'hl']
          .map((k) => {
            if (k === 'hl' && useAPI()) return 'Hype 主网账户查询 ' + clock(a.hl.at);
            return (
              (k === 'pf' ? 'VS' : 'Hype') +
              ' ' +
              Object.entries(local()[k].origins ?? {})
                .map(
                  ([field, meta]) =>
                    (legFields[field] ??
                      { qty: '持仓', equity: '权益', leverage: '杠杆', marginMode: '保证金模式' }[field] ??
                      field) +
                    ' ' +
                    meta.source +
                    ' ' +
                    clock(meta.at) +
                    ' ' +
                    freshnessLabel(meta.at, r.accountSecs)
                )
                .join('、')
            );
          })
          .join(' ｜ ')
  );
  put(
    'quotes',
    ($('quote-source').value === 'api' ? '公开行情' : '手工盘口') +
      ' ｜ ' +
      qs.join(' ｜ ') +
      (m.pf?.asOf && m.hl?.asOf
        ? ' · 双边时差 ' + Math.abs(Date.parse(m.pf.asOf) - Date.parse(m.hl.asOf)) + ' ms'
        : '') +
      (quoteError ? ' ｜ ' + quoteError : '')
  );
  const currencies = result.observed?.currencies ?? result.currencies;
  const fxRows = [];
  for (const [k, name] of [['pf', 'Vest'], ['hl', 'Hyperliquid']]) {
    const c = currencies?.[k];
    if (c) fxRows.push(name + ' ' + c.symbol + ' · 标的 ' + (c.baseAsset ?? '未知') +
      ' · 报价 ' + (c.quoteAsset ?? '未知') + ' · 结算 ' + (c.settleAsset ?? '未知') +
      ' · 每数量单位 ' + (c.contractMultiplier ?? '未知') + ' ' + (c.baseAsset ?? '') +
      ' · ' + (c.settlement === 'quanto-1:1' ? '每个报价点按 1 个结算币记账' : '线性') +
      ' · ' + c.source + (c.collateralEvidence ? ' · spotMeta 抵押币索引 ' +
        c.collateralEvidence.index + ' = ' + c.collateralEvidence.name : ''));
  }
  if (m.hl?.symbol) fxRows.push('Hyperliquid ' + m.hl.symbol +
    ' Perpetual · metaAndAssetCtxs (coin ' + m.hl.symbol + ', asset id ' + (m.hl.assetId ?? '未知') + ') · ' +
    (m.hl.bookSource ?? 'l2Book') + ' · '+(m.hl.markSource ?? '标记价')+' · Mark ' + (m.hl.mark ?? '未知') + ' / Oracle ' + (m.hl.oracle ?? '未知') +
    '。Mark 用于估值；Oracle 是参考指数，App 图表和逐笔成交的 Last 可与二者不同。' +
    ' 数量小数位 ' + m.hl.sizeDecimals + '，合约最大杠杆 ' + (m.hl.maxLeverage ?? '未知') +
    '，当前账户保证金模式 ' + (a.hl.marginMode ?? '未知') + '。');
  for (const [asset, q] of Object.entries(currencies?.spots ?? {}))
    fxRows.push('USD_per_' + asset + ' · ' + (q.error || ('买 ' + q.bid + ' / 卖 ' + q.ask +
      ' · ' + q.source + ' ' + q.asOf + ' · 本帧有效，年龄 ' +
      Math.max(0, Date.now() - Date.parse(q.asOf)) + ' ms · 偏离 1 USD 为 ' + fmt(q.deviationBps, 2) + ' bp')));
  const spot = currencies?.hypeToVest;
  if (spot) fxRows.push('独立汇率参考 · ' + spot.name + ' ' + fmt(spot.mid, 9));
  if (currencies?.referenceError) fxRows.push('独立汇率参考暂停 · ' + currencies.referenceError);
  if (currencies?.warnings?.length) fxRows.push(...currencies.warnings);
  if (result.ratioScan) {
    const { market } = result.ratioScan.ctx;
    fxRows.push('共同路径每上移 1 个原生价格点，每 1 个多头下单单位的盈亏敏感度 · Vest ' +
      normalizeExposure('1', market.pf) + ' USDC，Hyperliquid ' +
      normalizeExposure('1', market.hl) + ' USDC。空头符号相反。');
  }
  const dollarMark = currencies?.spots?.USDC;
  if (dollarMark?.mid && result.cash.hl != null) {
    const fiat = dec(result.cash.hl).times(dollarMark.mid);
    fxRows.push('独立汇率情景 · 固定币数与标的报价，Hype 当前 ' + fmt(result.cash.hl) +
      ' USDC 按此现货值 ' + fmt(fiat, 4) + ' USD，与 1 USD 平价相差 ' +
      fmt(fiat.minus(result.cash.hl), 4) + ' USD。');
  }
  const row = result.ratioScan?.representative?.row;
  if (dollarMark?.mid && row && !row.failStop && !row.passStop)
    fxRows.push('若当前 USDC/USD 保持至平仓，失败端个人资金折合 ' +
      fmt(dec(row.fail).times(dollarMark.mid), 4) + ' USD，通过端折合 ' +
      fmt(dec(row.successPersonal).times(dollarMark.mid), 4) + ' USD。两端 U 账本保留 USDC 口径。');
  if (currencies?.error) fxRows.push(currencies.error);
  put('fx-source', fxRows.join('\n') || '等待合约与报价元数据');
  put(
    'sync-status',
    useAPI()
      ? apiError ||
          (api
            ? 'Hype 主网 · ' +
              api.mode +
              ' · 返回账户价值 ' +
              money(api.rawEquity) +
              ' · 已用保证金 ' +
              money(api.used) +
              ' · 可转出 ' +
              money(api.withdrawable)
            : '等待读取公开地址')
      : plan
        ? '使用预设资金和双边公开行情。账户余额、持仓和挂单按规划起点计算。'
        : '当前使用手工账户快照，公开行情独立更新。'
  );
}
function refreshMarket() {
  if (calculatorPage) { scheduleBackendSync(); return; }
  const version = ++feedVersion, symbol = asset();
  clearTimeout(quoteTimer);
  clearTimeout(rateTimer);
  const active = () => version === feedVersion && asset() === symbol;
  async function read(url) {
    const resp = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    if (!resp.ok) throw Error('HTTP ' + resp.status);
    return resp.json();
  }
  const recovery=new Map();
  async function pollQuotes() {
    try {
      const data = await read('/api/current-market?asset=' + encodeURIComponent(symbol) + '&partial=1');
      if (!active()) return;
      if (data.asset !== symbol) throw Error('返回合约不一致');
      const next = {...data, errors:{...data.errors}};
      // Last-seen native quotes retain their source timestamps, and a missing
      // leg blocks new trade calculations until that venue actually responds.
      for (const k of ['pf','hl']) if (!next[k] && feed.asset === symbol && feed[k]) {
        next[k] = feed[k];
        next.errors[k] ||= (k === 'pf' ? 'Vest' : 'Hyperliquid') + ' 本次缺少报价';
      }
      // A browser can lose its HTTP connection while the server feed stays healthy.
      // Count distinct source observations on this client before promoting a recovery.
      for(const side of ['pf','hl']) {
        const clock=quoteClock(next[side],Date.now(),Math.min(3000,Number(r.quoteSecs)*1000));
        const stamp=Math.min(Date.parse(clock.bookAt),Date.parse(clock.markAt));
        if(next.errors[side] || !clock.ok || !subscriptionHealthy(next,side,Date.now())) recovery.set(side,null);
        else if(recovery.has(side)) {
          const first=recovery.get(side);
          if(first!=null && stamp>first && stamp-first<=3000) recovery.delete(side);
          else {
            recovery.set(side,stamp);
            next.errors[side]='本地行情恢复中，等待连续有效报价';
          }
        }
      }
      feed = next;
      quoteError = Object.values(next.errors).filter(Boolean).join(' · ');
    } catch (error) {
      if (!active()) return;
      recovery.set('pf',null); recovery.set('hl',null);
      quoteError = '本地行情连接失败 · ' + error.message;
      feed = {...feed, asset:symbol, errors:{...feed.errors, pf:quoteError, hl:quoteError}};
    }
    if (active()) {
      quoteTimer = setTimeout(pollQuotes, Math.min(2200,Math.max(1250,lastSolveMs+180)));
      render();
    }
  }
  async function pollRates() {
    let next = {};
    try { next = (await read('/api/usd-rates')).rates ?? {}; }
    catch { /* Missing FX is reported separately from native quotes. */ }
    if (active()) {
      rates = next;
      rateTimer = setTimeout(pollRates, 1250);
      render();
    }
  }
  void pollQuotes();
  void pollRates();
}
async function refreshAccount() {
  if (calculatorPage) { scheduleBackendSync(); return; }
  const version = ++accountVersion;
  clearTimeout(accountTimer);
  if (!useAPI()) {
    api = null;
    apiError = '';
    inputs();
    render();
    return;
  }
  const wallet = $('wallet').value.trim();
  if (!/^0x[0-9a-f]{40}$/i.test(wallet)) {
    api = null;
    apiError = '请填写完整的公开地址';
    inputs();
    render();
    return;
  }
  try {
    const value = await accountSnapshot(wallet, asset(), async (body) => {
      const resp = await fetch('/api/hype-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ network: 'mainnet', request: body }),
        signal: AbortSignal.timeout(7000)
      });
      if (!resp.ok) throw Error('主网查询失败');
      return resp.json();
    });
    if (version !== accountVersion) return;
    if (api?.at && value.at < api.at) throw Error('Hype 返回旧快照，保留最近读数');
    api = value;
    apiError = '';
  } catch (e) {
    if (version !== accountVersion) return;
    apiError = e.message;
  }
  inputs();
  render();
  accountTimer = setTimeout(refreshAccount, 5000);
}
function invalidatePreview() {
  pending = null;
  $('confirm').disabled = true;
  put('preview', '');
}
function manualImport(side, v, stamp) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('每个平台须提供当前快照对象');
  const f = {};
  for (const k of ['equity', 'qty', 'anchor', 'leverage', 'otherHold', 'free', 'maxQty']) {
    if (v[k] != null && v[k] !== '')
      f[k] = out(
        (['anchor', 'leverage'].includes(k)
          ? positive
          : ['otherHold', 'free', 'maxQty'].includes(k)
            ? nonnegative
            : dec)(String(v[k]))
      );
  }
  if (v.marginMode != null) {
    if (!['cross', 'isolated'].includes(v.marginMode)) throw Error('保证金模式无效');
    f.marginMode = v.marginMode;
  }
  if (v.orders !== undefined) f.orders = approvedOrders(v.orders);
  if (v.otherPositions !== undefined) f.otherPositions = v.otherPositions === true;
  if (!Object.keys(f).length) throw Error('未读取到可用字段');
  if (v.currency && v.currency !== 'USDC') throw Error('此表单需要 USDC 等值快照');
  if (v.at != null && (!Number.isFinite(Date.parse(v.at)) || Date.parse(v.at) > Date.now() + 1000))
    throw Error('快照时间无效');
  return { side, fields: f, stamp: v.at ?? stamp };
}
function parseVS(raw, stamp) {
  const v = manualVs(raw, 'USDC', stamp),
    listed = v.positions?.filter((p) => p.symbol === asset() + '-PERP' || p.symbol === asset());
  if (v.symbol && ![asset(), asset() + '-PERP'].includes(v.symbol)) throw Error('VS 快照与当前合约不同');
  if (listed?.length > 1) throw Error('同品种多笔分仓，请核对后输入带符号净数量');
  const f = {
    equity: v.fields.equity,
    free: v.fields.free,
    anchor: v.fields.mark,
    at: v.accountAt ?? v.occurredAt ?? stamp
  };
  if (listed) {
    f.qty = listed[0]?.qty ?? '0';
    f.otherPositions = listed.length !== v.positions.length;
  }
  return { edit: manualImport('pf', f, stamp), stage: v.stage };
}
$('parse').onclick = () => {
  invalidatePreview();
  try {
    const stamp = now(),
      raw = $('paste').value.trim(),
      edits = [];
    let stage = null;
    if ($('paste-kind').value === 'both') {
      const j = JSON.parse(raw);
      if (j.asset !== asset()) throw Error('快照品种与当前合约不同');
      for (const k of ['pf', 'hl']) if (j[k]) edits.push(manualImport(k, j[k], stamp));
      stage = j.stage;
    } else {
      const parsed = parseVS(raw, stamp);
      edits.push(parsed.edit);
      stage = parsed.stage;
    }
    if (!edits.length || (stage && !['challenge', 'funded'].includes(stage)))
      throw Error('当前快照或阶段无效');
    if (edits.some((e) => e.side === 'hl') && useAPI()) throw Error('请切换到手工 Hype 来源后确认');
    pending = {
      edits,
      stage,
      source: $('paste-kind').value === 'vs' ? 'VS 粘贴确认' : '手工确认 · 快照导入'
    };
    put('preview', JSON.stringify(pending, null, 2));
    $('confirm').disabled = false;
  } catch (e) {
    put('preview', e.message);
  }
};
function applySnapshot(snapshot) {
  if (planning()) throw Error('请先切换到当前账户快照，再写入识别结果');
  if(snapshot.stage && snapshot.stage!==r.stage) throw Error('导入快照的阶段与当前资金阶段不同');
  for (const e of snapshot.edits) {
    const old = local()[e.side];
    const stamps = Object.keys(e.fields).map((k) => old.origins?.[k]?.at);
    if ('qty' in e.fields) stamps.push(old.qtyAt);
    if ('equity' in e.fields) stamps.push(state.shared[e.side]?.at);
    if (stamps.some((t) => t && Date.parse(e.stamp) < Date.parse(t)))
      throw Error('识别结果早于当前快照，请核对平台时间。');
  }
  for (const e of snapshot.edits) updateLeg(e.side, e.fields, e.stamp, snapshot.source);

  save();
  inputs();
  render();
}
$('confirm').onclick = () => {
  if (!pending) return;
  try {
    applySnapshot(pending);
    invalidatePreview();
    put('preview', '已确认当前快照');
  } catch (e) {
    put('preview', e.message);
  }
};

let bridge = null;
async function bridgeRequest(action, body) {
  const response = await fetch(
    '/api/bridge/' + action,
    body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const value = await response.json();
  if (!response.ok) throw Error(value.error ?? '本机桥接失败');
  return value;
}
function clearBridge() {
  bridge = null;
  $('bridge-script').value = '';
  $('bridge-script').hidden = true;
  $('bridge-copy').disabled = true;
}
$('bridge-pair').onclick = async () => {
  try {
    const assetId = asset(),
      origin = new URL($('bridge-origin').value).origin;
    const paired = await bridgeRequest('pair', { origin, assetId });
    if (assetId !== asset()) return;
    bridge = { ...paired, sequence: 0 };
    $('bridge-script').value = captureScript({ ...paired, baseURL: location.origin });
    $('bridge-script').hidden = false;
    $('bridge-copy').disabled = false;
    put(
      'bridge-state',
      '已配对 ' +
        assetId +
        ' · ' +
        origin +
        '，有效至 ' +
        clock(new Date(paired.expires).toISOString()) +
        '。在来源页确认 USDC 等值快照后自动更新。'
    );
  } catch (e) {
    put('bridge-state', e.message);
  }
};
$('bridge-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('bridge-script').value);
    put('bridge-state', '已复制，请在配对的 VS 页面核对并发送快照。');
  } catch {
    $('bridge-script').select();
    put('bridge-state', '已选中采集脚本，可直接复制。');
  }
};
$('bridge-revoke').onclick = async () => {
  try {
    await bridgeRequest('revoke', {});
    clearBridge();
    put('bridge-state', '配对已撤销');
  } catch (e) {
    put('bridge-state', e.message);
  }
};
async function pollBridge() {
  if (planning()) return;
  const pair = bridge;
  if (!pair) return;
  if (Date.now() >= pair.expires) {
    clearBridge();
    put('bridge-state', '配对已到期');
    return;
  }
  try {
    const msg = await bridgeRequest('latest');
    if (
      !msg ||
      pair !== bridge ||
      pair.assetId !== asset() ||
      msg.assetId !== asset() ||
      msg.sequence <= pair.sequence
    )
      return;
    pair.sequence = msg.sequence;
    const parsed = parseVS(JSON.stringify(msg.snapshot), msg.snapshot.asOf);
    applySnapshot({ edits: [parsed.edit], stage: parsed.stage, source: 'VS 本机桥接 · ' + pair.origin });
    put('bridge-state', '已接收当前账户快照 · ' + clock(msg.receivedAt));
  } catch (e) {
    put('bridge-state', e.message);
  }
}
setInterval(pollBridge, 1500);
$('paste').oninput = invalidatePreview;
$('paste-kind').onchange = invalidatePreview;
for (const k of [
  'mode',
  'stage',
  'challengeDailyMode',
  'fundedLossMode',
  'fundedDailyMode',
  'B',
  'R_success',
  'R_free',
  'hardDepthD',

  ...Object.keys(ruleFields)
]) {
  const isSelectEl = ['stage','challengeDailyMode','fundedLossMode','fundedDailyMode','mode','objective'].includes(k);
  const handleRuleInput = () => {
    if (k==='stage') {
      const nextStage=$(k).value;
      if (!['challenge','funded'].includes(nextStage)) return;
      // In calculator planning mode, switching Challenge / Funded is a pure UI re-projection:
      // NEVER mutate r.stage, planFundedCash, planPF, evaluationClose, fundedAccount, storage,
      // NEVER trigger config POST, SSE reconnect, or cancel in-flight backend jobs!
      if (planningProjectionMode()) {
        if (nextStage===displayStage) return;
        displayStage=nextStage;
        inputs();
        reprojectCandidateSet(displayStage);
        return;
      }
      if (nextStage===r.stage) return;
      if (r.evaluationClose) {
        if (nextStage==='funded' && r.evaluationClose.status==='passed' && r.evaluationClose.hype!=null)
          r.planFundedCash=r.evaluationClose.hype;
        (r.closedEvaluations??=[]).push({evaluation:r.evaluationClose,funded:r.fundedAccount});
        delete r.evaluationClose;
      }
      r.stage=nextStage;
      displayStage=nextStage;
      if (nextStage==='funded') {
        if (planning() && (!r.planPF || dec(r.planPF).gte(r.challengeTarget || '11000')))
          r.planPF=r.fundedAccount?.equity ?? r.resetBaseline ?? r.baseline ?? '10000';
      } else {
        delete r.fundedAccount;
      }
      r.editedAt=now();
      cancelAuto(); lastGood=null;
      save(); inputs(); render();
      return;
    }
    const prevRuleVal = r[k];
    r[k] = $(k).value.trim();
    if (k === 'challengeFloor' && r[k] && (!r.fundedFloor || r.fundedFloor === prevRuleVal)) {
      r.fundedFloor = r[k];
    }
    // Section 2.2: Evaluation and Funded inherit daily loss rules from the same purchased account configuration
    if (k === 'challengeDailyMode' && (!r.fundedDailyMode || r.fundedDailyMode === prevRuleVal || r.fundedDailyMode === 'missing')) {
      r.fundedDailyMode = r[k];
      if (r[k] === 'none') {
        r.challengeDailyFloor = '';
        r.fundedDailyFloor = '';
      }
    }
    if (k === 'challengeDailyFloor' && (!r.fundedDailyFloor || r.fundedDailyFloor === prevRuleVal)) {
      r.fundedDailyFloor = r[k];
    }
    if (k === 'fundedDailyMode' && r[k] === 'none') {
      r.fundedDailyFloor = '';
    }
    if (['challengeTarget','challengeFloor','challengeDailyMode','challengeDailyFloor','fundedLossMode','fundedFloor','fundedMaxLoss','fundedDailyMode','fundedDailyFloor','share','baseline','resetBaseline'].includes(k)) {
      r.accountPreset = detectAccountPreset({ ...r, accountPreset: null });
    }
    if (k === 'mode' && r.mode !== 'auto') $('desk-details').open = true;
    r.editedAt = now();
    if (['stage','challengeDailyMode','fundedLossMode','fundedDailyMode','challengeDailyFloor','fundedDailyFloor','fundedFloor','fundedMaxLoss','fundedTarget','challengeTarget','challengeFloor','baseline','share','passCost','investedCapital','B'].includes(k) || (planning() && k === 'registration')) inputs();
    if (k === 'share' || k === 'platformShare') {
      const other=k==='share'?'platformShare':'share';
      if (/^(0?(?:\.\d+)|0|1(?:\.0+)?)$/.test(r[k])) {
        r[other]=out(dec('1').minus(r[k].startsWith('.')?'0'+r[k]:r[k]));
        $(other).value=r[other];
      }
    }
    if (k === 'deadlineMark') {
      r.deadlineAsset = asset();
      r.deadlineBound = r.deadline;
    }
    if (k === 'deadline' || k==='challengeStart') {
      const stamp=examTimestamp(r[k]);
      if (Number.isFinite(stamp)) {
        r[k]=new Date(stamp).toISOString();
        if(k==='challengeStart') {
          r.deadline=new Date(stamp+48*3600000).toISOString();
          $('deadline').value=localExamInput(r.deadline);
        }
      }
      r.deadlineMark = '';
      $('deadlineMark').value = '';
    }

    save();
    render();
  };
  $(k).addEventListener(isSelectEl ? 'change' : 'input', handleRuleInput);
  if (!isSelectEl) $(k).addEventListener('change', handleRuleInput);
}
for (const s of ['pf', 'hl'])
  for (const k of ['equity', 'qty', ...Object.keys(legFields), 'leverage', 'marginMode']) {
    const el = $(s + '-' + k);
    if (!el) continue;
    el.addEventListener(['equity','qty','orders'].includes(k)?'change':'input', () => {
      if (planning() || (s === 'hl' && useAPI())) return;
      try {
        const str = el.value.trim(),
          value =
            k === 'orders'
              ? str
                ? str === '0'
                  ? []
                  : approvedOrders(str.split(/[,，]/).map((q) => ({ qty: q.trim() })))
                : null
              : str;
        updateLeg(s, { [k]: value });
        delete local()[s].error;
      } catch (e) {
        local()[s].error = e.message;
        if (k === 'orders') local()[s].orders = null;
      }
      save();
      render();
    });
  }
for (const field of Object.keys(planFields)) {
  const handlePlanInput = () => {
    if (!planning()) return;
    const prevVal = r[field];
    const nextVal = $(field).value.trim();
    r[field] = nextVal;
    if (field === 'planCapital') r.B = nextVal;
    // Keep Funded original account size (baseline / resetBaseline) aligned with planPF when user edits S,
    // preventing Silver 5,000U accounts from accidentally inheriting Gold 10,000U Funded baselines!
    if (field === 'planPF' && nextVal) {
      if (!r.baseline || r.baseline === prevVal) r.baseline = nextVal;
      if (!r.resetBaseline || r.resetBaseline === prevVal) r.resetBaseline = nextVal;
    }
    if (field === 'planPF' || field === 'registration') {
      r.accountPreset = detectAccountPreset({ ...r, accountPreset: null });
    }
    r.editedAt = now();
    save();
    inputs();
    render();
  };
  $(field).addEventListener('input', handlePlanInput);
  $(field).addEventListener('change', handlePlanInput);
}
$('plan-cross-flat').onchange = () => {
  if (planning()) {
    r.planCrossFlat = $('plan-cross-flat').checked;
    r.editedAt = now();
    save();
    inputs();
    render();
  }
};
$('funding-view').onchange = () => {
  state.fundingView = $('funding-view').value;
  r = planning() ? state.planRules : state.rules;
  displayStage = r.stage === 'funded' ? 'funded' : 'challenge';
  api = null;
  previous = null;
  cancelAuto();
  invalidatePreview();
  save();
  manualPrices = null;
  $('quote-source').value = 'api';
  inputs();
  render();
  refreshAccount();
};
$('confirm-balances').onclick = () => {
  const stamp = now(),
    sides = useAPI() ? ['pf'] : ['pf', 'hl'];
  try {
    const edits = sides.map((side) => {
      const equity = out(dec($(side + '-equity').value.trim()));
      const free = out(nonnegative($(side + '-free').value.trim()));
      return [side, { equity, free }];
    });
    for (const [side, fields] of edits) updateLeg(side, fields, stamp, '手工核对平台余额');
    save();
    inputs();
    render();
    put('flat-feedback', '已记录本次核对的权益与可用保证金 · ' + clock(stamp));
  } catch {
    put('flat-feedback', '请先填写两边实际权益与可用保证金，再确认。');
  }
};
// Each fact is confirmed independently. A full-account declaration may supersede
// stale records on other symbols, but a fresh conflicting position/order needs review.
const factNames = { qty: '全账户空仓', orders: '全账户无挂单', marginMode: '使用全仓' };
function confirmFacts(sides, fields) {
  if (planning()) return;
  const stamp = now(),
    ttl = Number(r.accountSecs) * 1000;
  for (const side of sides) {
    if (side === 'hl' && useAPI()) return;
    const conflict = Object.values(state.assets).some((pair) => {
      const v = pair[side];
      return (
        v &&
        ((fields.includes('qty') &&
          ((v.otherPositions && fresh(v.origins?.otherPositions?.at ?? v.qtyAt, Date.now(), ttl)) ||
            (Number(v.qty) && fresh(v.qtyAt, Date.now(), ttl)))) ||
          (fields.includes('orders') && v.orders?.length && fresh(v.origins?.orders?.at, Date.now(), ttl)))
      );
    });
    if (conflict) return put('flat-feedback', '当前快照有持仓或挂单，请先核对对应品种。');
  }
  for (const side of sides) {
    for (const [symbol, pair] of Object.entries(state.assets)) {
      const v = pair[side];
      if (symbol === asset() || !v) continue;
      v.origins ??= {};
      for (const field of fields.filter((k) => k !== 'marginMode')) {
        v[field] = field === 'qty' ? '0' : [];
        v.origins[field] = { at: stamp, source: '确认' + factNames[field] };
        if (field === 'qty') {
          v.qtyAt = stamp;
          v.anchor = null;
          v.otherPositions = false;
        }
      }
    }
    for (const field of fields) {
      const value = field === 'qty' ? '0' : field === 'orders' ? [] : 'cross';
      updateLeg(side, { [field]: value }, stamp, '手工确认' + factNames[field]);
      if (field === 'qty') {
        local()[side].allFlatAt = stamp;
        local()[side].otherPositions = false;
      }
      if (field === 'orders') local()[side].noOrdersAt = stamp;
    }
    const v = local()[side];
    if (
      fresh(v.allFlatAt, Date.now(), ttl) &&
      fresh(v.noOrdersAt, Date.now(), ttl) &&
      v.qty === '0' &&
      v.orders?.length === 0
    ) {
      const confirmed = v.allFlatAt < v.noOrdersAt ? v.allFlatAt : v.noOrdersAt;
      updateLeg(side, { flatConfirmedAt: confirmed, otherHold: '0' }, confirmed, '全账户持仓及挂单均已核对');
    }
  }
  put(
    'flat-feedback',
    '已确认 ' +
      sides.map((s) => (s === 'pf' ? 'VS' : 'Hype')).join(' / ') +
      ' ' +
      fields.map((k) => factNames[k]).join('、') +
      ' · ' +
      clock(stamp)
  );
  inputs();
  save();
  render();
}
for (const side of ['pf', 'hl'])
  for (const field of Object.keys(factNames)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'confirm-' + side + '-' + field;
    btn.textContent = (side === 'pf' ? 'VS ' : 'Hype ') + factNames[field];
    btn.onclick = () => confirmFacts([side], [field]);
    $('separate-confirm').append(btn);
  }
$('confirm-flat').onclick = () => {
  if (planning() || !window.confirm('确认刚刚核对两边全账户空仓、无挂单，并且均使用全仓模式？')) return;
  confirmFacts(useAPI() ? ['pf'] : ['pf', 'hl'], Object.keys(factNames));
};
$('ledger-exact').onchange = render;
$('bound-details').ontoggle = render;
window.addEventListener('storage', (event) => {
  if (event.key !== key) return;
  const next = JSON.parse(storage.getItem(key) || 'null');
  if (next?.version !== 1) return;
  Object.assign(state, { assets: next.assets, shared: next.shared, asset: next.asset, vestSpecs: next.vestSpecs });
  state.rules = { ...rules, ...splitReserves(next.rules), riskPreference: '0' };
  state.planRules = { ...rules, ...planDefaults, ...splitReserves(next.planRules), riskPreference: '0' };
  for(const profile of [state.rules,state.planRules]) initializeProfile(profile);
  r = planning() ? state.planRules : state.rules;
  const switched = feed.asset !== asset();
  if (switched) {
    feed = {};
    api = null;
    manualPrices = null;
  }
  invalidatePreview();
  inputs();
  render();
  if (switched) {
    refreshMarket();
    refreshAccount();
  }
});
$('asset').onchange = () => {
  if (bridge) {
    clearBridge();
    bridgeRequest('revoke', {}).catch(() => {});
    put('bridge-state', '合约已切换，请重新配对。');
  }
  state.asset = $('asset').value;
  feed = {};
  api = null;
  manualPrices = null;
  invalidatePreview();
  save();
  inputs();
  render();
  refreshMarket();
  refreshAccount();
};
$('hl-source').onchange = () => {
  api = null;
  invalidatePreview();
  refreshAccount();
};
$('wallet').oninput = () => {
  api = null;
  if ($('wallet').value.trim()) $('hl-source').value = 'api';
  refreshAccount();
};
$('sync').onclick = () => {
  refreshMarket();
  refreshAccount();
};
$('quote-source').onchange = render;
$('confirm-quote').onclick = () => {
  try {
    const j = JSON.parse($('manual-quote').value);
    if (j.asset !== asset()) throw Error('品种不匹配');
    const both = {};
    for (const k of ['pf', 'hl']) {
      const q = j[k],
        spec = feed[k];
      if (!spec || !q || !fresh(q.asOf, Date.now(), Number(r.quoteSecs) * 1000))
        throw Error('需已识别的合约规格及新鲜盘口来源时间');
      const checked = q.levels.map((side) =>
        side.map(([px, size]) => [out(positive(String(px))), out(positive(String(size)))])
      );
      if (
        checked.length !== 2 ||
        !checked[0].length ||
        !checked[1].length ||
        dec(checked[0][0][0]).gt(checked[1][0][0])
      )
        throw Error('盘口无效');
      both[k] = {
        ...spec,
        bookAt: q.bookAt ?? q.asOf,
        markAt: q.markAt ?? q.asOf,
        bookSource: '手工盘口',
        mark: out(positive(String(q.mark))),
        asOf: q.asOf,
        levels: checked
      };
    }
    manualPrices = both;
    $('quote-source').value = 'manual';
    put('manual-status', '已确认手工盘口');
    render();
  } catch (e) {
    put('manual-status', e.message);
  }
};
$('desk-details').addEventListener('toggle', () => { if ($('desk-details').open) render(); });
let specEditorAsset, specEditorDirty = false;
function showVestSpec(m) {
  const form = $('vest-spec-form'), symbol = asset() + '-PERP';
  const saved = state.vestSpecs?.[asset()];
  const c = m.spec?.contract;
  if (specEditorAsset !== asset()) {
    specEditorAsset = asset();
    specEditorDirty = false;
    put('vest-spec-feedback', '');
  }
  put('vest-spec-source', [symbol, ...[
    ['baseAsset','标的'],['quoteAsset','报价'],['settleAsset','结算'],['contractMultiplier','乘数']
  ].map(([k,label]) => label + ' ' + (c?.[k] ?? '待确认') +
    (c?.evidence?.[k] ? '（' + c.evidence[k] + '）' : '')),
    m.specAt && '接口读取时间 ' + m.specAt, saved && '本机确认时间 ' + saved.confirmedAt, m.errors?.spec || m.errors?.specRisk].filter(Boolean).join(' · '));
  $('vest-spec-clear').disabled = !saved;
  if (specEditorDirty) return;
  const values = {...feed.spec?.contract, ...saved, symbol};
  for (const k of ['symbol','baseAsset','quoteAsset','settleAsset','contractMultiplier','quantityUnit',...riskFields]) {
    const input = form.elements.namedItem(k);
    const value = k === 'quantityUnit' && values[k] === asset() ? 'base' : String(values[k] ?? '');
    if (input.value !== value) input.value = value;
    if (riskFields.includes(k)) input.placeholder = feed.spec?.[k] == null ? '待核对' : 'API ' + feed.spec[k];
  }
}
$('vest-spec-details').addEventListener('toggle', () => { if ($('vest-spec-details').open) showVestSpec(market()); });
$('vest-spec-form').oninput = () => { specEditorDirty = true; };
$('vest-spec-form').onsubmit = event => {
  event.preventDefault();
  try {
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    if (fields.quantityUnit === 'base') fields.quantityUnit = asset();
    const confirmed = confirmVestSpec(asset(), fields, now());
    const pending = applyVestConfirmation(quoteMarket(), confirmed, r.stage);
    if (pending.specStatus === 'unlisted' || /冲突|不符|无效/.test(pending.errors?.spec ?? ''))
      throw Error(pending.errors.spec);
    (state.vestSpecs ??= {})[asset()] = confirmed;
    save(); specEditorDirty = false;
    put('vest-spec-feedback', '已保存 ' + confirmed.symbol + ' 的本机确认');
    render();
  } catch (e) { put('vest-spec-feedback', e.message); }
};
$('vest-spec-clear').onclick = () => {
  if (state.vestSpecs) delete state.vestSpecs[asset()];
  save(); specEditorDirty = false;
  put('vest-spec-feedback', '已撤销，当前使用公开规格');
  render();
};
function renderHypeApiStatus(live) {
  if (!$('hype-api-summary')) return;
  const hlHealth = live.health?.hl;
  const hlTime = live.hl?.markAt ?? live.hl?.asOf;
  const hlTimeShort = hlTime && Number.isFinite(Date.parse(hlTime))
    ? new Date(hlTime).toLocaleTimeString('zh-CN', { hour12: false })
    : null;
  const marketText = hlHealth?.ready && live.hl?.mark
    ? '已连接（' + (hlTimeShort ?? '实时') + '）'
    : '断开' + (live.errors?.hl ? '（' + live.errors.hl + '）' : '（等待盘口）');

  const st = hypeApiStatus;
  const activeSnap = useAPI() ? api : hypeProbeAccount;
  const activeErr = useAPI() ? apiError : hypeProbeError;
  const queryAddr = useAPI() ? $('wallet').value.trim() : st?.effectiveQueryAddress;
  const accountText = activeSnap && activeSnap.equity != null
    ? '读取成功（' + shortAddr(queryAddr) + ' · ' + fmt(activeSnap.equity, 2) + ' U）'
    : activeErr
      ? '请求异常（' + activeErr + '）'
      : queryAddr
        ? '读取中（' + shortAddr(queryAddr) + '）'
        : '未配置地址';

  const credMap = {
    loaded: '已加载（' + shortAddr(st?.signerAddress) + '）',
    not_configured: '未加载',
    missing: '未加载（文件不存在）',
    invalid_format: '格式错误',
    ambiguous: '格式错误（多把私钥）'
  };
  const credText = st ? (credMap[st.credentialStatus] ?? '未加载') : (hypeApiError ? '读取失败' : '检查中');

  const authMap = {
    verified: '已核对（Agent' + (st?.agentName ? ' "' + st.agentName + '"' : '') + '）',
    direct_master: '已核对（主账户直签）',
    unverified: '尚未核对',
    unauthorized: '未授权',
    expired: '授权已过期',
    misconfigured_agent_as_fund: '地址配置有误（Agent非资金账户）',
    not_applicable: '不适用'
  };
  const authText = st ? (authMap[st.authStatus] ?? '尚未核对') : '尚未核对';

  put(
    'hype-api-summary',
    'Hype API｜行情：' + marketText + ' · 账户：' + accountText + ' · 凭证：' + credText + ' · 签名授权：' + authText
  );

  const details = [];
  if (hypeApiError) details.push('本地后端状态请求失败：' + hypeApiError);
  if (st) {
    details.push('签名地址 signerAddress：' + (st.signerAddress ?? '未加载') + (st.signerRole ? '（角色 ' + st.signerRole + '）' : ''));
    details.push('资金账户 tradingAccountAddress：' + (st.tradingAccountAddress || '待填') + (st.subAccountAddress ? ' · 子账户：' + st.subAccountAddress : ''));
    if (st.credentialError) details.push('凭证说明：' + st.credentialError);
    details.push('授权核对：' + st.authDetail + (st.sdkReady ? ' · 官方 SDK 签名适配器就绪（未发送任何真实订单）' : ''));
    if (activeSnap) {
      details.push(
        '最近账户读数：' +
          (activeSnap.sourceDetail ?? activeSnap.source) +
          ' · 权益 ' +
          money(activeSnap.equity) +
          ' · ' +
          asset() +
          ' 持仓 ' +
          activeSnap.qty +
          ' · 挂单 ' +
          (activeSnap.orders?.length ?? '未知') +
          ' 笔 · 快照时间 ' +
          clock(activeSnap.at)
      );
    }
    details.push('安全口径：私钥仅在本地后端内存中用于签名，不进浏览器存储或响应；行情刷新、重算与方案切换绝不自动下单。');
  }
  put('hype-api-detail', details.join(' ｜ '));
}

async function probeHypeReadonlyAccount(addr, network = 'mainnet') {
  if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
    hypeProbeAccount = null;
    hypeProbeError = '';
    return;
  }
  try {
    hypeProbeAccount = await accountSnapshot(addr, asset(), async (body) => {
      const resp = await fetch('/api/hype-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ network, request: body }),
        signal: AbortSignal.timeout(7000)
      });
      if (!resp.ok) throw Error('主网查询失败 HTTP ' + resp.status);
      return resp.json();
    });
    hypeProbeError = '';
  } catch (e) {
    hypeProbeAccount = null;
    hypeProbeError = e.message;
  }
}

async function loadHypeApiStatus(method = 'GET', payload = null) {
  try {
    const endpoint = method === 'POST' ? '/api/hype-api/config' : '/api/hype-api/status';
    const resp = await fetch(endpoint, {
      method,
      cache: 'no-store',
      ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(10000)
    });
    const data = await resp.json();
    if (!resp.ok) throw Error(data.error ?? 'HTTP ' + resp.status);
    hypeApiStatus = data;
    hypeApiError = '';
    if ($('hype-cred-path') && $('hype-cred-path') !== document.activeElement)
      $('hype-cred-path').value = data.credentialPath ?? '';
    if ($('hype-trading-addr') && $('hype-trading-addr') !== document.activeElement)
      $('hype-trading-addr').value = data.tradingAccountAddress ?? '';
    if ($('hype-sub-addr') && $('hype-sub-addr') !== document.activeElement)
      $('hype-sub-addr').value = data.subAccountAddress ?? '';
    if (data.effectiveQueryAddress && !$('wallet').value.trim()) {
      $('wallet').value = data.effectiveQueryAddress;
    }
    await probeHypeReadonlyAccount(data.effectiveQueryAddress, data.network);
  } catch (e) {
    hypeApiError = e.message;
  }
  render();
}

if ($('hype-api-save')) {
  $('hype-api-save').onclick = async () => {
    $('hype-api-save').disabled = true;
    try {
      await loadHypeApiStatus('POST', {
        credentialPath: $('hype-cred-path').value.trim(),
        tradingAccountAddress: $('hype-trading-addr').value.trim(),
        subAccountAddress: $('hype-sub-addr').value.trim()
      });
      if (useAPI() && hypeApiStatus?.effectiveQueryAddress) {
        $('wallet').value = hypeApiStatus.effectiveQueryAddress;
        refreshAccount();
      }
    } finally {
      $('hype-api-save').disabled = false;
    }
  };
}
if ($('hype-api-use-account')) {
  $('hype-api-use-account').onclick = () => {
    const addr = hypeApiStatus?.effectiveQueryAddress || $('hype-trading-addr').value.trim();
    if (addr) $('wallet').value = addr;
    $('hl-source').value = 'api';
    state.fundingView = 'account';
    $('funding-view').value = 'account';
    r = state.rules;
    api = null;
    previous = null;
    cancelAuto();
    invalidatePreview();
    save();
    inputs();
    render();
    refreshAccount();
  };
}

let backendSessionId = null;
let backendStream = null;
let backendStreamGen = 0;
let backendSyncTimer = null;
let backendReconnectTimer = null;
let lastAppliedCalcVersion = 0;
let lastAppliedConfigVersion = 0;
let expectedConfigVersion = 0;
let backendConfigSeq = 0;
let configSyncPending = false;
let configSyncInFlight = false;
let configSyncQueued = false;
let configSyncError = null;
let lastBackendConfigSig = '';
let lastBackendTicker = null;

function shortClock(iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '—';
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
}

function buildBackendSessionPayload() {
  const isPlanProj = planningProjectionMode();
  const solveRules = isPlanProj
    ? { ...r, stage: 'challenge', planFundedCash: '' }
    : { ...r };
  // Exclude ephemeral UI timestamp so pure UI interactions never alter solver config signature
  delete solveRules.editedAt;
  delete solveRules.accountPreset;
  return {
    sessionId: backendSessionId,
    asset: asset(),
    fundingView: state.fundingView,
    hlSource: $('hl-source')?.value ?? 'manual',
    wallet: $('wallet')?.value.trim() ?? '',
    quoteSource: $('quote-source')?.value ?? 'api',
    manualPrices: $('quote-source')?.value === 'manual' ? manualPrices : null,
    manualAccounts: planning()
      ? null
      : { pf: manualAccount(state, asset(), 'pf'), hl: manualAccount(state, asset(), 'hl') },
    vestSpec: state.vestSpecs?.[asset()] ?? null,
    openingCapacity: true,
    rules: solveRules
  };
}

function renderHypeApiStatusFromTicker(ticker) {
  if (!ticker) return;
  const syntheticLive = {
    hl: ticker.hl
      ? { mark: ticker.hl.mark, markAt: ticker.hl.asOf, asOf: ticker.hl.asOf }
      : null,
    health: { hl: { ready: Boolean(ticker.hl?.ready) } },
    errors: ticker.errors ?? {}
  };
  if (ticker.apiAccount) {
    api = ticker.apiAccount.snapshot;
    apiError = ticker.apiAccount.error || '';
  }
  renderHypeApiStatus(syntheticLive);
}

function formatDurationCompact(ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) <= 0) return '—';
  const n = Number(ms);
  return n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms';
}

function renderDevDiagnostics(ticker) {
  const logEl = $('solve-log');
  if (!logEl || !ticker) return;
  const tm = ticker.timings ?? {};
  const vc = ticker.vestContractMeta;
  const lines = [
    '=== 后台任务与分层计算状态（开发诊断） ===',
    '连接与计算状态：' + (ticker.stateLabel || '—') + ' (' + (ticker.state || '—') + ') · 后台任务运行中：' + (ticker.bgCalculating ? '是' : '否'),
    '行情更新时间：' + (ticker.quoteUpdatedAt || '—') + ' · 实时行情延迟：' + (ticker.quoteLatencyMs != null ? ticker.quoteLatencyMs + ' ms' : '—'),
    '后台任务开始时间：' + (ticker.jobStartedAt || '—'),
    '最近一次求解耗时：' + (ticker.solveMs != null ? ticker.solveMs + ' ms' : '—') + '（计算层级：' + (ticker.calcLayer || tm.layer || '—') + '）',
    '最近完整求解耗时：' + (ticker.lastFullSolveMs != null ? ticker.lastFullSolveMs + ' ms' : '—') + ' · 最近完整计算时间：' + (ticker.lastFullCalculatedAt || ticker.calculatedAt || '—'),
    '结果快照时间：' + (ticker.calculatedAt || '—') + ' · 结果对应行情时间：' + (ticker.quoteTime || '—'),
    '结果对应行情版本：' + (ticker.publishedQuoteSnapshotId || ('mkt-' + (ticker.publishedMarketVersion ?? 0))) + '（v' + (ticker.publishedMarketVersion ?? 0) + '） ｜ 最新实时行情版本：mkt-' + (ticker.marketVersion ?? 0) + '（v' + (ticker.marketVersion ?? 0) + '）',
    'CPU 分项耗时：考核搜索 ' + (tm.evalSearchMs ?? '—') + ' ms ｜ Funded+多轮求解 ' + (tm.fundedSolveMs ?? '—') + ' ms ｜ 候选构建总计 ' + (tm.totalBuildMs ?? '—') + ' ms ｜ 多轮种子复用命中 ' + (tm.fundedSeedHits ?? 0) + ' 次 / 完整搜索 ' + (tm.fundedFullSearches ?? 0) + ' 次'
  ];
  if (vc) {
    lines.push(
      '=== Vest 永续合约官方规格核验 ===',
      '合约代码：' + (vc.symbol || '—') + ' · 标的(base)：' + (vc.base || '—') + ' · 报价币(quote)：' + (vc.quote || '—') + ' · 结算/保证金币(settlement)：' + (vc.settlement || '—'),
      '数量精度(sizeDecimals)：' + (vc.sizeDecimals ?? '—') + ' · 价格精度(priceDecimals)：' + (vc.priceDecimals ?? '—') + ' · Taker 费率：' + (vc.takerFee ?? '—'),
      '保证金率：initMarginRatio=' + (vc.initMarginRatio ?? '—') + ' · capitalInitMarginRatio=' + (vc.capitalInitMarginRatio ?? '—') + ' · fundedInitMarginRatio=' + (vc.fundedInitMarginRatio ?? '—') + ' · maintMarginRatio=' + (vc.maintMarginRatio ?? '—'),
      '规格来源：' + (vc.specSource || '—') + ' · 版本：' + (vc.specVersion || '—') + ' · 读取时间：' + (vc.obtainedAt || '—'),
      '字段证据：quote=' + (vc.evidence?.quoteAsset || '—') + ' ｜ settlement=' + (vc.evidence?.settleAsset || '—')
    );
  }
  put('solve-log', lines.join('\n'));
}

function applyBackendTicker(ticker) {
  if (!ticker || (backendSessionId && ticker.sessionId && ticker.sessionId !== backendSessionId)) return;
  lastBackendTicker = ticker;
  const awaitingNewConfig =
    configSyncPending ||
    (expectedConfigVersion > 0 && typeof ticker.publishedConfigVersion === 'number' && ticker.publishedConfigVersion < expectedConfigVersion);

  const pill = $('calc-conn-pill');
  const meta = $('calc-time-meta');
  const displayState =
    ticker.state === 'disconnected' || ticker.state === 'stale' || ticker.state === 'error'
      ? ticker.state
      : awaitingNewConfig && ticker.businessStatus !== 'rule_invalid'
        ? 'calculating'
        : ticker.state;
  const displayLabel =
    displayState === 'calculating'
      ? '正在计算'
      : displayState === 'error'
        ? '计算失败'
        : ticker.stateLabel || '正在计算';

  if (pill) {
    if (pill.dataset.state !== displayState) pill.dataset.state = displayState;
    put('calc-conn-pill', displayLabel);
    pill.title = configSyncError || ticker.reason || '';
  }
  if (meta) {
    const fullAnchorTime = shortClock(ticker.lastFullCalculatedAt ?? ticker.calculatedAt);
    const latText = ticker.quoteLatencyMs != null ? '行情延迟 ' + Math.round(ticker.quoteLatencyMs) + 'ms' : null;
    const solveRefMs = ticker.lastFullSolveMs || ticker.solveMs;
    const solveText = solveRefMs ? '完整求解 ' + formatDurationCompact(solveRefMs) : null;
    const snapText = ticker.calculatedAt ? '结果快照 ' + fullAnchorTime : null;
    const conciseTop = [latText, solveText, snapText].filter(Boolean).join(' · ');
    const text =
      configSyncError
        ? configSyncError + (snapText ? ' · ' + snapText : '')
        : ticker.businessStatus === 'rule_invalid' || ticker.businessStatus === 'calc_error' || displayState === 'error'
          ? (ticker.reason || '计算或规则校验异常') + (snapText ? ' · ' + snapText : '')
          : displayState === 'disconnected' || displayState === 'stale'
            ? (ticker.reason || displayLabel) + (snapText ? ' · ' + snapText : '')
            : ticker.calculatedAt
              ? conciseTop
              : ticker.reason || '等待首次计算…';
    put('calc-time-meta', text);
  }
  // Layer A: Immediately update Bid, Ask, Mark, Spread & floating PnL of existing candidates
  lastBackendTicker = ticker;
  if (ticker.pf?.mark != null) {
    feed.pf = {
      ...(feed.pf ?? {}),
      mark: ticker.pf.mark,
      asOf: ticker.pf.asOf ?? feed.pf?.asOf ?? new Date().toISOString(),
      markAt: ticker.pf.asOf ?? feed.pf?.markAt ?? new Date().toISOString()
    };
  }
  if (ticker.hl?.mark != null) {
    feed.hl = {
      ...(feed.hl ?? {}),
      mark: ticker.hl.mark,
      asOf: ticker.hl.asOf ?? feed.hl?.asOf ?? new Date().toISOString(),
      markAt: ticker.hl.asOf ?? feed.hl?.markAt ?? new Date().toISOString()
    };
  }
  if ($('home-ticker')) {
    const pfP = ticker.pf?.mark != null
      ? fmt(ticker.pf.mark, 1)
      : (ticker.pf?.error ? '行情未就绪(' + ticker.pf.error + ')' : '行情未就绪');
    const hlP = ticker.hl?.mark != null
      ? fmt(ticker.hl.mark, 1)
      : (ticker.hl?.error ? '行情未就绪(' + ticker.hl.error + ')' : '行情未就绪');
    const spreadTxt =
      ticker.crossSpread != null
        ? ' · 价差 ' + (Number(ticker.crossSpread) > 0 ? '+' : '') + ticker.crossSpread
        : '';
    const remMs = viewStage() === 'challenge' && r.deadline ? Math.max(0, Date.parse(r.deadline) - Date.now()) : null;
    const remText =
      remMs != null && Number.isFinite(remMs)
        ? ' · 剩余 ' + Math.floor(remMs / 3600000) + 'h' + String(Math.floor((remMs % 3600000) / 60000)).padStart(2, '0') + 'm'
        : '';
    put('home-ticker', (ticker.asset || asset()) + ' 永续 · Vest ' + pfP + ' / Hype ' + hlP + spreadTxt + remText);
  }
  if (ticker.pf) {
    if ($('scan-pf-bid')) put('scan-pf-bid', ticker.pf.bid != null ? fmt(ticker.pf.bid, 1) : '未就绪');
    if ($('scan-pf-ask')) put('scan-pf-ask', ticker.pf.ask != null ? fmt(ticker.pf.ask, 1) : '未就绪');
    if ($('scan-pf-price')) put('scan-pf-price', ticker.pf.mark != null ? fmt(ticker.pf.mark, 1) : '未就绪');
  }
  if (ticker.hl) {
    if ($('scan-hl-bid')) put('scan-hl-bid', ticker.hl.bid != null ? fmt(ticker.hl.bid, 1) : '未就绪');
    if ($('scan-hl-ask')) put('scan-hl-ask', ticker.hl.ask != null ? fmt(ticker.hl.ask, 1) : '未就绪');
    if ($('scan-hl-price')) put('scan-hl-price', ticker.hl.mark != null ? fmt(ticker.hl.mark, 1) : '未就绪');
  }
  if (ticker.floatingByKey && $('candidate-grid')) {
    for (const node of $('candidate-grid').querySelectorAll('[data-row-kind="candidate"][data-key]')) {
      const fl = ticker.floatingByKey[node.dataset.key];
      if (fl) {
        node.dataset.floatingNet = fl.netDelta;
        node.dataset.floatingPf = fl.dPf;
        node.dataset.floatingHl = fl.dHl;
      }
    }
  }
  if (ticker.vestContractMeta) {
    const vc = ticker.vestContractMeta;
    feed.spec = {
      symbol: vc.symbol,
      sizeDecimals: vc.sizeDecimals,
      priceDecimals: vc.priceDecimals,
      initMarginRatio: vc.initMarginRatio,
      capitalInitMarginRatio: vc.capitalInitMarginRatio,
      fundedInitMarginRatio: vc.fundedInitMarginRatio,
      maintMarginRatio: vc.maintMarginRatio,
      takerFee: vc.takerFee,
      contract: {
        symbol: vc.symbol,
        baseAsset: vc.base,
        quoteAsset: vc.quote,
        settleAsset: vc.settlement,
        contractMultiplier: '1',
        quantityUnit: vc.base,
        settlement: 'linear',
        specSource: vc.specSource,
        specVersion: vc.specVersion,
        obtainedAt: vc.obtainedAt,
        evidence: vc.evidence
      }
    };
    feed.specAt = vc.obtainedAt;
    feed.specStatus = 'ok';
    if ($('vest-spec-form')) showVestSpec(market());
  }
  renderDevDiagnostics(ticker);

  const isHistoricalVersion =
    awaitingNewConfig ||
    (expectedConfigVersion > 0 && lastAppliedConfigVersion > 0 && lastAppliedConfigVersion < expectedConfigVersion);
  const effectiveCanAct = Boolean(ticker.canAct) && !isHistoricalVersion && !configSyncError;
  if ($('current')) {
    $('current').dataset.historical = !effectiveCanAct ? 'true' : 'false';
  }
  const desk = $('scan-desk');
  if (desk) {
    const nextState = effectiveCanAct ? 'ready' : displayState;
    if (desk.dataset.state !== nextState) desk.dataset.state = nextState;
  }
  setCandidateActionable(effectiveCanAct);
  if (configSyncError) {
    setCandidateNotice(configSyncError);
  } else if (ticker.businessStatus === 'rule_invalid' || ticker.businessStatus === 'calc_error' || displayState === 'error') {
    setCandidateNotice((ticker.reason || '请核对规则输入') + (lastAppliedConfigVersion > 0 ? '（下方保留历史数据仅供参考，非当前有效结果）' : ''));
  } else if (isHistoricalVersion && lastAppliedConfigVersion > 0) {
    setCandidateNotice('输入或规则已变更，正在求解当前版本（v' + (expectedConfigVersion || (lastAppliedConfigVersion + 1)) + '）；下方保留上一版本（v' + lastAppliedConfigVersion + '）历史快照仅供参考，非当前有效结果');
  } else if (ticker.businessStatus === 'ready' && !isHistoricalVersion) {
    setCandidateNotice(null);
  }
  renderHypeApiStatusFromTicker(ticker);
}

function applyBackendSnapshot(snap) {
  if (!snap || typeof snap.calcVersion !== 'number') return;
  if (backendSessionId && snap.sessionId && snap.sessionId !== backendSessionId) return;
  // Never accept an old-config snapshot while a newer config is pending or confirmed
  if (configSyncPending) return;
  if (expectedConfigVersion > 0 && typeof snap.configVersion === 'number' && snap.configVersion < expectedConfigVersion) {
    return;
  }
  if (typeof snap.configVersion === 'number' && snap.configVersion < lastAppliedConfigVersion) return;
  if (
    typeof snap.configVersion === 'number' &&
    snap.configVersion === lastAppliedConfigVersion &&
    snap.calcVersion <= lastAppliedCalcVersion
  ) {
    return; // Idempotent for duplicate / stale calcVersion events
  }
  if (typeof snap.configVersion === 'number') lastAppliedConfigVersion = snap.configVersion;
  lastAppliedCalcVersion = snap.calcVersion;
  if ($('current')) $('current').dataset.historical = 'false';
  setCandidateNotice(null);
  setCandidateActionable(true);
  drawCandidateSet(snap, { viewStage: viewStage() });
  const desk = $('scan-desk');
  if (desk) {
    desk.dataset.resultId = snap.snapshotId ?? '';
    desk.dataset.quoteSnapshotId = snap.quoteSnapshotId ?? '';
    desk.dataset.calculatedAt = snap.calculatedAt ?? '';
  }
}

let backendHeartbeatTimer = null;
let lastBackendEventAt = 0;

function markBackendDisconnected(reason = '后台连接中断，自动重连中') {
  clearTimeout(backendHeartbeatTimer);
  backendHeartbeatTimer = null;
  backendStreamGen++;
  if (backendStream) {
    backendStream.close();
    backendStream = null;
  }
  const pill = $('calc-conn-pill');
  if (pill) {
    pill.dataset.state = 'disconnected';
    put('calc-conn-pill', '连接失败');
    pill.title = reason;
  }
  const meta = $('calc-time-meta');
  if (meta) {
    const suffix = lastBackendTicker?.calculatedAt ? ' · 上次计算 ' + shortClock(lastBackendTicker.calculatedAt) : '';
    put('calc-time-meta', reason + suffix);
  }
  setCandidateActionable(false);
  clearTimeout(backendReconnectTimer);
  backendReconnectTimer = setTimeout(() => {
    backendSessionId = null;
    expectedConfigVersion = 0;
    lastAppliedConfigVersion = 0;
    lastAppliedCalcVersion = 0;
    lastBackendConfigSig = '';
    void syncBackendSession(true);
  }, 1500);
}

function armBackendWatchdog(gen) {
  clearTimeout(backendHeartbeatTimer);
  lastBackendEventAt = Date.now();
  backendHeartbeatTimer = setTimeout(() => {
    if (gen === backendStreamGen && backendStream && Date.now() - lastBackendEventAt >= 4200) {
      markBackendDisconnected('后台行情心跳超时，自动重连中');
    }
  }, 4500);
}

function openBackendStream() {
  if (!backendSessionId) return;
  if (backendStream) {
    backendStream.close();
    backendStream = null;
  }
  clearTimeout(backendReconnectTimer);
  const myGen = ++backendStreamGen;
  const mySid = backendSessionId;
  const es = new EventSource('/api/hedge/stream?sessionId=' + encodeURIComponent(mySid));
  backendStream = es;
  armBackendWatchdog(myGen);
  es.addEventListener('ticker', (ev) => {
    if (myGen !== backendStreamGen || backendStream !== es) return;
    armBackendWatchdog(myGen);
    try { applyBackendTicker(JSON.parse(ev.data)); } catch {}
  });
  es.addEventListener('snapshot', (ev) => {
    if (myGen !== backendStreamGen || backendStream !== es) return;
    armBackendWatchdog(myGen);
    try { applyBackendSnapshot(JSON.parse(ev.data)); } catch {}
  });
  es.onerror = () => {
    if (myGen !== backendStreamGen || backendStream !== es) return;
    markBackendDisconnected('后台连接中断，自动重连中');
  };
}

if (calculatorPage && typeof window !== 'undefined') {
  window.addEventListener('offline', () => {
    markBackendDisconnected('网络已断开，保留上次只读快照');
  });
  window.addEventListener('online', () => {
    clearTimeout(backendReconnectTimer);
    backendSessionId = null;
    expectedConfigVersion = 0;
    lastAppliedConfigVersion = 0;
    lastAppliedCalcVersion = 0;
    lastBackendConfigSig = '';
    void syncBackendSession(true);
  });
}

async function syncBackendSession(force = false) {
  if (!calculatorPage) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    markBackendDisconnected('网络已断开，保留上次只读快照');
    return;
  }
  const payload = buildBackendSessionPayload();
  const sig = JSON.stringify({ ...payload, sessionId: null });
  if (!force && backendSessionId && backendStream && sig === lastBackendConfigSig) return;

  // Serialize config POSTs and coalesce rapid edits so slow responses never overwrite newer inputs
  if (configSyncInFlight) {
    configSyncQueued = true;
    configSyncPending = true;
    setCandidateActionable(false);
    return;
  }

  const mySeq = ++backendConfigSeq;
  configSyncInFlight = true;
  configSyncPending = true;
  configSyncError = null;
  lastBackendConfigSig = sig;
  setCandidateActionable(false);

  try {
    const res = await fetch('/api/hedge/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, clientConfigSeq: mySeq }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw Error('配置同步 HTTP ' + res.status);
    const data = await res.json();
    // Ignore stale response if a newer edit already bumped backendConfigSeq
    if (mySeq !== backendConfigSeq) return;
    const sessionChanged = backendSessionId !== data.sessionId;
    const isNew = !backendSessionId || sessionChanged || !backendStream;
    backendSessionId = data.sessionId;
    expectedConfigVersion = data.configVersion ?? expectedConfigVersion;
    configSyncPending = false;
    configSyncError = null;
    if (sessionChanged) {
      lastAppliedConfigVersion = 0;
      lastAppliedCalcVersion = 0;
    }
    if (lastAppliedConfigVersion > 0 && lastAppliedConfigVersion < expectedConfigVersion) {
      if ($('current')) $('current').dataset.historical = 'true';
      setCandidateActionable(false);
      setCandidateNotice('输入或规则已变更，正在求解当前版本（v' + expectedConfigVersion + '）；下方保留上一版本（v' + lastAppliedConfigVersion + '）历史快照仅供参考，非当前有效结果');
    }
    if (isNew) openBackendStream();
  } catch (e) {
    if (mySeq !== backendConfigSeq) return;
    configSyncPending = false;
    lastBackendConfigSig = ''; // Allow next edit or retry to submit
    const hasHealthyStream = Boolean(backendSessionId && backendStream && backendStream.readyState === EventSource.OPEN);
    if (hasHealthyStream) {
      // Keep healthy SSE alive; report config request failure separately without dropping connection!
      configSyncError = '配置提交失败（' + e.message + '），已保留当前连接与上次已生效快照';
      setCandidateNotice(configSyncError);
      setCandidateActionable(false);
    } else {
      markBackendDisconnected('后台连接失败，自动重连中');
    }
  } finally {
    configSyncInFlight = false;
    if (configSyncQueued) {
      configSyncQueued = false;
      void syncBackendSession(true);
    }
  }
}

// Expose read-only diagnostics hook on calculator page for verification without adding UI
if (calculatorPage && typeof window !== 'undefined') {
  window.__hedgeDebug = {
    getState: () => ({
      sessionId: backendSessionId,
      displayStage,
      ruleStage: r.stage,
      fundingView: state.fundingView,
      expectedConfigVersion,
      lastAppliedConfigVersion,
      lastAppliedCalcVersion,
      configSyncPending,
      configSyncError,
      streamState: backendStream?.readyState ?? null
    }),
    injectSnapshot: (snap) => applyBackendSnapshot(snap),
    injectTicker: (t) => applyBackendTicker(t)
  };
}

function scheduleBackendSync() {
  if (!calculatorPage) return;
  clearTimeout(backendSyncTimer);
  backendSyncTimer = setTimeout(() => void syncBackendSession(false), 160);
}

setupScan(() => {
  if (!calculatorPage) render();
});
inputs();
void loadHypeApiStatus('GET');
if (calculatorPage) {
  renderStage();
  void syncBackendSession(true);
} else {
  render();
  refreshMarket();
  // A stalled network must not leave an old actionable delta on screen.
  let quality = '';
  setInterval(() => {
    const t = Date.now(),
      m = market();
    const next = [
      ...['pf', 'hl'].map((k) => subscriptionHealthy(m,k,t) && quoteClock(m[k], t, Math.min(3000,Number(r.quoteSecs) * 1000)).ok),
      ...['pf', 'hl'].map((k) => fresh(account(k).at, t, Number(r.accountSecs) * 1000)),
      ...['pf', 'hl'].flatMap((k) =>
        Object.values(local()[k].origins ?? {}).map((meta) => fresh(meta.at, t, Number(r.accountSecs) * 1000))
      ),
      r.stage==='challenge' && !running && completed && t-completed.checkedAt>=1000,
      !!r.deadline && Date.parse(r.deadline) <= t,

      ...['pf', 'hl'].flatMap((k) =>
        ['equity', 'qty', 'free'].map((f) => fresh(fieldTime(account(k), f), t, Number(r.accountSecs) * 1000))
      ),
      ...['USDC', 'USDT'].map((k) => fresh(rates[k]?.asOf, t, Number(r.quoteSecs) * 1000))
    ].join('/');
    if (next !== quality) {
      quality = next;
      render();
    }
  }, 350);
}
