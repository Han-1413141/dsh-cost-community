import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { UnconfiguredStore } from '../server/store.js';
import { MemoryTestStore } from './memory-store.js';
import { fixture, body } from './fixtures.js';
async function withServer(options, fn) {
  const app = createApp({ appOrigin: 'http://localhost:3000', anonymizationSecret: 'test-only-secret-not-for-deployment', ...options });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options={}) => { const response = await fetch(base+url, options); return { status:response.status, json:await response.json() }; };
  const post = (data, options={}) => request('/api/contributions', { method:'POST', headers:{ Origin:'http://localhost:3000','Content-Type':'application/json',...options.headers }, body:JSON.stringify(data),...options });
  try { await fn({request,post,base}); } finally { await new Promise(resolve => server.close(resolve)); }
}
test('无数据库：不假存储，health降级，社区和合法上传503', async () => withServer({store:new UnconfiguredStore()}, async ({request,post}) => {
  assert.equal((await request('/api/health')).json.contributions_enabled,false); assert.equal((await request('/api/community')).status,503); assert.equal((await post(body(fixture()))).status,503);
}));
test('API安全边界：Origin、授权、构造数据、未知字段、JSON、大小限制', async () => withServer({store:new MemoryTestStore()}, async ({post,request}) => {
  assert.equal((await post(body(fixture()), {headers:{Origin:'https://elsewhere.invalid','Content-Type':'application/json'}})).status,403);
  assert.equal((await post({consent:{accepted:false,version:'2026-10-09'},data:fixture()})).status,403);
  assert.equal((await post(body(fixture(0,'synthetic')))).json.error.code,'SYNTHETIC_NOT_ALLOWED');
  const bad=fixture(); bad.cost_periods[0].tasks[0].prompt='not-for-upload'; assert.equal((await post(body(bad))).json.error.code,'UNKNOWN_FIELD');
  assert.equal((await request('/api/contributions',{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:'{'})).status,400);
  assert.equal((await post({padding:'x'.repeat(256*1024)})).status,413);
}));
test('贡献→去重→5份聚合→无效密钥→撤回，原始任务不入库', async () => {
  const store=new MemoryTestStore(); await withServer({store,trialExpiresAt:'2026-11-08T09:11:00Z'},async({request,post})=>{
    assert.equal((await request('/api/community')).json.totals.contributions,0);
    assert.equal((await request('/api/health')).json.trial.storage_expires_at,'2026-11-08T09:11:00Z');
    const receipts=[];
    for(let i=0;i<5;i++){const r=await post(body(fixture(i)));assert.equal(r.status,201);receipts.push(r.json.receipt);}
    assert.equal((await post(body(fixture()))).status,409);
    const saved=[...store.records.values()][0]; assert.ok(!JSON.stringify(saved.summary).includes('task_id')); assert.ok(!JSON.stringify(saved).includes(receipts[0].withdrawal_key));
    assert.equal((await request('/api/community')).json.cost_groups[0].published,true);
    const r=receipts[0]; assert.equal((await request(`/api/contributions/${r.contribution_id}`,{method:'DELETE',headers:{Origin:'http://localhost:3000',Authorization:`Bearer ${'x'.repeat(43)}`}})).status,404);
    assert.equal((await request(`/api/contributions/${r.contribution_id}`,{method:'DELETE',headers:{Origin:'http://localhost:3000',Authorization:`Bearer ${r.withdrawal_key}`}})).json.withdrawn,true);
    const after=(await request('/api/community')).json;assert.equal(after.totals.contributions,4);assert.equal(after.cost_groups[0].metrics,null);
  });
});
test('单条重复、非公开额度与工作流匿名化', async () => withServer({store:new MemoryTestStore()},async({post,request})=>{
  assert.equal((await post(body(fixture()))).status,201);
  const partial=fixture(1);partial.quota_samples=fixture().quota_samples;assert.equal((await post(body(partial))).status,409);
  const local=fixture(2);local.cost_periods=[];local.quota_samples[0].coverage='partial';assert.equal((await post(body(local))).json.error.code,'NO_COMMUNITY_ELIGIBLE_RECORDS');
  const workflow=fixture(3);workflow.quota_samples=[];workflow.cost_periods[0].subject_kind='workflow';workflow.cost_periods[0].subject_id='private-project-name';
  const created=await post(body(workflow));assert.equal(created.status,201);assert.ok(created.json.summary.cost_results[0].subject_id.startsWith('workflow-'));assert.ok(!JSON.stringify((await request('/api/community')).json).includes('private-project-name'));
}));
test('基础限流有明确429响应', async () => withServer({store:new MemoryTestStore(),writeLimit:1},async({post})=>{
  assert.equal((await post(body(fixture()))).status,201);assert.equal((await post(body(fixture(1)))).status,429);
}));
