import {drawCandidateSet,setupCandidateSet} from './candidate-ui.js';
import {reachability} from './reachability.js';
import {venueCases} from './venue-scenarios.js';
import { publicationState } from './display-history.js';
import { exitDepthLabel } from './exit-liquidity.js';
import { dec, out } from './math.js';
import { inspectRatio, ratioSlice } from './ratio-scan.js';
import { capitalGroups, reportGroups, subsetGroups, recoveryCushion } from './range-report.js';
import { ledgerLabels, presentLedger } from './settlement-ledger.js';

const $ = (id) => document.getElementById(id);
const setText = (el, text) => {
  text = String(text);
  if (el.textContent === text) return;
  if (el.childNodes.length === 1 && el.firstChild.nodeType === Node.TEXT_NODE) el.firstChild.data = text;
  else el.textContent = text;
};
const write = (id, text) => setText($(id), text);
const fmt = (x, n = 2) => (x == null ? '未验证' : dec(String(x)).toFixed(n));
const usd = (x) =>
  x == null ? '未验证' : fmt(x, dec(String(x)).abs().lt('1') && !dec(String(x)).isZero() ? 4 : 2) + ' U';
const settlementAmount = (x) =>
  x == null
    ? '未验证'
    : (dec(String(x)).abs().lt('0.0001') && !dec(String(x)).isZero()
        ? dec(String(x)).toSignificantDigits(4).toString()
        : fmt(x, 4)) + ' U';
const pct = (x, n = 4) => (x == null ? '未验证' : dec(String(x)).times(100).toFixed(n) + '%');
const time = (x) =>
  x
    ? new Date(x).toLocaleTimeString('zh-CN', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
      })
    : '未知';
let frame = null,
  frameKey = '',
  audit = null;
const names = {
  protect: '失败端本金回收',
  survive: '成功端最低留存',
  both: '双路径交集合格',
  profit: '提现前双路径均净盈利',
  legal: '全部合法候选（条件终点估值）',
  risk: '通过保证金检查',
  failProfit: '失败路径净盈利',
  passProfit: '成功提现前净盈利'
};
// The existing scan already prices both directions. Inspect its legal lots on
// demand at the representative size, using the same settlement ledgers.
function executionComparison(scan, row) {
  const lines = ['同规模双边成交成本 · PF ' + dec(row.pf).abs() + ' / Hype ' + dec(row.hl).abs() +
    '（各自合约数量）；价格为原生报价，费用与深度滑点为 U。'];
  for (const sign of [1, -1]) {
    const direction = (sign === 1 ? 'PF 多 / ' : 'PF 空 / ') +
      (row.j === 0 ? 'Hype 空仓' : sign === 1 ? 'Hype 空' : 'Hype 多');
    let candidate = row;
    if (sign !== row.sign) {
      if (!scan.cells) { lines.push(direction + ' · 历史快照未保留反向盘口'); continue; }
      if (!ratioSlice(scan, sign, row.i).some(([lo, hi]) => lo <= row.j && row.j <= hi)) {
        lines.push(direction + ' · 当前模式或盘口不支持同规模反向仓位');
        continue;
      }
      try {
        candidate = inspectRatio(scan.ctx, { sign, i: row.i, j: row.j });
      } catch (error) {
        lines.push(direction + ' · 成本未验证 · ' + error.message);
        continue;
      }
    }
    const fill = (leg, entry) => {
      const q = entry ? dec(leg.adjustment) : dec(leg.target).neg();
      if (q.isZero()) return '无需成交';
      const field = entry ? 'entry' : 'exit';
      return (q.gt(0) ? '买 Ask ' : '卖 Bid ') + fmt(leg[field + 'Price'], 5) +
        '（费 ' + fmt(leg[field + 'Fee'], 5) + '，滑点 ' + fmt(leg[field + 'Slippage'], 5) + '）';
    };
    for (const [label, path, entry] of [['开仓/调仓', 'fail', true], ['失败平仓', 'fail', false], ['成功平仓', 'pass', false]]) {
      const stop = !entry && (path === 'fail' ? candidate.failStop : candidate.passStop);
      const legs = candidate.paths?.[path];
      lines.push(direction + ' · ' + label + ' · ' + (stop || (!legs ? '未验证' :
        'PF ' + fill(legs.pf, entry) + ' / Hype ' + fill(legs.hl, entry))));
    }
  }
  return lines;
}
function auditText() {
  if (!$('scan-detail').open || !$('desk-details').open || !$('audit-details').open || !audit) {
    write('scan-audit', '');
    return;
  }
  const { row, scan } = audit;
  const lines = [
    ...executionComparison(scan, row),
    'PF 有符号目标 ' + row.pf + ' / Hype ' + row.hl + ' · 源快照 ' + audit.snapshotId + ' · PF 提现与 Hype 权益分列',
    '建议档位 ' + (row.lev ?? '空仓') + ' · 初始占用 ' + usd(row.initial) + ' · 开仓后可用 ' + usd(row.free),
    'Hype 压力后维持余量 ' + (row.stress ? usd(row.surplus) : '未配置，基础情景 ' + usd(row.surplus)),
    '成功路径按规则提现 ' +
      usd(row.payout) +
      '；净收益基准含报名费和待收回历史成本 ' +
      usd(scan.ctx.params.profitBasis)
  ];
  for (const [key, title] of [
    ['fail', '失败'],
    ['pass', '成功']
  ]) {
    const stop = key === 'fail' ? row.failStop : row.passStop;
    if (stop) { lines.push(title + '路径 · ' + stop); continue; }
    for (const venue of ['pf', 'hl']) {
      const l = (row.settlementPaths ?? row.paths)?.[key]?.[venue];
      if (!l) continue;
      const view = presentLedger(l);
      lines.push(
        title +
          ' · ' +
          (venue === 'pf' ? 'PF 模拟' : 'Hype') +
          ' · 标记 ' +
          fmt(l.mark, 5) +
          ' → ' +
          fmt(l.exitMark, 5) +
          '，调仓 ' + (dec(l.adjustment).isZero() ? '无需成交' : (dec(l.adjustment).gt(0) ? '买入 Ask ' : '卖出 Bid ') + l.entryPrice) +
          '，条件平仓 ' + (dec(l.target).isZero() ? '空仓' : (dec(l.target).gt(0) ? '卖出 Bid ' : '买入 Ask ') + l.exitPrice) +
          '（各自原生报价，按当前深度平移至终点估算）',
        Object.entries(ledgerLabels)
          .map(([k, label]) => label + ' ' + view.entries[k])
          .join(' ｜ '),
        '显示舍入差 ' + view.rounding + '；平仓权益 ' + view.total + ' U'
      );
    }
  }
  if (row.stress)
    lines.push(
      '条件现金含不利价格偏移 ' +
        row.stress.priceShock +
        '、延迟成本 ' +
        usd(row.stress.delayDebit) +
        '、资金费 ' +
        usd(row.stress.fundingDebit)
    );
  write('scan-audit', lines.join('\n'));
}
const objectives = [
  ['base','基础情景最大仓位'],
  ['pressure','已配置压力下最大仓位'],
  ['failure','失败端回收缓冲优先'],
  ['success','成功端现金留存优先'],
  ['cashPriority','最差现金缓冲优先']
];

function objectiveName(index, scan) {
  if (index !== 1) return objectives[index][1];
  const scope = scan?.plans?.pressure?.scope;
  if (scope === 'bookOnly') return 'A-C已配置盘口压力下的最大候选';
  if (scope === 'allSpecified') return '全部指定压力下最大仓位';
  return objectives[index][1];
}

const fullCash = (plan, end) => {
  const evidence=plan.liquidity?.[end]?.full;
  if (evidence) return evidence.settlement?.[end==='fail'?'personal':'hype'] ?? null;
  return end==='fail' ? plan.fail : plan.success;
};

