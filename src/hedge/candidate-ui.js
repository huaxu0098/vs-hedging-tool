import {dec,out} from './math.js';

const el=id=>document.getElementById(id);
const amount=(v,n=2)=>v==null?'—':dec(v).toFixed(n);
const commas=(v,n=0)=>{
  if(v==null) return '—';
  const [int,frac]=dec(v).toFixed(n).split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(frac?'.'+frac:'');
};
// Never round tiny non-zero profit/loss (e.g. +0.003) into misleading "+0.00".
const signedNet=v=>{
  if(v==null) return '—';
  const d=dec(v);
  const abs=d.abs();
  if(abs.gt(0) && abs.lt('0.0001')) return (d.gt(0)?'+<0.0001':'-<0.0001');
  const digits=abs.gt(0) && abs.lt('0.01') ? 4 : 2;
  return (d.gt(0)?'+':'')+d.toFixed(digits);
};
const setText=(node,text)=>{
  const str=text==null?'':String(text);
  if(node.textContent!==str) node.textContent=str;
};
const setClass=(node,cls)=>{
  if(node.className!==cls) node.className=cls;
};
const setHidden=(node,hidden)=>{
  if(node.hidden!==Boolean(hidden)) node.hidden=Boolean(hidden);
};
const sideName=(side,qty)=>(side==='pf'?'PF ':'Hype ')+(dec(qty).gt(0)?'做多':dec(qty).lt(0)?'做空':'空仓');
function positionText(r,side,units,held) {
  const q=r[side], value=side==='pf'?r.pfValue:r.hypeValue,a=r.adjust[side];
  const text=sideName(side,q)+' '+out(dec(q).abs())+' '+units[side].unit+' · 名义仓位 '+amount(value)+' U';
  return !held?text:text+'\n当前 '+a.current+' / 目标 '+q+' / 需增减 '+a.delta+
    (a.remaining==null?'（挂单待核对）':a.remaining!==a.delta?'（扣除挂单余 '+a.remaining+'）':'')+
    (a.reversal?'\n平仓成本 '+amount(a.close,4)+' U / 反手开仓 '+amount(a.open,4)+' U':'');
}
const ratio=r=>amount(dec(r.h).times(100),2)+'%';
function shortLine(r,end) {
  const x=r.lines[end];
  if(!x) return null;
  return commas(x.mark,0)+' ('+(dec(x.percent).gt(0)?'+':'')+amount(x.percent,2)+'%)';
}
function formatBranchCostLine(label,bc) {
  if(!bc) return null;
  const parts=[];
  if(bc.pf) {
    parts.push('PF(计入PF权益) 开费 '+amount(bc.pf.openFee,2)+'+平费 '+amount(bc.pf.closeFee,2)+
      '+执行 '+amount(bc.pf.execTotal,2)+' U');
  }
  if(bc.hl) {
    parts.push('Hype(计入实盘损益) 开费 '+amount(bc.hl.openFee,2)+'+平费 '+amount(bc.hl.closeFee,2)+
      '+执行 '+amount(bc.hl.execTotal,2)+' U');
  }
  if(bc.withdrawalFee && dec(bc.withdrawalFee).gt(0)) {
    parts.push('出金费 '+amount(bc.withdrawalFee,2)+' U(分成前扣一次)');
  }
  return label+'：'+parts.join(' ｜ ');
}

// Create a reusable skeleton for an 8-column candidate row so updates patch IN-PLACE
// without destroying DOM nodes, losing scroll, or collapsing open <details>.
function createMetricSlots(td) {
  const big=document.createElement('strong');
  big.className='big-num';
  const line=document.createElement('div');
  line.className='outcome-line';
  const badge=document.createElement('span');
  badge.className='verdict-pill verdict-muted';
  const sub=document.createElement('span');
  sub.className='outcome-sub';
  line.append(badge,sub);
  const note=document.createElement('small');
  td.append(big,line,note);
  return {big,line,badge,sub,note};
}

function patchMetricSlots(slots,mainValue,pillText,tone,subText,extraNote) {
  setText(slots.big,mainValue??'—');
  if(pillText) {
    setHidden(slots.badge,false);
    setText(slots.badge,pillText);
    setClass(slots.badge,'verdict-pill verdict-'+tone);
  } else {
    setHidden(slots.badge,true);
  }
  if(subText) {
    setHidden(slots.sub,false);
    setText(slots.sub,subText);
  } else {
    setHidden(slots.sub,true);
  }
  setHidden(slots.line,!pillText && !subText);
  if(extraNote) {
    setHidden(slots.note,false);
    setText(slots.note,extraNote);
  } else {
    setHidden(slots.note,true);
  }
}

function createLegSlots(td,withTag) {
  const head=document.createElement('div');
  head.className='leg-head';
  const dir=document.createElement('span');
  dir.className='verdict-pill';
  const qty=document.createElement('strong');
  qty.className='leg-qty';
  head.append(dir,qty);
  const notional=document.createElement('small');
  const lev=document.createElement('small');
  const tag=withTag?document.createElement('small'):null;
  if(tag) tag.className='tag-hint';
  const delta=document.createElement('small');
  delta.className='hold-delta';
  td.append(head,notional,lev,...(tag?[tag]:[]),delta);
  return {dir,qty,notional,lev,tag,delta};
}

// Map<rowKey, { key, sign, pf, hl, tagsKey, primaryTag, inFeatured, slotIndex }>
// Persists expanded detail state across live market recalculations even when integer lot counts (i, j) shift slightly.
const expandedDetails=new Map();

function buildExpandedMeta(row,inFeatured=true,slotIndex=0) {
  return {
    key:row.key,
    sign:dec(row.pf).gte(0)?1:-1,
    pf:Number(row.pf)||0,
    hl:Number(row.hl)||0,
    tagsKey:(row.tags??[]).join('|'),
    primaryTag:row.tags?.[0]??'',
    inFeatured:Boolean(inFeatured),
    slotIndex:Number.isFinite(slotIndex)?slotIndex:0
  };
}

function reconcileExpandedDetails(rows,byKey) {
  const migratedFromKey=new Map();
  if(!expandedDetails.size || !rows.length) return migratedFromKey;
  const nextMap=new Map();
  const claimed=new Set();

  // Pass 1: keep exact key matches
  for(const [oldKey,meta] of expandedDetails) {
    const hit=byKey.get(oldKey);
    if(hit) {
      claimed.add(oldKey);
      nextMap.set(oldKey,{
        ...meta,
        key:oldKey,
        sign:dec(hit.r.pf).gte(0)?1:-1,
        pf:Number(hit.r.pf)||0,
        hl:Number(hit.r.hl)||0,
        tagsKey:(hit.r.tags??[]).join('|'),
        primaryTag:hit.r.tags?.[0]??''
      });
    }
  }

  // Pass 2: migrate any expanded row whose (i, j) lot integers shifted on full recalculation
  for(const [oldKey,meta] of expandedDetails) {
    if(nextMap.has(oldKey)) continue;
    let bestRow=null;
    let bestScore=Infinity;
    for(const r of rows) {
      if(claimed.has(r.key)) continue;
      const rSign=dec(r.pf).gte(0)?1:-1;
      const rTagsKey=(r.tags??[]).join('|');
      const rPrimary=r.tags?.[0]??'';
      const signPenalty=rSign===meta.sign?0:1000;
      const tagPenalty=rTagsKey && rTagsKey===meta.tagsKey ? 0 : (rPrimary && rPrimary===meta.primaryTag ? 0.12 : 0.45);
      const pfDist=Math.abs((Number(r.pf)||0)-meta.pf)/Math.max(Math.abs(meta.pf),1e-6);
      const hlDist=Math.abs((Number(r.hl)||0)-meta.hl)/Math.max(Math.abs(meta.hl),1e-6);
      const score=signPenalty+tagPenalty+pfDist+hlDist;
      if(score<bestScore) {
        bestScore=score;
        bestRow=r;
      }
    }
    if(bestRow) {
      claimed.add(bestRow.key);
      migratedFromKey.set(bestRow.key,oldKey);
      nextMap.set(bestRow.key,{
        ...meta,
        key:bestRow.key,
        sign:dec(bestRow.pf).gte(0)?1:-1,
        pf:Number(bestRow.pf)||0,
        hl:Number(bestRow.hl)||0,
        tagsKey:(bestRow.tags??[]).join('|'),
        primaryTag:bestRow.tags?.[0]??''
      });
    }
  }

  expandedDetails.clear();
  for(const [k,v] of nextMap) expandedDetails.set(k,v);
  return migratedFromKey;
}

