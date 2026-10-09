#!/usr/bin/env node
/**
 * Local, read-only observations from dsh-cost-meter ledger version 1. Node >=22.
 * Schema checked against Han-1413141/dsh-cost-meter commit
 * 812ba267164b493387ee639e262a8223a9126704:
 * lib/store.js:285-293,1980-1984,2082-2109;
 * lib/ledger-persistence.js:88-111; lib/typert.host.js:12-39.
 * Do not import Ledger.open(): the plugin performs migrations and writes on load.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const FIELD_MAP = Object.freeze({
  input: 'input_tokens', output: 'output_tokens',
  cacheRead: 'cache_read_tokens', cacheWrite: 'cache_write_tokens',
  reasoning: 'reasoning_tokens', calls: 'model_call_count',
  cost: 'api_equivalent_usd', apiCost: 'recorded_api_cost_estimate_usd',
});
const INTEGER_FIELDS = new Set(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'calls']);
const own = (object, field) => Object.hasOwn(object, field);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export class CollectorError extends Error {
  constructor(code, message) { super(message); this.name = 'CollectorError'; this.code = code; }
}
const fail = (code, message) => { throw new CollectorError(code, message); };

/** Creates a fresh allowlisted object; source strings never enter the result. */
export function collectDshObservations(ledger, { start, end } = {}) {
  if (!validDate(start) || !validDate(end) || start > end) {
    fail('DATE_RANGE', '开始和结束日期须为有效的 YYYY-MM-DD，且开始日期不得晚于结束日期。');
  }
  if (!record(ledger) || ledger.version !== 1 || !record(ledger.days)) {
    fail('LEDGER_FORMAT', '仅支持包含 days 对象的 dsh-cost-meter version 1 账本。');
  }
  const missing = [
    { scope: 'range', field: 'token_semantics', reason: '账本未声明输入是否包含缓存 Token；需根据具体模型与宿主口径确认。' },
    { scope: 'range', field: 'reasoning_in_output', reason: '账本未声明推理 Token 是否已计入输出；不生成归一 Token 总量。' },
    { scope: 'range', field: 'model_and_plan_identity', reason: '原 provider:model 键已替换为本次别名；需由当前会话或用户确认公开模型、套餐及路由。' },
    { scope: 'range', field: 'price_snapshot_and_coverage', reason: '未读取价格配置，不能确认价格覆盖；零估值不等于免费。' },
    { scope: 'range', field: 'actual_paid_costs_and_currency_conversion', reason: '这里只保留账本 USD 估值；实付、订阅、超额、退款、额度来源及人民币换算依据需另行提供。' },
    { scope: 'range', field: 'complete_period_and_all_attempted_tasks', reason: '本地已记录用量不能证明完整计费周期或已覆盖所有尝试的任务。' },
    { scope: 'range', field: 'task_outcomes', reason: '会话和模型调用不等于任务或重试；任务边界、尝试次数、验收结果、统一标准及人工时间需另行确认。' },
    { scope: 'range', field: 'quota_window_snapshots', reason: '本采集器不读取套餐额度采样；没有生成可提交的额度窗口记录。' },
    { scope: 'range', field: 'calendar_timezone', reason: '日期沿用账本宿主本地日；账本日键不携带时区，不能据此生成 UTC 周期边界。' },
  ];
  const providerAliases = new Map();
  const sessionAliases = new Map();
  let sessionSequence = 0;
  const providerAlias = key => {
    if (!providerAliases.has(key)) providerAliases.set(key, `provider-model-${providerAliases.size + 1}`);
    return providerAliases.get(key);
  };
  const sessionAlias = source => {
    if (typeof source.id === 'string' && source.id.length > 0) {
      if (!sessionAliases.has(source.id)) sessionAliases.set(source.id, `session-${++sessionSequence}`);
      return sessionAliases.get(source.id);
    }
    return `session-${++sessionSequence}`;
  };
  function usage(source, scope) {
    const result = {};
    for (const [inputField, outputField] of Object.entries(FIELD_MAP)) {
      const value = own(source, inputField) ? source[inputField] : undefined;
      const valid = typeof value === 'number' && Number.isFinite(value) && value >= 0
        && value <= Number.MAX_SAFE_INTEGER && (!INTEGER_FIELDS.has(inputField) || Number.isSafeInteger(value));
      result[outputField] = valid ? value : null;
      if (!valid) missing.push({ scope, field: outputField, reason: '该数值缺失或不是有效的非负数；未补零或从其他字段推算。' });
    }
    if (result.api_equivalent_usd !== null && result.recorded_api_cost_estimate_usd !== null
      && result.recorded_api_cost_estimate_usd > result.api_equivalent_usd + 1e-8) {
      result.recorded_api_cost_estimate_usd = null;
      missing.push({ scope, field: 'recorded_api_cost_estimate_usd', reason: 'API 分项超过该条总估值，保留总估值并将分项标为待确认。' });
    }
    return result;
  }
  function modelDetails(source, scope) {
    if (!record(source.byProviderModel)) {
      missing.push({ scope, field: 'provider_models', reason: '没有可读取的模型分项对象。' });
      return [];
    }
    const result = [];
    for (const [key, bucket] of Object.entries(source.byProviderModel)) {
      if (!record(bucket)) {
        missing.push({ scope, field: 'provider_models', reason: '存在无效模型分项，已忽略该条且未输出原键。' });
        continue;
      }
      const provider_model_ref = providerAlias(key);
      result.push({ provider_model_ref, usage: usage(bucket, `${scope}/${provider_model_ref}`) });
    }
    return result;
  }
  const observations = [];
  let invalidDayRecords = 0;
  const selectedKeys = Object.keys(ledger.days).filter(date => {
    if (!validDate(date)) { invalidDayRecords += 1; return false; }
    return start <= date && date <= end;
  }).sort();
  for (const date of selectedKeys) {
    const day = ledger.days[date];
    if (!record(day)) { invalidDayRecords += 1; continue; }
    const observation_ref = `day-${observations.length + 1}`;
    const row = { observation_ref, date, usage: usage(day, observation_ref), provider_models: modelDetails(day, observation_ref), sessions: [] };
    if (own(day, 'date') && day.date !== date) {
      missing.push({ scope: observation_ref, field: 'date_consistency', reason: '记录内日期与外层日期键不同；本次采用外层有效日期键。' });
    }
    if (!Array.isArray(day.sessions)) {
      missing.push({ scope: observation_ref, field: 'sessions', reason: '没有可读取的会话明细数组；日汇总仍保留。' });
    } else {
      const seen = new Set();
      for (const session of day.sessions) {
        if (!record(session)) {
          missing.push({ scope: observation_ref, field: 'sessions', reason: '存在无效会话明细，已忽略。' });
          continue;
        }
        const session_ref = sessionAlias(session);
        const scope = `${observation_ref}/${session_ref}`;
        if (seen.has(session_ref)) missing.push({ scope, field: 'session_identity', reason: '同一天出现重复会话标识；明细仅供核对，不参与日期范围总量。' });
        seen.add(session_ref);
        row.sessions.push({ session_ref, usage: usage(session, scope), provider_models: modelDetails(session, scope) });
      }
    }
    observations.push(row);
  }
  if (invalidDayRecords) missing.push({ scope: 'range', field: 'invalid_day_records', count: invalidDayRecords, reason: '无效日期键或日期记录未计入；不输出原始键。' });
  const rangeDays = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  const daysWithoutRecords = rangeDays - observations.length;
  if (daysWithoutRecords) missing.push({ scope: 'range', field: 'days_without_records', count: daysWithoutRecords, reason: '没有记录的日期不解释为零用量，也不能证明周期完整。' });
  const totals = {};
  for (const field of Object.values(FIELD_MAP)) {
    const values = observations.map(day => day.usage[field]);
    const sum = values.length && values.every(value => value !== null) ? values.reduce((a, b) => a + b, 0) : null;
    totals[field] = sum !== null && Number.isFinite(sum) && sum <= Number.MAX_SAFE_INTEGER ? sum : null;
    if (sum !== null && totals[field] === null) missing.push({ scope: 'range', field, reason: '合计超出安全数值范围，未输出失真的合计。' });
  }
  return {
    schema_version: 'dsh-observations-1', dataset_kind: 'local_observations', upload_ready: false,
    source: { kind: 'dsh-cost-meter-ledger', ledger_version: 1, calendar_basis: 'ledger_host_local_days' },
    requested_range: { start_date: start, end_date: end, inclusive: true },
    coverage: { recorded_days: observations.length, days_without_records: daysWithoutRecords, complete_period: null, all_attempted_tasks_included: null },
    semantics: {
      currency: 'USD', amount_basis: 'ledger_estimate_not_payment',
      api_equivalent_usd: '账本 cost：全部已记录调用的 API 等值估算，包含按套餐分类的用量。',
      recorded_api_cost_estimate_usd: '账本 apiCost：插件当时归类为 API 的估算部分；不是账单实付。',
      token_semantics: 'unknown', reasoning_in_output: null, normalized_total_tokens: null,
      calls_are: 'model_calls_not_tasks_or_retries',
      aggregation: 'totals_sum_day_usage_only; sessions_and_provider_models_are_overlapping_details',
      aliases: '本次本地输出内的序号别名；原会话标识与 provider:model 键不输出，也不写映射文件。',
    },
    totals, observations, missing,
  };
}