// The two pressure figures can be reached under different shocks. Keep each
// cash amount paired with its scenario; a recorded A–C result may predate this audit.
let orderSnapshot=null;
function windowText(x) {
  if(!x) return '缺少触线价格';
  const amount=dec(x.percent);
  return (amount.lt(0)?'跌 ':'涨 ')+amount.abs().toFixed(2)+'%'+(x.mark==null?'':' 至 '+fmt(x.mark,2))+' · '+
    (x.reason??(x.status==='pass'?'在情景范围内':x.status==='fail'?'超出情景范围':'未配置'+(amount.lt(0)?'下跌':'上涨')+'波动情景'));
}
function expiryText(cutoff) {
  if(cutoff?.status==='scenario') return '假设期间未触线，按截止价 '+fmt(cutoff.mark,2)+' 平仓，个人回收 '+settlementAmount(cutoff.cash)+'，考核提现 0 U';
  if(cutoff?.status==='firstBoundary') return '指定截止价已达到或越过'+(cutoff.key==='pass'?'通过':'失败')+'线，未触线前提不成立';
  if(cutoff?.status==='risk') return '无法估值 · 仓位或退出路径未通过核验';
  return cutoff?.status==='notApplicable'?'当前阶段不适用':'缺少与本次考核截止时间匹配的 PF 退出价';
}
function actionRow(view) {
  const d=view?.ratioScan.plans?.decision;
  return d?d.action:view?.targets?.[1];
}
function orderParameters(side) {
  const view=orderSnapshot, row=actionRow(view), desk=$('scan-desk');
  if(!row || desk.dataset.state!=='ready' || desk.dataset.resultId!==view.snapshotId ||
      $('current').dataset.stageClosed==='true') return null;
  const delta=row.adjustments?.[side]?.remaining;
  if(delta==null || dec(delta).isZero()) return null;
  const venue=side==='pf'?'PF（Vest）':'Hype（Hyperliquid）';
  const unit=view.ratioScan.ctx.market[side].unit;
  return [venue+' '+view.prices[side].base+' 永续', '目标仓位 '+targetQty(row[side],{unit}),
    '目标名义金额 '+settlementAmount(side==='pf'?row.pfValue:row.hypeValue),
    '调整方向 '+(dec(delta).gt(0)?'买入':'卖出')+' · 下单数量 '+dec(delta).abs()+' '+(unit==='contract'?'张':unit),
    ...(side==='hl' && row.leverage?['杠杆 '+row.leverage+'×']:[]),'行情快照 '+view.quoteSnapshotId,'结果版本 '+view.snapshotId].join('\n');
}
function showOptimum(snapshot) {
  const row=actionRow(snapshot), prior=snapshot?.previousSolve, scan=snapshot?.ratioScan;
  const proof=row?.pressureSummary, search=scan?.plans?.pressure;
  const nominal=r=>r.notionalRatio??out(dec(r.hypeValue).div(r.pfValue));
  const decision=scan?.plans?.decision;
  const allowance=decision?.directions.find(v=>v.sign===decision.adopted)?.maxFeasiblePosition;
  const alt=snapshot?.targets[4];
  write('buffer-alternative',alt?'PF '+targetQty(alt.pf,scan.ctx.market.pf)+' / '+settlementAmount(alt.pfValue)+
    ' · Hype '+targetQty(alt.hl,scan.ctx.market.hl)+' / '+settlementAmount(alt.hypeValue)+' · 比例 '+pct(nominal(alt),6)+
    ' · 失败回收 '+settlementAmount(alt.pressureSummary.minFailure?.value)+' · 通过留存 '+settlementAmount(alt.pressureSummary.minSuccess?.value)+
    ' · Hype 峰值保证金 '+settlementAmount(alt.pressureSummary.maxMarginUsed?.value)+' · 最低维持余量 '+settlementAmount(alt.pressureSummary.minSurplus?.value)+
    ' · M_eval '+signedCash(alt.pressureSummary.M_eval)+' · 通过线 '+windowText(alt.pressureSummary.cases[0]?.success.exam)+' · 失败线 '+windowText(alt.pressureSummary.cases[0]?.fail.exam):snapshot?'无合格缓冲方案':'等待求解');
  orderSnapshot=snapshot;
  for(const side of ['pf','hl']) {
    const d=decision, dir=d?.directions.find(v=>v.sign===d.adopted);
    const level=dir?.levels.find(v=>v.percent===d.percent);
    const diagnostic=!row && d?.mode==='move' && side==='pf'?level.requiredPosition:null;
    const qty=row?dec(row[side]):diagnostic?.qty?dec(diagnostic.qty):null;
    const unit=scan?.ctx.market[side].unit;
    write('order-'+side+'-direction',qty?(diagnostic?'情景所需 · ':'')+(qty.gt(0)?'做多':qty.lt(0)?'做空':'空仓'):'—');
    write('order-'+side+'-qty',qty?out(qty.abs())+' '+(unit==='contract'?'张':unit):d && side==='hl'?(level.complete && level.requiredPosition.i?'无可行仓位':'未核全'):'—');
    write('order-'+side+'-value',row?settlementAmount(side==='pf'?row.pfValue:row.hypeValue):diagnostic?.notional?settlementAmount(diagnostic.notional):'—');
  }
  const adopted=decision?.directions.find(v=>v.sign===decision.adopted);
  const selectedLevel=adopted?.levels.find(v=>v.percent===decision.percent);
  const unresolved=decision?.mode==='maximum'?adopted?.status==='incomplete':decision && !selectedLevel?.complete;
  const status=!snapshot?'等待有效输入':unresolved?'所选目标未核全':!row?'无可行方案':search?.reason;
  for(const id of ['live-ratio','live-targets','live-margin','solve-change']) {
    $(id).dataset.point=row?.key??'';
    $(id).dataset.snapshotId=snapshot?.snapshotId??'';
  }
  write('live-ratio',row?pct(nominal(row),6):status);
  const currentCase=proof?.cases.find(c=>c.id==='A');
  write('branch-summary',currentCase?'已填写的资金条件通过 · 基础盘口通过线 '+windowText(currentCase.success.exam)+
    ' ｜ 失败线 '+windowText(currentCase.fail.exam):search?.status==='none'?'没有同时满足已配置硬约束的仓位。见首页各方向的限制原因。':scan?.plans.decision?'所选目标缺少合格双边组合 · '+(scan.ctx.deriveMoves?'两日可达性未知，未配置方向波动情景':'各分支时间评估见仓位结果'):'等待本帧仓位核验');
  const moves=$('required-moves');
  moves.hidden=!(row && scan.ctx.stage==='challenge' && currentCase?.fail.mathMarks && currentCase?.success.mathMarks);
  if (!moves.hidden) {
    const describe=(label,path)=>{
      const {start,trigger}=path.mathMarks;
      const percent=dec(trigger).minus(start).div(start).times(100);
      return label+' '+(percent.lt(0)?'下跌 ':'上涨 ')+percent.abs().toFixed(2)+'% 至 '+fmt(trigger,2);
    };
    write('required-moves','数学触线价 · Vest 起始价 '+fmt(currentCase.fail.mathMarks.start,2)+' · '+
      describe('考核失败需',currentCase.fail)+' · '+describe('考核通过需',currentCase.success)+
      (scan.ctx.deriveMoves?' · 考核期限内可达性未知（缺少方向波动情景）':' · 在已设考核波动情景内'));
  }
  const unit=scan?.ctx.market;
  write('live-targets',row?'PF '+targetQty(row.pf,unit.pf)+'（'+settlementAmount(row.pfValue)+'） · Hype '+targetQty(row.hl,unit.hl)+
    '（'+settlementAmount(row.hypeValue)+'，'+(row.leverage??'—')+'×）':'—');
  write('live-margin',row?'最大 Hype 保证金占用 '+settlementAmount(proof.maxMarginUsed?.value)+
    ' · 最低维持余量 '+settlementAmount(proof.minSurplus?.value)+' · '+'最差现金缓冲 '+signedCash(proof.M_verified)+
    ' · 完整压力余量 '+(proof.M_full==null?'未知':signedCash(proof.M_full)):allowance?'允许上限 · Hype 杠杆 '+allowance.leverage+'× · 最大保证金占用 '+usd(allowance.margin)+' · 最低维持余量 '+usd(allowance.surplus):'—');
  const format=x=>pct(x.notionalRatio??x.h,6)+' / PF '+x.pf+' '+unit.pf.unit+'（'+settlementAmount(x.pfValue)+'） / Hype '+x.hl+' '+unit.hl.unit+'（'+settlementAmount(x.hypeValue)+'）';
  const values=[prior?'上次 '+time(prior.at)+' '+(prior.best?format(prior.best):'无合格目标'):'首帧，无上次求解',
    '本次 '+(snapshot?time(snapshot.trace.at)+' ':'')+(row?format(row):status)];
  if(prior?.best && row) {
    const prev=prior.best;
    const delta=(x,y,mult=1)=>dec(x).minus(y).times(mult);
    const signed=x=>(x.gt(0)?'+':'')+out(x);
    const bp=delta(nominal(row),prev.h,10000);
    values.push('变化 '+signed(bp.toDecimalPlaces(6))+' bp · PF '+signed(delta(row.pf,prev.pf))+' '+unit.pf.unit+
      ' · Hype '+signed(delta(row.hl,prev.hl))+' '+unit.hl.unit+' · 缓冲 '+signedCash(delta(proof.M_verified,prev.M)));
    const sameLots=row.pf===prev.pf && row.hl===prev.hl;
    values.push(sameLots && row.leverage===prev.leverage?'当前快照重新求解，最优候选未变':'最优候选已变化');
    const balance=scan.plans.decision?null:search.continuousBalance;
    if (sameLots && balance?.roundsToWinner && prior.balance?.roundsToWinner && !dec(balance.h).eq(prior.balance.h))
      values.push('撤前两档盘口的连续平衡比例 '+pct(prior.balance.h,8)+' → '+pct(balance.h,8)+'。比例发生变化，但当前交易数量精度不足以产生新的可执行仓位');
    if(bp.isZero()) values.push(row.pf===prev.pf && row.hl===prev.hl ?
      '本帧仍选中同一最大规模，双边名义额之比相同':'仓位规模变化，名义金额比例相同');
  }
  write('solve-change',snapshot?[snapshot.solveCause,...values].filter(Boolean).join(' ｜ '):'');
}
function showHeadline(snapshot) {
  const maximum=actionRow(snapshot), scan=snapshot.ratioScan;
  const stress=maximum?.pressureSummary;
  const certified=stress?.status==='pass' && stress.minFailure?.value!=null && stress.minSuccess?.value!=null;
  if(!certified) {
    for(const id of ['fail-pf','pass-pf','fail-before','pass-before','scan-fail-cash','scan-pass-cash']) write(id,'—');
    for(const id of ['scan-fail-summary','scan-pass-summary','scan-withdrawal','scan-final-worst','path-profit','stress-count','venue-report','trigger-paths','reach-windows']) write(id,'');
    $('scan-cash').dataset.point='';
    $('scan-cash').dataset.objective='';
    const decision=scan.plans?.decision;
    const cap=decision?.directions.find(v=>v.sign===decision.adopted)?.maxFeasiblePosition;
    write('cash-source',cap?'允许上限的两条路径 · PF '+settlementAmount(cap.notional):'个人资金 · 暂无可核价的合格规模');
    if(cap) {
      write('scan-fail-cash',settlementAmount(cap.fail));write('scan-pass-cash',settlementAmount(cap.pass));
    }
    return;
  }
  const target=maximum;
  const fail=stress.failComponent?.value??stress.minFailure.value;
  const floor=scan.recoveryFloor ?? scan.ctx.book.B, B=scan.ctx.book.B;
  const source='Evaluation · 两条路径的条件资金';
  const noBuffers=!dec(scan.ctx.params.recoveryBuffer??'0').gt(0) && !dec(scan.ctx.params.successBuffer??'0').gt(0);
  write('cash-source',source+(noBuffers?' · 极薄缓冲（未设置额外现金门槛）':''));
  const cash=$('scan-cash');
  cash.dataset.point=target.key??'';
  cash.dataset.objective=scan.plans?.decision?.mode??'maximumScale';
  write('fail-before',settlementAmount(fail));
  write('scan-fail-cash',settlementAmount(fail));

  const audit=target.pressureSummary;
  const successCase=stress.successFinal?.id??stress.minSuccess.id;
  const funds=audit?.cases.find(c=>c.id===successCase)?.success.personalFunds;

  write('fail-pf',settlementAmount(audit.cases.find(c=>c.id===stress.minFailure.id)?.fail.pfEquity));
  write('pass-pf',settlementAmount(audit.cases.find(c=>c.id===successCase)?.success.pfEquity));
  const shareLabel=rate=>rate==null?'':'（'+out(dec(rate).times(100))+'%）';
  write('pass-before',settlementAmount(funds?.before));
  write('scan-pass-cash',settlementAmount(funds?.final));
  write('scan-withdrawal',funds?.split?
    '成功路径 · PF 合格利润 '+settlementAmount(funds.split.qualified)+' · 个人提现 '+settlementAmount(funds.projectedPayout)+shareLabel(scan.ctx.book.share)+
    ' · 平台分成 '+settlementAmount(funds.split.platform)+shareLabel(scan.ctx.book.platformShare)+(funds.resetEquity!=null?' · 提现后 PF 基准 '+settlementAmount(funds.resetEquity):''):
    '考核提现 0 U。通过后另开 10,000 U Funded 账户。');
  const investment=scan.ctx.params.profitBasis;
  const net=(value)=>signedCash(dec(value).minus(investment));
  write('path-profit',investment==null || fail==null || funds?.final==null?'双路径净盈利 · 待取得个人投入与双端结算':
    '已核价情景双路径净盈利 · '+(dec(fail).gt(investment) && dec(funds.final).gt(investment)?'均盈利':'未同时盈利')+
    '（投入 '+settlementAmount(investment)+'，失败 '+net(fail)+'，考核通过 '+net(funds.final)+'）');
  const coverage=audit?.coverage;
  write('stress-count',coverage?'压力情景 · 已配置 '+audit.cases.filter(c=>c.configured).length+
    ' / 通过 '+coverage.passed+' / 失败 '+coverage.failed+' / 未验证 '+coverage.unverified:'压力覆盖未知');
  const priceLines=[], windowLines=[];
  const horizon=scan.ctx.params.horizon, deadline=scan.ctx.params.deadline;
  const now=snapshot.trace.at;
  windowLines.push('假设持仓 '+(horizon?.holdHours?horizon.holdHours+' 小时':'未配置')+
    ' · 考核截止 '+(deadline?new Date(deadline).toLocaleString('zh-CN'):scan.ctx.stage==='funded'?'本阶段不适用':'未配置')+
    '。窗口截至持仓或考核截止的较早时刻，按已填幅度分段线性折算。');
  const amplitude=value=>value==null?'未配置':value+'%';
  windowLines.push('24 小时上行 / 下行幅度假设 '+amplitude(horizon?.dailyUpPct)+' / '+amplitude(horizon?.dailyDownPct)+'。');
  windowLines.push('48 小时上行 / 下行幅度假设 '+amplitude(horizon?.twoDayUpPct)+' / '+amplitude(horizon?.twoDayDownPct)+'。');

  for (const [end,id,label] of [['fail',stress.minFailure.id,'失败'],['success',successCase,'成功']]) {
    const scenario=audit?.cases.find(c=>c.id===id);
    const endpoint=scenario?.[end];
    const path=endpoint?.prices;
    if (path?.pf && path.hl) {
      const legs=[['PF',path.pf],['Hype',path.hl]].map(([name,l])=>
        name+' '+fmt(l.start)+' → '+fmt(l.mark)+'（'+fmt(l.changePct,2)+'%），净盈亏 '+signedCash(l.netPnl));
      priceLines.push(label+' · '+scenario.label+' · '+legs.join(' / '));
    } else {
      priceLines.push(label+' · '+(endpoint?.reason??'未取得完整退出证据')+'，净盈亏待核实。');
    }
    const marks=endpoint?.mathMarks;
    const start=marks?.start??path?.pf?.start;
    const trigger=marks?.trigger??endpoint?.venue?.triggerMark??path?.pf?.mark;
    if(start==null || trigger==null) {
      windowLines.push(label+' · 数学触线价未知，无法核验可达性。');
      continue;
    }
    const deriv=endpoint.derivation??audit.cases.find(c=>c.id==='A')?.[end]?.derivation;
    if(deriv?.line!=null) priceLines.push('PF 数学触线价 = '+fmt(start)+' + ('+fmt(deriv.line)+' − '+
      fmt(deriv.intercept,5)+') / '+fmt(deriv.slope,8)+' ≈ '+fmt(trigger)+'。分子为规则权益减零变动权益，分母为每个原生报价点的有符号权益变化。');
    const percent=out(dec(trigger).div(start).minus(1).times(100));
    const windows=reachability(percent,horizon,deadline,now);
    windowLines.push(label+' · '+snapshot.prices.pf.base+' 以 Vest 永续标记衡量需变化 '+fmt(percent,2)+'%。'+windows.map(w=>
      w.window+'h（有效 '+fmt(w.effective,1)+'h）'+(w.status==='unknown'?'窗口幅度缺失或冲突，可达性未知':
        '幅度 '+fmt(w.bound,2)+'%，'+(w.status==='within'?'在假设范围内':'超出假设范围'))).join(' / '));
    const breaches=Object.entries(endpoint.breach??{}).filter(([,mark])=>mark!=null)
      .map(([side,mark])=>(side==='pf'?'Vest':'Hype')+' 途中首次触及维持线 '+fmt(mark));
    windowLines.push(label+' · '+(breaches.join(' / ') || (endpoint.pathStatus==='pass'?
      '该已核价路径的双边维持保证金检查通过，Hype 最低维持余量 '+settlementAmount(endpoint.minSurplus):
      endpoint.reason??'提前触线待核实'))+
      '。考核日亏损、追踪回撤等额外规则未建模，实际能否先于这些规则和期限到达仍未验证。');
  }
  write('trigger-paths',priceLines.join('\n'));
  write('reach-windows',windowLines.join('\n'));
  write('scan-final-worst',audit?.successFinal?'已核价两端最低个人资金 · 提现前 '+settlementAmount(audit.worstAvailable?.value)+
    ' · 按规则提现后 '+settlementAmount(audit.worstFinal?.value):'两端资金待计算');
  const basis=audit?.basis;
  const q=snapshot.prices.pf.quote;
  const basisLines=[basis?'当前基差（Hype 折合 '+q+' 减 Vest） '+fmt(basis.gap,4)+' '+q+'，'+fmt(basis.bps,3)+' bp · 汇率 '+fmt(basis.rate,9)+' '+q+'/'+snapshot.prices.hl.quote:'当前基差未知，缺少同帧汇率或报价',
    '独立情景以双边同比例移动为起点。基差按同币种溢价率扩大或向零收敛。Vest 跳价可越过边界，Hype 跳价在共同移动前发生。Vest 先平时，Hype 从共同终点再走不利幅度；Hype 先平时，Vest 随后走完触线前的最后一段（按起始价 bp）。'];
  for (const [id,label] of [['A','当前盘口基准'],...Object.entries(venueCases).map(([k,[v]])=>[k,v])]) {
    const c=audit?.cases.find(c=>c.id===id);
    if(!c?.configured) {basisLines.push(label+' · 未配置');continue;}
    for(const [key,title] of [['fail','失败'],['success','成功']]) {
      const p=c[key];
      basisLines.push(label+' · '+title+' · '+(p.prices?
        'PF 净盈亏 '+signedCash(p.prices.pf?.netPnl)+'（含费用 '+settlementAmount(p.fees?.pf)+'），Hype 净盈亏 '+
        signedCash(p.prices.hl?.netPnl)+'（含费用 '+settlementAmount(p.fees?.hl)+'） · '+
        (key==='fail'?'失败回收 ':'成功 Hype 剩余 ')+settlementAmount(p.cash)+
        (p.venue?' · 退出报价基差 '+fmt(p.venue.basisAfter.bps,3)+' bp':''):
        p.reason??'无法证明完整退出'));
    }
  }
  write('venue-report',basisLines.join('\n'));
  const cushion=fail==null?null:recoveryCushion(fail,B);
  $('scan-fail-summary').classList.toggle('thin-buffer',!!cushion?.thin);
  const delta=(amount,limit)=>signedCash(dec(amount).minus(limit));
  write('scan-fail-summary',fail==null?'完整退出未验证':
    (stress.minFailure.label+' · ')+'较本金 '+delta(fail,B)+
    (cushion.thin?' · 极薄缓冲':'')+(dec(floor).gt(B)?' · 保护门槛 '+usd(floor):''));
  write('scan-pass-summary',funds?'成功提现前 · Hype 平仓剩余 '+settlementAmount(funds.before)+'（'+
    (audit?.cases.find(c=>c.id===successCase)?.label??'条件情景')+'）':'成功路径未核价');
  write('scan-representative',pct(target.h));
  write('scan-position','PF '+targetQty(target.pf,scan.ctx.market.pf)+' / '+usd(target.pfValue)+
    ' · Hype '+targetQty(target.hl,scan.ctx.market.hl)+' / '+usd(target.hypeValue));
}
function showRepresentative(snapshot, auditScan) {
  const { ratioScan:scan, targets:[maximum], stress } = snapshot;
  const { buffer } = scan.representative;
  const row = scan.plans?.focus ?? scan.representative.row;
  const { book, params } = scan.ctx;
  // Advanced rule, cutoff and ledger evidence belongs to the base objective.
  const target = maximum ?? row;
  showHeadline(snapshot);
  const excess = dec(maximum?.failDelta ?? row.failureVsProtection ?? '0'),
    B = dec(book.B);
  const cushion = maximum ? recoveryCushion(maximum.fail,book.B) : row.cushion;
  const bufferRate = cushion.rate == null ? '无保护基准' : pct(cushion.rate, 6);
  const thin = cushion.thin;
  const stressIncomplete = stress?.missing.length || stress?.zero.length;
  $('scan-fail-net').classList.toggle('thin-buffer', thin);
  write(
    'scan-fail-net',
    target.failStop
      ? target.failStop
      : (excess.lt(0) ? '距离 ' : thin ? '仅比 ' : '比 ') +
          usd(book.B) +
          (excess.lt(0) ? ' 还差 ' : ' 多 ') +
          settlementAmount(excess.abs()) +
          '（相对保护基准 ' +
          bufferRate +
          '）' +
          (thin ? ' · 极薄缓冲（几乎零缓冲）' : '') +
          (thin && stressIncomplete
            ? stress.positive.length
              ? '，基础情景刚好覆盖，完整压力未验证'
              : '，仅基础情景刚好覆盖，完整压力未验证'
            : '') +
          (dec(buffer).gt(0) ? ' · 额外缓冲要求 ' + usd(buffer) : ' · 失败端未设额外安全缓冲')
  );
  write('scan-pass-title','考核通过');
  const diff = target.successPersonal==null ? null : dec(target.successPersonal).minus(B);
  write(
    'scan-pass-net',
    target.passStop
      ? target.passStop
      : '假设 PF 自身净结算达到 ' +
          usd(params.target) +
          '。Hype 平仓权益 ' +
          settlementAmount(target.success) +
          (target.survives ? '，满足 ' : '，低于 ') +
          usd(params.R) +
          ' 最低留存。个人资金' +
          (diff?.lt(0) ? '距保护本金尚差 ' : '较保护本金多 ') +
          settlementAmount(diff?.abs()) +
          ' · 相对累计投入 ' +
          settlementAmount(params.profitBasis==null || target.successPersonal==null ? null : dec(target.successPersonal).minus(params.profitBasis))
  );
  if (maximum && (maximum.sign!==row.sign || maximum.i!==row.i || maximum.j!==row.j)) {
    // Older snapshots can contain a preference ledger for a different position.
    for (const id of ['scan-deadline','scan-deadline-note','scan-risk','scan-funded'])
      write(id,'此历史快照未保存最大仓位的对应明细');
    audit=null;
    auditText();
    return;
  }
  const cutoff = row.deadline;
  write(
    'scan-deadline',
    cutoff.status === 'scenario'
      ? settlementAmount(cutoff.cash)
      : cutoff.status === 'notApplicable'
        ? '当前阶段不适用'
        : cutoff.status === 'firstBoundary'
          ? cutoff.key === 'fail'
            ? '先触及失败线'
            : '先触及通过线'
          : cutoff.status === 'risk'
            ? '路径风险未通过'
            : '到期结果未知'
  );
  write(
    'scan-deadline-note',
    cutoff.status === 'scenario'
      ? '按指定截止价 ' + cutoff.mark + ' 单向运行并平仓'
      : cutoff.status === 'unknown'
        ? '需要截止时间与明确的终点价格'
        : ''
  );
  if (row.funded && row.passStop)
    write('scan-funded', 'Funded 分成 · ' + row.passStop + '，无法计算该仓位的条件提现');
  else if (row.funded)
    write(
      'scan-funded',
      'Funded 分成 · 目标可分 ' +
        usd(row.funded.eligible) +
        ' · 按规则提现后，个人资金 ' +
        settlementAmount(row.funded.ifCredited) +
        '，相对总投入 ' +
        settlementAmount(row.funded.ifCreditedNet) +
        '（按规则测算）'
    );
  write(
    'scan-risk',
    'Hype 现金消耗 / 起始权益 ' +
      pct(row.consumption) +
      ' · 初始保证金 / 起始权益 ' +
      pct(row.imRate) +
      ' · 维持余量 / 路径权益 ' +
      pct(row.surplusRate) +
      ' · 强平距离 / 当前标记价 ' +
      (row.bufferRate == null ? '无正价交点或空仓' : pct(row.bufferRate))
  );
  audit = { row, scan:auditScan ?? scan, snapshotId:snapshot.snapshotId };
  auditText();
}
const columns = [
  '范围及组合数',
  'PF 数量 / 名义额',
  'Hype 数量 / 名义额',
  '失败个人回收 / 成功 Hype 权益',
  '失败 / 成功双边成交手续费',
  '失败缺口 / B · 成功消耗 / Hype 权益',
  'Hype 初始保证金范围 / 有交点的强平距离范围'
];
const pair = (values, format) =>
  !values || values.some((v) => v == null) ? '未知' : values.map((v) => format(v)).join(' – ');