function createStepBox(title) {
  const box=document.createElement('div');
  box.className='step-box';
  const head=document.createElement('div');
  head.className='step-title';
  head.textContent=title;
  const line1=document.createElement('div');
  line1.className='step-line';
  const line2=document.createElement('div');
  line2.className='step-line';
  const line3=document.createElement('div');
  line3.className='step-sub';
  const line4=document.createElement('div');
  line4.className='step-sub';
  const foot=document.createElement('div');
  foot.className='step-footnote';
  box.append(head,line1,line2,line3,line4,foot);
  return {box,head,line1,line2,line3,line4,foot};
}

function setStepLine(elLine,prefix,strongTxt,suffix,toneClass='') {
  setClass(elLine,'step-line'+(toneClass?' '+toneClass:''));
  let pre=elLine._pre, str=elLine._str, suf=elLine._suf;
  if(!pre || !str || !suf) {
    elLine.textContent='';
    pre=document.createElement('span');
    str=document.createElement('strong');
    suf=document.createElement('span');
    elLine.append(pre,str,suf);
    elLine._pre=pre; elLine._str=str; elLine._suf=suf;
  }
  setText(pre,prefix||'');
  setText(str,strongTxt||'');
  setText(suf,suffix||'');
  setHidden(elLine,!prefix && !strongTxt && !suffix);
}

function createSchemeCard() {
  const card=document.createElement('article');
  card.className='scheme-card';
  card.dataset.rowKind='candidate';

  const head=document.createElement('header');
  head.className='scheme-head';
  const headLeft=document.createElement('div');
  headLeft.className='scheme-head-left';
  const tierPill=document.createElement('span');
  tierPill.className='tier-pill';
  const dirLabel=document.createElement('strong');
  dirLabel.className='scheme-dir';
  const verdictPill=document.createElement('span');
  verdictPill.className='verdict-pill verdict-muted';
  headLeft.append(tierPill,dirLabel,verdictPill);

  const headRight=document.createElement('div');
  headRight.className='scheme-head-right';
  const copyBtn=document.createElement('button');
  copyBtn.type='button';
  copyBtn.textContent='复制考核参数';
  const toggleBtn=document.createElement('button');
  toggleBtn.type='button';
  toggleBtn.className='detail-toggle-btn';
  toggleBtn.textContent='▸ 展开详情';
  headRight.append(copyBtn,toggleBtn);
  head.append(headLeft,headRight);

  const steps=document.createElement('div');
  steps.className='scheme-steps';
  const st1=createStepBox('① 考核怎么开');
  const st2=createStepBox('② 考核两种结果');
  const st3=createStepBox('③ Funded 怎么开');
  const st4=createStepBox('④ Funded 最终剩多少钱');
  steps.append(st1.box,st2.box,st3.box,st4.box);

  const drawer=document.createElement('div');
  drawer.className='card-detail-drawer';
  drawer.hidden=true;
  const detailPanel=document.createElement('div');
  detailPanel.className='detail-panel';
  const roadmapWrap=document.createElement('div');
  roadmapWrap.className='detail-roadmap';
  const multiWrap=document.createElement('div');
  multiWrap.className='multi-round-wrap';
  multiWrap.hidden=true;
  const detailBody=document.createElement('div');
  detailBody.className='detail-body';
  detailPanel.append(roadmapWrap,multiWrap,detailBody);
  drawer.append(detailPanel);

  card.append(head,steps,drawer);
  card._slots={tierPill,dirLabel,verdictPill,copyBtn,toggleBtn,st1,st2,st3,st4,drawer,roadmapWrap,multiWrap,detailBody};
  return card;
}

function patchRoadmapBanner(wrap,r,f,units,stage) {
  if(stage==='funded') {
    setHidden(wrap,true);
    return;
  }
  setHidden(wrap,false);
  while(wrap.children.length<3) {
    const step=document.createElement('div');
    step.className='roadmap-step';
    const head=document.createElement('b');
    head.className='roadmap-title';
    const desc=document.createElement('span');
    desc.className='roadmap-desc';
    step.append(head,desc);
    wrap.append(step);
  }
  const pfDir=dec(r.pf).gt(0)?'做多':'做空';
  const hlDir=dec(r.hl).gt(0)?'做多':'做空';
  const failR=r.repayment?.fail;
  const failTxt=failR
    ? (failR.recovered?'失败回本 '+amount(r.fail,2)+' U（净 '+signedNet(failR.net)+' U）':'失败回收 '+amount(r.fail,2)+' U（缺 '+amount(failR.gap,2)+' U）')
    : '失败回收 '+amount(r.fail,2)+' U';
  const s1=wrap.children[0];
  setText(s1.firstElementChild,'① 阶段一 · 考核阶段（PF '+pfDir+' '+out(dec(r.pf).abs())+' / Hype '+hlDir+' '+out(dec(r.hl).abs())+'）');
  setText(s1.lastElementChild,failTxt+' ｜ 若考核通过：Hype 实盘剩 '+amount(r.pass,2)+' U，尚待在 Funded 回收通关成本 '+amount(r.passCost,2)+' U。');

  const s2=wrap.children[1];
  const p=f?.position;
  if(p && f?.failRepayment && f?.repayment) {
    const fPfD=dec(p.pf).gt(0)?'多':'空';
    const fHlD=dec(p.hl).gt(0)?'多':dec(p.hl).lt(0)?'空':'平';
    const srVerdict=f.dualPositive?'单轮即可双端回本盈利':(f.wBounds?.code==='LOSS_SPACE_TOO_SMALL'?'单轮数学上无法同时回本 (C ≥ s×D)':'当前延续实盘不足以单轮双端回本');
    setText(s2.firstElementChild,'② 阶段二 · Funded 单轮（同仓位 PF '+fPfD+' '+out(dec(p.pf).abs())+' / Hype '+fHlD+' '+out(dec(p.hl).abs())+' · 比例 '+amount(dec(p.h).times(100),2)+'%）');
    setText(s2.lastElementChild,'止损结局净 '+signedNet(f.failRepayment.net)+' U（剩 '+amount(f.fundedFailCash,2)+' U）｜ 领取结局(W='+commas(f.w,0)+' U)净 '+signedNet(f.repayment.net)+' U（总资产 '+amount(f.totalCash,2)+' U）→ '+srVerdict+'。');
  } else {
    setText(s2.firstElementChild,'② 阶段二 · Funded 单轮');
    setText(s2.lastElementChild,f?.reason??'等待 Funded 规则或无可开单轮仓位。');
  }

  const s3=wrap.children[2];
  const mr=f?.multiRound;
  if(f?.dualPositive) {
    setText(s3.firstElementChild,'③ 阶段三 · Funded 多轮推演（无需多轮）');
    setText(s3.lastElementChild,'阶段二单轮同仓位在止损与领取两端均已覆盖通关成本并盈利，第 1 轮即可回本。');
  } else if(mr?.rounds?.length) {
    const r1Stop=mr.rounds[0]?.stopOutcome;
    const recTxt=mr.recoveredAtRound!=null
      ? '连续分批领取成功可在第 '+mr.recoveredAtRound+' 轮累计回本（'+mr.roundCount+' 轮后累计净利 '+signedNet(mr.finalCumulativeNetPnL)+' U，总资产 '+amount(mr.finalCumulativeAsset,2)+' U）'
      : '推演 '+mr.roundCount+' 轮尚未完全回本（累计净利 '+signedNet(mr.finalCumulativeNetPnL)+' U）';
    const riskTxt=r1Stop
      ? '⚠️ 首轮中途止损风险：若第 1 轮未达领取线而触发止损底线，Funded 账户终止，个人最终净 '+signedNet(r1Stop.finalNetPnL)+' U（剩 '+amount(r1Stop.personalTotalAsset,2)+' U）。'
      : '';
    setText(s3.firstElementChild,'③ 阶段三 · Funded 多轮分批领取推演（每轮按最新资金动态重算仓位与 W_k）');
    setText(s3.lastElementChild,recTxt+' ｜ '+riskTxt);
  } else {
    setText(s3.firstElementChild,'③ 阶段三 · Funded 多轮分批领取推演');
    setText(s3.lastElementChild,f?.reason??'当前条件下无法建立多轮领取路径。');
  }
}

