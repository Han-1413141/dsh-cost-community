#!/usr/bin/env node
import { readFile, writeFile, mkdir, lstat, access, chmod } from 'node:fs/promises';
import { randomBytes, createHash, webcrypto } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyzeDataset, acceptanceSummary, hasWorkSummaries, CONSENT_VERSION, LIMITS } from '../shared/analysis.js';
import { prepareContribution, assertUploadAliases } from '../shared/privacy.js';

export const PRODUCTION_ENDPOINT = 'https://dsh-cost-community.onrender.com';
const DRAFT_FORMAT = 'dsh-cost-draft-v1';
const RECEIPT_FORMAT = 'dsh-withdrawal-receipt-v1';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class ClientError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new ClientError(code, message); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const exists = async file => { try { await access(file); return true; } catch { return false; } };

export function resolveEndpoint(testEndpoint) {
  if (testEndpoint === undefined) return PRODUCTION_ENDPOINT;
  let url; try { url = new URL(testEndpoint); } catch { fail('ENDPOINT', '测试端点须为显式本机 HTTP 地址。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('ENDPOINT', '只允许固定项目 HTTPS 服务，或带端口的 http://127.0.0.1 / http://[::1] 隔离测试端点。');
  }
  return url.origin;
}
export function defaultStateDir() {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local') : path.join(homedir(), '.local', 'share');
  if (!path.isAbsolute(base)) fail('PRIVATE_DIRECTORY', '用户数据目录必须是绝对路径。');
  return path.join(base, 'DSHCostCommunity', 'client');
}
async function ensurePrivateDir(directory) {
  const resolved = path.resolve(directory);
  for (let at = resolved; ; at = path.dirname(at)) {
    if (await exists(path.join(at, '.git'))) fail('PRIVATE_DIRECTORY', '本地去标识密钥和撤回凭证必须保存在代码仓库以外的用户数据目录。');
    if (path.dirname(at) === at) break;
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PRIVATE_DIRECTORY', '用户数据目录必须是普通本地目录。');
  if (process.platform !== 'win32') await chmod(resolved, 0o700);
  // On Windows this app-specific directory inherits the user's LocalAppData ACL.
  // No machine-wide ACL, policy or environment settings are modified.
  return resolved;
}
async function readLimited(file, maximum) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('LOCAL_FILE', '本地文件须为普通文件，且不得超过对应大小限制。');
  const bytes = await readFile(file);
  if (bytes.length > maximum) fail('LOCAL_FILE', '本地文件超过大小限制。');
  return bytes;
}
function parseJSON(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail('JSON', '本地文件不是有效的 UTF-8 JSON。'); }
}
async function privateWrite(file, bytes, { overwrite = false } = {}) {
  if (overwrite && await exists(file)) {
    const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) fail('LOCAL_FILE', '写入目标必须是普通本地文件。');
  }
  await writeFile(file, bytes, { flag: overwrite ? 'w' : 'wx', mode: 0o600 });
  if (process.platform !== 'win32') await chmod(file, 0o600);
}
async function workflowKey(stateDir) {
  const directory = await ensurePrivateDir(stateDir), file = path.join(directory, 'workflow-hmac-key-v1.bin');
  try { await privateWrite(file, randomBytes(32)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const bytes = await readLimited(file, 32);
  if (bytes.length !== 32) fail('LOCAL_KEY', '本地去标识密钥无效，未生成或发送贡献。请保留该文件并检查本地存储。');
  try { return await webcrypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); }
  finally { bytes.fill(0); }
}
function payloadValidation(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['consent', 'data'].includes(key))) fail('PAYLOAD', '待发送正文只能包含 consent 与 data。');
  const c = payload.consent;
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(key => !['accepted', 'version', 'work_summary_reviewed'].includes(key)) || c.accepted !== true || c.version !== CONSENT_VERSION) fail('CONSENT_VERSION', '草稿授权版本不匹配，请重新 prepare 并核对新预览。');
  const analysis = analyzeDataset(payload.data); assertUploadAliases(payload.data);
  if (hasWorkSummaries(payload.data) ? c.work_summary_reviewed !== true : Object.hasOwn(c, 'work_summary_reviewed')) fail('WORK_SUMMARY_REVIEW', '草稿中的工作摘要确认与当前数据不一致。');
  return analysis;
}
const percent = value => `${(value * 100).toFixed(1)}%`;
const LABELS = Object.freeze({
  function_category: { interface: '用户界面', api: 'API 接口', data_processing: '数据处理', automation: '自动化', integration: '集成', infrastructure: '基础设施', testing: '测试', documentation: '文档', other: '其他' },
  code_change_band: { not_applicable: '不涉及代码行', '1_50': '1—50 行', '51_200': '51—200 行', '201_500': '201—500 行', '501_1000': '501—1000 行', '1000_plus': '超过 1000 行' },
  difficulty: { simple: '简单', medium: '中等', complex: '复杂' },
  task_type: { bugfix: '修复缺陷', feature: '功能开发', refactor: '重构', tests: '测试', docs: '文档' },
  acceptance_standard: { test_suite_passed: '测试套件通过', review_approved: '评审通过', spec_checklist_passed: '需求清单通过' },
  payment_category: { standard: '常规付款', promotional: '促销付款', credit: '赠送额度', trial: '试用', unknown: '付款类别未知' },
  subject_kind: { model: '模型', workflow: '工作流组合' },
  quota_source: { official_api: '提供商 API', official_cli: '提供商 CLI', user_snapshot: '用户读取快照', local_estimate: '本地估算' },
  window_type: { fixed_reset: '固定重置窗口', rolling: '滚动窗口' },
  coverage: { complete: '覆盖完整', partial: '覆盖部分', unknown: '覆盖情况未知' }
});
const label = (field, value) => LABELS[field]?.[value] ?? '未提供';
function previewMarkdown(payload, analysis, endpoint, payloadHash) {
  const rows = [
    '# 本地贡献预览', '', `目标服务：${endpoint}`, `授权版本：${CONSENT_VERSION}`, `实际 payload.json 的 SHA-256：\`${payloadHash}\``, '',
    '**当前只生成了本地草稿，没有发送。** 请先核对下面的比较条件、每项任务与完整实际请求；明确确认本版本后，技能才可执行上传。哈希绑定版本，不代替用户确认，用户不需要自己抄写哈希。', '',
    '账单实付、完整周期、任务是否验收及工作摘要由数据提供者确认，工具不会从调用次数、API 等价金额或代码量推断。请求模板中的同意标记只有在用户确认并执行 upload 后才会发送。', '',
    '发送范围：去标识任务统计、工作摘要封闭枚举、费用及额度快照。服务器重算后仅存周期/额度摘要和工作摘要分布；原任务名、工作流名、源码、路径和本地密钥不发送。提供商、套餐、模型、额度池、价格快照等比较字段须适合公开。', '',
    '站内用于公开聚合；单份摘要由用户决定是否另行公开及采用何种数据许可。撤回凭证需保管，终端不会打印密钥。', '',
    `数据类型：\`${payload.data.dataset_kind}\`${payload.data.dataset_kind === 'synthetic' ? '（构造数据：只可本地预览，禁止上传）' : '（用户自报）'}`, ''
  ];
  if (payload.data.cost_periods.length) {
    const a = acceptanceSummary(analysis.cost_results);
    rows.push('## 验收与任务统计', '', `各完整周期内任务去重后合计：${a.attempted_tasks} 项，已验收 ${a.accepted_tasks} 项，未验收 ${a.unaccepted_tasks} 项，验收率 ${a.acceptance_rate === null ? '无任务' : percent(a.acceptance_rate)}。`, `全部尝试 ${a.total_attempts} 次，重试 ${a.retry_attempts} 次，未通过验收的尝试 ${a.failed_attempts} 次。重试不当作新任务，跨周期不声明项目或真人去重。`, '');
  } else rows.push('本次仅包含额度观察，未提供任务验收与账单实付数据。', '');
  payload.data.cost_periods.forEach((p, index) => {
    const result = analysis.cost_results[index];
    rows.push(`## 成本周期 ${index + 1}`, '',
      `- 提供商 / 套餐 / 统计对象：\`${p.provider_id}\` / \`${p.plan_id}\` / ${label('subject_kind', p.subject_kind)} \`${p.subject_id}\``,
      `- UTC 周期：${p.period_start} 至 ${p.period_end}；声明周期完整且已包含全部尝试任务`,
      `- 比较条件：${label('task_type', p.task_type)}；难度 ${label('difficulty', p.difficulty)}；验收标准 ${label('acceptance_standard', p.acceptance_standard)}；${label('payment_category', p.payment_category)}`,
      `- CNY 实付：订阅 ${p.costs.subscription_cny} + 超额 ${p.costs.overage_cny} + 其他 API ${p.costs.other_api_cny} − 退款 ${p.costs.refund_cny} = 净实付 ${result.net_paid_cny}`,
      `- 每项验收任务净实付：${result.paid_cny_per_accepted_task ?? '无验收任务，不计算'}；人工 ${result.human_minutes} 分钟；已摘要任务 ${result.work_summary_counts.summarized_tasks} 项`, '',
      '| 任务位置 | 验收 | 尝试 | 人工分钟 | 非重复 Token | API 等价 CNY | 功能类别 | 代码量区间 | 摘要难度 |',
      '|---|---|---:|---:|---:|---:|---|---|---|');
    p.tasks.forEach((t, taskIndex) => rows.push(`| 周期${index + 1}-任务${taskIndex + 1} | ${t.accepted ? '通过' : '未通过'} | ${t.attempt_count} | ${t.human_minutes} | ${t.token_usage.normalized_total_tokens} | ${t.api_equivalent_cny} | ${label('function_category', t.work_summary?.function_category)} | ${label('code_change_band', t.work_summary?.code_change_band)} | ${label('difficulty', t.work_summary?.difficulty)} |`));
    rows.push('', '可按周期和任务序号指出需要修改的行；完整匿名标识见下方实际请求。代码量区间只描述工作规模，不作为质量或性价比排名。每条记录的 Token 包含关系与全部组件见下方完整实际请求。', '');
  });
  payload.data.quota_samples.forEach((q, index) => {
    const result = analysis.quota_results[index];
    rows.push(`## 额度样本 ${index + 1}`, '',
      `- 比较对象：\`${q.provider_id}\` / \`${q.plan_id}\` / ${label('subject_kind', q.subject_kind)} \`${q.subject_id}\``,
      `- 额度池 / 价格快照：\`${q.quota_pool_id}\` / \`${q.price_snapshot_id}\`；窗口别名 \`${q.window_id}\``,
      `- UTC 窗口：${q.window_start} 至 ${q.window_end}；来源 ${label('quota_source', q.quota_source)}；${label('window_type', q.window_type)}；${label('coverage', q.coverage)}`,
      `- 采样：${q.before.observed_at} → ${q.after.observed_at}；已用额度 ${q.before.used_percent}% → ${q.after.used_percent}%`,
      `- 非重复 Token：${q.before.token_usage.normalized_total_tokens} → ${q.after.token_usage.normalized_total_tokens}；API 等价 CNY：${q.before.api_equivalent_cny} → ${q.after.api_equivalent_cny}`,
      `- 每百分点：${result.tokens_per_percentage_point} Token，API 等价 ${result.api_equivalent_cny_per_percentage_point} 元；社区额度资格：${result.community_eligible ? '符合当前规则（来源仍为自报）' : '仅用于个人观察，服务器不保存此额度样本'}`, '',
      'API 等价费用不是订阅净实付。', '');
  });
  rows.push('## 完整实际请求', '', '下面内容与 payload.json 完全一致。修改 payload、预览、端点或版本会使原确认哈希失效，必须重新准备并确认。', '', '```json', JSON.stringify(payload, null, 2), '```', '');
  return Buffer.from(rows.join('\n'), 'utf8');
}
function reviewHash(manifest) {
  return sha256(JSON.stringify({ format_version: manifest.format_version, created_at: manifest.created_at, endpoint: manifest.endpoint, consent_version: manifest.consent_version, dataset_kind: manifest.dataset_kind, requires_work_summary_review: manifest.requires_work_summary_review, payload_sha256: manifest.payload_sha256, preview_sha256: manifest.preview_sha256 }));
}
export async function prepareDraft({ input, out, testEndpoint, stateDir = defaultStateDir() }) {
  const endpoint = resolveEndpoint(testEndpoint);
  const source = parseJSON(await readLimited(path.resolve(input), LIMITS.bytes));
  analyzeDataset(source); // Reject unknown/sensitive fields before creating output or a local key.
  const needsKey = [...source.quota_samples, ...source.cost_periods].some(row => row.subject_kind === 'workflow');
  const prepared = await prepareContribution(source, { workflowKey: needsKey ? await workflowKey(stateDir) : undefined, cryptoProvider: webcrypto });
  const payload = { consent: { accepted: true, version: CONSENT_VERSION, ...(hasWorkSummaries(prepared.data) ? { work_summary_reviewed: true } : {}) }, data: prepared.data };
  payloadValidation(payload);
  const payloadBytes = jsonBytes(payload);
  if (payloadBytes.length > LIMITS.bytes) fail('PAYLOAD_TOO_LARGE', '待发送正文超过 256 KiB，请按完整周期拆分。');
  const payloadHash = sha256(payloadBytes), preview = previewMarkdown(payload, prepared.analysis, endpoint, payloadHash);
  const manifest = { format_version: DRAFT_FORMAT, created_at: new Date().toISOString(), endpoint, consent_version: CONSENT_VERSION, dataset_kind: source.dataset_kind, requires_work_summary_review: hasWorkSummaries(source), payload_sha256: payloadHash, preview_sha256: sha256(preview) };
  manifest.review_sha256 = reviewHash(manifest);
  const directory = path.resolve(out);
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('DRAFT_EXISTS', '草稿目录已存在。请指定一个新目录，保留原预览和发送记录。'); throw error; }
  await privateWrite(path.join(directory, 'payload.json'), payloadBytes);
  await privateWrite(path.join(directory, 'preview.md'), preview);
  await privateWrite(path.join(directory, 'manifest.json'), jsonBytes(manifest));
  return { status: 'prepared_locally', network_requests: 0, draft: directory, preview: path.join(directory, 'preview.md'), review_sha256: manifest.review_sha256, dataset_kind: source.dataset_kind, note: '先向用户展示本版本完整预览；取得明确确认后才执行 upload。哈希本身不是用户确认。' };
}
async function verifiedDraft({ draft, confirmedSha256, confirmReviewed, testEndpoint }) {
  if (confirmReviewed !== true || typeof confirmedSha256 !== 'string' || !HASH.test(confirmedSha256)) fail('USER_CONFIRMATION_REQUIRED', '只有用户已核对当前预览并明确同意上传后，才能传入 --confirm-reviewed 与该版本 --confirmed-sha256。');
  const directory = path.resolve(draft), manifest = parseJSON(await readLimited(path.join(directory, 'manifest.json'), 8192));
  const allowed = ['format_version', 'created_at', 'endpoint', 'consent_version', 'dataset_kind', 'requires_work_summary_review', 'payload_sha256', 'preview_sha256', 'review_sha256'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).length !== allowed.length || Object.keys(manifest).some(key => !allowed.includes(key)) || manifest.format_version !== DRAFT_FORMAT || manifest.consent_version !== CONSENT_VERSION) fail('MANIFEST', '草稿清单格式或授权版本无效，请重新 prepare 并核对。');
  if (manifest.endpoint !== resolveEndpoint(testEndpoint)) fail('ENDPOINT_MISMATCH', '执行目标与用户核对的草稿端点不同。测试端点必须在 prepare 与 upload 时显式保持一致。');
  const payloadBytes = await readLimited(path.join(directory, 'payload.json'), LIMITS.bytes), preview = await readLimited(path.join(directory, 'preview.md'), 2 * 1024 * 1024);
  if (sha256(payloadBytes) !== manifest.payload_sha256 || sha256(preview) !== manifest.preview_sha256 || reviewHash(manifest) !== manifest.review_sha256 || manifest.review_sha256 !== confirmedSha256) fail('REVIEW_CHANGED', '草稿或预览已改变，当前哈希与用户确认的版本不一致。请重新 prepare 并再次展示预览。');
  const payload = parseJSON(payloadBytes); payloadValidation(payload);
  if (manifest.dataset_kind !== payload.data.dataset_kind || manifest.requires_work_summary_review !== hasWorkSummaries(payload.data)) fail('MANIFEST', '清单与实际请求不一致。');
  if (payload.data.dataset_kind !== 'user_reported') fail('SYNTHETIC_NOT_ALLOWED', '构造数据只用于本地预览，不能上传到真实贡献接口。');
  return { directory, manifest, payloadBytes };
}
async function responseJSON(response) {
  if (Number(response.headers.get('content-length') || 0) > 1024 * 1024) fail('INVALID_RESPONSE', '服务返回内容超过预期，未自动重试。');
  const reader = response.body?.getReader(); if (!reader) fail('INVALID_RESPONSE', '服务没有返回有效 JSON，未自动重试。');
  let length = 0; const chunks = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 1024 * 1024) { await reader.cancel(); fail('INVALID_RESPONSE', '服务返回内容超过预期，未自动重试。'); } chunks.push(Buffer.from(value)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_RESPONSE', '服务未返回有效 JSON，未自动重试。'); }
}
export async function uploadDraft({ draft, confirmedSha256, confirmReviewed, testEndpoint, stateDir = defaultStateDir(), fetchImpl = globalThis.fetch }) {
  const { directory, manifest, payloadBytes } = await verifiedDraft({ draft, confirmedSha256, confirmReviewed, testEndpoint });
  const receiptDirectory = await ensurePrivateDir(path.join(stateDir, 'receipts'));
  const statePath = path.join(directory, 'upload-state.json');
  const state = { status: 'sending', endpoint: manifest.endpoint, review_sha256: manifest.review_sha256, started_at: new Date().toISOString() };
  try { await privateWrite(statePath, jsonBytes(state)); } catch (error) { if (error.code === 'EEXIST') fail('UPLOAD_ALREADY_ATTEMPTED', '该草稿已有发送记录。请先查看 upload-state.json；结果不明时不能自动重传或另建相同草稿上传。'); throw error; }
  try {
    const response = await fetchImpl(`${manifest.endpoint}/api/contributions`, { method: 'POST', headers: { Origin: manifest.endpoint, 'Content-Type': 'application/json' }, body: payloadBytes, redirect: 'error', signal: AbortSignal.timeout(30000) });
    const result = await responseJSON(response);
    if (!response.ok) {
      state.status = response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown'; state.http_status = response.status;
      state.error_code = /^[A-Z_]{1,60}$/.test(result?.error?.code) ? result.error.code : 'REQUEST_REJECTED';
      if (state.status === 'unknown') fail('UPLOAD_OUTCOME_UNKNOWN', `服务未确认请求结果（HTTP ${response.status}），发送记录已保留，不能自动重传。`);
      fail('REQUEST_REJECTED', `接口拒绝请求（HTTP ${response.status}，${state.error_code}）。没有自动重试。`);
    }
    const receipt = result?.receipt;
    if (response.status !== 201 || result.ok !== true || !receipt || !UUID.test(receipt.contribution_id) || !/^[A-Za-z0-9_-]{43}$/.test(receipt.withdrawal_key)) fail('INVALID_RESPONSE', '服务返回的贡献凭证无效，结果待确认；不能自动重传。');
    const receiptPath = path.join(receiptDirectory, `${receipt.contribution_id}.json`);
    await privateWrite(receiptPath, jsonBytes({ format_version: RECEIPT_FORMAT, endpoint: manifest.endpoint, contribution_id: receipt.contribution_id, withdrawal_key: receipt.withdrawal_key, created_at: receipt.created_at, consent_version: receipt.consent_version, review_sha256: manifest.review_sha256 }));
    state.receipt_path = receiptPath; state.contribution_id = receipt.contribution_id;
    if (!result.summary || !Array.isArray(result.summary.cost_results) || !Array.isArray(result.summary.quota_results)) fail('INVALID_RESPONSE', '撤回凭证已保存，但服务端摘要缺失。结果待确认，不能自动重传。');
    const summaryPath = path.join(directory, 'server-summary.json'); await privateWrite(summaryPath, jsonBytes(result.summary));
    state.status = 'succeeded'; state.summary_path = summaryPath;
    return { status: 'uploaded', contribution_id: receipt.contribution_id, receipt_path: receiptPath, summary_path: summaryPath, note: '撤回密钥只保存在私有凭证文件中，不在终端输出。' };
  } catch (error) {
    if (state.status === 'sending') state.status = 'unknown';
    if (error instanceof ClientError) throw error;
    fail('UPLOAD_OUTCOME_UNKNOWN', '网络或本地保存中断，服务端结果不明。发送记录已保留；不能自动重传，也不要另建相同草稿绕过。');
  } finally { state.finished_at = new Date().toISOString(); await privateWrite(statePath, jsonBytes(state), { overwrite: true }); }
}
export async function withdrawContribution({ receipt: receiptFile, confirmWithdraw, testEndpoint, fetchImpl = globalThis.fetch }) {
  if (confirmWithdraw !== true) fail('WITHDRAW_CONFIRMATION_REQUIRED', '只有用户明确要求撤回该贡献后，才能执行 withdraw --confirm-withdraw。');
  const file = path.resolve(receiptFile), receipt = parseJSON(await readLimited(file, 16384));
  const endpoint = resolveEndpoint(testEndpoint);
  if (!receipt || receipt.format_version !== RECEIPT_FORMAT || receipt.endpoint !== endpoint || !UUID.test(receipt.contribution_id) || !/^[A-Za-z0-9_-]{43}$/.test(receipt.withdrawal_key)) fail('RECEIPT', '凭证无效或目标与凭证端点不一致，未发送撤回请求。');
  const statePath = `${file}.withdrawal-state.json`, state = { status: 'sending', contribution_id: receipt.contribution_id, endpoint, started_at: new Date().toISOString() };
  try { await privateWrite(statePath, jsonBytes(state)); } catch (error) { if (error.code === 'EEXIST') fail('WITHDRAW_ALREADY_ATTEMPTED', '此凭证已有撤回记录，请先核对本地状态，不自动重发。'); throw error; }
  try {
    const response = await fetchImpl(`${endpoint}/api/contributions/${receipt.contribution_id}`, { method: 'DELETE', headers: { Origin: endpoint, Authorization: `Bearer ${receipt.withdrawal_key}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    const result = await responseJSON(response);
    if (response.status !== 200 || result?.ok !== true || result?.withdrawn !== true) {
      state.status = response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown'; state.http_status = response.status;
      fail(state.status === 'unknown' ? 'WITHDRAW_OUTCOME_UNKNOWN' : 'WITHDRAW_REJECTED', `撤回未获成功确认（HTTP ${response.status}），没有自动重试。`);
    }
    state.status = 'withdrawn'; return { status: 'withdrawn', contribution_id: receipt.contribution_id, note: '该贡献已停止计入公开聚合。' };
  } catch (error) { if (state.status === 'sending') state.status = 'unknown'; if (error instanceof ClientError) throw error; fail('WITHDRAW_OUTCOME_UNKNOWN', '撤回请求结果不明，请保留凭证与状态记录，不能自动重试。'); }
  finally { state.finished_at = new Date().toISOString(); await privateWrite(statePath, jsonBytes(state), { overwrite: true }); }
}

const HELP = `DSH Cost Community 本地贡献执行器（Node.js 22–24）
prepare --input <本地v2.json> --out <新草稿目录> [--test-endpoint <loopback>]
upload --draft <草稿目录> --confirmed-sha256 <用户确认版本的哈希> --confirm-reviewed [--test-endpoint <loopback>]
withdraw --receipt <私有凭证.json> --confirm-withdraw [--test-endpoint <loopback>]

prepare 只处理本地数据。先向用户展示 preview.md 与 manifest.json 对应版本；用户明确确认后，技能可读取 exact hash 执行 upload，用户不必手抄。
哈希一致不代表用户已确认。没有用户指令时，技能和插件不得自行传入确认标志。
不自动推断账单、完整周期或验收结果；不自动上传、不自动重试；默认目标为 ${PRODUCTION_ENDPOINT}。
`;
async function main(args) {
  const major = Number(process.versions.node.split('.')[0]); if (major < 22 || major > 24) fail('NODE_VERSION', '请使用 Node.js 22–24。');
  const command = args[0]; if (!command || ['help', '--help', '-h'].includes(command)) { console.log(HELP); return; }
  const specifications = { prepare: ['input', 'out', 'test-endpoint'], upload: ['draft', 'confirmed-sha256', 'confirm-reviewed', 'test-endpoint'], withdraw: ['receipt', 'confirm-withdraw', 'test-endpoint'] };
  if (!specifications[command]) fail('COMMAND', '未知命令。运行 --help 查看用法。');
  const parsed = {}, booleanFlags = ['confirm-reviewed', 'confirm-withdraw'];
  for (let index = 1; index < args.length; index++) {
    const flag = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || !specifications[command].includes(flag) || Object.hasOwn(parsed, flag)) fail('ARGUMENT', '存在未知或重复参数。');
    if (booleanFlags.includes(flag)) parsed[flag] = true;
    else { const value = args[++index]; if (!value || value.startsWith('--')) fail('ARGUMENT', `参数 --${flag} 缺少值。`); parsed[flag] = value; }
  }
  for (const required of command === 'prepare' ? ['input', 'out'] : command === 'upload' ? ['draft'] : ['receipt']) if (!parsed[required]) fail('ARGUMENT', `缺少 --${required}。`);
  const options = { ...parsed, testEndpoint: parsed['test-endpoint'], confirmedSha256: parsed['confirmed-sha256'], confirmReviewed: parsed['confirm-reviewed'], confirmWithdraw: parsed['confirm-withdraw'] };
  const result = await ({ prepare: prepareDraft, upload: uploadDraft, withdraw: withdrawContribution }[command])(options);
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const known = error instanceof ClientError || error.name === 'ValidationError';
    const output = { ok: false, code: known ? error.code : 'LOCAL_IO_ERROR', message: known ? error.message : '本地文件处理未完成。请检查输入、目录与权限；没有自动重试。' };
    console.error(JSON.stringify(output, null, 2)); process.exitCode = 1;
  });
}