function summaryRow(body, label, range, emptyText) {
  const tr = body.insertRow();
  const head = document.createElement('th');
  head.scope = 'row';
  head.textContent = label;
  tr.append(head);
  if (!range) {
    const cell = tr.insertCell();
    cell.colSpan = columns.length - 1;
    cell.textContent = emptyText;
    return tr;
  }
  head.append(document.createElement('br'), range.count.toLocaleString() + ' 组');
  head.title =
    'PF 多 ' + range.pfLong.toLocaleString() + ' 组 / PF 空 ' + range.pfShort.toLocaleString() + ' 组';
  const lines = [
    [pair(range.pfQty, (v) => v), pair(range.pfValue, usd)],
    [pair(range.hlQty, (v) => v), pair(range.hlValue, usd)],
    [pair(range.failure, settlementAmount), pair(range.successHype, settlementAmount)],
    [pair(range.failureFee, settlementAmount), pair(range.successFee, settlementAmount)],
    [pair(range.gapRate, pct), pair(range.consumption, pct)],
    [
      pair([range.minMargin,range.maxMargin],usd) + '（' + pair([range.minMarginRate,range.maxMarginRate],pct) + '）',
      range.minBuffer == null ? '无已验证强平交点' : pair([range.minBuffer,range.maxBuffer],v => fmt(v,4)) + ' 原生价格单位'
    ]
  ];
  for (const [top, bottom] of lines) tr.insertCell().append(top, document.createElement('br'), bottom);
  return tr;
}
// Keep the live row nodes, focus and horizontal scroll position across snapshots.
function patchRows(body, next) {
  const rows = Array.from(next.rows);
  for (const [i, incoming] of rows.entries()) {
    const row = body.rows[i];
    if (!row) {
      body.append(incoming);
      continue;
    }
    if (incoming.dataset.point) {
      for (const key of ['point', 'ratio', 'pfSize']) {
        if (row.dataset[key] !== incoming.dataset[key]) row.dataset[key] = incoming.dataset[key];
      }
    }
    if (incoming.hasAttribute('data-band')) {
      if (row.dataset.band !== incoming.dataset.band) row.dataset.band = incoming.dataset.band;
      if (row.dataset.subset !== incoming.dataset.subset) row.dataset.subset = incoming.dataset.subset;
    }
    if (incoming.dataset.case) row.dataset.case=incoming.dataset.case;
    if (row.className !== incoming.className) row.className = incoming.className;
    const cells = Array.from(incoming.cells);
    for (const [j, cell] of cells.entries()) {
      const old = row.cells[j];
      if (!old) row.append(cell);
      else if (!old.isEqualNode(cell)) {
        for (const audit of cell.querySelectorAll('details[data-path]')) {
          const prior=old.querySelector('details[data-path="'+audit.dataset.path+'"]');
          if (prior) audit.open=prior.open;
        }
        if (old.title !== cell.title) old.title = cell.title;
        if (old.colSpan !== cell.colSpan) old.colSpan = cell.colSpan;
        const sameLayout =
          old.childNodes.length === cell.childNodes.length &&
          [...old.childNodes].every((node, k) => node.nodeName === cell.childNodes[k].nodeName);
        if (sameLayout) {
          [...old.childNodes].forEach((node, k) => {
            const nextText = cell.childNodes[k].nodeValue;
            if (node.nodeType === Node.TEXT_NODE && node.nodeValue !== nextText) node.nodeValue = nextText;
            if (node.nodeType === Node.ELEMENT_NODE && !node.isEqualNode(cell.childNodes[k]))
              node.replaceWith(cell.childNodes[k].cloneNode(true));
          });
        } else old.replaceChildren(...cell.childNodes);
      }
    }
    while (row.cells.length > cells.length) row.deleteCell(-1);
  }
  while (body.rows.length > rows.length) body.deleteRow(-1);
}
function intervalText(lo, hi, separate = ' – ') {
  let digits = 4;
  while (digits < 48 && !dec(lo).eq(hi) && pct(lo, digits) === pct(hi, digits)) digits++;
  return pct(lo, digits) + separate + pct(hi, digits);
}
function renderSubsets() {
  if (!$('subset-detail').open) return;
  const details = document.createElement('tbody');
  for (const bin of frame?.buckets ?? []) {
    if (!bin.legal) continue;
    const label = binLabel(bin);
    for (const key of subsetGroups) {
      const unknown =
        (key === 'profit' || key.endsWith('Profit')) &&
        frame.ctx.params.profitBasis == null;
      summaryRow(
        details,
        label + ' · ' + names[key],
        unknown ? null : bin.ranges[key],
        unknown ? '投入基准待核实' : '0 组'
      );
    }
  }
  patchRows($('scan-subsets'), details);
}
function neighborVerdict(row) {
  if (!row.physical) return row.failStop || row.passStop || '保证金或强平缓冲不足';
  if (row.both) return '双路径保护';
  const gaps = [];
  if (!row.covers) gaps.push('回本差 ' + settlementAmount(row.shortfall));
  if (row.covers && row.coversWithBuffer === false) gaps.push('额外回本缓冲不足');
  if (!row.survives) gaps.push('留存差 ' + settlementAmount(dec(row.reserveHeadroom).neg()));
  return gaps.join('，');
}

