// Empirical intrawindow excursions. Each completed bar belongs to at most one
// sample. Do not bridge missing bars or use the current unfinished candle.
import {MAINNET} from './adapters.js';
const minute=60000;
const intervals=[['1h',60],['5m',5],['1m',1]];
function period(deadline,now) {
  const remaining=Date.parse(deadline)-now;
  const [interval,minutes]=intervals[remaining>=12*60*minute?0:remaining>=60*minute?1:2];
  const ms=minutes*minute;
  return {interval,ms,bars:Math.floor(remaining/ms),end:Math.floor(now/ms)*ms};
}
export function candleReference(raw,coin,p) {
  const {ms,bars,end,interval}=p;
  const byTime=new Map();
  for(const b of raw) {
    if(b.s!==coin || b.i!==interval || b.t%ms!==0 || b.T!==b.t+ms-1 || b.T>=end) continue;
    const [o,h,l,c]=[b.o,b.h,b.l,b.c].map(Number);
    if([o,h,l,c].every(v=>Number.isFinite(v)&&v>0) && l<=Math.min(o,c) && h>=Math.max(o,c)) byTime.set(b.t,{o,h,l});
  }
  if(!byTime.has(end-ms)) return {issue:'缺少最近一根已收盘的 '+coin+' '+interval+' K线'};
  const up=[],down=[];
  let first;
  for(let n=0;n<32;n++) {
    const start=end-(n+1)*bars*ms;
    let high=-Infinity,low=Infinity,open;
    for(let j=0;j<bars;j++) {
      const b=byTime.get(start+j*ms);
      if(!b) {open=null;break;}
      if(j===0) open=b.o;
      high=Math.max(high,b.h);low=Math.min(low,b.l);
    }
    if(!open) continue;
    first=start;up.push(100*(high/open-1));down.push(100*(1-low/open));
  }
  if(up.length<12) return {issue:coin+' 完整且不重叠的历史窗口不足 12 个（实得 '+up.length+'）'};
  const percentile=list=>list.sort((a,b)=>a-b)[Math.ceil(list.length*0.9)-1];
  return {coin,interval,windowMs:ms*bars,first,end,samples:up.length,source:'Hyperliquid '+coin+' 永续',
    method:'不重叠窗口开盘至最高／最低的幅度，各取第90百分位',up:percentile(up),down:percentile(down)};
}

// A reference read is independent of the live quote socket and cannot block a solve.
export function termReader() {
  const cache=new Map();
  return function read(coin,deadline,now=Date.now()) {
    if(!['BTC','ETH','SOL'].includes(coin)) return {issue:'缺少同标的永续K线映射'};
    const p=period(deadline,now);
    if(!Number.isFinite(p.bars)||p.bars<1) return {issue:'剩余期限不足一分钟或截止时间无效'};
    if(p.bars*12>4800) return {issue:'历史K线覆盖不足以组成 12 个完整期限窗口'};
    const key=[coin,p.interval,p.bars,p.end].join('/');
    const entry=cache.get(coin);
    if(entry?.key===key && now<entry.retry) return entry.value;
    const next={key,retry:Infinity,value:{issue:'正在读取 '+coin+' '+p.interval+' 已收盘K线'}};
    cache.set(coin,next);
    const count=Math.min(4800,32*p.bars);
    fetch(MAINNET,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(10000),
      body:JSON.stringify({type:'candleSnapshot',req:{coin,interval:p.interval,startTime:p.end-count*p.ms,endTime:p.end-1}})})
      .then(async response=>{
        if(!response.ok) throw Error('HTTP '+response.status);
        const raw=await response.json();
        if(!Array.isArray(raw)) throw Error('K线响应格式无效');
        next.value=candleReference(raw,coin,p);
        if(next.value.issue) next.retry=Date.now()+minute;
      }).catch(error=>{next.value={issue:coin+' '+p.interval+' K线读取失败（'+error.message+'）'};next.retry=Date.now()+minute;});
    return next.value;
  };
}

export function termFit(reference,pass,fail) {
  if(!reference || reference.issue || pass==null || fail==null) return null;
  const gap=p=>Math.abs(Number(p))-(Number(p)>=0?reference.up:reference.down);
  const passGap=gap(pass),failGap=gap(fail);
  return {passGap,failGap,rank:passGap<=0?(failGap<=0?0:1):2};
}
export function compareFit(a,b) {
  if(!a || !b) return a?-1:b?1:0;
  return a.rank-b.rank || Math.max(0,a.passGap)-Math.max(0,b.passGap) || Math.max(0,a.failGap)-Math.max(0,b.failGap);
}
