// Isolated local fixtures only. No production network access or production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, stat, access, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareDraft, uploadDraft, withdrawContribution, resolveEndpoint, PRODUCTION_ENDPOINT } from '../client/dsh-cost-contribute.mjs';
import { createApp } from '../server/app.js';
import { MemoryTestStore } from './memory-store.js';
import { fixture } from './fixtures.js';
import { CONSENT_VERSION } from '../shared/analysis.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
const absent = async file => { try { await access(file); return false; } catch (error) { if (error.code !== 'ENOENT') throw error; return true; } };
async function withTemp(fn) {
  const parent = path.resolve(tmpdir()), directory = await mkdtemp(path.join(parent, 'dsh-cost-client-'));
  try { return await fn(directory); }
  finally {
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), parent); assert.ok(path.basename(absolute).startsWith('dsh-cost-client-'));
    await rm(absolute, { recursive: true, force: true });
  }
}
function workflowFixture() {
  const data = fixture();
  for (const row of [...data.quota_samples, ...data.cost_periods]) { row.subject_kind = 'workflow'; row.subject_id = 'original-private-workflow'; }
  data.quota_samples[0].window_id = 'original-private-window';
  data.cost_periods[0].tasks.forEach((task, i) => { task.task_id = `original-private-task-${i}`; });
  data.cost_periods[0].tasks[0].work_summary = { function_category: 'api', code_change_band: '51_200', difficulty: 'medium' };
  data.cost_periods[0].tasks[2].work_summary = { function_category: 'testing', code_change_band: '1_50', difficulty: 'medium' };
  return data;
}
async function listen(handler) {
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, endpoint: `http://127.0.0.1:${server.address().port}` };
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('prepare 只本地处理，原标识不进草稿；稳定工作流别名、完整字段预览及私有密钥', async () => withTemp(async directory => {
  const input = path.join(directory, 'input.json'), stateDir = path.join(directory, 'private-state');
  await save(input, workflowFixture()); let network = 0;
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => { network++; throw new Error('network forbidden'); };
  let first, second;
  try {
    first = await prepareDraft({ input, out: path.join(directory, 'draft-1'), stateDir });
    second = await prepareDraft({ input, out: path.join(directory, 'draft-2'), stateDir });
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(network, 0); assert.equal(first.network_requests, 0);
  const bytes = await readFile(path.join(first.draft, 'payload.json')), payload = JSON.parse(bytes), manifest = await json(path.join(first.draft, 'manifest.json'));
  const preview = await readFile(first.preview, 'utf8'), repeated = await json(path.join(second.draft, 'payload.json'));
  assert.equal(bytes.includes(Buffer.from('original-private')), false); assert.equal(preview.includes('original-private'), false);
  assert.equal(JSON.stringify(manifest).includes(input), false);
  assert.equal(manifest.payload_sha256, hash(bytes)); assert.equal(manifest.preview_sha256, hash(Buffer.from(preview))); assert.equal(manifest.review_sha256, first.review_sha256);
  assert.equal(manifest.endpoint, PRODUCTION_ENDPOINT); assert.equal(manifest.consent_version, CONSENT_VERSION);
  assert.deepEqual(payload.consent, { accepted: true, version: CONSENT_VERSION, work_summary_reviewed: true });
  assert.match(payload.data.cost_periods[0].subject_id, /^wf-[A-Za-z0-9_-]{43}$/);
  assert.equal(payload.data.cost_periods[0].subject_id, repeated.data.cost_periods[0].subject_id);
  assert.equal(payload.data.cost_periods[0].subject_id, payload.data.quota_samples[0].subject_id);
  assert.notEqual(payload.data.cost_periods[0].tasks[0].task_id, repeated.data.cost_periods[0].tasks[0].task_id);
  assert.ok(preview.includes('已验收 2 项') && preview.includes('未验收 1 项') && preview.includes('重试 2 次'));
  assert.ok(preview.includes('API 接口 | 51—200 行 | 中等') && preview.includes('测试套件通过') && preview.includes('常规付款'));
  const humanPreview = preview.split('## 完整实际请求')[0];
  assert.ok(humanPreview.includes('| 周期1-任务3 | 未通过 | 2 |'));
  assert.equal(humanPreview.includes(payload.data.cost_periods[0].tasks[0].task_id), false);
  for (const field of ['test_suite_passed', 'payment_category', 'price_snapshot_id', 'reasoning_in_output', 'work_summary', 'refund_cny']) assert.ok(preview.includes(field));
  const embedded = preview.split('```json\n')[1].split('\n```')[0]; assert.deepEqual(JSON.parse(embedded), payload);
  assert.deepEqual((await readdir(first.draft)).sort(), ['manifest.json', 'payload.json', 'preview.md']);
  assert.equal((await stat(path.join(stateDir, 'workflow-hmac-key-v1.bin'))).size, 32);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(stateDir, 'workflow-hmac-key-v1.bin'))).mode & 0o777, 0o600);
}));