function renderAnalysis(scan) {
  const info = scan?.analysis;
  $('ratio-analysis').hidden = !info;
  if (!info) return;
  const { boundary, theory, change } = info;
  const rep = scan.representative;
  const qty = (q, leg) => q + ' ' + (leg.unit === 'contract' ? '张' : leg.unit);
  const leg = scan.ctx.market;
  const counts = scan.buckets.filter((b) => b.both).map((b) => b.both.toLocaleString());
  write(
    'ratio-counts',
    '交集对账' +
      (scan.complete ? '' : '（已覆盖网格）') +
      '　' +
      (counts.length ? counts.join(' + ') + ' = ' : '') +
      scan.sets.both.count.toLocaleString() +
      ' 组'
  );
  write(
    'ratio-boundary',
    boundary
      ? '下界 ' +
          boundary.fraction +
          '（约 ' +
          pct(boundary.h, 8) +
          '）计入双路径闭区间，恰在下界且达标共 ' +
          boundary.count.toLocaleString() +
          ' 组。' +
          (boundary.count === 1 ? '该组' : '其中一组') +
          ' PF ' +
          qty(boundary.pf, leg.pf) +
          '，Hype ' +
          qty(boundary.hl, leg.hl) +
          '。'
      : ''
  );
  const objective = {
    max_pf: '优先扩大可行 PF 仓位，同额时取最差路径剩余现金较多的一组。',
    max_min_cash: '优先提高两端较低的个人现金，并列时取较小 PF 仓位。',
    max_pf_with_cash_floor: '最差个人现金至少 ' + usd(info.cashFloor) + '，再优先扩大 PF 仓位。',
    fixed: '按固定侧现仓求解另一侧。',
    diagnostic: '当前没有可推荐仓位，以下为条件路径对照。'
  };
  write(
    'ratio-objective',
    rep
      ? (rep.complete ? '' : '当前搜索范围内，') +
          (objective[rep.objective] ?? '') +
          '固定' +
          (info.fixed === 'hl' ? ' Hype ' : ' PF ') +
          '数量和方向，对比另一侧相邻合法档。数量正为多、负为空。' +
          (info.neighbors.length === 1 ? '当前仅此一档。' : '')
      : '当前没有可供比较的代表仓位。'
  );
  const next = document.createElement('tbody');
  for (const row of info.neighbors) {
    const tr = next.insertRow();
    tr.classList.toggle('representative-range', row.center);
    const head = document.createElement('th');
    head.scope = 'row';
    head.append(
      (row.center ? '代表 · ' : '') + pct(row.h, 6),
      document.createElement('br'),
      neighborVerdict(row)
    );
    head.title = dec(row.h).times(100).toString() + '%';
    tr.append(head);
    for (const [value, q, venue] of [
      [row.pfValue, row.pf, leg.pf],
      [row.hypeValue, row.hl, leg.hl]
    ]) {
      tr.insertCell().append(usd(value), document.createElement('br'), qty(q, venue));
    }
    tr.insertCell().textContent = row.failStop || settlementAmount(row.fail);
    tr.insertCell().textContent = row.passStop || settlementAmount(row.success);
    tr.insertCell().append(usd(row.initial), document.createElement('br'), pct(row.imRate, 2));
    tr.insertCell().textContent =
      row.buffer == null
        ? row.physical
          ? '无正价交点或空仓'
          : '未验证'
        : fmt(row.buffer) + ' ' + info.quote;
  }
  patchRows($('ratio-neighbors'), next);
  write(
    'ratio-theory',
    '理论下限 ' + pct(theory.lower) + '（待回收 ' + usd(theory.recoveryNeed) + ' ÷ PF 失败空间 ' + usd(theory.loss) +
    '），理论上限 ' + pct(theory.upper) + '（Hype 留存后可承亏 ' + usd(theory.spendable) + ' ÷ PF 成功空间 ' + usd(theory.gain) +
    '）。' + (dec(theory.lower).gt(theory.upper) ? '理论无交集。' : '') +
    '实际区间另计成交成本、数量步长及风险约束。'
  );
  let message = '';
  if (change) {
    if (change.changes.length) message += '较上一帧，' + change.changes.join('、') + '有变动。';
    if (change.theoryChanged) message += '资金理论界限已变。';
    else if (change.changes.includes('每单位盈亏敏感度')) message += '理论界限未变，每单位敏感度已重新换算。';
    else message += '资金边界和线性盈亏敏感度未改变，理论比例保持不变。';
    if (rep && change.previousH != null) {
      if (change.hChanged) {
        message +=
          '代表 h ' +
          intervalText(change.previousH, rep.row.h, ' → ') +
          '，' +
          (change.lotsChanged ? '两边数量步数组合已变。' : '每步的相对盈亏敏感度已变。');
      } else message += '代表 h 未变。';
      if (change.directionChanged) message += '代表方向已反转。';
    }
    if (change.intervalChanged) message += '实际区间端点已变。';
  } else message = '同一标的同步涨跌时，若资金空间和每单位敏感度不变，理论界限可以保持不变。';
  write('ratio-change', message);
}

function binLabel(bin) {
  if (bin.edgeKey === 'below') return 'h < ' + pct(bin.through);
  if (bin.edgeKey === 'above') return 'h > ' + pct(bin.above);
  if (bin.edgeKey === 'joint') return intervalText(bin.above, bin.through, ' ≤ h ≤ ');
  return '全部合法比例';
}

function formatRatios(records) {
  // Resolve rounding collisions between different executable fractions. Equal
  // fractions keep the same label at every position size on this page.
  const ratios = new Map(records.map(row => [row.fraction ?? row.h, row.h]));
  return row => {
    let digits = 4;
    for (const [key, h] of ratios) {
      if (key === (row.fraction ?? row.h)) continue;
      while (digits < 20 && pct(row.h, digits) === pct(h, digits)) digits++;
      if (pct(row.h, digits) === pct(h, digits)) return row.fraction ?? pct(row.h, digits);
    }
    return pct(row.h, digits);
  };
}

const signedCash = value => value == null ? '未验证' : (dec(value).gt(0) ? '+' : '') + settlementAmount(value);
const targetQty = (qty, leg) => {
  const q = dec(qty), unit = leg.unit === 'contract' ? '张' : leg.unit;
  return (q.isZero() ? '空仓 ' : q.gt(0) ? '多 ' : '空 ') + q.abs() + ' ' + unit;
};
const distanceText = (plan, scan) => plan.distance == null
  ? (plan.j === 0 ? 'Hype 空仓' : '无已验证交点')
  : fmt(plan.distance, 2) + ' ' + scan.plans.hlQuote;

// Columns are objectives. Every metric in a column reads the same solver record.
const comparisonMetrics = [
  ['h', '实际目标对冲比例', (p, s, ratio) => ratio(p)],
  ['pf', 'PF 目标仓位', (p,s) => targetQty(p.pf, s.ctx.market.pf)],
  ['pfValue', 'PF 名义金额', p => usd(p.pfValue)],
  ['hl', 'Hype 目标仓位', (p,s) => targetQty(p.hl, s.ctx.market.hl)],
  ['hypeValue', 'Hype 名义金额', p => usd(p.hypeValue)],
  ['fail', '完整盘口 · 失败回收', p => settlementAmount(fullCash(p,'fail'))],
  ['success', '完整盘口 · 成功留存', p => settlementAmount(fullCash(p,'pass'))],
  ['minFailure', '已核价最低失败回收', p => settlementAmount(p.pressureSummary?.minFailure?.value)],
  ['minSuccess', '已核价最低成功留存', p => settlementAmount(p.pressureSummary?.minSuccess?.value)],
  ['worstAvailable','已核价两端最低个人资金（提现前）',p=>settlementAmount(p.pressureSummary?.worstAvailable?.value)],
  ['worstFinal','已核价两端最低个人资金（按规则提现后）',p=>settlementAmount(p.pressureSummary?.successFinal?p.pressureSummary.worstFinal?.value:null)],
  ['personalShare','最低留存情景 · 预计 PF 个人提现',p=>settlementAmount(p.pressureSummary?.cases.find(c=>c.id===p.pressureSummary.minSuccess?.id)?.success.personalFunds?.projectedPayout)],
  ['fullBuffer','完整压力 M_full',p=>p.pressureSummary?.M_full==null?'未知':signedCash(p.pressureSummary.M_full)],
  ['cashBuffer', '已核价现金缓冲 M_verified', p => signedCash(p.pressureSummary?.cashBuffers?.minimum)],
  ['coverage', '通过 / 失败 / 未验证', p => {
    const c = p.pressureSummary?.coverage;
    return c ? c.passed+' / '+c.failed+' / '+c.unverified : '未记录';
  }],
  ['leverage', 'Hype 建议杠杆', p => p.leverage == null ? '未验证' : p.leverage + '×'],
  ['initial', 'Hype 开仓初始保证金', p => usd(p.initial)],
  ['maxMarginUsed', 'Hype 路径最大保证金占用', p => usd(p.pressureSummary?.maxMarginUsed?.value)],
  ['minSurplus', 'Hype 路径最小清算余量', p => settlementAmount(p.pressureSummary?.minSurplus?.value)],
  ['worstCase', '最差已配置情景', p => caseLabel(p.pressureSummary?.worstCase)]
];

function caseLabel(witness) {
  if(!witness) return '未验证';
  const path={fail:'失败',success:'通过',pass:'通过'}[witness.endpoint ?? witness.side];
  return witness.label+(path?' · '+path:'');
}

function initComparison() {
  const head = $('plan-columns').rows[0];
  for (const [key,name] of objectives) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.dataset.objective=key;
    if(key==='pressure') th.id='liquidity-maximum';
    const link=document.createElement('button');
    link.type='button';
    link.setAttribute('aria-controls',key==='pressure'?'liquidity-evidence':'evidence-'+key);
    link.textContent=name;
    link.setAttribute('aria-label','查看'+name+'的压力明细');
    link.onclick=()=>{
      const fold=$('plan-evidence').querySelector('details[data-objective="'+key+'"]');
      $('positions-view').open=true;
      $('position-breakdown').open=true;
      fold.open=true;
      fold.querySelector('summary').focus();
    };
    const scenario = document.createElement('small');
    th.append(link,scenario);
    head.append(th);
  }
  for (const [key,label] of comparisonMetrics) {
    const tr = $('plan-rows').insertRow();
    tr.dataset.metric = key;
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = label;
    tr.append(th);
    for (let col = 0; col < objectives.length; col++) tr.insertCell();
  }
}

