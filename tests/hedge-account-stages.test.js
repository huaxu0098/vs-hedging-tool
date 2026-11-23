import test from 'node:test';
import assert from 'node:assert/strict';
import {rules} from '../src/hedge/current.js';
import {evaluationClose,closeEvaluation,observeFunded,settleFunded,fundedStatement} from '../src/hedge/account-stages.js';
import {projectedShare} from '../src/hedge/math.js';

const at='2026-11-21T09:00:00Z';
const passed=()=>closeEvaluation(rules,evaluationClose(rules,'12000','101.25',at));
test('Evaluation 10000 → 12000 的 2000 盈利留在考核，失败于 9400 只回收 Hype',()=>{
  assert.equal(evaluationClose(rules,'10000','409',at),null);
  const old={...rules,withdrawal:{onPass:true}};
  assert.equal(projectedShare('12000',old,'12000','net_settlement'),'0');
  const p=passed();
  assert.deepEqual([p.evaluationClose.personal,p.evaluationClose.payout,p.fundedAccount.initial,p.fundedAccount.equity],['101.25','0','10000','10000']);
  assert.deepEqual([fundedStatement(p).qualified,fundedStatement(p).platform,fundedStatement(p).user],['0','0','0']);
  const fail=closeEvaluation(rules,evaluationClose(rules,'9400','501.15',at));
  assert.equal(fail.evaluationClose.personal,'501.15');assert.equal(fail.evaluationClose.payout,'0');assert.equal(fail.fundedAccount,undefined);
});
test('Funded 10100 结算 80/20，重置后不能重计，多轮累计与 Evaluation 独立',()=>{
  const p=passed();
  p.fundedAccount=observeFunded(p,'10100');
  const s=fundedStatement(p);
  assert.deepEqual([s.qualified,s.user,s.platform,s.reset,s.userTotal],['100','80','20','10000','0']);
  p.fundedAccount=settleFunded(p,at);
  assert.equal(p.fundedAccount.equity,'10000');assert.throws(()=>settleFunded(p,at));
  p.fundedAccount=observeFunded(p,'10200');p.fundedAccount=settleFunded(p,at);
  assert.deepEqual([fundedStatement(p).userTotal,fundedStatement(p).platformTotal,fundedStatement(p).personal],
    ['240','60','341.25']);
  assert.equal(p.evaluationClose.personal,'101.25');
});
test('Funded 爆号线、回撤、费用、门槛与考核条件独立',()=>{
  const p={...passed(),fundedFloor:'8000',fundedDrawdown:'',withdrawalFee:'5',minimumProfit:'101'};
  p.fundedAccount=observeFunded(p,'9400');assert.equal(fundedStatement(p).failed,false);
  p.fundedAccount=observeFunded(p,'10100');assert.equal(fundedStatement(p).qualified,'0');
  p.minimumProfit='100'; assert.equal(fundedStatement(p).user,'76');
  p.fundedDrawdown='125';p.fundedAccount=observeFunded(p,'9975');
  assert.equal(fundedStatement(p).failed,true);assert.throws(()=>observeFunded(p,'10200'));
  assert.throws(()=>settleFunded(p,at));
});
