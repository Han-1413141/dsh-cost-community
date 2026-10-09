import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { prepareContribution, assertUploadAliases } from '../shared/privacy.js';
import { analyzeDataset, acceptanceSummary } from '../shared/analysis.js';
import { fingerprint } from '../server/fingerprint.js';
import { validateContribution } from '../server/validation.js';
import { createApp } from '../server/app.js';
import { fixture, body } from './fixtures.js';
import { MemoryTestStore } from './memory-store.js';

const newKey = () => webcrypto.subtle.generateKey({name:'HMAC',hash:'SHA-256',length:256},false,['sign']);
const workflowKey = await newKey();
function privateFixture() {
  const data=fixture();
  for(const row of [...data.quota_samples,...data.cost_periods]) { row.subject_kind='workflow';row.subject_id='internal-payroll-project'; }
  data.quota_samples[0].window_id='customer-acme-window';
  data.cost_periods[0].tasks.forEach((task,index)=>{task.task_id=`internal-ticket-${index}`;});
  return data;
}

test('隐私：原记录先校验，任务重复和窗口标签冲突不能靠随机别名绕过', async()=>{
  const duplicate=privateFixture();duplicate.cost_periods[0].tasks[1].task_id=duplicate.cost_periods[0].tasks[0].task_id;
  await assert.rejects(prepareContribution(duplicate,{workflowKey}),error=>error.code==='DUPLICATE');
  const conflict=privateFixture(),extra=structuredClone(conflict.quota_samples[0]);
  extra.window_start='2025-09-09T06:00:00Z';extra.window_end='2025-09-09T12:00:00Z';
  extra.before.observed_at='2025-09-09T08:00:00Z';extra.after.observed_at='2025-09-09T09:00:00Z';
  conflict.quota_samples.push(extra);
  await assert.rejects(prepareContribution(conflict,{workflowKey}),error=>error.code==='WINDOW_MISMATCH');
});

test('隐私：工作流别名同密钥稳定，任务/窗口随机且不改变指纹，不同工作流仍区分',async()=>{
  const source=privateFixture(),original=structuredClone(source);
  const first=await prepareContribution(source,{workflowKey}),again=await prepareContribution(source,{workflowKey});
  assert.deepEqual(source,original);
  for(const value of ['internal-payroll-project','customer-acme-window','internal-ticket-']) assert.equal(JSON.stringify(first).includes(value),false);
  assert.match(first.data.cost_periods[0].subject_id,/^wf-[A-Za-z0-9_-]{43}$/);
  assert.equal(first.data.cost_periods[0].subject_id,first.data.quota_samples[0].subject_id);
  assert.equal(first.data.cost_periods[0].subject_id,again.data.cost_periods[0].subject_id);
  assert.notEqual(first.data.cost_periods[0].tasks[0].task_id,again.data.cost_periods[0].tasks[0].task_id);
  assert.notEqual(first.data.quota_samples[0].window_id,again.data.quota_samples[0].window_id);
  assert.equal(fingerprint(first.data),fingerprint(again.data));
  const otherBrowser=await prepareContribution(source,{workflowKey:await newKey()});
  assert.notEqual(first.data.cost_periods[0].subject_id,otherBrowser.data.cost_periods[0].subject_id);
  const otherWorkflow=privateFixture();for(const row of [...otherWorkflow.quota_samples,...otherWorkflow.cost_periods])row.subject_id='different-workflow';
  assert.notEqual(fingerprint(first.data),fingerprint((await prepareContribution(otherWorkflow,{workflowKey})).data));
  assert.equal(workflowKey.extractable,false);
  await assert.rejects(webcrypto.subtle.exportKey('raw',workflowKey));
});