test('仅额度 prepare 明确未提供验收与实付数据，不生成零任务统计', async () => withTemp(async directory => {
  const data = fixture(); data.cost_periods = [];
  const input = path.join(directory, 'quota-only.json'); await save(input, data);
  const originalFetch = globalThis.fetch; let network = 0;
  globalThis.fetch = async () => { network++; throw new Error('network forbidden'); };
  let prepared;
  try { prepared = await prepareDraft({ input, out: path.join(directory, 'draft'), stateDir: path.join(directory, 'private-state') }); }
  finally { globalThis.fetch = originalFetch; }
  const preview = await readFile(prepared.preview, 'utf8'), payload = await json(path.join(prepared.draft, 'payload.json'));
  assert.equal(network, 0); assert.equal(prepared.network_requests, 0);
  assert.ok(preview.includes('本次仅包含额度观察，未提供任务验收与账单实付数据。'));
  for (const phrase of ['已验收 0', '未验收 0', '全部尝试 0', '重试 0', '验收与任务统计']) assert.equal(preview.includes(phrase), false);
  assert.deepEqual(payload.data.cost_periods, []); assert.equal(payload.data.quota_samples.length, 1);
  assert.deepEqual(JSON.parse(preview.split('```json\n')[1].split('\n```')[0]), payload);
}));

test('敏感字段、重复任务和缺少账单/验收不能被去标识或猜测补齐', async () => withTemp(async directory => {
  const variants = [
    ['sensitive', data => { data.cost_periods[0].tasks[0].api_key = 'never-output-this-value'; }, 'UNKNOWN_FIELD'],
    ['duplicate', data => { data.cost_periods[0].tasks[1].task_id = data.cost_periods[0].tasks[0].task_id; }, 'DUPLICATE'],
    ['missing-paid', data => { delete data.cost_periods[0].costs; }, 'MISSING_FIELD'],
    ['missing-accepted', data => { delete data.cost_periods[0].tasks[0].accepted; }, 'MISSING_FIELD'],
    ['observations', data => { data.schema_version = 'dsh-observations-1'; data.dataset_kind = 'local_observations'; }, 'ENUM']
  ];
  for (const [name, alter, code] of variants) {
    const data = workflowFixture(); alter(data); const input = path.join(directory, `${name}.json`), out = path.join(directory, `${name}-draft`), stateDir = path.join(directory, 'private-state');
    await save(input, data);
    await assert.rejects(prepareDraft({ input, out, stateDir }), error => error.code === code && !error.message.includes('never-output-this-value'));
    assert.equal(await absent(out), true); assert.equal(await absent(stateDir), true);
  }
}));