function patchMultiRoundTable(wrap,f) {
  const mr=f?.multiRound;
  const rounds=mr?.rounds;
  if(!rounds?.length) {
    setHidden(wrap,true);
    return;
  }
  setHidden(wrap,false);
  let header=wrap.querySelector(':scope > .mr-head');
  let table=wrap.querySelector(':scope > .mr-scroll > table.multi-round-table');
  let notes=wrap.querySelector(':scope > .mr-notes');
  if(!header || !table || !notes) {
    wrap.textContent='';
    header=document.createElement('div');
    header.className='mr-head';
    const scroll=document.createElement('div');
    scroll.className='mr-scroll';
    table=document.createElement('table');
    table.className='multi-round-table';
    const thead=table.createTHead();
    const htr=thead.insertRow();
    for(const col of [
      '轮次 / 本轮起点资金',
      '①② 本轮双方开仓数量与实际比例',
      '③④ 达标 PF 价格与平仓后实际净盈亏',
      '⑤⑥⑦ 可领毛利 W / 个人分成 P / Hype平仓后剩余',
      '⑧⑨ 领取到账状态与下一轮实际可用资金',
      '⑩ 下一轮自动重新计算的双方仓位',
      '若本轮中途触发止损底线（终止）'
    ]) {
      const th=document.createElement('th');
      th.textContent=col;
      htr.append(th);
    }
    table.createTBody();
    scroll.append(table);
    notes=document.createElement('div');
    notes.className='mr-notes';
    wrap.append(header,scroll,notes);
  }

  const clsLabel=f.classification?.label ?? '多轮推演';
  const recTag=mr.recoveredAtRound!=null ? ' · 预计第 '+mr.recoveredAtRound+' 轮累计回本' : ' · 暂未在推演轮次内回本';
  const tFeeTag=mr.transferFeePerRound!=null ? ' · 单次转账费 T_k='+amount(mr.transferFeePerRound,2)+' U' : '';
  setText(header,'Funded 逐轮平仓与提现推演（'+clsLabel+recTag+tFeeTag+' · R16.2 双边先平仓归零再申请提现 · 固定底线 L = '+commas(f.fundedFloor,0)+' U）');

  const tbody=table.tBodies[0];
  while(tbody.rows.length>rounds.length) tbody.lastElementChild.remove();
  for(let idx=0;idx<rounds.length;idx++) {
    const rd=rounds[idx];
    let tr=tbody.rows[idx];
    if(!tr || tr.cells.length!==7) {
      if(tr) tr.remove();
      tr=tbody.insertRow(idx);
      for(let c=0;c<7;c++) tr.insertCell();
    }
    const pfP=rd.pfPosition, hlP=rd.hypePosition, st=rd.stopOutcome;
    const trigPriceTxt=rd.pfClaimTriggerPrice!=null
      ? 'PF '+commas(rd.pfClaimTriggerPrice,1)+(rd.pfClaimMovePct!=null?' ('+signedNet(rd.pfClaimMovePct)+'%)':'')
      : '目标净值 '+commas(rd.targetEquity,0)+' U';
    const hypeClosePrice=rd.closeSettlement?.hypeExitAvgPrice ?? rd.hypeMappedExitMark ?? null;
    const hypeCloseTxt=hypeClosePrice!=null ? ' · 对应 Hype 平仓价 '+commas(hypeClosePrice,1) : '';
    const flatBadge=rd.postClosePositions?.bothFlatConfirmed
      ? '平仓后持仓 0 / 0'
      : '待确认平仓';
    const hypePostCloseVal=rd.hypePostClose ?? rd.hypeBeforeTransfer;
    const cl=rd.claimLifecycle;
    const statusLabel=cl?.finalStatus==='settled_and_transferred_to_hype'
      ? '双边平仓0/0 → 申请 '+commas(rd.claimGross,2)+' U → 到账 +'+amount(rd.claimNetReceived,2)+' U (已转入Hype)'
      : cl?.finalStatus==='settled_in_vest_main'
        ? '双边平仓0/0 → 申请 '+commas(rd.claimGross,2)+' U → 到账 +'+amount(rd.claimNetReceived,2)+' U (留存Vest主账户)'
        : '双边平仓0/0 → 申请 '+commas(rd.claimGross,2)+' U → 到账 +'+amount(rd.claimNetReceived,2)+' U (外部钱包)';
    const nFunds=rd.nextRoundAvailableFunds;
    const nextFundsTxt=nFunds
      ? '下轮可用 Hype '+amount(nFunds.hypeActualEquity,2)+' U · PF '+commas(nFunds.pfAccountValue,0)+' U · 累计资产 '+amount(nFunds.personalCumulativeAsset,2)+' U（待回 '+amount(nFunds.unrecoveredPrincipal,2)+' U / 净 '+signedNet(nFunds.cumulativeNetPnL)+' U）'
      : '下轮可用 Hype '+amount(rd.hypeEquityEnd,2)+' U · 累计资产 '+amount(rd.personalTotalAsset,2)+' U（待回 '+amount(rd.unrecoveredCost,2)+' U / 净 '+signedNet(rd.cumulativeNetPnL)+' U）';
    const nxtP=rd.nextRoundPosition;
    const nextPosTxt=nxtP && nxtP.pfPosition && nxtP.hypePosition
      ? '第 '+nxtP.roundIndex+' 轮重算：PF '+nxtP.pfPosition.dir+' '+out(dec(nxtP.pfPosition.qty).abs())+' '+nxtP.pfPosition.unit+
        ' · Hype '+nxtP.hypePosition.dir+' '+out(dec(nxtP.hypePosition.qty).abs())+' '+nxtP.hypePosition.unit+
        ' · 比例 '+amount(dec(nxtP.hedgeRatio).times(100),2)+'% · W='+commas(nxtP.profitAtClaim,2)+' U'
      : (nxtP?.reason ?? '待下一轮到账后重算');

    setText(tr.cells[0],
      '第 '+rd.roundIndex+' 轮 · Hype起点 '+amount(rd.hypeEquityStart,2)+' U · PF '+commas(rd.pfEquityStart,0)+' / 底线 '+commas(rd.pfFixedFloor,0)+' U'
    );
    setText(tr.cells[1],
      'PF '+pfP.dir+' '+out(dec(pfP.qty).abs())+' '+pfP.unit+' · Hype '+hlP.dir+' '+out(dec(hlP.qty).abs())+' '+hlP.unit+
      ' · 实际比例 '+amount(dec(rd.hedgeRatio).times(100),2)+'% · '+hlP.leverage+'×'
    );
    setText(tr.cells[2],
      '达标 '+trigPriceTxt+hypeCloseTxt+' · 平仓净盈亏 PF +'+commas(rd.pfRealizedNetPnL ?? rd.claimGross,2)+' U / Hype '+signedNet(rd.hypeRealizedNetPnL ?? rd.hypePnL)+' U · '+flatBadge
    );
    const cushionPctTxt=rd.hypePostCloseRatioPct!=null ? '（余 '+amount(rd.hypePostCloseRatioPct,1)+'%）' : '';
    const roundRiskTag=[
      rd.extremeMoveWarning ? '⚠️极端波动' : '',
      rd.lowHypeCushionWarning ? '⚠️残余保证金过低' : ''
    ].filter(Boolean).join(' ');
    const roundFeeTxt=rd.transferFee && dec(rd.transferFee).gt(0) ? ' · 扣转账费 T_k=-'+amount(rd.transferFee,2)+' U' : '';
    setText(tr.cells[3],
      '毛利 W='+commas(rd.profitAtClaim,2)+' U · 分成 P=+'+amount(rd.claimNetReceived,2)+' U'+roundFeeTxt+' · Hype平仓后剩余 '+amount(hypePostCloseVal,2)+' U'+cushionPctTxt+(roundRiskTag?' · '+roundRiskTag:'（等待期0仓位/无强平）')
    );
    setText(tr.cells[4],
      statusLabel+' ｜ '+nextFundsTxt
    );
    tr.cells[4].className=dec(rd.cumulativeNetPnL).gt(0)?'mr-pos':dec(rd.unrecoveredCost).lte(0)?'mr-flat':'';
    setText(tr.cells[5],nextPosTxt);
    setText(tr.cells[6],
      '若本轮先止损：净 '+signedNet(st.finalNetPnL)+' U（Funded 终止 · 个人资产 '+amount(st.personalTotalAsset,2)+' U'+
      (dec(st.gapToBreakeven).gt(0)?' · 缺 '+amount(st.gapToBreakeven,2)+' U）':' · 已回本）')
    );
    tr.cells[6].className=st.strictProfit?'mr-pos':st.recovered?'mr-flat':'mr-neg';
  }

  const noteLines=[
    mr.priceBasisNote ?? '基准价口径：第 2 轮及后续轮次均以当前实时市价为基准并按相对涨跌幅（%）推演，便于横向对比各轮波动需求（非假设承接上一轮收盘价）。',
    'R16.2 流程：达标后先关闭 Vest 与 Hype 全部仓位并确认 0/0 → 结算 Hype_PostClose → 空仓申请领取 → 等待期双边0仓位/0维持保证金/待到账分成不计入Hype保证金 → 实际到账扣 T_k 后动态重算下一轮仓位（绝不复制上一轮）。'
  ];
  if(mr.stoppedReason) noteLines.push('终止原因：'+mr.stoppedReason);
  while(notes.children.length>noteLines.length) notes.lastElementChild.remove();
  for(let k=0;k<noteLines.length;k++) {
    let sm=notes.children[k];
    if(!sm) { sm=document.createElement('small'); notes.append(sm); }
    setText(sm,'· '+noteLines[k]);
  }
}