const statusText = value => ({pass:'通过',fail:'未通过',unknown:'未验证',insufficient:'深度不足'})[value] ?? '未验证';
function planChecks(plan) {
  const summary=plan.pressureSummary;
  if (!summary) return '逐项压力未验证';
  if (summary.status==='fail') return '已配置压力未通过';
  if (summary.status!=='pass') return '已配置压力待验证';
  const venueIds=Object.keys(venueCases).filter(id=>summary.cases?.some(c=>c.id===id));
  const completePrice=[...venueIds,'basis','async','delay','jump','combinedA','combinedB','combinedC'].every(id=>
    summary.cases?.some(c=>c.id===id && c.configured && c.verified && c.status==='pass'));
  return completePrice?'完整价格压力通过'+(summary.fullStress?'':'，完整压力验证未完成'):
    '已配置盘口压力通过，完整压力验证未完成';
}
function renderComparison(snapshot) {
  const { ratioScan:scan, targets:winners, stress } = snapshot ?? {targets:objectives.map(() => null)};
  for(const [slot,id] of [[0,'home-base'],[1,'home-pressure'],[4,'home-cash']]) {
    const plan=winners[slot], summary=plan?.pressureSummary, c=summary?.coverage;
    write(id,plan?'PF '+targetQty(plan.pf,scan.ctx.market.pf)+'（'+usd(plan.pfValue)+'） / Hype '+targetQty(plan.hl,scan.ctx.market.hl)+'（'+usd(plan.hypeValue)+'） · 名义比例 '+pct(plan.notionalRatio??out(dec(plan.hypeValue).div(plan.pfValue))):scan?'无合格方案':'等待同帧计算');
    write(id+'-risk',summary && c?'Hype 最大保证金 '+settlementAmount(summary.maxMarginUsed?.value)+' · 已核价 M_verified '+signedCash(summary.M_verified??summary.cashBuffers.minimum)+' · 完整压力 M_full '+(summary.M_full==null?'未知':signedCash(summary.M_full))+' · 通过 '+c.passed+' / 失败 '+c.failed+' / 未验证 '+c.unverified:'');
    $(id).dataset.snapshotId=snapshot?.snapshotId??'';
    $(id).dataset.point=plan?.key??'';
  }
  write('home-pressure-name',scan?objectiveName(1,scan):'A-C 压力最大仓位');
  const max = winners[0];
  const baseOnly = stress && !stress.positive.length;
  const partial = stress && (stress.missing.length > 0 || stress.zero.length > 0);
  const scenario = !stress ? '压力状态未知' : baseOnly ? '基础情景' : partial ? '部分压力情景' : '已配置压力情景';
  const coverage = !stress ? scenario : stress.missing.length ? (baseOnly ? '价格与资金费压力未配置' : '价格与资金费压力未配齐') :
    stress.zero.length ? '含零压力假设' : '价格与资金费压力已配置';
  write('plan-stress', scan ? (scenario === coverage ? scenario : scenario + ' · ' + coverage) : '');
  const search=scan?.plans?.pressure, all=search?.allSpecified;
  const allStatus=all?.status??'unverified';
  $('pressure-scope-note').hidden=!scan;
  $('pressure-all-specified').dataset.status=allStatus;
  write('pressure-all-specified','全部指定压力下最大仓位 · '+(
    allStatus==='verified' ? '见压力方案列' : allStatus==='none' ? '无可行候选' : '未验证'));
  $('pressure-all-specified').title=all?.reason??'此快照未记录全部指定压力的最大仓位';
  $('plan-comparison').hidden = !winners.some(Boolean);
  const ratio = formatRatios(winners.filter(Boolean));
  for (const [col, plan] of winners.entries()) {
    const header = $('plan-columns').rows[0].cells[col+1];
    const point = plan?.key ?? '';
    if (header.dataset.point !== point) header.dataset.point = point;
    header.dataset.snapshotId=snapshot?.snapshotId??'';
    header.dataset.pressureStatus=plan?.pressureSummary?.status??'unknown';
    if(col===1) header.dataset.scope=search?.scope??'unknown';
    const name=objectiveName(col,scan);
    setText(header.firstElementChild,name);
    header.firstElementChild.setAttribute('aria-label','查看'+name+'的压力明细');
    header.firstElementChild.disabled=!plan;
    const empty=col===4 && scan ? scan.plans?.cashPriority?.reason??'历史帧未求解此目标' : col===1 && scan ? (scan.plans?.pressure?.reason??'本帧缺少压力结果') : '无合格方案';
    setText(header.lastElementChild, plan ? (col===1 || col===4?'':'基础情景通过 · ')+planChecks(plan) : empty);
    header.title=plan?.pressureSummary?.missing?.join('、')??'';
    for (const [index, [key,,format]] of comparisonMetrics.entries()) {
      const td = $('plan-rows').rows[index].cells[col+1];
      setText(td, plan ? format(plan, scan, ratio) : '—');
      const witness=plan?.pressureSummary?.[key];
      td.title=witness?.label ? caseLabel(witness)+(witness.reason?' · '+witness.reason:'') : '';
      if (key==='cashBuffer') {
        const buffers=plan?.pressureSummary?.cashBuffers;
        td.title=buffers?'失败回收较保护本金 '+signedCash(buffers.fail)+' · 成功留存较最低要求 '+signedCash(buffers.success):'';
        td.classList.toggle('negative-buffer',buffers?.minimum!=null && dec(buffers.minimum).lt(0));
      }
      if (key==='coverage') {
        const c=plan?.pressureSummary?.coverage;
        td.title=c?'通过 '+c.passed+' · 未通过 '+c.failed+' · 未验证 '+(c.unverifiedLabels.join('、')||'无'):'';
      }
    }
  }
  $('max-risk').hidden = !max;
  if (!max) return;
  const floor=scan.recoveryFloor??scan.ctx.book.B;
  const exit=max.liquidity?.fail, depthSummary=max.pressureSummary;
  const failedExit=exit?.settlement && dec(exit.settlement.personal).lt(floor);
  const warning=depthSummary?.status==='fail' ? '基础最大仓位未通过压力筛选' :
    !depthSummary || depthSummary.status==='unknown' ? '基础最大仓位的压力结果未验证' :
    '基础最大仓位满足已核价条件';
  write('max-risk-title',warning);
  const explanation = failedExit ? '撤去最优档后回收 '+settlementAmount(exit.settlement.personal)+'，门槛 '+usd(floor) :
    exit?.status==='insufficient' ? '撤去最优档后无法全量退出' :
    depthSummary?.status==='fail' && depthSummary.worstCase ? caseLabel(depthSummary.worstCase) :
    '初始保证金占权益 '+pct(max.marginRate,2);
  write('max-risk-values',explanation);
  $('scale-link').hidden = !scan.plans.comparison;
}

function renderScaleComparison(snapshot, fixed = false) {
  const scan = snapshot?.ratioScan;
  const pair = fixed ? snapshot?.scale.fixed : snapshot?.scale.automatic;
  const [small, large] = pair?.rows ?? [];
  const comparison = pair?.comparison;
  const prefix = fixed ? 'fixed-scale' : 'scale';
  const valid = !!(small && large && comparison);
  $(prefix + '-table').hidden = !valid;
  let caption = pair?.reason || '没有可核对的同方向、同一精确比例规模对照。';
  if (valid) {
    const method = fixed ? '两仓固定使用共同通过校验的最低档 ' + small.leverage + '×' :
      '独立择档，小仓 ' + small.leverage + '×，大仓 ' + large.leverage + '×';
    const change = comparison.delta.distance;
    const distanceNote = change == null ? '强平距离未验证' : dec(change).isZero() ? '强平距离相同' :
      '强平距离' + (dec(change).lt(0) ? '缩短 ' : '增加 ') + fmt(dec(change).abs(),2) + ' ' + scan.plans.hlQuote;
    caption = '目标比例 ' + pct(small.h) + ' · ' + method + ' · ' + distanceNote +
      '。小仓' + (small.both ? '满足' : '未同时满足') + '两端保护条件，大仓' +
      (large.both ? '满足' : '未同时满足') + '两端保护条件。';
  }
  write(prefix + '-caption', caption);
  const body = document.createElement('tbody');
  if (valid) {
    const qty = side => v => dec(v).abs() + ' ' + scan.ctx.market[side].unit;
    const metrics = [
      ['PF 数量', 'pf', qty('pf')], ['PF 名义额','pfValue', usd],
      ['Hype 数量','hl',qty('hl')], ['Hype 名义额','hypeValue',usd],
      ['Hype 初始保证金','initial',usd], ['保证金占权益','marginRate',v => pct(v,2)],
      ['失败回收减保护本金','failDelta',settlementAmount], ['成功后 Hype 剩余','success',settlementAmount],
      ['成功线至 Hype 强平距离','distance',v => fmt(v,2)+' '+scan.plans.hlQuote],
      [fixed ? '固定杠杆' : '自动杠杆','leverage',v => v+' 倍'], ['开仓后可用抵押品','free',usd],
      ['失败后个人回收','fail',settlementAmount], ['目标维持保证金','maintenance',usd],
      ['Hype 强平标记价','liquidation',v => fmt(v,2)+' '+scan.plans.hlQuote]
    ];
    for (const [label,key,format] of metrics) {
      const row = body.insertRow();
      row.dataset.metric = key;
      row.insertCell().textContent = label;
      for (const plan of [small,large])
        row.insertCell().textContent = plan[key] == null ? '未验证' : format(plan[key]);
      const change = comparison.delta[key];
      let text = '未验证';
      if (change != null) {
        const number = dec(change);
        const magnitude = key === 'marginRate' ? fmt(number.abs().times(100),2)+' 个百分点' : format(number.abs());
        text = (number.gt(0) ? '+' : number.lt(0) ? '−' : '') + magnitude;
      }
      row.insertCell().textContent = text;
    }
  }
  patchRows($(prefix + '-rows'),body);
}

function detailLine(cell, text) {
  const line = document.createElement('small');
  line.textContent = text;
  cell.append(line);
}

function liquidityLines(cell,first,scan) {
  for (const [label,test] of [['A 完整盘口',first.full],['B 撤档退出 · 撤最优档',first],['C 撤前两档',first.two],['D 剩余可见深度不足',first.shortfall]]) {
    if (!test) continue;
    const cash=test.settlement;
    detailLine(cell,label+' · '+exitDepthLabel(test)+' · 退出核验'+statusText(test.status)+' · '+(cash ? '个人资金 '+settlementAmount(cash.personal)+
      ' / Hype '+settlementAmount(cash.hype) : '全量退出资金未验证')+
      (test.reason?' · '+test.reason:'')+
      ' · 清算路径 '+statusText(test.pathStatus)+'，最低维持余量 '+settlementAmount(test.path?.worst?.surplus));
    for (const [side,venue] of [['pf','PF'],['hl','Hype']]) {
      const f=test.depth[side], unit=scan.ctx.market[side].unit;
      detailLine(cell,venue+' 可成交 '+(f.covered??'未知')+' / 未覆盖 '+(f.uncovered??'未知')+' '+unit+
        ' · 退出均价 '+fmt(f.vwap)+' · 档内滑点 '+settlementAmount(f.slippage)+
        ' · 撤档新增成交成本 '+settlementAmount(test.extraExitCost?.[side])+
        ' · 退出手续费 '+settlementAmount(test.exitFees?.[side]));
      const part=f.coveredExecution;
      if(part && (f.status!=='covered' || !part.atEndpoint)) detailLine(cell,
        venue+(part.atEndpoint?' 终点':' 当前盘口')+'已覆盖部分均价 '+fmt(part.vwap)+
        ' · 滑点 '+settlementAmount(part.slippage)+' · 手续费 '+settlementAmount(part.fee));
    }
  }
  if (first.withdrawn) {
    const remaining=['pf','hl'].map(side=>{
      const fill=first.withdrawn[side];
      return (side==='pf'?'PF':'Hype')+' 可成交 '+(fill?.covered??'未知')+'，未覆盖 '+
        (fill?.uncovered??'未知')+' '+scan.ctx.market[side].unit;
    });
    detailLine(cell,'退出侧可见档全部撤去时 · '+remaining.join(' / ')+' · 全量退出资金未验证');
  }
}

const evidenceColumns = ['压力情景','判定','失败后个人回收','通过后 Hype 剩余',
  '开仓初始保证金','最大占用（失败 / 通过）','最小清算余量（失败 / 通过）'];