test('明确确认与当前哈希缺一不可；payload/预览/端点变化及构造数据在联网前拒绝', async () => withTemp(async directory => {
  const input = path.join(directory, 'input.json'), stateDir = path.join(directory, 'private-state'); await save(input, fixture());
  const draft = await prepareDraft({ input, out: path.join(directory, 'draft'), stateDir }); let network = 0;
  const fetchImpl = async () => { network++; throw new Error('network forbidden'); };
  const options = { draft: draft.draft, confirmedSha256: draft.review_sha256, confirmReviewed: true, stateDir, fetchImpl };
  await assert.rejects(uploadDraft({ ...options, confirmReviewed: false }), { code: 'USER_CONFIRMATION_REQUIRED' });
  await assert.rejects(uploadDraft({ ...options, confirmedSha256: undefined }), { code: 'USER_CONFIRMATION_REQUIRED' });
  await assert.rejects(uploadDraft({ ...options, confirmedSha256: '0'.repeat(64) }), { code: 'REVIEW_CHANGED' });
  await assert.rejects(uploadDraft({ ...options, testEndpoint: 'http://127.0.0.1:39999' }), { code: 'ENDPOINT_MISMATCH' });
  const payloadPath = path.join(draft.draft, 'payload.json'), bytes = await readFile(payloadPath);
  await writeFile(payloadPath, Buffer.concat([bytes, Buffer.from('\n')]));
  await assert.rejects(uploadDraft(options), { code: 'REVIEW_CHANGED' }); await writeFile(payloadPath, bytes);
  await writeFile(draft.preview, 'changed reviewed content', 'utf8'); await assert.rejects(uploadDraft(options), { code: 'REVIEW_CHANGED' });
  const syntheticInput = path.join(directory, 'synthetic.json'); await save(syntheticInput, fixture(0, 'synthetic'));
  const synthetic = await prepareDraft({ input: syntheticInput, out: path.join(directory, 'synthetic'), stateDir });
  await assert.rejects(uploadDraft({ ...options, draft: synthetic.draft, confirmedSha256: synthetic.review_sha256 }), { code: 'SYNTHETIC_NOT_ALLOWED' });
  assert.equal(network, 0); assert.equal(await absent(path.join(draft.draft, 'upload-state.json')), true);
  assert.equal(await absent(stateDir), true);
  for (const endpoint of ['https://example.com', 'http://localhost:1234', 'http://127.0.0.1:1234/api', 'http://name:pass@127.0.0.1:1234', 'https://127.0.0.1:1234']) assert.throws(() => resolveEndpoint(endpoint), { code: 'ENDPOINT' });
  assert.equal(resolveEndpoint('http://[::1]:1234'), 'http://[::1]:1234');
}));