function patchDetailSections(container,sections) {
  const valid=sections.filter(s=>s.lines.length>0);
  while(container.children.length>valid.length) container.lastElementChild.remove();
  for(let i=0;i<valid.length;i++) {
    let sec=container.children[i];
    if(!sec) {
      sec=document.createElement('div');
      sec.className='detail-section';
      const titleEl=document.createElement('b');
      titleEl.className='detail-title';
      sec.append(titleEl);
      container.append(sec);
    }
    const {title,lines}=valid[i];
    setText(sec.firstElementChild,title);
    // Children 1..lines.length are <small> nodes
    while(sec.children.length>lines.length+1) sec.lastElementChild.remove();
    for(let k=0;k<lines.length;k++) {
      let lineEl=sec.children[k+1];
      if(!lineEl) {
        lineEl=document.createElement('small');
        sec.append(lineEl);
      }
      setText(lineEl,lines[k]);
    }
  }
}

let shown=null;
let currentCanAct=true;
let currentViewStage='challenge';
let currentSnapshotNotice=null;

function extractCollection(snapshot) {
  if(!snapshot) return null;
  if(snapshot.collection) {
    return {
      data:snapshot.collection,
      units:snapshot.marketUnits,
      book:snapshot.bookSummary
    };
  }
  const data=snapshot.ratioScan?.plans?.collection;
  if(!data) return null;
  return {
    data,
    units:snapshot.ratioScan.ctx.market,
    book:snapshot.ratioScan.ctx.book
  };
}

function compactFundedLegsSummary(f) {
  const p=f?.position;
  if(!p) return '';
  const pfD=dec(p.pf).gt(0)?'多':'空';
  const hlD=dec(p.hl).gt(0)?'多':dec(p.hl).lt(0)?'空':'平';
  const pfQty=out(dec(p.pf).abs());
  const hlQty=out(dec(p.hl).abs());
  const ratioPct=p.h!=null?amount(dec(p.h).times(100),2)+'%':'—';
  return 'PF '+pfD+' '+pfQty+' / Hype '+hlD+' '+hlQty+' ('+ratioPct+' · '+p.leverage+'×)';
}

// Never display an inverted W interval (wMin >= wMaxCash). Always explain lower bound, cash cap, gap between them & min real cash needed.
export function formatWBoundsLine(f) {
  const wb=f?.wBounds;
  if(!wb) return null;
  const inverted=wb.inverted===true || wb.feasible===false ||
    (wb.wMin!=null && wb.wMaxCash!=null && dec(wb.wMin).gte(wb.wMaxCash));
  if(inverted) {
    const parts=['W 区间：无可行区间'];
    const minReq=wb.floorW ?? wb.wMin;
    if(minReq!=null) parts.push('双端盈利最低 W > '+commas(minReq,2)+' U');
    if(wb.wMaxCash!=null) parts.push('当前资金（'+amount(f.carryCash,2)+' U）支持最高 W ≤ '+commas(wb.wMaxCash,2)+' U');
    const wGap=wb.wGap ?? (minReq!=null && wb.wMaxCash!=null && dec(minReq).gt(wb.wMaxCash) ? out(dec(minReq).minus(wb.wMaxCash)) : null);
    if(wGap!=null && dec(wGap).gt(0)) parts.push('两者缺口 '+commas(wGap,2)+' U');
    if(wb.hNeededMin!=null) {
      parts.push('双端盈利最低需实盘 '+commas(wb.hNeededMin,2)+' U'+(wb.cashShortfall && dec(wb.cashShortfall).gt(0)?'（实盘缺口 '+commas(wb.cashShortfall,2)+' U）':''));
    } else if(wb.cashShortfall && dec(wb.cashShortfall).gt(0)) {
      parts.push('差额 '+commas(wb.cashShortfall,2)+' U');
    }
    if(wb.limitCondition || wb.reason) parts.push('限制条件：'+(wb.limitCondition ?? wb.reason));
    return parts.join(' · ');
  }
  if(wb.wMin!=null && wb.wMaxCash!=null) {
    return 'W 无费理论搜索范围：('+commas(wb.wMin,2)+', '+commas(wb.wMaxCash,2)+') U（'+
      (wb.scopeNote??'允许重选仓位/比例，未计费用与维持保证金，不代表固定组合可执行')+'）';
  }
  return null;
}

function fundedStatusBadge(f) {
  const cls=f?.classification;
  if(!f || f.status==='unconfigured' || cls?.code==='unconfirmed_conditions') {
    const pill=f?.status==='invalid_target'?'目标无效':f?.status==='missing_total'?'缺总止损':'条件未确认';
    return {main:'条件未确认',pill,tone:'warn',sub:f?.reason??'Funded 规则待完善'};
  }
  if(cls?.code==='single_round_dual_profit' || f.dualPositive) {
    return {main:'一次双端盈利',pill:'一次领取双端盈利',tone:'ok',sub:'止损与出金两端均严格为正'};
  }
  if(cls?.code==='multi_round_profit_after_recovery') {
    const rN=f.multiRound?.recoveredAtRound;
    return {main:'多轮回本后盈利',pill:'回本后继续盈利可行',tone:'ok',sub:'条件推演 · 约 '+(rN??'?')+' 轮回本'};
  }
  if(cls?.code==='multi_round_recovery_feasible') {
    const rN=f.multiRound?.recoveredAtRound;
    return {main:'多轮累计回本',pill:'多轮累计回本可行',tone:'ok',sub:'条件推演 · 约 '+(rN??'?')+' 轮回本'};
  }
  if(cls?.code==='openable_not_profitable' || f.status==='openable_no_dual') {
    const isMathSpace=f.wBounds?.code==='LOSS_SPACE_TOO_SMALL';
    const gapTxt=f.wBounds?.hNeededMin && f.wBounds?.cashShortfall && dec(f.wBounds.cashShortfall).gt(0)
      ? '单轮双端需 '+amount(f.wBounds.hNeededMin,2)+' U（缺 '+amount(f.wBounds.cashShortfall,2)+' U）'
      : isMathSpace ? 'a×D_F ≤ 通关成本' : (f.dualBlockReason??'未满足盈利目标');
    return {main:'可开仓未达标',pill:'可开仓但不满足盈利目标',tone:'warn',sub:gapTxt};
  }
  if(cls?.code==='path_risk_failed') {
    const gapTxt=f.openShortfall && dec(f.openShortfall).gt(0)
      ? '路径保证金缺 '+amount(f.openShortfall,2)+' U'
      : (f.reason??'路径维持保证金未通过');
    return {main:'路径风险不通过',pill:'路径风险不通过',tone:'bad',sub:gapTxt};
  }
  if(cls?.code==='no_legal_position' || f.status==='cannot_open') {
    const gapTxt=f.openShortfall && dec(f.openShortfall).gt(0)
      ? '最小下单缺 '+amount(f.openShortfall,2)+' U'
      : (f.reason??'无合法仓位');
    return {main:'无合法仓位',pill:'无合法仓位',tone:'bad',sub:gapTxt};
  }
  return {main:'条件未确认',pill:'条件未确认',tone:'warn',sub:f.reason??'规则或数据未完整确认'};
}

