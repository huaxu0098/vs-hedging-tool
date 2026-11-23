// A recorded Evaluation outcome opens the Funded ledger independently of Hype settlement.
import {dec,out,max,positive,nonnegative,profitSplit} from './math.js';

export function investmentBasis(profile,planning) {
  const amount=planning?(profile.planCapital??profile.B):(profile.investedCapital||profile.B);
  if(amount==null || amount==='') return null;
  return out(nonnegative(amount).plus(nonnegative(profile.outsideCosts??'0')));
}

export function evaluationClose(profile, pf, hype, at, planning=profile.planCapital!=null) {
  if (profile.stage !== 'challenge' || profile.evaluationClose) return null;
  const equity=dec(pf), floor=nonnegative(profile.challengeFloor), target=positive(profile.challengeTarget);
  if (floor.gte(target)) return null;
  const status=equity.lte(floor)?'failed':equity.gte(target)?'passed':null;
  if (!status) return null;
  const cash=hype==null?null:out(dec(hype));
  return {status,at,pf:out(equity),payout:'0',hype:cash,personal:cash,
    investment:investmentBasis(profile,planning)};
}

export function closeEvaluation(profile, close) {
  if (profile.evaluationClose || !close) return profile;
  if (close.status==='failed') return {...profile,evaluationClose:close};
  if (close.status!=='passed') throw Error('缺少通过考核的结算记录');
  const start=out(positive(profile.resetBaseline ?? profile.baseline ?? profile.planPF ?? '10000'));
  return {...profile,stage:'funded',evaluationClose:close,planFundedCash:close.hype??'',
    fundedAccount:{initial:start,opening:start,equity:start,peak:start,rounds:[],failed:false}};
}

function riskFloor(profile, peak) {
  const fixed=profile.fundedFloor==='' || profile.fundedFloor==null ? null : nonnegative(profile.fundedFloor);
  const trailing=profile.fundedDrawdown ? dec(peak).minus(positive(profile.fundedDrawdown)) : null;
  return fixed==null?trailing:trailing==null?fixed:max(fixed,trailing);
}

export function fundedStatement(profile) {
  const f=profile.fundedAccount;
  if (profile.stage!=='funded' || !f) throw Error('需要先结算考核通过权益');
  const floor=riskFloor(profile,f.peak);
  const failed=f.failed || (floor!=null && dec(f.equity).lte(floor));
  const threshold=out(max(positive(profile.baseline),positive(f.opening)));
  const split=profitSplit(failed?threshold:f.equity,threshold,profile.share,{
    minimum:profile.minimumProfit||'0',fee:profile.withdrawalFee||'0',platformShare:profile.platformShare});
  const sum=key=>out(f.rounds.reduce((n,entry)=>n.plus(entry[key]),dec('0')));
  const userTotal=sum('user');
  return {...split,failed,floor:floor==null?null:out(floor),reset:out(positive(profile.resetBaseline)),
    userTotal,platformTotal:sum('platform'),personal:profile.evaluationClose.hype==null?null:out(dec(profile.evaluationClose.hype).plus(userTotal))};
}

export function observeFunded(profile, equity) {
  const f=profile.fundedAccount;
  if (fundedStatement(profile).failed) throw Error('Funded 已触及独立风险线');
  const next={...f,equity:out(nonnegative(equity)),peak:out(max(f.peak,equity))};
  next.failed=fundedStatement({...profile,fundedAccount:next}).failed;
  return next;
}

export function settleFunded(profile, at) {
  const f=profile.fundedAccount, s=fundedStatement(profile);
  if (s.failed || !dec(s.qualified).gt(0)) throw Error('本轮没有合格 Funded 利润');
  const round={at,opening:f.opening,equity:f.equity,qualified:s.qualified,user:s.user,platform:s.platform,reset:s.reset};
  // A distribution debits the account. Rebase its observed high-water mark by the same amount.
  const peak=out(max(s.reset,dec(f.peak).minus(f.equity).plus(s.reset)));
  return {...f,opening:s.reset,equity:s.reset,peak,rounds:[...f.rounds,round]};
}