const evidenceMetrics = [
  ['failBuffer','失败端较保护本金 M_fail',s=>signedCash(s?.cashBuffers?.fail)],
  ['successBuffer','成功端较最低留存 M_success',s=>signedCash(s?.cashBuffers?.success)],
  ['cashBuffer','两端最差现金缓冲 M',s=>signedCash(s?.cashBuffers?.minimum)],
  ['openingInitial','开仓初始保证金',s=>usd(s?.openingInitial)],
  ['openingFree','开仓后可用抵押品',s=>usd(s?.openingFree?.value)],
  ['maxMarginUsed','路径最大保证金占用',s=>usd(s?.maxMarginUsed?.value)],
  ['minFreeCollateral','途中最低可用抵押品',s=>usd(s?.minFreeCollateral?.value)],
  ['maxCollateralDeficit','最大抵押缺口',s=>usd(s?.maxCollateralDeficit?.value)],
  ['minSurplus','最低维持保证金余量',s=>settlementAmount(s?.minSurplus?.value)],
  ['minLiquidationDistance','路径最小强平距离',(s,unit)=>s?.minLiquidationDistance?.value==null?'未验证':
    fmt(s.minLiquidationDistance.value,2)+' '+unit]
];

function initPressureDetails() {
  for(const [key,name] of objectives) {
    const fold=document.createElement('details');
    fold.dataset.objective=key;
    const summary=document.createElement('summary');
    summary.textContent=name+' · 压力明细';
    const scope=document.createElement('p');
    const metrics=document.createElement('dl');
    metrics.className='pressure-metrics';
    for (const [field,label] of evidenceMetrics) {
      const group=document.createElement('div');
      const dt=document.createElement('dt'),dd=document.createElement('dd');
      dt.textContent=label; dd.dataset.metric=field;
      group.append(dt,dd); metrics.append(group);
    }
    const wrap=document.createElement('div');
    wrap.className='table-wrap';
    const table=document.createElement('table');
    const tr=table.createTHead().insertRow();
    for(const label of evidenceColumns){
      const th=document.createElement('th');
      th.scope='col'; th.textContent=label; tr.append(th);
    }
    table.setAttribute('aria-label',name+'的逐情景现金与保证金');
    const body=table.createTBody();
    fold.id=key==='pressure'?'liquidity-evidence':'evidence-'+key;
    if(key==='pressure') body.id='liquidity-evidence-body';
    wrap.append(table); fold.append(summary,scope,metrics,wrap); $('plan-evidence').append(fold);
  }
}

function renderPressureDetails(snapshot) {
  const section=$('plan-evidence');
  section.hidden=!snapshot?.targets.some(Boolean);
  for(const [i,fold] of [...section.querySelectorAll(':scope > details')].entries()){
    const target=snapshot?.targets[i], s=target?.pressureSummary;
    fold.hidden=!target;
    fold.dataset.point=target?.key??'';
    fold.dataset.snapshotId=snapshot?.snapshotId??'';
    const name=objectiveName(i,snapshot?.ratioScan);
    setText(fold.querySelector('summary'),name+' · 压力明细');
    const c=s?.coverage;
    const missing=c?.unverifiedLabels??s?.missing;
    const record=c?' · 通过 '+c.passed+' 项，未通过 '+c.failed+' 项，未验证 '+c.unverified+' 项':'';
    const reason=target ? 'PF '+targetQty(target.pf,snapshot.ratioScan.ctx.market.pf)+' / Hype '+
      targetQty(target.hl,snapshot.ratioScan.ctx.market.hl)+' · '+planChecks(target)+record+
      (missing?.length?'（未验证 '+missing.join('、')+'）':'') : '';
    const objective=i===1 && target ? ' · 同规模先比较最差现金缓冲，再比较按规则提现后的最差个人回收、清算余量及占用。' : '';
    setText(fold.querySelector('p'),reason+objective);
    for (const [field,,format] of evidenceMetrics) {
      const dd=fold.querySelector('dd[data-metric="'+field+'"]');
      const witness=s?.[field];
      setText(dd,format(s,snapshot?.ratioScan?.plans?.hlQuote??''));
      dd.title=witness?.label?caseLabel(witness):'';
    }
    const table=fold.querySelector('table');
    table.setAttribute('aria-label',name+'的逐情景现金与保证金');
    table.hidden=!s?.cases?.length;
    const next=document.createElement('tbody');
    for(const scenario of s?.cases??[]){
      const tr=next.insertRow();
      tr.dataset.case=scenario.id;
      const f=scenario.fail,p=scenario.success;
      tr.insertCell().textContent=scenario.label;
      const condition=tr.insertCell();
      condition.append(statusText(scenario.status));
      if(scenario.reason) detailLine(condition,scenario.reason);
      for(const path of [f,p]){
        const cash=tr.insertCell();
        cash.append(settlementAmount(path?.cash));
        const funds=path?.personalFunds;
        if(funds && path===p) detailLine(cash,'预计分成 '+settlementAmount(funds.projectedPayout)+' · 按规则提现后，成功路径合计 '+settlementAmount(funds.final));
        if(path?.reason && path.reason!==scenario.reason) detailLine(cash,path.reason);
        const funding=path?.funding;
        if(funding) {
          if(funding.periods) detailLine(cash,funding.periods+' 期共 '+funding.sumBps+' bp，路径峰值名义额 '+
            usd(funding.peakNotional)+'，逐期预算合计 '+settlementAmount(funding.rateDebit));
          detailLine(cash,'固定预算 '+settlementAmount(funding.fixedDebit)+' · 计入一次 '+settlementAmount(funding.charged));
        }
      }
      tr.insertCell().textContent=usd(f?.initialMargin??p?.initialMargin);
      tr.insertCell().textContent=usd(f?.maxMarginUsed)+' / '+usd(p?.maxMarginUsed);
      tr.insertCell().textContent=settlementAmount(f?.minSurplus)+' / '+settlementAmount(p?.minSurplus);
    }
    patchRows(table.tBodies[0],next);
  }
}

function intervalEvidence(cell,label,name,test) {
  if (!test.proof?.continuous || !test.proof.segments.length) return;
  const detail=document.createElement('details'), summary=document.createElement('summary');
  detail.dataset.path=name;
  summary.textContent=label+' · 查看逐段保证金';
  detail.append(summary);
  for (const [i,segment] of test.proof.segments.entries()) {
    const start=test.checkpoints[i], end=test.checkpoints[i+1];
    const pair=field=>usd(start[field])+' → '+usd(end[field]);
    detailLine(detail,fmt(segment.from)+' → '+fmt(segment.to)+' · 权益 '+pair('equity')+
      ' · 维持保证金 '+pair('maintenance')+' · 清算余量 '+pair('surplus')+
      ' · 可追加 '+pair('freeCollateral')+' · 段内最低清算余量 '+usd(segment.minimum));
  }
  cell.append(detail);
}