function patchSchemeCard(card,group,snapshot,units,book,held,r,stage,viewStage) {
  const s=card._slots;
  if(card.dataset.key!==r.key) card.dataset.key=r.key;
  if(s.toggleBtn.dataset.toggleDetail!==r.key) s.toggleBtn.dataset.toggleDetail=r.key;
  const isExpanded=expandedDetails.has(r.key);
  setHidden(s.drawer,!isExpanded);
  const mrCount=r.funded?.multiRound?.rounds?.length ?? 0;
  setText(s.toggleBtn,isExpanded?'▾ 收起详情':(mrCount>0?'▸ 展开详情（'+mrCount+' 轮明细与单轮核查）':'▸ 展开详情'));

  const loss=r.lossBoundary;
  const f=r.funded;
  const plan=f?.primaryPlan ?? null;
  const pfLong=dec(r.pf).gt(0);
  const hlLong=dec(r.hl).gt(0);

  // Header: Pace Tier Pill + Direction + Unified Honest Verdict Pill + Copy Button
  const tier=r.paceTier ?? {code:'balanced',label:'实用方案'};
  setText(s.tierPill,tier.label);
  setClass(s.tierPill,'tier-pill tier-'+tier.code);
  setText(s.dirLabel,(stage==='funded'?'Funded · ':'考核 · ')+'PF '+(pfLong?'做多':'做空')+' / Hype '+(hlLong?'做多':'做空'));

  if(plan) {
    setText(s.verdictPill,plan.verdictLabel);
    setClass(s.verdictPill,'verdict-pill verdict-'+(plan.tone||'muted'));
  } else if(f) {
    const st=fundedStatusBadge(f);
    setText(s.verdictPill,f.failureCategory?.label ?? st.pill);
    setClass(s.verdictPill,'verdict-pill verdict-'+st.tone);
  } else {
    setText(s.verdictPill,'待核算 Funded');
    setClass(s.verdictPill,'verdict-pill verdict-muted');
  }

  const canCopy=r.status==='pass' && r.adjust.pf.remaining!=null && r.adjust.hl.remaining!=null;
  setHidden(s.copyBtn,!canCopy);
  if(canCopy) {
    if(s.copyBtn.dataset.copy!==r.key) s.copyBtn.dataset.copy=r.key;
    if(s.copyBtn.dataset.version!==snapshot.snapshotId) s.copyBtn.dataset.version=snapshot.snapshotId;
    s.copyBtn.dataset.stage=stage;
    s.copyBtn.disabled=!currentCanAct;
  }

  // ===== 步骤① 考核怎么开 =====
  setText(s.st1.head,stage==='funded'?'① 当前怎么开':'① 考核怎么开');
  setStepLine(s.st1.line1,'PF '+(pfLong?'做多':'做空'),out(dec(r.pf).abs())+' '+units.pf.unit,'（名义 '+commas(r.pfValue,0)+' U）');
  setStepLine(s.st1.line2,'Hype '+(hlLong?'做多':'做空'),out(dec(r.hl).abs())+' '+units.hl.unit,'（名义 '+commas(r.hypeValue,0)+' U）');
  const hlEff=r.hlEffectiveLev!=null ? amount(r.hlEffectiveLev,1)+'×' : '—';
  setText(s.st1.line3,'对冲比例 '+ratio(r)+' · Hype 有效杠杆 '+hlEff+(r.leverage?'（建议 '+r.leverage+'×）':''));
  if(held) {
    const ap=r.adjust.pf, ah=r.adjust.hl;
    setText(s.st1.line4,'调仓：PF '+ap.delta+' / Hype '+ah.delta);
    setHidden(s.st1.line4,false);
  } else {
    setHidden(s.st1.line4,true);
  }
  setText(s.st1.foot,'');
  setHidden(s.st1.foot,true);

  // ===== 步骤② 考核两种结果 =====
  setText(s.st2.head,stage==='funded'?'② 当前两种结果':'② 考核两种结果');
  const failR=r.repayment?.fail;
  const failTrig=shortLine(r,'fail');
  const passTrig=shortLine(r,'pass');
  if(loss?.caseCode==='E') {
    setStepLine(s.st2.line1,'失败结果','缺总止损','（请先填总止损）','outcome-neg');
  } else if(failR) {
    const fTone=failR.recovered?'outcome-pos':'outcome-neg';
    const fTag=failR.recovered ? '（保本 '+signedNet(failR.net)+' U）' : '（缺 '+amount(failR.gap,2)+' U）';
    setStepLine(s.st2.line1,'考核失败剩',amount(r.fail,2)+' U',fTag,fTone);
  } else {
    setStepLine(s.st2.line1,'考核失败剩',amount(r.fail,2)+' U','');
  }
  const passCostTxt=r.passCost!=null && dec(r.passCost).gt(0) ? '（待回本 '+amount(r.passCost,2)+' U）' : '（已回本）';
  setStepLine(s.st2.line2,'考核通过剩',amount(r.pass,2)+' U',stage==='challenge'?passCostTxt:'');
  setText(s.st2.line3,failTrig?'失败触发：'+failTrig:'');
  setHidden(s.st2.line3,!failTrig);
  setText(s.st2.line4,passTrig?'通过触发：'+passTrig:'');
  setHidden(s.st2.line4,!passTrig);
  setHidden(s.st2.foot,true);

  // ===== 步骤③ Funded 怎么开（统一主推荐路径，与步骤④ 100% 同仓位） =====
  setText(s.st3.head,'③ Funded 怎么开');
  if(plan && plan.pfPosition && plan.hypePosition) {
    const fp=plan.pfPosition, hp=plan.hypePosition;
    setStepLine(s.st3.line1,'PF '+fp.dir,out(dec(fp.qty).abs())+' '+fp.unit,'（名义 '+commas(fp.notional,0)+' U）');
    setStepLine(s.st3.line2,'Hype '+hp.dir,out(dec(hp.qty).abs())+' '+hp.unit,'（名义 '+commas(hp.notional,0)+' U）');
    setText(s.st3.line3,'比例 '+amount(dec(plan.hedgeRatio).times(100),2)+'% · Hype 杠杆 '+(hp.leverage??'—')+'×');
    const claimMv=plan.claimMovePct!=null ? (dec(plan.claimMovePct).gt(0)?'涨 +':'跌 ')+amount(plan.claimMovePct,2)+'%' : '—';
    const stopMv=plan.stopMovePct!=null ? (fp.dir==='做多'?'跌 -':'涨 +')+amount(plan.stopMovePct,2)+'%' : '—';
    setText(s.st3.line4,'本轮盈利需 '+claimMv+' ｜ 触发止损需 '+stopMv);
    setHidden(s.st3.line4,false);
    const riskNote=[
      plan.extremeMoveWarning ? '⚠️波动要求极端' : '',
      plan.lowHypeCushionWarning ? '⚠️Hype残余偏薄' : ''
    ].filter(Boolean).join(' · ');
    setText(s.st3.foot,riskNote || (plan.mode==='multi_round' && plan.totalRounds>1 ? '以上为第 1 轮开仓（后续轮次见展开详情）' : '单轮完整持仓'));
    setHidden(s.st3.foot,false);
  } else {
    const st=fundedStatusBadge(f);
    setStepLine(s.st3.line1,'状态',f?.failureCategory?.label ?? st.main,'','outcome-neg');
    setStepLine(s.st3.line2,'','','');
    setText(s.st3.line3,f?.reason ?? st.sub ?? '等待 Funded 规则确认');
    setHidden(s.st3.line4,true);
    setHidden(s.st3.foot,true);
  }

  // ===== 步骤④ Funded 最终剩多少钱 =====
  setText(s.st4.head,'④ Funded 最终剩多少钱');
  if(plan && plan.stopCash!=null && plan.firstClaimCash!=null) {
    const stopNetD=plan.stopNet!=null ? dec(plan.stopNet) : null;
    const stopTone=stopNetD && stopNetD.gte(0) ? 'outcome-pos' : 'outcome-neg';
    setStepLine(
      s.st4.line1,
      '若先止损剩',
      amount(plan.stopCash,2)+' U',
      stopNetD ? '（'+(stopNetD.gte(0)?'保本 +':'亏 ')+stopNetD.toFixed(2)+' U）' : '',
      stopTone
    );
    const c1NetD=plan.firstClaimNet!=null ? dec(plan.firstClaimNet) : null;
    const c1Tone=c1NetD && c1NetD.gte(0) ? 'outcome-pos' : '';
    const c1Suffix=c1NetD
      ? (c1NetD.gte(0) ? '（已回本，净赚 +'+c1NetD.toFixed(2)+' U）' : '（还差 '+c1NetD.abs().toFixed(2)+' U 回本）')
      : '';
    setStepLine(s.st4.line2,'领第 1 次剩',amount(plan.firstClaimCash,2)+' U',c1Suffix,c1Tone);

    if(plan.mode==='multi_round' && plan.totalRounds>1) {
      const recLine=plan.recoveredAtRound!=null
        ? (plan.recoveredAtRound===1
            ? '第 1 轮即回本；继续稳健领第 '+plan.totalRounds+' 轮 → 剩 '+amount(plan.finalCash,2)+' U（净赚 '+signedNet(plan.finalNet)+' U）'
            : '第 '+plan.recoveredAtRound+' 轮回本；继续领至第 '+plan.totalRounds+' 轮 → 剩 '+amount(plan.finalCash,2)+' U（净赚 '+signedNet(plan.finalNet)+' U）')
        : '推演 '+plan.totalRounds+' 轮剩 '+amount(plan.finalCash,2)+' U（尚未回本）';
      setText(s.st4.line3,recLine);
      setHidden(s.st4.line3,false);
      const lastStopTxt=plan.lastRoundStopCash!=null && plan.lastRoundStopNet!=null
        ? '第 '+plan.totalRounds+' 轮中途止损剩 '+amount(plan.lastRoundStopCash,2)+' U（'+(dec(plan.lastRoundStopNet).gte(0)?'已锁利 +':'净 ')+dec(plan.lastRoundStopNet).toFixed(2)+' U）'
        : '';
      setText(s.st4.line4,lastStopTxt);
      setHidden(s.st4.line4,!lastStopTxt);
    } else {
      setText(s.st4.line3,plan.mode==='single_round_dual' ? '1 轮即可在止损与领取两头都保本盈利' : '');
      setHidden(s.st4.line3,plan.mode!=='single_round_dual');
      setHidden(s.st4.line4,true);
    }
    setText(s.st4.foot,r.fundingIncluded ? '已含配置资金费' : '未计入未来资金费');
    setHidden(s.st4.foot,false);
  } else {
    const st=fundedStatusBadge(f);
    setStepLine(s.st4.line1,'结局',st.main,'','outcome-neg');
    setStepLine(s.st4.line2,'','','');
    setText(s.st4.line3,st.sub ?? '');
    setHidden(s.st4.line4,true);
    setText(s.st4.foot,'未计入未来资金费');
    setHidden(s.st4.foot,false);
  }

  // ===== Expandable Detail Drawer: Roadmap + R16.2 Multi-Round Table + Single-Round Audit & Fee/Margin Details =====
  const curLines=[];
  if(r.entryPrices) {
    curLines.push('参考入场价：PF 均价 '+commas(r.entryPrices.pfEntry,1)+'（Mark '+commas(r.entryPrices.pfMark,1)+
      '）｜ Hype 均价 '+commas(r.entryPrices.hlEntry,1)+'（Mark '+commas(r.entryPrices.hlMark,1)+'）');
  }
  if(r.lines?.fail || r.lines?.pass) {
    const lf=r.lines?.fail, lp=r.lines?.pass;
    const failPart=lf?'失败触发 PF '+commas(lf.mark,1)+' ('+signedNet(lf.percent)+'%) / Hype '+commas(lf.hlMark,1):'失败触发价待核';
    const passPart=lp?(stage==='funded'?'出金':'通过')+'平仓 PF '+commas(lp.mark,1)+' ('+signedNet(lp.percent)+'%) / Hype '+commas(lp.hlMark,1):'';
    curLines.push('双边触发与结算价：'+failPart+(passPart?' ｜ '+passPart:''));
  }
  const failCostLine=formatBranchCostLine(stage==='funded'?'止损费用':'失败费用',r.costs?.fail);
  const passCostLine=formatBranchCostLine(stage==='funded'?'出金费用':'通过费用',r.costs?.pass);
  if(failCostLine || passCostLine) {
    curLines.push([failCostLine,passCostLine].filter(Boolean).join(' ； '));
  }
  if(r.marginCondition) {
    const mc=r.marginCondition;
    const levRangeTxt=r.leverageRange?' · 全仓合法 '+r.leverageRange.min+'×–'+r.leverageRange.max+'×（代表 '+r.leverage+'×）':'';
    curLines.push('Hype 保证金与强平：初始 '+amount(mc.hlInitialMargin,2)+' U · 维持 '+amount(mc.hlMaintenance,2)+
      ' U · 路径最低余量 '+amount(mc.hlMinSurplus,2)+' U'+
      (mc.hlLiqMark?' · 强平价 '+commas(mc.hlLiqMark,1):'')+levRangeTxt);
  }
  if(loss?.notice) {
    curLines.push('止损与结算口径：'+loss.notice+' · 失败按实时标记权益触线，通过按主动平仓后净值达标。');
  }

  const sections=[{
    title:stage==='funded'?'本阶段核心明细':'考核阶段核心明细',
    lines:curLines
  }];

  if(f && f.status!=='unconfigured') {
    const fLines=[];
    if(stage==='challenge') {
      const cb=f.challengeBreakdown;
      const costBreak=cb && cb.registration!=null && cb.challengeHedgeCost!=null
        ? '（买号费 '+amount(cb.registration,2)+' + 考核对冲成本 '+amount(cb.challengeHedgeCost,2)+' U）'
        : '';
      const hrTxt=r.fundedHeadroom!=null ? ' · 理论空间余量(s×D−C) '+signedNet(r.fundedHeadroom)+' U' : '';
      fLines.push('承接资金与底线：Hype 延续 '+amount(f.carryCash,2)+' U · 待回收通关成本 '+amount(f.passCost,2)+' U'+costBreak+hrTxt+
        ' · Funded PF 起点 '+commas(f.fundedStart,0)+' U / 固定底线 '+(f.fundedFloor!=null?commas(f.fundedFloor,0)+' U':'未填'));
    }
    if(f.position) {
      const p=f.position;
      fLines.push('同仓位单轮诊断（'+(f.singleRoundId??'SR')+'）：PF '+p.pfDir+' '+out(dec(p.pf).abs())+' '+p.pfUnit+
        '（名义 '+commas(p.pfValue,0)+' U / 保 '+amount(p.initialMargin?.pf,0)+' U）｜ Hype '+
        p.hlDir+' '+out(dec(p.hl).abs())+' '+p.hlUnit+'（名义 '+commas(p.hypeValue,0)+' U / '+p.leverage+'× / 保 '+amount(p.initialMargin?.hl,0)+' U）｜ 比例 '+amount(dec(p.h).times(100),2)+'%');
    }
    if(f.failRepayment || f.repayment) {
      const stopPart=f.failRepayment
        ? '止损结局：实盘 '+amount(f.fundedFailCash,2)+' U（净 '+signedNet(f.failRepayment.net)+' U）'
        : '';
      const claimPart=f.repayment
        ? '领取结局（W='+commas(f.w,0)+' U / 分成 +'+amount(f.payout,2)+' U）：总资产 '+amount(f.totalCash,2)+' U（净 '+signedNet(f.repayment.net)+' U）'
        : '';
      fLines.push('单轮两结局（同仓位）：'+[stopPart,claimPart].filter(Boolean).join(' ｜ ')+(f.srHonestVerdict?' → '+f.srHonestVerdict:''));
    }
    const wBoundsLine=formatWBoundsLine(f);
    if(wBoundsLine) fLines.push(wBoundsLine);
    if(f.constraintsAudit) {
      const ca=f.constraintsAudit;
      const aTxt=ca.minOrder?.passed?'A 下单: 通过':'A 下单: '+(ca.minOrder?.note??'未通过');
      const bTxt=ca.stopCoverage?.minHedgeRatio!=null?'B 止损回本需比例 ≥ '+amount(dec(ca.stopCoverage.minHedgeRatio).times(100),2)+'%':'B 止损覆盖: '+(ca.stopCoverage?.note??'—');
      const cTxt=ca.payoutCoverage?.maxHedgeRatio!=null?'C 领取盈利需比例 ≤ '+amount(dec(ca.payoutCoverage.maxHedgeRatio).times(100),2)+'%':'C 领取覆盖: '+(ca.payoutCoverage?.note??'—');
      const dTxt=ca.pathMargin?.passed?'D 路径维持: 通过':'D 路径维持: '+(ca.pathMargin?.note??'未通过');
      fLines.push('单轮四层约束：'+[aTxt,bTxt,cTxt,dTxt].join(' ｜ '));
    }
    if((f.status==='openable_no_dual' || f.status==='cannot_open' || f.supported===false) && (f.dualBlockReason || f.reason)) {
      fLines.push('诊断说明：'+(f.dualBlockReason ?? f.reason));
    }
    sections.push({
      title:stage==='challenge'
        ? (f.isDiagnostic?'Funded 同仓位单轮诊断核查':'Funded 单轮核心明细（单轮双端盈利）')
        : 'Funded 单轮核心明细',
      lines:fLines
    });
  }

  patchRoadmapBanner(s.roadmapWrap,r,f,units,stage);
  patchMultiRoundTable(s.multiWrap,f);
  patchDetailSections(s.detailBody,sections);
}

