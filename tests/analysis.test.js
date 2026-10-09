import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDataset, communityFromRows, ValidationError } from '../shared/analysis.js';
import { fingerprint } from '../server/fingerprint.js';
import { fixture, tokenUsage } from './fixtures.js';
function bad(change, code) { const d = fixture(); change(d); assert.throws(() => analyzeDataset(d), e => e instanceof ValidationError && e.code === code); }
test('计算：额度百分点、目录等价值、净实付及失败任务分母', () => {
  const r = analyzeDataset(fixture()); assert.equal(r.quota_results[0].tokens_per_percentage_point, 100000); assert.equal(r.quota_results[0].api_equivalent_cny_per_percentage_point, .6);
  const p = r.cost_results[0]; assert.equal(p.net_paid_cny, 170); assert.equal(p.paid_cny_per_accepted_task, 85); assert.equal(p.attempted_tasks, 3); assert.equal(p.accepted_tasks, 2); assert.equal(p.failed_attempts, 3); assert.equal(p.retry_attempts, 2);
});
test('Token：明确包含关系，拒绝 reasoning 双计与未知语义', () => {
  bad(d => { d.quota_samples[0].after.token_usage.normalized_total_tokens += 1; }, 'TOKEN_TOTAL');
  bad(d => { d.cost_periods[0].tasks[0].token_usage.reasoning_in_output = null; }, 'TOKEN_SEMANTICS');
  const d = fixture(); const t = d.cost_periods[0].tasks[0].token_usage; t.reasoning_in_output = false; t.normalized_total_tokens += t.reasoning_tokens; analyzeDataset(d);
});
test('额度：拒绝零变化、回退、窗口外采样与重叠区间', () => {
  bad(d => { d.quota_samples[0].after.used_percent = 24; }, 'QUOTA_DELTA');
  bad(d => { d.quota_samples[0].after.api_equivalent_cny = 11; }, 'COUNTER_ROLLBACK');
  bad(d => { d.quota_samples[0].after.observed_at = d.quota_samples[0].window_end; }, 'WINDOW');
  bad(d => { d.quota_samples.push(structuredClone(d.quota_samples[0])); }, 'OVERLAPPING_SAMPLE');
});
test('额度：更换window_id且改变采样值，不能绕过同一实际窗口的重叠检查', () => {
  const d = fixture(), second = structuredClone(d.quota_samples[0]);
  second.window_id = 'renamed-overlapping-window';
  second.before = { observed_at: '2025-09-10T08:30:00Z', used_percent: 28, token_usage: tokenUsage(2800000), api_equivalent_cny: 14.4 };
  second.after = { observed_at: '2025-09-10T09:30:00Z', used_percent: 36, token_usage: tokenUsage(3600000), api_equivalent_cny: 19.2 };
  assert.notEqual(fingerprint(d.quota_samples[0]), fingerprint(second), '该回归不能依赖内容指纹相同而被挡住');
  d.quota_samples.push(second);
  assert.throws(() => analyzeDataset(d), e => e.code === 'OVERLAPPING_SAMPLE');
  second.window_id = d.quota_samples[0].window_id;
  second.window_end = '2025-09-10T13:00:00Z';
  assert.throws(() => analyzeDataset(d), e => e.code === 'WINDOW_MISMATCH', '仍保留相同窗口编号的起止一致性检查');
});
test('周期：缺失成本、未结束、重叠与退款越界均拒绝', () => {
  bad(d => { delete d.cost_periods[0].costs.subscription_cny; }, 'MISSING_FIELD');
  bad(d => { d.cost_periods[0].complete_period = false; }, 'INCOMPLETE_PERIOD');
  bad(d => { d.cost_periods[0].period_end = '2099-10-01T00:00:00Z'; }, 'FUTURE_PERIOD');
  bad(d => { d.cost_periods.push(structuredClone(d.cost_periods[0])); d.cost_periods[1].subject_id = 'another-model'; }, 'OVERLAPPING_PERIOD');
  bad(d => { d.cost_periods[0].costs.refund_cny = 10000; }, 'NEGATIVE_NET_COST');
});
test('结构：敏感字段拒绝，允许仅一种样本，零验收不除零', () => {
  for (const name of ['prompt','code','email','api_key','token']) bad(d => { d.cost_periods[0].tasks[0][name] = 'private'; }, 'UNKNOWN_FIELD');
  const q = fixture(); q.cost_periods = []; assert.equal(analyzeDataset(q).totals.cost_periods, 0);
  const p = fixture(); p.quota_samples = []; p.cost_periods[0].tasks.forEach(t => { t.accepted = false; }); assert.equal(analyzeDataset(p).cost_results[0].paid_cny_per_accepted_task, null);
});
test('去重指纹：字段顺序、任务改名和数组排序不能绕过', () => {
  const a = fixture(), b = fixture(); b.cost_periods[0].tasks.reverse().forEach((t,i) => { t.task_id = `renamed-${i}`; }); b.quota_samples[0].window_id = 'renamed-window';
  assert.equal(fingerprint(a), fingerprint(b));
});
test('聚合：5贡献门槛、加总比值、排除构造及不适格额度', () => {
  const records = Array.from({ length: 5 }, (_,i) => ({ id: `id-${i}`, dataset_kind: 'user_reported', summary: analyzeDataset(fixture(i)) }));
  assert.equal(communityFromRows(records.slice(0,4)).cost_groups[0].metrics, null);
  const all = communityFromRows(records); const costs = records.map(r => r.summary.cost_results[0]);
  assert.equal(all.cost_groups[0].metrics.paid_cny_per_accepted_task, Number((costs.reduce((s,c) => s+c.net_paid_cny,0) / costs.reduce((s,c) => s+c.accepted_tasks,0)).toFixed(6)));
  const demo = { ...records[0], id:'demo', dataset_kind:'synthetic' }; assert.equal(communityFromRows([demo]).totals.contributions, 0);
  const local = fixture(); local.cost_periods=[]; local.quota_samples[0].quota_source='local_estimate'; assert.equal(communityFromRows([{id:'local',dataset_kind:'user_reported',summary:analyzeDataset(local)}]).quota_groups.length,0);
});
