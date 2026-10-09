// Constructed test records. This module is never served or imported by production.
import { CONSENT_VERSION } from '../shared/analysis.js';
export function tokenUsage(total) {
  const input = Math.floor(total * .8), output = total - input;
  return { token_semantics: 'input_includes_cache', reasoning_in_output: true, input_tokens: input, output_tokens: output, cache_read_tokens: Math.floor(input / 4), cache_write_tokens: 0, reasoning_tokens: Math.floor(output / 3), normalized_total_tokens: total };
}
export function fixture(seed = 0, kind = 'user_reported') {
  const day = String(10 + seed).padStart(2, '0');
  return {
    schema_version: '2.0', dataset_kind: kind, currency: 'CNY',
    quota_samples: [{ provider_id: 'test-provider', plan_id: 'test-plan', subject_kind: 'model', subject_id: 'test-model', quota_pool_id: 'six-hour', window_id: `window-${seed}`, window_start: `2025-09-${day}T06:00:00Z`, window_end: `2025-09-${day}T12:00:00Z`, price_snapshot_id: 'test-price-v1', quota_source: 'user_snapshot', window_type: 'fixed_reset', coverage: 'complete', before: { observed_at: `2025-09-${day}T08:00:00Z`, used_percent: 24, token_usage: tokenUsage(2400000), api_equivalent_cny: 12 }, after: { observed_at: `2025-09-${day}T09:00:00Z`, used_percent: 32 + seed, token_usage: tokenUsage(3200000 + seed * 150000), api_equivalent_cny: 16.8 + seed } }],
    cost_periods: [{ provider_id: 'test-provider', plan_id: 'test-plan', subject_kind: 'model', subject_id: 'test-model', period_start: '2025-09-01T00:00:00Z', period_end: '2025-10-01T00:00:00Z', complete_period: true, all_attempted_tasks_included: true, task_type: 'bugfix', difficulty: 'medium', acceptance_standard: 'test_suite_passed', payment_category: 'standard', costs: { subscription_cny: 159 + seed * 7, overage_cny: 21, other_api_cny: 0, refund_cny: 10 }, tasks: [0,1,2].map(i => ({ task_id: `task-${i}`, attempt_count: i === 0 ? 1 : 2, accepted: i < 2 + (seed % 2), human_minutes: 5 + i * 5, token_usage: tokenUsage(100000 + seed * 1000), api_equivalent_cny: 1 + seed / 10 })) }]
  };
}
export const body = data => ({ consent: { accepted: true, version: CONSENT_VERSION }, data });