function renderPlans(snapshot) {
  const scan = snapshot?.ratioScan;
  const report = scan?.plans;
  const riskBody = document.createElement('tbody');
  const positionRows = document.createElement('tbody');
  for (const [i, r] of (snapshot?.targets ?? []).entries()) {
    const name = objectiveName(i,scan);
    if (!r) continue;
    const tr = positionRows.insertRow();
    tr.dataset.point = r.key;
    const heading = tr.insertCell();
    heading.append(name);
    const details=document.createElement('details');
    details.dataset.path='account-risk';
    const disclosure=document.createElement('summary');
    disclosure.textContent='查看保证金与资金约束';
    details.append(disclosure); heading.append(details);
    detailLine(details,'Hype 占权益 '+pct(r.marginRate,2)+' · 开仓可用 '+usd(r.free)+' · 强平距离 '+distanceText(r,scan));
    detailLine(details,'两端相对本金的差额，失败 '+signedCash(r.failDelta)+' / 通过 '+signedCash(r.successDelta));
    const v = r.verification ?? {};
    for (const [label,value] of [['失败回收',v.failureFunds],['成功留存',v.successFunds],['初始保证金',v.initial],
        ['维持保证金约束',v.maintenance],['设定价格路径',v.path],['压力测试',v.stress]])
      detailLine(details,label + ' · ' + statusText(value));
    if (r.fail!=null) detailLine(details,'失败端要求 '+usd(scan.recoveryFloor??scan.ctx.book.B)+
      '，高于门槛 '+settlementAmount(dec(r.fail).minus(scan.recoveryFloor??scan.ctx.book.B))+
      (recoveryCushion(r.fail,scan.ctx.book.B).thin?' · 极薄缓冲':''));
    detailLine(details,r.coverage==='verified' ? '已核对设定情景与全仓数据' : '路径风险未充分验证');
    if (Number(r.minimumHeadroom)<0) detailLine(details,'途中可新增 0 U。抵押品缺口 '+usd(dec(r.minimumHeadroom).neg()));
    if (Number(r.minimumInitialHeadroom)<0) detailLine(details,'无法追加仓位的初保资金缺口 '+usd(dec(r.minimumInitialHeadroom).neg())+'。清算按权益与维持保证金核验');
    for (const side of ['pf', 'hl']) {
      const leg = scan.ctx.market[side], adj = r.adjustments?.[side];
      const cell = tr.insertCell();
      cell.append(targetQty(r[side],leg) + ' / ' + usd(side === 'pf' ? r.pfValue : r.hypeValue));
      if (!adj) { detailLine(cell, '该快照未记录调仓差额'); continue; }
      detailLine(cell, '净仓 ' + adj.current + ' · 挂单 ' + (adj.pending ?? '未知') + ' ' + leg.unit);
      const remaining = adj.remaining == null ? null : dec(adj.remaining);
      detailLine(cell, !remaining ? adj.text : (adj.pending != null && !dec(adj.pending).isZero() ? '若挂单全成，' : '') +
        (remaining.isZero() ? '无需调仓' : (remaining.gt(0) ? '差额买入 ' : '差额卖出 ') + remaining.abs() + ' ' + leg.unit));
    }
    for (const key of ['fail','pass']) {
      const summaryCell = tr.insertCell(), path = r.paths?.[key];
      summaryCell.append(settlementAmount(fullCash(r,key)));
      if (!path) { detailLine(summaryCell, r[key === 'fail' ? 'failStop' : 'passStop'] || '该快照未记录路径价格'); continue; }
      const cell=document.createElement('details');
      cell.dataset.path=key+'-book-audit';
      const disclosure=document.createElement('summary');
      disclosure.textContent='查看触线、成交与清算路径';
      cell.append(disclosure); summaryCell.append(cell);
      for (const side of ['pf','hl']) {
        const unit = side === 'pf' ? report.pfQuote : report.hlQuote;
        const line = path[side], mark = line.mark ?? snapshot.prices[side].mark;
        const direction = dec(line.exitMark).cmp(mark);
        detailLine(cell, (side === 'pf' ? 'PF' : 'Hype') + (direction > 0 ? ' ↑ ' : direction < 0 ? ' ↓ ' : ' → ') +
          fmt(line.exitMark) + ' ' + unit + ' · 平仓 ' + (line.exitPrice == null ? '无仓位' : fmt(line.exitPrice)));
      }
      for (const [side,label] of [['pf','PF'],['hl','Hype']]) {
        const l=path[side];
        if (l.markPnl == null) continue;
        detailLine(cell,label+' '+targetQty(l.target,scan.ctx.market[side])+' × 乘数 '+l.multiplier+
          ' · 标记价格盈亏 '+signedCash(l.markPnl)+' · 成交价调整 '+signedCash(l.fillPnl));
        detailLine(cell,'起始权益 '+settlementAmount(l.startEquity)+' · 调仓均价 '+(l.entryPrice==null?'无调仓':fmt(l.entryPrice))+
          ' · 调仓费 '+settlementAmount(l.entryFee)+' · 平仓费 '+settlementAmount(l.closeFee)+
          ' · 平仓权益 '+settlementAmount(l.finalEquity));
      }
      detailLine(cell,'起点 PF ' + fmt(snapshot.prices.pf.mark) + ' ' + report.pfQuote +
        ' / Hype ' + fmt(snapshot.prices.hl.mark) + ' ' + report.hlQuote);
      for (const side of ['pf','hl']) for (const phase of ['entry','exit']) {
        const fill=r.depth?.[key]?.[side]?.[phase], unit=scan.ctx.market[side].unit;
        const label=(side==='hl'?'Hype':'PF')+(phase==='entry'?' 调仓':' 条件平仓');
        if (fill?.status==='noTrade') { detailLine(cell,label+' · 无成交'); continue; }
        if (fill?.status!=='covered') { detailLine(cell,label+' · 深度未验证'+
          (fill?.uncovered!=null?'，未覆盖 '+fill.uncovered+' '+unit:'')); continue; }
        detailLine(cell,label+' · '+(fill.side==='ask'?'吃卖盘':'吃买盘')+' · 目标 '+fill.target+' '+unit+
          '，覆盖 '+fill.covered+'（'+pct(fill.coverageRatio,2)+'） / 可见 '+fill.visible+'，未覆盖 '+fill.uncovered+'；用 '+fill.levels+
          ' 档，首档 '+fill.topSize+' @ '+fmt(fill.best)+'，均价 '+fmt(fill.vwap)+
          '，半点差成本 '+settlementAmount(fill.spreadCost)+'，深度滑点 '+settlementAmount(fill.slippage));
      }
      detailLine(cell,'深度滑点 PF ' + settlementAmount(path.pf.slippage) + ' / Hype ' + settlementAmount(path.hl.slippage));
      const stressDepth=r.liquidity?.[key];
      if (stressDepth) liquidityLines(cell,stressDepth,scan);
      if (key === 'pass' && r.successPersonal != null) detailLine(cell,'成功提现前 Hype ' + settlementAmount(r.successPersonal));
      for (const [kind,test] of Object.entries(r.pathAudit?.[key] ?? {})) {
        const label = {base:'基础同步',basisWiden:'基差扩大',basisNarrow:'基差收敛',
          adverseJump:'不利跳价',basisAdverse:'基差对当前 Hype 仓不利',basisFavorable:'基差对当前 Hype 仓有利',
          asyncExit:'盘口异步且退出时仍承受不利偏移',dislocation:'途中错位后恢复同步',delayedFill:'延迟成交后',beforeFill:'延迟成交前（原仓）',funding:'累计资金费',fundingOnly:'累计资金费',async:'双边报价不同步',asyncOnly:'双边报价不同步',singleLegDelay:'单边调仓延迟'}[kind] ?? test.label ?? '配置价格路径';
        const low=test.worst;
        if (low) {
          detailLine(cell,label+' · '+(test.proof?.continuous?'解析检验 '+test.proof.intervals+' 段':'路径风险未充分验证')+
            '，最小维持余量位于'+(low.legIndex===0?'起点':'第 '+low.legIndex+' 段 '+pct(low.progress,1))+
            '，Hype 标记 '+fmt(low.mark)+' '+report.hlQuote);
          detailLine(cell,'账户权益 '+usd(low.equity)+' · 目标初始保证金 '+usd(low.initial)+
            ' · 总保证金占用 '+usd(low.marginUsed)+'（其他已知占用 '+usd(low.otherUsed)+'）');
          if (Number(low.additionalIMShortfall)>0) detailLine(cell,'无法追加仓位的资金缺口 '+settlementAmount(low.additionalIMShortfall)+'（按初保要求）');
          detailLine(cell,'维持保证金 '+usd(low.maintenance)+' · 清算余量 '+usd(low.surplus)+
            ' · 可用抵押品 '+usd(low.freeCollateral)+' · 初始保证金净余量 '+usd(low.initialHeadroom));
          if (Number(test.lowestFree?.free)<0) detailLine(cell,'途中新增仓位可用 0 U，最大抵押缺口 '+
            usd(dec(test.lowestFree.free).neg())+'，出现在 '+fmt(test.lowestFree.mark)+' '+report.hlQuote);
        }
        intervalEvidence(cell,label,kind,test);
        if (test.offset!=null) detailLine(cell,'同步终点基差 '+fmt(test.gapBefore)+' → '+fmt(test.gapAfter)+
          ' '+report.hlQuote+'，'+(Number(test.offset)===0?'无额外位移':test.adverse?'对 Hype 不利':'对 Hype 有利'));
        const v=test.settlement;
        if (v) detailLine(cell,'双边平仓价 PF '+fmt(v.pfFill)+' / Hype '+fmt(v.hlFill)+
          '，PF 净盈亏 '+signedCash(v.pfNet)+'，Hype 净盈亏 '+signedCash(v.hlNet)+
          '，Hype 剩余 '+settlementAmount(v.hype)+'，提现前回收 '+settlementAmount(v.personal));
        else if (kind!=='beforeFill') detailLine(cell,'该路径结算未验证');
        if (test.firstBreach) detailLine(cell,'途中首次触线 ' + fmt(test.firstBreach.mark) + ' ' + report.hlQuote);
      }
      if (!r.pathAudit?.[key]?.basisWiden) detailLine(cell,'基差扩大 / 收敛 · 未验证（须有基差幅度和有效同币种参考）');
      detailLine(cell, 'Hype 净盈亏 ' + signedCash(path.hypeNet));
      detailLine(cell, '手续费 PF ' + settlementAmount(path.pf.fees) + ' / Hype ' + settlementAmount(path.hl.fees));
      detailLine(cell, '盘口成交成本 PF ' + settlementAmount(path.pf.executionCost) + ' / Hype ' + settlementAmount(path.hl.executionCost));
    }
  }
  const hasTargets = snapshot?.targets.some(Boolean) ?? false;
  patchRows($('position-list-rows'),positionRows);
  $('position-list').hidden = !hasTargets;
  $('positions-empty').hidden = hasTargets;
  write('positions-empty', hasTargets ? '' : !snapshot ? '等待首份计算快照' :
    report?.legacy ? '该历史快照缺少分方案明细' :
    '本次计算没有合格目标方案');
  renderScaleComparison(snapshot);
  renderScaleComparison(snapshot,true);
  write('plan-caption', !report ? '' :
    report.legacy ? '历史条件目标' : !report.eligible ? '当前门槛下无合格方案' :
    scan.complete ? '' : '限已扫描规模');
  const units = side => scan.ctx.market[side].unit === 'contract' ? '张' : scan.ctx.market[side].unit;
  function appendRisk(r) {
    const cost = k => [r.failCost, r.passCost].map(v => v ? fmt(v[k], 4) : '未知').join(' / ');
    const detail = riskBody.insertRow();
    for (const str of [pct(r.h) + ' · PF ' + r.pf + ' ' + units('pf'), r.hl + ' ' + units('hl'),
      r.leverage ? r.leverage + '×' : '—', usd(r.initial) + ' · ' + pct(r.marginRate, 2), usd(r.maintenance),
      usd(r.otherInitial), usd(r.free), usd(r.baseSurplus), usd(r.stressSurplus), r.liquidation == null ? '无已验证交点' : fmt(r.liquidation, 4) + ' ' + report.hlQuote,
      r.distance == null ? '无已验证交点' : fmt(r.distance, 4) + ' ' + report.hlQuote, cost('fees') + ' U', cost('slippage') + ' U']) detail.insertCell().textContent = str;
  }
  for (const r of report?.rows ?? []) appendRisk(r);
  const shown=new Set((report?.rows??[]).map(r=>r.key+'/'+r.leverage));
  for(const r of [snapshot?.targets[1],snapshot?.targets[4]]) {
    if(!r || shown.has(r.key+'/'+r.leverage)) continue;
    appendRisk(r);
    shown.add(r.key+'/'+r.leverage);
  }
  patchRows($('plan-risk-rows'), riskBody);
}