test('隔离真实 HTTP：本地确认后保存服务端摘要和私密凭证，显式撤回后聚合归零', async () => withTemp(async directory => {
  const store = new MemoryTestStore(), requests = [], sentBodies = []; let app;
  const { server, endpoint } = await listen((req, res) => {
    // Observe headers without putting the body stream into flowing mode before
    // Express's async middleware has installed its JSON parser.
    requests.push({ method: req.method, url: req.url, origin: req.headers.origin }); app(req, res);
  });
  app = createApp({ store, appOrigin: endpoint, anonymizationSecret: 'isolated-client-test-secret' });
  try {
    const input = path.join(directory, 'input.json'), stateDir = path.join(directory, 'private-state'); await save(input, workflowFixture());
    const prepared = await prepareDraft({ input, out: path.join(directory, 'draft'), stateDir, testEndpoint: endpoint }); assert.equal(requests.length, 0);
    const fetchImpl = (url, options) => { sentBodies.push(Buffer.from(options.body).toString('utf8')); return fetch(url, options); };
    const options = { draft: prepared.draft, confirmedSha256: prepared.review_sha256, confirmReviewed: true, stateDir, testEndpoint: endpoint, fetchImpl };
    const result = await uploadDraft(options), receipt = await json(result.receipt_path), savedSummary = await json(result.summary_path);
    assert.equal(result.status, 'uploaded'); assert.equal(store.records.size, 1); assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].origin, endpoint); assert.equal(sentBodies[0].includes('original-private'), false);
    assert.deepEqual(JSON.parse(sentBodies[0]), await json(path.join(prepared.draft, 'payload.json')));
    assert.equal(savedSummary.cost_results[0].accepted_tasks, 2); assert.equal(savedSummary.cost_results[0].attempted_tasks, 3); assert.equal(savedSummary.cost_results[0].retry_attempts, 2); assert.equal(savedSummary.cost_results[0].net_paid_cny, 170); assert.equal(savedSummary.cost_results[0].work_summary_counts.summarized_tasks, 2);
    assert.match(savedSummary.cost_results[0].subject_id, /^workflow-[a-f0-9]{20}$/);
    assert.equal(JSON.stringify(savedSummary).includes('task_id'), false); assert.equal(JSON.stringify([...store.records.values()]).includes('original-private'), false);
    assert.equal(JSON.stringify(result).includes(receipt.withdrawal_key), false); assert.equal(JSON.stringify(await json(path.join(prepared.draft, 'upload-state.json'))).includes(receipt.withdrawal_key), false);
    assert.equal(path.dirname(result.receipt_path), path.join(stateDir, 'receipts'));
    await assert.rejects(uploadDraft(options), { code: 'UPLOAD_ALREADY_ATTEMPTED' }); assert.equal(requests.length, 1);
    await assert.rejects(withdrawContribution({ receipt: result.receipt_path, testEndpoint: endpoint }), { code: 'WITHDRAW_CONFIRMATION_REQUIRED' }); assert.equal(requests.length, 1);
    const withdrawn = await withdrawContribution({ receipt: result.receipt_path, confirmWithdraw: true, testEndpoint: endpoint });
    assert.equal(withdrawn.status, 'withdrawn'); assert.equal(requests.length, 2); assert.equal(requests[1].method, 'DELETE'); assert.equal(requests[1].origin, endpoint);
    assert.equal(store.records.size, 0); assert.equal((await store.community()).totals.contributions, 0);
    assert.equal((await json(`${result.receipt_path}.withdrawal-state.json`)).status, 'withdrawn');
  } finally { await close(server); }
}));

test('重定向与网络失败保留 unknown，原草稿不能自动重传', async () => withTemp(async directory => {
  let redirectedRequests = 0, originalRequests = 0;
  const trap = await listen((_req, res) => { redirectedRequests++; res.writeHead(200).end('{}'); });
  const redirect = await listen((_req, res) => { originalRequests++; res.writeHead(307, { Location: `${trap.endpoint}/unexpected` }).end(); });
  try {
    const input = path.join(directory, 'input.json'), stateDir = path.join(directory, 'private-state'); await save(input, fixture());
    const draft = await prepareDraft({ input, out: path.join(directory, 'draft'), stateDir, testEndpoint: redirect.endpoint });
    const options = { draft: draft.draft, confirmedSha256: draft.review_sha256, confirmReviewed: true, stateDir, testEndpoint: redirect.endpoint };
    await assert.rejects(uploadDraft(options), { code: 'UPLOAD_OUTCOME_UNKNOWN' }); assert.equal(originalRequests, 1); assert.equal(redirectedRequests, 0);
    assert.equal((await json(path.join(draft.draft, 'upload-state.json'))).status, 'unknown');
    await assert.rejects(uploadDraft(options), { code: 'UPLOAD_ALREADY_ATTEMPTED' }); assert.equal(originalRequests, 1);
    const failed = await prepareDraft({ input, out: path.join(directory, 'failure'), stateDir, testEndpoint: redirect.endpoint }); let calls = 0;
    const failing = { ...options, draft: failed.draft, confirmedSha256: failed.review_sha256, fetchImpl: async () => { calls++; throw new TypeError('simulated disconnect'); } };
    await assert.rejects(uploadDraft(failing), { code: 'UPLOAD_OUTCOME_UNKNOWN' }); await assert.rejects(uploadDraft(failing), { code: 'UPLOAD_ALREADY_ATTEMPTED' }); assert.equal(calls, 1);
  } finally { await close(redirect.server); await close(trap.server); }
}));
