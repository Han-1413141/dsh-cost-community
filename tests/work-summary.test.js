import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeDataset, communityFromRows, hasWorkSummaries, summarizeWorkSummaries, CONSENT_VERSION } from '../shared/analysis.js';
import { prepareContribution } from '../shared/privacy.js';
import { fingerprint, recordFingerprints } from '../server/fingerprint.js';
import { validateContribution } from '../server/validation.js';
import { createApp } from '../server/app.js';
import { MemoryTestStore } from './memory-store.js';
import { fixture, body } from './fixtures.js';

function describedFixture(seed=0) {
  const data=fixture(seed);data.quota_samples=[];
  data.cost_periods[0].tasks[0].work_summary={function_category:'api',code_change_band:'51_200',difficulty:'medium'};
  data.cost_periods[0].tasks[2].work_summary={function_category:'testing',code_change_band:'201_500',difficulty:'medium'};
  return data;
}
function reviewed(data) { const request=body(data);request.consent.work_summary_reviewed=true;return request; }

test('工作摘要：可选字段兼容旧数据，只按不同任务计摘要，原成本与验收分母不变',()=>{
  const legacy=fixture(),old=analyzeDataset(legacy),described=analyzeDataset(describedFixture());
  assert.equal(hasWorkSummaries(legacy),false);assert.equal(hasWorkSummaries(describedFixture()),true);
  assert.equal(old.cost_results[0].work_summary_counts.summarized_tasks,0);
  const row=described.cost_results[0],counts=row.work_summary_counts;
  assert.equal(counts.summarized_tasks,2);assert.equal(counts.function_category.api,1);assert.equal(counts.function_category.testing,1);
  assert.equal(counts.code_change_band['51_200'],1);assert.equal(counts.code_change_band['201_500'],1);assert.equal(counts.difficulty.medium,2);
  assert.equal(row.attempted_tasks,3);assert.equal(row.total_attempts,5);assert.equal(row.retry_attempts,2);assert.equal(row.accepted_tasks,2);
  assert.equal(row.net_paid_cny,170);assert.equal(row.paid_cny_per_accepted_task,85);
  const actualLegacy={...old.cost_results[0]};delete actualLegacy.work_summary_counts;
  assert.equal(summarizeWorkSummaries([actualLegacy,row]).summarized_tasks,2);
  const demo=JSON.parse(readFileSync(new URL('../public/samples/work-summary.json',import.meta.url),'utf8'));
  assert.equal(demo.dataset_kind,'synthetic');assert.ok(summarizeWorkSummaries(analyzeDataset(demo).cost_results).summarized_tasks>0);
});

test('工作摘要：共享校验与 Ajv 都拒绝自由文本、具体行数、路径和非法枚举',async()=>{
  const prepared=(await prepareContribution(describedFixture())).data;
  for(const field of ['description','business_name','code','path','file_name','line_count','raw_lines']){
    const data=structuredClone(prepared);data.cost_periods[0].tasks[0].work_summary[field]=field==='line_count'?37:'private-content';
    assert.throws(()=>analyzeDataset(data),error=>error.code==='UNKNOWN_FIELD');
    assert.throws(()=>validateContribution(reviewed(data)),error=>error.code==='UNKNOWN_FIELD');
  }
  for(const [field,value] of [['function_category','payroll-business'],['code_change_band',37],['code_change_band','37'],['difficulty','very_hard']]){
    const data=structuredClone(prepared);data.cost_periods[0].tasks[0].work_summary[field]=value;
    assert.throws(()=>analyzeDataset(data),error=>error.code==='ENUM');
    assert.throws(()=>validateContribution(reviewed(data)),error=>error.code==='SCHEMA');
  }
  const mismatch=structuredClone(prepared);mismatch.cost_periods[0].tasks[0].work_summary.difficulty='simple';
  assert.throws(()=>analyzeDataset(mismatch),error=>error.code==='WORK_SUMMARY_DIFFICULTY');
  assert.throws(()=>validateContribution(reviewed(mismatch)),error=>error.code==='WORK_SUMMARY_DIFFICULTY');
  for(const value of [null,{},[]]){
    const data=structuredClone(prepared);data.cost_periods[0].tasks[0].work_summary=value;
    assert.throws(()=>analyzeDataset(data));assert.throws(()=>validateContribution(reviewed(data)));
  }
});

test('工作摘要：保持别名脱敏且必须确认当前摘要，旧文件使用新授权仍可贡献',async()=>{
  const raw=describedFixture(),prepared=await prepareContribution(raw);
  assert.deepEqual(prepared.data.cost_periods[0].tasks[0].work_summary,raw.cost_periods[0].tasks[0].work_summary);
  assert.equal(JSON.stringify(prepared.data).includes('"task-0"'),false);
  for(const reviewedFlag of [undefined,false]){
    const request=body(prepared.data);if(reviewedFlag!==undefined)request.consent.work_summary_reviewed=reviewedFlag;
    assert.throws(()=>validateContribution(request),error=>error.code==='WORK_SUMMARY_REVIEW_REQUIRED');
  }
  assert.equal(validateContribution(reviewed(prepared.data)).cost_results[0].work_summary_counts.summarized_tasks,2);
  const wrongType=reviewed(prepared.data);wrongType.consent.work_summary_reviewed='true';
  assert.throws(()=>validateContribution(wrongType),error=>error.code==='CONSENT_REQUIRED');
  const oldVersion=reviewed(prepared.data);oldVersion.consent.version='2026-10-09-privacy-1';
  assert.throws(()=>validateContribution(oldVersion),error=>error.code==='CONSENT_REQUIRED');
  assert.equal(CONSENT_VERSION,'2026-10-09-work-summary-1');
  assert.equal(validateContribution(body((await prepareContribution(fixture(1))).data)).cost_results[0].work_summary_counts.summarized_tasks,0);
});