// Reconcile scheme cards in-place by row.key (and migratedFromKey when lot integers shift slightly on live ticks)
// so SSE refreshes NEVER flicker, NEVER lose scroll/focus, and NEVER collapse open detail drawers!
function patchCardList(container,entries,emptyGroups,snapshot,units,book,held,stage,viewStage,migratedFromKey) {
  const existingByKey=new Map();
  const existingEmpty=[];
  for(let i=container.children.length-1;i>=0;i--) {
    const node=container.children[i];
    const kind=node.dataset?.rowKind;
    if(kind==='candidate' && node.dataset.key) {
      existingByKey.set(node.dataset.key,node);
    } else if(kind==='empty') {
      existingEmpty.push(node);
    } else {
      node.remove();
    }
  }

  if(migratedFromKey?.size) {
    for(const [newKey,oldKey] of migratedFromKey) {
      if(!existingByKey.has(newKey) && existingByKey.has(oldKey)) {
        const card=existingByKey.get(oldKey);
        existingByKey.delete(oldKey);
        card.dataset.key=newKey;
        existingByKey.set(newKey,card);
      }
    }
  }

  const desiredKeys=new Set(entries.map(e=>e.r.key));
  for(const [k,card] of existingByKey) {
    if(!desiredKeys.has(k)) {
      card.remove();
      existingByKey.delete(k);
    }
  }

  const orderedNodes=[];
  for(const entry of entries) {
    let card=existingByKey.get(entry.r.key);
    if(!card || !card._slots) {
      card=createSchemeCard();
      card.dataset.key=entry.r.key;
    }
    patchSchemeCard(card,entry.group,snapshot,units,book,held,entry.r,stage,viewStage);
    orderedNodes.push(card);
  }

  for(let k=0;k<emptyGroups.length;k++) {
    let div=existingEmpty[k];
    if(!div) {
      div=document.createElement('div');
      div.className='scheme-empty';
      div.dataset.rowKind='empty';
    }
    const g=emptyGroups[k];
    setText(div,(g.sign===1?'PF 做多 / Hype 做空':'PF 做空 / Hype 做多')+'：无可行仓位 · '+g.reason);
    orderedNodes.push(div);
  }
  for(let k=emptyGroups.length;k<existingEmpty.length;k++) existingEmpty[k].remove();

  for(let i=0;i<orderedNodes.length;i++) {
    const want=orderedNodes[i];
    const currentAtSlot=container.children[i]??null;
    if(currentAtSlot!==want) {
      container.insertBefore(want,currentAtSlot);
    }
  }
  while(container.children.length>orderedNodes.length) container.lastElementChild.remove();
}