test('验收统计：脱敏不改变任务、重试与成本分母，零验收成本保持 null',async()=>{
  const source=privateFixture(),before=analyzeDataset(source),after=(await prepareContribution(source,{workflowKey})).analysis;
  const withoutSubject=value=>JSON.parse(JSON.stringify(value,(key,item)=>key==='subject_id'?undefined:item));
  assert.deepEqual(withoutSubject(after),withoutSubject(before));
  assert.deepEqual(acceptanceSummary(after.cost_results),{attempted_tasks:3,accepted_tasks:2,unaccepted_tasks:1,acceptance_rate:0.666667,total_attempts:5,failed_attempts:3,retry_attempts:2});
  assert.equal(after.cost_results[0].paid_cny_per_accepted_task,85);
  source.cost_periods[0].tasks.forEach(task=>{task.accepted=false;});
  const zero=(await prepareContribution(source,{workflowKey})).analysis;
  assert.equal(zero.cost_results[0].paid_cny_per_accepted_task,null);
  assert.equal(acceptanceSummary(zero.cost_results).unaccepted_tasks,3);
  assert.equal(acceptanceSummary(zero.cost_results).acceptance_rate,0);
  assert.equal(acceptanceSummary([...after.cost_results,...zero.cost_results]).acceptance_rate,0.333333);
});

test('上传边界：拒绝原标识，允许本地分析，发送的逐任务结构在服务端重算',async()=>{
  const raw=privateFixture();assert.equal(analyzeDataset(raw).totals.attempted_tasks,3);
  assert.throws(()=>validateContribution(body(raw)),error=>error.code==='LOCAL_ALIASES_REQUIRED');
  const prepared=await prepareContribution(raw,{workflowKey});
  assert.doesNotThrow(()=>assertUploadAliases(prepared.data));
  assert.equal(validateContribution(body(prepared.data)).cost_results[0].accepted_tasks,2);
  const taskRaw=structuredClone(prepared.data);taskRaw.cost_periods[0].tasks[0].task_id='private-ticket';
  assert.throws(()=>validateContribution(body(taskRaw)),error=>error.code==='LOCAL_ALIASES_REQUIRED');
  const workflowRaw=structuredClone(prepared.data);workflowRaw.cost_periods[0].subject_id='private-workflow';
  assert.throws(()=>validateContribution(body(workflowRaw)),error=>error.code==='LOCAL_ALIASES_REQUIRED');
});

test('隐私 API：返回实际保存摘要，任务记录不入库，重复导入被拒绝',async()=>{
  const store=new MemoryTestStore(),app=createApp({store,appOrigin:'http://localhost:3000',anonymizationSecret:'test-privacy-service-key-only'});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=async data=>{const response=await fetch(`${base}/api/contributions`,{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:JSON.stringify(body(data))});return {status:response.status,json:await response.json()};};
  try{
    const raw=privateFixture();raw.quota_samples[0].coverage='partial';
    assert.equal((await post(raw)).status,422);
    const prepared=await prepareContribution(raw,{workflowKey}),created=await post(prepared.data);
    assert.equal(created.status,201);assert.equal(created.json.summary.quota_results.length,0);
    assert.match(created.json.summary.cost_results[0].subject_id,/^workflow-[a-f0-9]{20}$/);
    assert.equal(created.json.summary.cost_results[0].accepted_tasks,2);
    const saved=[...store.records.values()][0];
    for(const sensitive of ['internal-payroll-project','internal-ticket-','task_id','window_id',prepared.data.cost_periods[0].subject_id,created.json.withdrawal_key])assert.equal(JSON.stringify(saved).includes(sensitive),false);
    const repeat=await prepareContribution(raw,{workflowKey});assert.equal((await post(repeat.data)).status,409);
    const receipt=created.json.receipt;
    const removed=await fetch(`${base}/api/contributions/${receipt.contribution_id}`,{method:'DELETE',headers:{Origin:'http://localhost:3000',Authorization:`Bearer ${receipt.withdrawal_key}`}});
    assert.equal(removed.status,200);assert.equal(store.records.size,0);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