test('工作摘要：内容指纹包含摘要，记录唯一指纹防止改摘要重灌并兼容旧指纹',()=>{
  const old=fixture();old.quota_samples=[];const original=describedFixture(),changed=structuredClone(original);
  changed.cost_periods[0].tasks[0].work_summary.function_category='integration';
  assert.notEqual(fingerprint(original),fingerprint(changed));
  assert.deepEqual(recordFingerprints(original).cost,recordFingerprints(changed).cost);
  assert.equal(recordFingerprints(original).cost[0],fingerprint(old.cost_periods[0]));
  const duplicateTask=describedFixture();duplicateTask.cost_periods[0].tasks[2].task_id=duplicateTask.cost_periods[0].tasks[0].task_id;
  assert.throws(()=>analyzeDataset(duplicateTask),error=>error.code==='DUPLICATE');
  const duplicatePeriod=describedFixture();duplicatePeriod.cost_periods.push(structuredClone(changed.cost_periods[0]));
  assert.throws(()=>analyzeDataset(duplicatePeriod),error=>error.code==='OVERLAPPING_PERIOD');
  const genuinelyDifferent=describedFixture(1);assert.notEqual(recordFingerprints(original).cost[0],recordFingerprints(genuinelyDifferent).cost[0]);
});

test('工作摘要：公开分布只在5份含摘要贡献后返回，旧行不泄露少量新摘要',()=>{
  const contributions=Array.from({length:5},(_,index)=>({id:`test-${index}`,dataset_kind:'user_reported',summary:analyzeDataset(index===0?describedFixture(index):fixture(index))}));
  for(const item of contributions.slice(1))delete item.summary.cost_results[0].work_summary_counts;
  const group=communityFromRows(contributions).cost_groups[0];
  assert.equal(group.published,true);assert.equal(group.metrics.work_summary_contribution_count,1);assert.equal(group.metrics.work_summary_counts,null);
  contributions.forEach((item,index)=>{item.summary=analyzeDataset(describedFixture(index));});
  assert.equal(communityFromRows(contributions.slice(0,4)).cost_groups[0].metrics,null);
  const published=communityFromRows(contributions).cost_groups[0].metrics;
  assert.equal(published.work_summary_contribution_count,5);assert.equal(published.work_summary_counts.summarized_tasks,10);
  assert.equal(published.work_summary_counts.function_category.api,5);assert.equal(published.work_summary_counts.function_category.testing,5);
  assert.equal(published.work_summary_counts.difficulty.medium,10);
  assert.equal(published.paid_cny_per_accepted_task,Number((published.net_paid_cny/published.accepted_tasks).toFixed(6)));
});

test('工作摘要 API：确认闸门、仅计数入库、改摘要409、旧数据兼容与撤回',async()=>{
  const store=new MemoryTestStore(),app=createApp({store,appOrigin:'http://localhost:3000',anonymizationSecret:'isolated-work-summary-only-key'});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=async payload=>{const response=await fetch(`${base}/api/contributions`,{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:JSON.stringify(payload)});return {status:response.status,json:await response.json()};};
  try{
    const raw=describedFixture(),prepared=(await prepareContribution(raw)).data;
    const unreviewed=await post(body(prepared));assert.equal(unreviewed.status,403);assert.equal(unreviewed.json.error.code,'WORK_SUMMARY_REVIEW_REQUIRED');assert.equal(store.records.size,0);
    const created=await post(reviewed(prepared));assert.equal(created.status,201);assert.equal(created.json.summary.cost_results[0].work_summary_counts.summarized_tasks,2);
    const saved=[...store.records.values()][0];assert.ok(saved.summary.cost_results[0].work_summary_counts);assert.equal(saved.consentVersion,CONSENT_VERSION);
    for(const denied of ['"tasks":','"work_summary":','"task_id":','"line_count":'])assert.equal(JSON.stringify(saved).includes(denied),false);
    const changed=structuredClone(raw);changed.cost_periods[0].tasks[0].work_summary.function_category='automation';
    assert.equal((await post(reviewed((await prepareContribution(changed)).data))).status,409);
    raw.cost_periods[0].tasks.forEach(task=>{delete task.work_summary;});assert.equal((await post(body((await prepareContribution(raw)).data))).status,409);
    const old=fixture(1);old.quota_samples=[];assert.equal((await post(body((await prepareContribution(old)).data))).status,201);
    const synthetic=describedFixture(2);synthetic.dataset_kind='synthetic';assert.equal((await post(reviewed((await prepareContribution(synthetic)).data))).json.error.code,'SYNTHETIC_NOT_ALLOWED');
    const receipt=created.json.receipt;
    const removed=await fetch(`${base}/api/contributions/${receipt.contribution_id}`,{method:'DELETE',headers:{Origin:'http://localhost:3000',Authorization:`Bearer ${receipt.withdrawal_key}`}});
    assert.equal(removed.status,200);assert.equal(store.records.size,1);assert.equal((await store.community()).cost_groups[0].metrics,null);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