const HELP = `只读生成 DSH 用量观察草稿（不会上传）。Node.js >=22。
用法：node collect-dsh.mjs --start YYYY-MM-DD --end YYYY-MM-DD --out draft.json [--dsh-home <目录>]
未传 --dsh-home 时仅使用 DSH_HOME 环境变量；不会搜索用户目录。
日期两端包含在内，按账本宿主本地日筛选。输出文件必须不存在。
输出是 dsh-observations-1 本地辅助草稿，不能直接作为 v2 贡献提交。\n`;

export async function runCollectorCli(args, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (args.length === 1 && args[0] === '--help') { stdout.write(HELP); return 0; }
    const options = {};
    const allowed = new Set(['--start', '--end', '--out', '--dsh-home']);
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      if (!allowed.has(key) || own(options, key) || !args[index + 1] || args[index + 1].startsWith('--')) {
        fail('ARGUMENTS', '参数无效或重复；请使用 --help 查看用法。');
      }
      options[key] = args[index + 1];
    }
    if (!options['--start'] || !options['--end'] || !options['--out']) fail('ARGUMENTS', '必须显式提供 --start、--end 与 --out。');
    const dshHome = options['--dsh-home'] || env.DSH_HOME;
    if (!dshHome) fail('DSH_HOME_REQUIRED', '请显式提供 --dsh-home，或由当前宿主设置 DSH_HOME；不会自动搜索账本。');
    if (!validDate(options['--start']) || !validDate(options['--end']) || options['--start'] > options['--end']) fail('DATE_RANGE', '开始和结束日期须有效且顺序正确。');
    let text;
    try { text = await readFile(join(resolve(dshHome), 'storages', 'cost-meter', 'ledger.json'), 'utf8'); }
    catch { fail('LEDGER_READ', '无法只读打开指定 DSH 根目录下的账本；请检查目录与访问权限。'); }
    let ledger;
    try { ledger = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { fail('LEDGER_JSON', '账本不是有效 JSON；未创建草稿，也未修改账本。'); }
    const draft = collectDshObservations(ledger, { start: options['--start'], end: options['--end'] });
    try { await writeFile(resolve(options['--out']), `${JSON.stringify(draft, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch { fail('OUTPUT_WRITE', '无法新建草稿文件；请使用现有目录中的新文件名。已有文件不会被覆盖。'); }
    stdout.write(`${JSON.stringify({ status: 'local_draft_created', schema_version: draft.schema_version, recorded_days: draft.coverage.recorded_days, upload_ready: false })}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof CollectorError ? error : new CollectorError('COLLECTOR_ERROR', '本地采集失败；未输出账本内容或私人路径。');
    stderr.write(`${JSON.stringify({ error: safe.code, message: safe.message })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCollectorCli(process.argv.slice(2));
}
