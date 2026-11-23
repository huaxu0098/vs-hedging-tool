import test from 'node:test';
import assert from 'node:assert/strict';
import {examTimestamp,localExamInput,initializeExam,examSchedule} from '../src/hedge/exam-clock.js';

test('考核时钟兼容 UTC、本地输入、秒及毫秒，刷新保留相同截止时刻',()=>{
  const start=Date.parse('2026-11-21T08:10:00+08:00');
  for(const input of [start,start/1000,String(start),'2026-11-21T08:10:00.000000000+0800',String(start/1000)+'.000',new Date(start).toISOString(),localExamInput(start)]) {
    const p={challengeStart:input};initializeExam(p,start);
    assert.equal(Date.parse(p.challengeStart),start);
    assert.equal(Date.parse(p.deadline)-start,48*3600000);
    const copy=JSON.parse(JSON.stringify(p));initializeExam(copy,start+3600000);
    assert.deepEqual(copy,p);
  }
  const p={};initializeExam(p,start);assert.equal(examSchedule(p,start).issue,undefined);
  for(const [field,pattern] of [['challengeStart',/开始/],['deadline',/截止/]]) {
    for(const bad of ['', '2026-02-30T10:00','bad']) {
      const profile={...p,[field]:bad};initializeExam(profile,start);
      assert.match(examSchedule(profile,start).issue,pattern);
    }
  }
  for (const key of ['deadline','challengeStart']) {
    const legacy={...p}; delete legacy[key]; initializeExam(legacy,start);
    assert.equal(legacy[key],p[key]);
  }
  assert.match(examSchedule({...p,deadline:p.challengeStart},start).issue,/截止时间必须晚于/);
  assert.ok(Number.isNaN(examTimestamp('2026-13-40T08:10')));
});
