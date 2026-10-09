export const METHOD_VERSION = '2.0.0';
export const CONSENT_VERSION = '2026-10-09';
export const MINIMUM_CONTRIBUTIONS = 5;
export const LIMITS = Object.freeze({ quotaSamples: 20, costPeriods: 12, tasks: 1000, bytes: 256 * 1024 });
const ROOT = ['schema_version', 'dataset_kind', 'currency', 'quota_samples', 'cost_periods'];
const QUOTA = ['provider_id', 'plan_id', 'subject_kind', 'subject_id', 'quota_pool_id', 'window_id', 'window_start', 'window_end', 'price_snapshot_id', 'quota_source', 'window_type', 'coverage', 'before', 'after'];
const SNAPSHOT = ['observed_at', 'used_percent', 'token_usage', 'api_equivalent_cny'];
const PERIOD = ['provider_id', 'plan_id', 'subject_kind', 'subject_id', 'period_start', 'period_end', 'complete_period', 'all_attempted_tasks_included', 'task_type', 'difficulty', 'acceptance_standard', 'payment_category', 'costs', 'tasks'];
const TASK = ['task_id', 'attempt_count', 'accepted', 'human_minutes', 'token_usage', 'api_equivalent_cny'];
const TOKENS = ['token_semantics', 'reasoning_in_output', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'normalized_total_tokens'];
export const ENUMS = Object.freeze({ taskTypes: ['bugfix', 'feature', 'refactor', 'tests', 'docs'], difficulties: ['simple', 'medium', 'complex'], acceptanceStandards: ['test_suite_passed', 'review_approved', 'spec_checklist_passed'] });
export class ValidationError extends Error {
  constructor(code, path, message) { super(message); this.name = 'ValidationError'; this.code = code; this.path = path; }
}
function reject(code, path, message) { throw new ValidationError(code, path, message); }
function fields(value, allowed, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('TYPE', path, '必须是 JSON 对象。');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) reject('UNKNOWN_FIELD', path, '含有未允许字段；请移除提示词、代码、账号、邮箱和密钥等内容。');
  for (const key of allowed) if (!Object.prototype.hasOwnProperty.call(value, key)) reject('MISSING_FIELD', `${path}.${key}`, '缺少必填字段，不能用猜测值代替。');
}
function enumeration(v, options, path) { if (!options.includes(v)) reject('ENUM', path, '字段取值不在允许列表内。'); }
function identifier(v, path) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(v)) reject('IDENTIFIER', path, '标识只能包含 1–48 位字母、数字、点、下划线或短横线。');
  if (/^(?:sk|rk|pk|ghp|gho|github_pat)[_-]/i.test(v) || /(?:api[_-]?key|secret|password|bearer)/i.test(v)) reject('SENSITIVE_VALUE', path, '标识疑似包含敏感内容，请先脱敏。');
}
function numeric(v, path, max = 1e8, integer = false) { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max || (integer && !Number.isSafeInteger(v))) reject('NUMBER', path, integer ? '须为范围内的非负安全整数。' : '须为范围内的非负有限数值。'); }
function utc(v, path) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v)) reject('TIME', path, '时间须为 UTC 的 YYYY-MM-DDTHH:mm:ssZ。');
  const value = Date.parse(v); if (!Number.isFinite(value) || new Date(value).toISOString().replace('.000Z', 'Z') !== v) reject('TIME', path, '日期或时间不存在。'); return value;
}
function array(v, path, min, max) { if (!Array.isArray(v) || v.length < min || v.length > max) reject('ARRAY', path, `数组数量须为 ${min}–${max}。`); }
function unique(v, set, path) { if (set.has(v)) reject('DUPLICATE', path, '存在重复任务或支付周期，不能重复计入。'); set.add(v); }
const round = v => Number(v.toFixed(6));
export function validateTokenUsage(t, path = '$.token_usage') {
  fields(t, TOKENS, path); enumeration(t.token_semantics, ['input_includes_cache', 'input_excludes_cache'], `${path}.token_semantics`);
  if (typeof t.reasoning_in_output !== 'boolean') reject('TOKEN_SEMANTICS', path, '必须明确 reasoning 是否已包含在 output 中。');
  for (const key of TOKENS.slice(2)) numeric(t[key], `${path}.${key}`, 1e12, true);
  if (t.token_semantics === 'input_includes_cache' && t.cache_read_tokens + t.cache_write_tokens > t.input_tokens) reject('TOKEN_SUBSET', path, '缓存作为 input 子集时不能超过 input。');
  if (t.reasoning_in_output && t.reasoning_tokens > t.output_tokens) reject('TOKEN_SUBSET', path, 'reasoning 作为 output 子集时不能超过 output。');
  const total = t.input_tokens + t.output_tokens + (t.token_semantics === 'input_excludes_cache' ? t.cache_read_tokens + t.cache_write_tokens : 0) + (t.reasoning_in_output ? 0 : t.reasoning_tokens);
  if (total !== t.normalized_total_tokens) reject('TOKEN_TOTAL', path, '非重复 Token 总量不符合显式计数语义；不得重复累加缓存或 reasoning。');
  return total;
}
function subject(value, path) { identifier(value.provider_id, `${path}.provider_id`); identifier(value.plan_id, `${path}.plan_id`); identifier(value.subject_id, `${path}.subject_id`); enumeration(value.subject_kind, ['model', 'workflow'], `${path}.subject_kind`); }
function quota(q, path) {
  fields(q, QUOTA, path); subject(q, path);
  enumeration(q.quota_source, ['official_api', 'official_cli', 'user_snapshot', 'local_estimate'], `${path}.quota_source`);
  enumeration(q.window_type, ['fixed_reset', 'rolling'], `${path}.window_type`);
  enumeration(q.coverage, ['complete', 'partial', 'unknown'], `${path}.coverage`);
  for (const key of ['quota_pool_id', 'window_id', 'price_snapshot_id']) identifier(q[key], `${path}.${key}`);
  const start = utc(q.window_start, `${path}.window_start`), end = utc(q.window_end, `${path}.window_end`);
  if (!(start < end)) reject('WINDOW', path, '窗口起止无效。');
  for (const key of ['before', 'after']) {
    const s = q[key], p = `${path}.${key}`; fields(s, SNAPSHOT, p);
    const observed = utc(s.observed_at, `${p}.observed_at`); if (observed < start || observed >= end) reject('WINDOW', p, '采样须在同一个左闭右开的重置窗口内。');
    numeric(s.used_percent, `${p}.used_percent`, 100); validateTokenUsage(s.token_usage, `${p}.token_usage`); numeric(s.api_equivalent_cny, `${p}.api_equivalent_cny`);
  }
  const a = q.before, b = q.after;
  if (Date.parse(b.observed_at) <= Date.parse(a.observed_at)) reject('TIME_ORDER', path, '后一次采样必须晚于前一次。');
  const pp = round(b.used_percent - a.used_percent); if (pp <= 0) reject('QUOTA_DELTA', path, '额度必须增加；相同读数、回退或不足百万分之一个百分点不能换算。');
  if (a.token_usage.token_semantics !== b.token_usage.token_semantics || a.token_usage.reasoning_in_output !== b.token_usage.reasoning_in_output) reject('TOKEN_SEMANTICS', path, '前后两次 Token 计数语义须一致。');
  for (const key of TOKENS.slice(2)) if (b.token_usage[key] < a.token_usage[key]) reject('COUNTER_ROLLBACK', path, '累计 Token 组件回退，不能跨重置相减。');
  if (b.api_equivalent_cny < a.api_equivalent_cny) reject('COUNTER_ROLLBACK', path, '累计目录等价金额回退。');
  const tokens = b.token_usage.normalized_total_tokens - a.token_usage.normalized_total_tokens, equivalent = round(b.api_equivalent_cny - a.api_equivalent_cny);
  return {
    provider_id: q.provider_id, plan_id: q.plan_id, subject_kind: q.subject_kind, subject_id: q.subject_id,
    quota_pool_id: q.quota_pool_id, price_snapshot_id: q.price_snapshot_id,
    quota_source: q.quota_source, window_type: q.window_type, coverage: q.coverage,
    community_eligible: q.quota_source !== 'local_estimate' && q.window_type === 'fixed_reset' && q.coverage === 'complete',
    window_duration_seconds: (end - start) / 1000,
    token_semantics: a.token_usage.token_semantics, reasoning_in_output: a.token_usage.reasoning_in_output,
    delta_percentage_points: pp, delta_tokens: tokens, delta_api_equivalent_cny: equivalent,
    tokens_per_percentage_point: round(tokens / pp), api_equivalent_cny_per_percentage_point: round(equivalent / pp)
  };
}
function cost(p, path, isReal, now) {
  fields(p, PERIOD, path); subject(p, path);
  const start = utc(p.period_start, `${path}.period_start`), end = utc(p.period_end, `${path}.period_end`);
  if (start >= end) reject('PERIOD', path, '支付周期结束须晚于开始。');
  if (isReal && end > now) reject('FUTURE_PERIOD', path, '实际贡献不能包含尚未结束的支付周期。');
  if (p.complete_period !== true || p.all_attempted_tasks_included !== true) reject('INCOMPLETE_PERIOD', path, '只能按已结束且包括全部尝试任务的完整周期比较成本。');
  enumeration(p.task_type, ENUMS.taskTypes, `${path}.task_type`); enumeration(p.difficulty, ENUMS.difficulties, `${path}.difficulty`); enumeration(p.acceptance_standard, ENUMS.acceptanceStandards, `${path}.acceptance_standard`);
  enumeration(p.payment_category, ['standard', 'promotional', 'credit', 'trial', 'unknown'], `${path}.payment_category`);
  fields(p.costs, ['subscription_cny', 'overage_cny', 'other_api_cny', 'refund_cny'], `${path}.costs`);
  for (const key of Object.keys(p.costs)) numeric(p.costs[key], `${path}.costs.${key}`);
  const net = round(p.costs.subscription_cny + p.costs.overage_cny + p.costs.other_api_cny - p.costs.refund_cny);
  if (net < 0) reject('NEGATIVE_NET_COST', `${path}.costs`, '已确认退款不能超过本期支付合计。');
  array(p.tasks, `${path}.tasks`, 1, LIMITS.tasks);
  const ids = new Set(); let accepted = 0, attempts = 0, human = 0, tokens = 0, equivalent = 0;
  p.tasks.forEach((t, i) => {
    const tp = `${path}.tasks[${i}]`; fields(t, TASK, tp); identifier(t.task_id, `${tp}.task_id`); unique(t.task_id, ids, tp);
    numeric(t.attempt_count, `${tp}.attempt_count`, 100, true); if (t.attempt_count < 1) reject('ATTEMPTS', tp, '每个任务至少有一次尝试。');
    if (typeof t.accepted !== 'boolean') reject('BOOLEAN', `${tp}.accepted`, 'accepted 须为 true 或 false。');
    numeric(t.human_minutes, `${tp}.human_minutes`, 1e6); numeric(t.api_equivalent_cny, `${tp}.api_equivalent_cny`);
    tokens += validateTokenUsage(t.token_usage, `${tp}.token_usage`); accepted += Number(t.accepted); attempts += t.attempt_count; human += t.human_minutes; equivalent += t.api_equivalent_cny;
  });
  return {
    provider_id: p.provider_id, plan_id: p.plan_id, subject_kind: p.subject_kind, subject_id: p.subject_id,
    task_type: p.task_type, difficulty: p.difficulty, acceptance_standard: p.acceptance_standard,
    payment_category: p.payment_category,
    period_duration_days: round((end - start) / 86400000), cohort_month: p.period_start.slice(0, 7),
    net_paid_cny: net, attempted_tasks: p.tasks.length, accepted_tasks: accepted, acceptance_rate: round(accepted / p.tasks.length),
    total_attempts: attempts, failed_attempts: attempts - accepted, retry_attempts: attempts - p.tasks.length,
    human_minutes: round(human), normalized_total_tokens: tokens, api_equivalent_cny: round(equivalent),
    paid_cny_per_accepted_task: accepted ? round(net / accepted) : null
  };
}
export function analyzeDataset(data, { now = Date.now() } = {}) {
  fields(data, ROOT, '$'); enumeration(data.schema_version, ['2.0'], '$.schema_version'); enumeration(data.dataset_kind, ['synthetic', 'user_reported'], '$.dataset_kind'); enumeration(data.currency, ['CNY'], '$.currency');
  array(data.quota_samples, '$.quota_samples', 0, LIMITS.quotaSamples); array(data.cost_periods, '$.cost_periods', 0, LIMITS.costPeriods);
  if (!data.quota_samples.length && !data.cost_periods.length) reject('EMPTY_DATA', '$', '至少提供一种样本。');
  const taskTotal = data.cost_periods.reduce((n, p) => n + (Array.isArray(p?.tasks) ? p.tasks.length : 0), 0); if (taskTotal > LIMITS.tasks) reject('TOO_MANY_TASKS', '$.cost_periods', '一份贡献最多 1000 个任务。');
  const windows = new Map(), windowLabels = new Map(), cycles = new Map();
  const quota_results = data.quota_samples.map((q, i) => {
    const path = `$.quota_samples[${i}]`, result = quota(q, path);
    if (data.dataset_kind === 'user_reported' && Date.parse(q.after.observed_at) > now) reject('FUTURE_SAMPLE', path, '实际贡献不能包含未来采样。');
    // A caller-provided label is metadata, not the identity of a real reset window.
    const key = [q.provider_id, q.plan_id, q.quota_pool_id, q.window_start, q.window_end].join('|');
    const labelKey = [q.provider_id, q.plan_id, q.quota_pool_id, q.window_id].join('|');
    if (windowLabels.has(labelKey) && windowLabels.get(labelKey) !== key) reject('WINDOW_MISMATCH', path, '相同窗口标识不能对应不同重置时间。');
    windowLabels.set(labelKey, key);
    const existing = windows.get(key) || [];
    for (const old of existing) {
      if (Math.max(Date.parse(old.before.observed_at), Date.parse(q.before.observed_at)) < Math.min(Date.parse(old.after.observed_at), Date.parse(q.after.observed_at))) reject('OVERLAPPING_SAMPLE', path, '同一额度窗口的观察区间重叠，不能重复累计。');
    }
    existing.push(q); windows.set(key, existing); return result;
  });
  const cost_results = data.cost_periods.map((p, i) => {
    const path = `$.cost_periods[${i}]`, result = cost(p, path, data.dataset_kind === 'user_reported', now);
    const key = [p.provider_id, p.plan_id].join('|'), old = cycles.get(key) || [];
    for (const prior of old) if (Math.max(Date.parse(p.period_start), Date.parse(prior.period_start)) < Math.min(Date.parse(p.period_end), Date.parse(prior.period_end))) reject('OVERLAPPING_PERIOD', path, '同一提供商和套餐的支付周期重叠，不能重复分配实付费用。');
    old.push(p); cycles.set(key, old); return result;
  });
  return { schema_version: '2.0', method_version: METHOD_VERSION, dataset_kind: data.dataset_kind, currency: 'CNY', quota_results, cost_results,
    totals: { quota_samples: quota_results.length, cost_periods: cost_results.length, attempted_tasks: cost_results.reduce((n, p) => n + p.attempted_tasks, 0), accepted_tasks: cost_results.reduce((n, p) => n + p.accepted_tasks, 0) } };
}
export function anonymizeAnalysis(result) {
  return { ...result, verification: 'self_reported_unverified', contains_raw_tasks: false, contains_raw_snapshots: false };
}
export const QUOTA_GROUP_FIELDS = ['provider_id', 'plan_id', 'subject_kind', 'subject_id', 'quota_pool_id', 'price_snapshot_id', 'quota_source', 'window_type', 'coverage', 'window_duration_seconds', 'token_semantics', 'reasoning_in_output'];
export const COST_GROUP_FIELDS = ['provider_id', 'plan_id', 'subject_kind', 'subject_id', 'task_type', 'difficulty', 'acceptance_standard', 'payment_category', 'period_duration_days', 'cohort_month'];
export function pickGroup(row, kind) { return Object.fromEntries((kind === 'quota' ? QUOTA_GROUP_FIELDS : COST_GROUP_FIELDS).map(k => [k, row[k]])); }
export function communityFromRows(contributions, minimum = MINIMUM_CONTRIBUTIONS) {
  const maps = { quota: new Map(), cost: new Map() }; let quotaCount = 0, periodCount = 0;
  for (const contribution of contributions) {
    if (contribution.dataset_kind !== 'user_reported') continue;
    for (const [kind, rows] of [['quota', contribution.summary.quota_results], ['cost', contribution.summary.cost_results]]) {
      for (const row of rows) {
        if (kind === 'quota' && row.community_eligible !== true) continue;
        const group = pickGroup(row, kind), key = JSON.stringify(group); let item = maps[kind].get(key);
        if (!item) { item = { group, ids: new Set(), rows: [] }; maps[kind].set(key, item); }
        item.ids.add(contribution.id); item.rows.push(row); if (kind === 'quota') quotaCount++; else periodCount++;
      }
    }
  }
  const sum = (rows, key) => round(rows.reduce((n, row) => n + row[key], 0));
  const build = (kind, entry) => {
    const published = entry.ids.size >= minimum, result = { group: entry.group, contribution_count: entry.ids.size, [kind === 'quota' ? 'sample_count' : 'period_count']: entry.rows.length, published, metrics: null };
    if (!published) return result;
    if (kind === 'quota') { const pp = sum(entry.rows, 'delta_percentage_points'), tokens = sum(entry.rows, 'delta_tokens'), equivalent = sum(entry.rows, 'delta_api_equivalent_cny'); result.metrics = { delta_percentage_points: pp, delta_tokens: tokens, delta_api_equivalent_cny: equivalent, tokens_per_percentage_point: round(tokens / pp), api_equivalent_cny_per_percentage_point: round(equivalent / pp) }; }
    else { const keys = ['net_paid_cny', 'attempted_tasks', 'accepted_tasks', 'total_attempts', 'failed_attempts', 'retry_attempts', 'human_minutes', 'normalized_total_tokens', 'api_equivalent_cny']; const m = Object.fromEntries(keys.map(key => [key, sum(entry.rows, key)])); m.acceptance_rate = round(m.accepted_tasks / m.attempted_tasks); m.paid_cny_per_accepted_task = m.accepted_tasks ? round(m.net_paid_cny / m.accepted_tasks) : null; result.metrics = m; }
    return result;
  };
  return { ok: true, source: 'user_reported_unverified', minimum_contributions: minimum,
    totals: { contributions: contributions.filter(c => c.dataset_kind === 'user_reported').length, quota_samples: quotaCount, cost_periods: periodCount },
    quota_groups: [...maps.quota.values()].map(e => build('quota', e)), cost_groups: [...maps.cost.values()].map(e => build('cost', e)) };
}