function draw(snapshot, auditScan) {
  frame = snapshot?.ratioScan ?? null;
  audit = null;
  const scan = frame,
    rep = scan?.representative;
  renderPressureDetails(snapshot);
  renderComparison(snapshot);
  renderPlans(snapshot);
  renderAnalysis(scan);
  $('bands-empty').hidden = !!scan?.sets.legal.count || !scan;
  if (scan && !scan.sets.legal.count) write('bands-empty','当前扫描范围没有合法仓位');
  const aggregate = document.createElement('tbody');
  const bands = document.createElement('tbody');
  write('capital-threshold', scan ? ' · ' + scan.ctx.book.B + ' U' : '');
  const floor = scan?.recoveryFloor ?? scan?.ctx.book.B;
  write('joint-threshold', scan ? (scan.historicalIntersection ? ' · 上版合格子集' : '') + ' · ≥' + floor + ' / ≥' + scan.ctx.params.R + ' U' : '');
  write('reserve-threshold', scan ? ' · ' + scan.ctx.params.R + ' U' : '');
  const noProfit = '无';
  for (const key of reportGroups) {
    const s = scan?.sets[key];
    const unknown =
      key === 'profit' &&
      scan &&
      scan.ctx.params.profitBasis == null;
    const empty = unknown
      ? '个人投入或外币估值待核实'
      : !scan
        ? '—'
        : !scan.complete
          ? '已覆盖范围内未找到'
          : key === 'profit'
            ? noProfit
            : '无符合条件的仓位';
    write('scan-' + key, s?.min && !unknown ? intervalText(s.min.h, s.max.h) : empty);
    $('scan-' + key).title =
      s?.min && !unknown
        ? dec(s.min.h).times(100).toString() + '% 至 ' + dec(s.max.h).times(100).toString() + '%'
        : '';
    if (scan) summaryRow(aggregate, names[key], unknown ? null : s.range, empty);
    if (key === 'profit') $('profit-panel').classList.toggle('no-profit', !s?.count && empty === noProfit);
  }
  if (scan) summaryRow(aggregate, names.legal, scan.sets.legal.range, '0 组');
  const excluded = [];
  for (const [n, bin] of (scan?.buckets ?? []).entries()) {
    const label = binLabel(bin);
    if (bin.legal) {
      for (const group of capitalGroups) {
        const range = bin.ranges[group];
        const row = summaryRow(bands, names[group] + ' · ' + label, range, '0 组');
        row.dataset.band = String(n);
        row.dataset.subset = group;
        if (group === 'both' && range) row.classList.add('qualified');
        if (range && n === rep?.segment && group === rep.group) {
          row.classList.add('representative-range');
          row.cells[0].title += ' · 含本帧条件目标方案';
        }
      }
    }
    if (bin.legal)
      excluded.push(
        label +
          ' · 合法 ' +
          bin.legal.toLocaleString() +
          '，失败回本 ' +
          bin.protect.toLocaleString() +
          '，成功留存 ' +
          bin.survive.toLocaleString() +
          '，交集 ' +
          bin.both.toLocaleString() +
          '，未达到两端约束 ' +
          (bin.legal - bin.both).toLocaleString() +
          ' 组'
      );
  }
  renderSubsets();
  patchRows($('scan-rows'), aggregate);
  patchRows($('scan-buckets'), bands);
  write('scan-risk-counts', excluded.join('\n'));
  write(
    'scan-intersection',
    scan
      ? '交集要求同组仓位在失败时回收至少 ' +
          usd(floor) +
          '（含额外缓冲），成功时 Hype 至少留存 ' +
          usd(scan.ctx.params.R) +
          '。个人净盈利另按两端平仓后的个人现金与累计投入比较。'
      : ''
  );
  if (rep) showRepresentative(snapshot, auditScan);
  else {
    auditText();
    for (const field of [
      'scan-representative',
      'scan-position',
      'scan-fail-cash',
      'scan-pass-cash',
      'fail-pf','pass-pf','fail-before','pass-before','path-profit','stress-count','scan-fail-net','scan-withdrawal','scan-final-worst','trigger-paths','reach-windows','venue-report',
      'scan-fail-summary',
      'scan-pass-summary',
      'scan-pass-net',
      'scan-risk',
      'scan-deadline',
      'scan-deadline-note'
    ])
      write(field, '');
    write('cash-source', '资金结果');
    $('scan-cash').dataset.point='';
    $('scan-cash').dataset.objective='';
    write('scan-fail-cash', '—');
    write('scan-pass-cash', '—');
    if (scan) write('scan-representative', '当前条件下无可推荐仓位');
  }
}
export function renderScan(result, m, r, plan, status, snapshot) {
  const observed = result.observed ?? result;
  const missingDirection=[['dailyUpPct','twoDayUpPct'],['dailyDownPct','twoDayDownPct']]
    .some(fields=>fields.every(field=>r[field]==null || String(r[field]).trim()===''));
  const examIssue=[...(observed.issues??[]),...(result.issues??[])]
    .find(issue=>/考核.*(可达性|开始|截止|没有可行仓位)/.test(issue));
  write('exam-status',r.stage!=='challenge'?'出金阶段':examIssue ?? (missingDirection?
    '考核波动情景未填全，已分别列出通过线与失败线':'考核截止 '+new Date(r.deadline).toLocaleString('zh-CN')));
  const networkError = m.errors?.pf || m.errors?.hl;
  const waitingForMarket = !networkError && !m.errors?.spec && m.source !== '手工确认盘口' &&
    ((!m.pf || !m.hl) || (!m.spec && (!m.specStatus || m.specStatus === 'loading')));
  const specError = m.errors?.spec || m.errors?.specRisk;
  const unverifiedVest = !waitingForMarket && !networkError &&
    (specError || /(?:VS 报价币|VS 标的)/.test(observed.currencies?.error ?? ''));
  for (const [key, title] of [
    ['pf', 'VS'],
    ['hl', 'Hype']
  ]) {
    const q = m[key];
    const saved = snapshot?.prices?.[key];
    const book = q?.levels?.[0]?.[0] && q.levels[1]?.[0] ? {
      bid:q.levels[0][0][0], ask:q.levels[1][0][0], bookAt:q.bookAt ?? q.asOf
    } : null;
    const prices = book ?? saved;
    const c = observed.currencies?.[key] ?? (saved && {baseAsset:saved.base, quoteAsset:saved.quote});
    const prefix = 'scan-' + key + '-';
    const health=m.health?.[key];
    write(prefix+'connection',health?'WS Connected '+(health.connected?'是':'否')+' · 最近消息 '+time(health.lastMessageAt)+
      ' · 盘口 '+time(health.lastBookAt)+' · Mark '+time(health.lastMarkAt)+' · '+(key==='hl'?'心跳 ':'消息活动 ')+(health.heartbeat?'正常':'待确认')+' · '+(key==='hl' && health.continuous && health.subscription==='streaming'?'持续接收 '+m.asset+' · ':'')+'最近有效报价 '+time(health.lastValidQuoteAt)+' · 报价年龄 '+(health.lastValidQuoteAt?Math.max(0,Date.now()-Date.parse(health.lastValidQuoteAt))+' ms':'未知')+
      ' · 重连 '+health.reconnectCount+' 次 · 订阅 '+health.subscription+(key==='pf'?' · 连接 ID '+(health.connectionId??'—')+
        ' · 订阅 ID '+(health.subscriptionId??'—')+' · 上次断开 '+(health.lastDisconnectReason??'无')+
        ' · 上次重连 '+(health.lastReconnectAt?time(health.lastReconnectAt):'无')+' · 连续稳定 '+Math.floor((health.stableMs??0)/1000)+' 秒 · 解析异常 '+(health.parseErrors??0):''):'连接状态未知');
    write(prefix + 'product', (key === 'pf' ? 'Vest ' : 'Hyperliquid ') + (m.asset ?? '') + ' Perp');
    write(prefix + 'unit', c?.quoteAsset && c?.baseAsset ? c.quoteAsset + '/' + c.baseAsset : '报价币待核实');
    const bookInvalid = m.errors?.[key] || observed.timing?.clocks?.[key]?.ok === false;
    write(prefix + 'health', bookInvalid || (prices && !book) ? ' · 已失效' : health ? (health.ready?' · 行情有效':' · 等待有效订阅') : '');
    write(prefix + 'price', q?.mark ?? saved?.mark ?? '—');
    const markAt = q?.mark != null ? q.markAt ?? q.asOf : saved?.markAt ?? saved?.asOf;
    $(prefix + 'price').title = (q?.mark == null && saved ? '历史标记时间 ' : (q?.markSource??'标记时间')+' ') + time(markAt);
    write(prefix + 'bid', prices?.bid ?? '—');
    write(prefix + 'ask', prices?.ask ?? '—');
    const clock = $(prefix + 'book-time');
    const bookAt = prices?.bookAt;
    if (clock.dateTime !== (bookAt ?? '')) clock.dateTime = bookAt ?? '';
    write(prefix + 'book-time', bookAt ? (book ? '盘口 ' : '历史盘口 ') + time(bookAt) : '盘口时间未知');
    write(prefix + 'quote', [m.source === '手工确认盘口' && m.source, clock.textContent,
      m.errors?.[key] || (bookInvalid && '报价过期或盘口无效') || (!book && '等待新报价')].filter(Boolean).join(' · '));
  }
  const displayed = result.ratioScan ? result : result.retained;
  const tr = snapshot?.trace;
  const f = observed.funding;
  const theory=observed.theoreticalRatio;
  write('theory-only',theory?.lower!=null && theory?.upper!=null?
    (theory.code==='NO_CASH_INTERSECTION'?'无交集 · 下界 / 上界 ':'')+
    pct(theory.lower)+' – '+pct(theory.upper)+'（按本金与成功留存计算，假设零成交成本）':'等待资金规则');
  write('scan-source', plan ? (r.planCrossFlat === true ? '预设资金规划 · 规划空仓' : '预设资金规划 · 仓位待确认') : f?.C_H == null || f?.E == null ? '当前账户快照 · 待读取' : '当前账户快照');
  write(
    'scan-capital',
    f?.E != null
      ? (plan ? '预设资金规划 · 条件结果 · ' : '当前账户快照 · 条件结果 · ') +
          '保护基准 ' +
          usd(f.B) +
          ' · Hype ' +
          usd(f.C_H) +
          ' · PF ' +
          usd(f.E) +
          '（失败 ' +
          fmt(f.F) +
          ' / 成功 ' +
          fmt(f.T) +
          '） · 成功最低留存 ' +
          usd(f.R??f.R_success)
      : plan
        ? '预设规划 · 等待完整行情和规划条件'
        : '当前账户 · 等待有效权益和持仓快照'
  );
  if (!snapshot?.ratioScan?.representative?.row?.funded) write('scan-funded',r.stage==='challenge'?'考核分成 · 当前阶段不适用（PF 提现 0 U）':'Funded · 等待有效结算快照');
  const timing = observed.timing;
  const quoteBreak = timing?.quoteSkew > timing?.quoteLimit;
  const state = waitingForMarket ? 'loading' : publicationState(result,snapshot,m,
    !!(quoteBreak || networkError || specError || observed.currencies?.error)),
    id = snapshot?.snapshotId ?? '';
  const stamp = tr ? '输入时点 ' + new Date(tr.at).toLocaleDateString('zh-CN') + ' ' + time(tr.at) : '';
  const desk = $('scan-desk');
  if (desk.dataset.state !== state) desk.dataset.state = state;
  const currentInputs = state === 'ready';
  const reason = quoteBreak ? '行情熔断 · 双边盘口或标记时差 ' + timing.quoteSkew +
    ' ms，阈值 ' + timing.quoteLimit + ' ms' : networkError || observed.currencies?.error || specError || result.issues?.[0] || status;
  let validity;
  if (quoteBreak) {
    validity = tr ? reason : reason + ' · 暂停新目标建议';
  } else if (state === 'recovering') {
    validity = tr ? '行情和输入已恢复，正在重新计算' : '输入就绪，首次计算中';
  } else if (currentInputs) {
    const isOpening = snapshot?.ratioScan.plans?.collection?.opening === true;
    const hasRows = (snapshot?.ratioScan.plans?.collection?.summary?.total ?? 0) > 0;
    validity = (!isOpening && snapshot?.ratioScan.plans?.pressure?.status==='none')
      ? '已配置硬约束下无解 · 原因见双向仓位结果'
      : (isOpening && !hasRows)
        ? '当前资金/规则下无可行仓位'
        : snapshot?.ratioScan.ctx.deriveMoves
          ? '当前盘口实时测算（未填辅助方向波动情景，不影响仓位求解）'
          : '当前盘口实时测算';
    if (displayed?.ratioScan?.complete === false) validity += '（部分网格）';
  } else if (state === 'updating') {
    validity = tr ? (result.trigger === '行情更新' ? '盘口已更新，重算中（下方为上一快照）' : '输入已变更，重算中（下方为上一快照）') : '输入就绪，首次计算中';
  } else if (waitingForMarket) {
    validity = '等待双边盘口';
  } else {
    validity = (state === 'failed' ? '计算失败' : '计算暂停') + ' · ' + (reason || '数据待核实');
    if (tr) validity += '（仅供历史参考）';
  }
  const completedAt = snapshot?.calculatedAt;
  const lastTime = completedAt ? new Date(completedAt).toLocaleString('zh-CN',{hour12:false}) : '—';
  const historical = !!tr && !currentInputs;
  if (historical && !validity.includes('历史')) validity+=' · 历史快照，暂停新建议';
  for (const label of document.querySelectorAll('.history-label'))
    setText(label,historical ? '历史快照' : '');
  const cashClock = $('cash-calculated-at');
  if (cashClock.dateTime !== (completedAt ?? '')) cashClock.dateTime = completedAt ?? '';
  write('cash-calculated-at', completedAt ? '最后成功计算 ' + time(completedAt) : '等待首次计算');
  const main = $('current');
  if (main.dataset.historical !== String(historical)) main.dataset.historical = String(historical);
  if (main.dataset.frameState !== state) main.dataset.frameState = state;
  $('snapshot-note').hidden = !historical || state === 'updating';
  write('snapshot-note', historical ? '历史快照 · ' + lastTime + '。新目标建议已暂停，以下资金、区间与仓位仅供核对。' : '');
  write('scan-status', validity + ' ｜ 最近成功计算 ' + (completedAt ? time(completedAt) : lastTime));
  write(
    'scan-runtime',
    [
      displayed?.trigger,
      displayed?.startedAt && 'Worker 开始 ' + time(displayed.startedAt),
      displayed?.finishedAt && '完成 ' + time(displayed.finishedAt),
      displayed && '耗时 ' + displayed.solveMs + ' ms',
      displayed?.ratioScan && '覆盖 ' + displayed.ratioScan.sets.legal.count.toLocaleString() + ' 组',
      displayed?.stress?.label,
      stamp,
      tr && tr.model + ' / ' + id
    ]
      .filter(Boolean)
      .join(' · ')
  );
  if (frameKey !== (id || 'empty')) {
    const auditScan = displayed?.trace?.id === id ? (displayed.baseScan ?? displayed.ratioScan) : null;
    if(!snapshot?.ratioScan.plans?.collection?.opening) {
      draw(snapshot, auditScan);
      showOptimum(snapshot);
    }
    drawCandidateSet(snapshot);
    // All panels are patched synchronously from one publication before exposing its version.
    frameKey = id || 'empty';
    for (const panel of ['candidate-grid','live-view','positions-view','scale-details','desk-details','scan-results','scan-cash','ratio-intervals','desk-state']) {
      $(panel).dataset.snapshotId = id;
      $(panel).dataset.calculatedAt = completedAt ?? '';
    }
    for (const key of ['quoteSnapshotId','accountSnapshotId','rulesVersion','solverVersion','calculatedAt'])
      desk.dataset[key] = snapshot?.[key] ?? '';
    desk.dataset.resultId = id;
    desk.dataset.solverRunId = snapshot?.solverRunId ?? '';
  }
  const row=actionRow(snapshot);
  const expiry=observed.expiryOutcome;
  write('unhit-expiry','到期未触线退出 · '+(expiry?(expiry.cash==null?expiry.reason:
    '若期间未曾触线，截止盘口估算个人回收 '+settlementAmount(expiry.cash)+'，待实际结算'):row?expiryText(row.deadline):'缺少本帧可核价仓位'));
  for(const side of ['pf','hl']) $('copy-'+side).disabled=!orderParameters(side);
}
export function setupScan(refresh) {
  setupCandidateSet(refresh);
  for(const side of ['pf','hl']) $('copy-'+side).onclick=async ()=>{
    const original=orderSnapshot?.snapshotId;
    refresh();
    const text=orderParameters(side);
    if(!text || original!==orderSnapshot?.snapshotId) {write('copy-status','行情或仓位已更新，请核对当前结果');return;}
    try {await navigator.clipboard.writeText(text);write('copy-status','已复制 '+(side==='pf'?'PF':'Hype')+' 下单参数');}
    catch {write('copy-status','浏览器未允许复制，请使用页面中的目标仓位');}
  };
  initComparison();
  initPressureDetails();
  const buttons = [...$('desk-views').querySelectorAll('button')];
  for (const button of buttons) {
    const panel = $(button.getAttribute('aria-controls'));
    button.onclick = () => { panel.open = true; panel.scrollIntoView({block:'start'}); };
    panel.addEventListener('toggle', () => button.setAttribute('aria-expanded',String(panel.open)));
  }
  $('scale-link').onclick = () => { $('positions-view').open = true; $('position-breakdown').open=true; };
  for (const id of ['desk-details', 'audit-details', 'scan-detail'])
    $(id).addEventListener('toggle', auditText);
  $('subset-detail').ontoggle = renderSubsets;
  for (const id of ['range-columns', 'bin-columns', 'subset-columns']) {
    const tr = $(id).insertRow();
    for (const title of columns) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = title;
      tr.append(cell);
    }
  }
}