function updateTableHeaders() {
  // Card layout uses explicit step headings directly inside each card.
}

function patchStatusBar(statusBox,chipsList,warnText) {
  let strip=statusBox.querySelector(':scope > .kpi-strip');
  if(!strip) {
    statusBox.textContent='';
    strip=document.createElement('div');
    strip.className='kpi-strip';
    statusBox.append(strip);
  }
  while(strip.children.length>chipsList.length) strip.lastElementChild.remove();
  for(let i=0;i<chipsList.length;i++) {
    let span=strip.children[i];
    if(!span) {
      span=document.createElement('span');
      strip.append(span);
    }
    setText(span,chipsList[i].text);
    setClass(span,'verdict-pill verdict-'+chipsList[i].tone);
  }
  let warnEl=statusBox.querySelector(':scope > .status-warn');
  if(warnText) {
    if(!warnEl) {
      warnEl=document.createElement('strong');
      warnEl.className='status-warn';
      statusBox.append(warnEl);
    }
    setText(warnEl,warnText);
  } else if(warnEl) {
    warnEl.remove();
  }
}

export function setCandidateActionable(canAct) {
  currentCanAct=Boolean(canAct);
  const grid=el('candidate-grid');
  if(!grid) return;
  for(const btn of grid.querySelectorAll('button[data-copy]')) {
    if(btn.disabled!==!currentCanAct) btn.disabled=!currentCanAct;
  }
}

export function setCandidateNotice(msg=null) {
  const next=msg || null;
  if(currentSnapshotNotice===next) return;
  currentSnapshotNotice=next;
  if(shown) {
    drawCandidateSet(shown,{viewStage:currentViewStage});
  } else {
    const statusBox=el('collection-status');
    if(statusBox && next) setText(statusBox,next);
  }
}

export function reprojectCandidateSet(viewStage) {
  currentViewStage=viewStage==='funded'?'funded':'challenge';
  if(shown) {
    drawCandidateSet(shown,{viewStage:currentViewStage});
  } else {
    updateTableHeaders('challenge',currentViewStage);
    const statusBox=el('collection-status');
    if(statusBox) {
      setText(
        statusBox,
        currentViewStage==='funded'
          ? '等待考核规划首份快照（若对应方案通过，各行将自动展示 Funded 后半段）'
          : '等待双边有效报价和资金规则'
      );
    }
  }
}

export function getShownCandidateSnapshot() {
  return shown;
}

export function drawCandidateSet(snapshot,options={}) {
  const previous=shown;
  if(options.viewStage==='challenge' || options.viewStage==='funded') {
    currentViewStage=options.viewStage;
  }
  const extracted=extractCollection(snapshot);
  const body=el('candidate-rows');
  const moreFold=el('more-candidates-fold');
  const moreBody=el('more-candidate-rows');
  const moreSummary=el('more-candidates-summary');
  const statusBox=el('collection-status');
  if(extracted?.data?.kind!=='joint') {
    if(!previous) {
      setText(statusBox,snapshot?'等待当前行情的联合求解结果':'等待双边有效报价和资金规则');
    }
    return;
  }
  shown=snapshot;
  const {data,units,book}=extracted;
  const stage=data.stage??'challenge';
  const viewStage=stage==='funded'?'funded':currentViewStage;
  const isFundedProj=stage==='challenge' && viewStage==='funded';
  const loss=data.lossBoundary;
  updateTableHeaders(stage,viewStage);

  const rows=data.groups.flatMap(g=>g.rows);
  const byKey=new Map();
  for(const group of data.groups) for(const r of group.rows) byKey.set(r.key,{group,r});

  // Migrate expanded detail keys across recalculations when lot counts (i, j) shift slightly
  const migratedFromKey=reconcileExpandedDetails(rows,byKey);

  const held=rows.some(r=>!dec(r.adjust.pf.current).isZero()||!dec(r.adjust.hl.current).isZero());
  const s=data.summary;

  const rankedKeys=data.rankedKeys??rows.map(r=>r.key);
  const baseFeatured=data.featuredKeys??rankedKeys.slice(0,6);
  const featuredKeys=[...baseFeatured];
  const featuredSet=new Set(featuredKeys);
  // Pin any expanded row that was opened in the top featured table so it never vanishes into the folded section while open!
  for(const [expKey,meta] of expandedDetails) {
    if(meta.inFeatured && byKey.has(expKey) && !featuredSet.has(expKey)) {
      const insertAt=Math.min(Math.max(0,meta.slotIndex),featuredKeys.length);
      featuredKeys.splice(insertAt,0,expKey);
      featuredSet.add(expKey);
    }
  }
  const restKeys=rankedKeys.filter(k=>!featuredSet.has(k));

  const chips=[];
  // 1. Stage & Candidate Count
  chips.push({
    text:(isFundedProj?'Funded 规划投影':stage==='funded'?'Funded 实际账户':'考核规划')+' · 首页 '+featuredKeys.length+' 组 / 共 '+rows.length+' 组',
    tone:'muted'
  });

  // 2. Effective Loss Floor & Space
  const activeLoss=isFundedProj ? (rows.find(r=>r.funded?.lossBoundary)?.funded?.lossBoundary ?? loss) : loss;
  if(activeLoss) {
    const srcTag=activeLoss.totalRule?.derivedFrom==='exam_target'?'[按目标推导] ':activeLoss.totalRule?.derivedFrom==='max_loss'?'[按亏损推导] ':'';
    const prefix=isFundedProj?'Funded ':'';
    chips.push(
      activeLoss.caseCode==='A' || activeLoss.caseCode==='B'
        ? {text:prefix+srcTag+'止损底线 '+commas(activeLoss.effectiveFloor,0)+' U（空间 '+commas(activeLoss.effectiveSpace,0)+' U）',tone:'muted'}
        : activeLoss.caseCode==='C'
          ? {text:prefix+srcTag+'止损 '+commas(activeLoss.effectiveFloor,0)+' U · 缺日限配置',tone:'warn'}
          : {text:prefix+'缺少总止损数据',tone:'bad'}
    );
  }

  // 3 & 4. High-signal Stage 1 / Stage 2 / Stage 3 feasibility counters
  if(data.opening && rows.length && data.principal!=null && s) {
    if(!isFundedProj && loss?.failureComplete) {
      chips.push({text:'阶段一 · 考核失败回本 '+s.failRecovered+'/'+s.total,tone:s.failRecovered>0?'ok':'bad'});
    }
    if(stage==='funded') {
      chips.push({text:'Funded 单轮双端盈利 '+s.dualPositive+'/'+s.total,tone:s.dualPositive>0?'ok':'warn'});
    } else {
      const dualCount=s.singleRoundDual??s.dualPositive??0;
      chips.push({text:'阶段二 · Funded 单轮双端盈利 '+dualCount+'/'+s.total,tone:dualCount>0?'ok':'warn'});
      const condMultiCount=(s.multiRoundProfit??0)+(s.multiRoundRecovery??0);
      if(condMultiCount>0) {
        chips.push({
          text:'阶段三 · 多轮条件回本 '+condMultiCount+'/'+s.total+'（首轮止损仍有亏损风险）',
          tone:dualCount>0?'ok':'warn'
        });
      } else if(s.noLegalPosition>0 || s.pathRiskFailed>0) {
        chips.push({
          text:'Funded 不可开/路径受限 '+((s.noLegalPosition??0)+(s.pathRiskFailed??0))+'/'+s.total,
          tone:'bad'
        });
      }
    }
  }

  let warnText=currentSnapshotNotice;
  if(!warnText) {
    if(loss && !loss.failureComplete) warnText=loss.notice;
    else if(stage==='funded' && data.fundedWBounds?.feasible===false) warnText=data.fundedWBounds.reason;
    else if(isFundedProj && rows.some(r=>r.funded?.status==='invalid_target')) {
      warnText=rows.find(r=>r.funded?.status==='invalid_target')?.funded?.reason??'Funded 出金目标字段无效';
    } else if(data.opening && rows.length && data.principal!=null && s?.failRecovered===0 && !isFundedProj) {
      warnText='无失败端回本方案（最小缺口 '+amount(s.bestFailShortfall,2)+' U），以下保留可开仓位与具体缺口。';
    }
  }

  patchStatusBar(statusBox,chips,warnText);

  const featuredEntries=featuredKeys.map(k=>byKey.get(k)).filter(Boolean);
  const emptyGroups=data.groups.filter(g=>!g.rows.length);
  patchCardList(body,featuredEntries,emptyGroups,snapshot,units,book,held,stage,viewStage,migratedFromKey);

  if(moreFold && moreBody && moreSummary) {
    if(restKeys.length) {
      const restEntries=restKeys.map(k=>byKey.get(k)).filter(Boolean);
      patchCardList(moreBody,restEntries,[],snapshot,units,book,held,stage,viewStage,migratedFromKey);
      setText(moreSummary,'全部其余候选（含极小仓参考，共 '+restEntries.length+' 组 · 点击展开）');
      setHidden(moreFold,false);
    } else {
      setHidden(moreFold,true);
    }
  }
}

