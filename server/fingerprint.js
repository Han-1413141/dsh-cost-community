import { createHash } from 'node:crypto';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter(key => !['task_id', 'window_id', 'dataset_kind'].includes(key)).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function fingerprint(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
export function recordFingerprints(data) {
  // Full content fingerprints retain the summary. Record uniqueness instead uses
  // the original statistical facts, so adding/editing a summary cannot reinsert
  // the same cost record, and pre-summary hashes continue to match.
  return { quota: data.quota_samples.map(fingerprint), cost: data.cost_periods.map(period => fingerprint({
    ...period, tasks: period.tasks.map(({ work_summary: _summary, ...task }) => task)
  })) };
}
export function hashWithdrawalKey(key) { return createHash('sha256').update(key).digest('hex'); }