export function buildCopyTextForRow(row,snapshot,units,stageKind) {
  const quoteStamp=snapshot.quoteTime || snapshot.quoteSnapshotId || '—';
  const calcStamp=snapshot.calculatedAt || snapshot.snapshotId || '—';
  if(stageKind==='funded_conditional') {
    const f=row.funded, p=f?.position;
    if(!p) return null;
    const pfLine='Funded PF '+p.pfDir+' '+out(dec(p.pf).abs())+' '+p.pfUnit+' · 名义 '+amount(p.pfValue,2)+' U · 保证金 '+amount(p.initialMargin?.pf,2)+' U · 有效 '+amount(p.pfEffectiveLev,2)+'×';
    const hlLine='Funded Hype '+p.hlDir+' '+out(dec(p.hl).abs())+' '+p.hlUnit+' · 名义 '+amount(p.hypeValue,2)+' U · 保证金 '+amount(p.initialMargin?.hl,2)+' U · 建议杠杆 '+p.leverage+'×';
    const sumLine='比例 '+amount(dec(p.h).times(100),2)+'% · W='+amount(f.w,2)+' U · 承接实盘 '+amount(f.carryCash,2)+' U · 通关成本 '+amount(f.passCost,2)+' U · 止损净利 '+signedNet(f.failRepayment?.net)+' U · 出金净利 '+signedNet(f.repayment?.net)+' U';
    const labelTag=f.isDiagnostic?'【Funded 诊断方案（可开仓但双端盈利不成立，非推荐）】':'【Funded 条件方案（若对应考核方案通过，非已成交）】';
    return labelTag+'来源候选 '+row.key+'\n'+pfLine+'\n'+hlLine+'\n'+sumLine+'\n行情 '+quoteStamp+' ('+snapshot.quoteSnapshotId+') / 结果 '+calcStamp+' ('+snapshot.snapshotId+')';
  }
  const header=stageKind==='funded'?'【Funded 实际账户】':'【考核阶段】';
  const legs=['pf','hl'].map(side=>positionText(row,side,units,true)+' · 待下单 '+row.adjust[side].remaining+
    ' '+units[side].unit+(side==='hl'?' · 建议杠杆 '+row.leverage+'×':'')).join('\n');
  return header+'候选 '+row.key+'\n'+legs+'\n行情 '+quoteStamp+' ('+snapshot.quoteSnapshotId+') / 结果 '+calcStamp+' ('+snapshot.snapshotId+')';
}

export function setupCandidateSet(refresh) {
  el('candidate-grid').onclick=async event=>{
    const toggleBtn=event.target.closest('button[data-toggle-detail]');
    if(toggleBtn) {
      const card=toggleBtn.closest('.scheme-card');
      const key=card?.dataset?.key || toggleBtn.dataset.toggleDetail;
      if(!key) return;
      const openNow=!expandedDetails.has(key);
      const extracted=extractCollection(shown);
      const row=extracted?.data?.groups.flatMap(x=>x.rows).find(r=>r.key===key);
      if(openNow) {
        const listEl=card?.parentElement;
        const inFeatured=listEl?.id==='candidate-rows';
        const cards=listEl?[...listEl.querySelectorAll('.scheme-card[data-row-kind="candidate"]')]:[];
        const slotIndex=Math.max(0,cards.indexOf(card));
        if(row) {
          expandedDetails.set(key,buildExpandedMeta(row,inFeatured,slotIndex));
        } else {
          expandedDetails.set(key,{key,sign:1,pf:0,hl:0,tagsKey:'',primaryTag:'',inFeatured,slotIndex});
        }
      } else {
        expandedDetails.delete(key);
      }
      const drawer=card?._slots?.drawer;
      if(drawer) setHidden(drawer,!openNow);
      const mrCount=row?.funded?.multiRound?.rounds?.length ?? 0;
      setText(toggleBtn,openNow?'▾ 收起详情':(mrCount>0?'▸ 展开详情（'+mrCount+' 轮明细与单轮核查）':'▸ 展开详情'));
      return;
    }
    const button=event.target.closest('button[data-copy]');
    if(!button || button.disabled)return;
    refresh();
    const extracted=extractCollection(shown);
    const row=extracted?.data?.groups.flatMap(x=>x.rows).find(r=>r.key===button.dataset.copy);
    if(!currentCanAct || el('current').dataset.stageClosed==='true'||shown?.snapshotId!==button.dataset.version||!row) {
      setText(el('collection-copy-status'),'当前为历史快照或已更新，请核对最新方案');return;
    }
    const stageKind=button.dataset.stage || (extracted.data.stage==='funded'?'funded':'challenge');
    if(stageKind!=='funded_conditional' && row.status!=='pass') {
      setText(el('collection-copy-status'),'当前为历史快照或已更新，请核对最新方案');return;
    }
    const text=buildCopyTextForRow(row,shown,extracted.units,stageKind);
    if(!text) {
      setText(el('collection-copy-status'),'该行暂无可复制的仓位参数');return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setText(el('collection-copy-status'),stageKind==='funded_conditional'?'已复制 Funded 条件方案双边参数':'已复制双边参数');
    } catch {
      setText(el('collection-copy-status'),'浏览器未授权复制，可直接读取双边数量');
    }
  };
}
