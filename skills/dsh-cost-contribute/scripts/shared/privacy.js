import { analyzeDataset, ValidationError, LIMITS } from './analysis.js';

export const PRIVACY_VERSION = 'local-hmac-v1';
export const PRIVACY_DATABASE = 'dsh-local-privacy-v1';
const KEY_STORE = 'keys';
const KEY_NAME = 'workflow-hmac-v1';
const TASK_ALIAS = /^task-[0-9a-f]{32}$/;
const WINDOW_ALIAS = /^window-[0-9a-f]{32}$/;
const WORKFLOW_ALIAS = /^wf-[A-Za-z0-9_-]{43}$/;
let savedKeyPromise;

function privacyError(message) { return new ValidationError('LOCAL_PRIVACY', '$', message); }
function assertKey(key) {
  if (!key || key.type !== 'secret' || key.extractable !== false || key.algorithm?.name !== 'HMAC' || key.algorithm?.hash?.name !== 'SHA-256' || key.algorithm?.length !== 256 || key.usages.length !== 1 || key.usages[0] !== 'sign') {
    throw privacyError('本地去标识密钥无效，尚未发送数据。请使用支持 Web Crypto 与 IndexedDB 的浏览器。');
  }
  return key;
}
async function readOrCreateKey(cryptoProvider, databaseProvider) {
  if (!cryptoProvider?.subtle || !databaseProvider) throw privacyError('当前浏览器无法安全保存本地去标识密钥，尚未发送数据。请使用 HTTPS 或 localhost 打开本站。');
  // Generate outside the transaction so no asynchronous crypto work can close it.
  const candidate = await cryptoProvider.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  return new Promise((resolve, reject) => {
    const request = databaseProvider.open(PRIVACY_DATABASE, 1);
    const failure = () => reject(privacyError('本地去标识密钥保存失败，尚未发送数据。请允许本站使用浏览器本地存储后重试。'));
    request.onupgradeneeded = () => request.result.createObjectStore(KEY_STORE);
    request.onerror = failure;
    request.onblocked = failure;
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(KEY_STORE, 'readwrite');
      const store = transaction.objectStore(KEY_STORE);
      let selected;
      const existing = store.get(KEY_NAME);
      existing.onsuccess = () => {
        try {
          selected = assertKey(existing.result ?? candidate);
          if (!existing.result) store.put(selected, KEY_NAME);
        } catch { transaction.abort(); }
      };
      transaction.oncomplete = () => { database.close(); resolve(selected); };
      transaction.onabort = () => { database.close(); failure(); };
      transaction.onerror = () => { /* onabort handles the failed transaction. */ };
    };
  });
}
export function localWorkflowKey() {
  // Only a non-exportable random CryptoKey persists. No source names, files or mappings.
  if (!savedKeyPromise) savedKeyPromise = readOrCreateKey(globalThis.crypto, globalThis.indexedDB).catch(error => { savedKeyPromise = undefined; throw error; });
  return savedKeyPromise;
}
function randomAlias(prefix, cryptoProvider) {
  const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Validate original IDs before aliasing; original identifiers never enter the return value. */
export async function prepareContribution(source, { workflowKey, cryptoProvider = globalThis.crypto } = {}) {
  analyzeDataset(source);
  if (!cryptoProvider?.getRandomValues) throw privacyError('当前浏览器无法生成安全随机别名，尚未发送数据。');
  const data = structuredClone(source);
  const allRows = [...data.quota_samples, ...data.cost_periods];
  const hasWorkflow = allRows.some(row => row.subject_kind === 'workflow');
  const key = hasWorkflow ? assertKey(workflowKey ?? await localWorkflowKey()) : null;
  const workflows = new Map(), windows = new Map();
  let taskCount = 0;
  for (const row of allRows) {
    if (row.subject_kind !== 'workflow') continue;
    const scope = JSON.stringify([row.provider_id, row.plan_id, row.subject_id]);
    if (!workflows.has(scope)) {
      const digest = await cryptoProvider.subtle.sign('HMAC', key, new TextEncoder().encode(`dsh-workflow-v1\0${scope}`));
      workflows.set(scope, `wf-${base64url(new Uint8Array(digest))}`);
    }
    row.subject_id = workflows.get(scope);
  }
  for (const row of data.quota_samples) {
    const scope = JSON.stringify([row.provider_id, row.plan_id, row.quota_pool_id, row.window_id]);
    if (!windows.has(scope)) windows.set(scope, randomAlias('window', cryptoProvider));
    row.window_id = windows.get(scope);
  }
  for (const period of data.cost_periods) {
    const tasks = new Map();
    for (const task of period.tasks) {
      if (!tasks.has(task.task_id)) tasks.set(task.task_id, randomAlias('task', cryptoProvider));
      task.task_id = tasks.get(task.task_id);
      taskCount++;
    }
  }
  const analysis = analyzeDataset(data);
  assertUploadAliases(data);
  if (new TextEncoder().encode(JSON.stringify(data)).length > LIMITS.bytes - 512) throw privacyError('替换别名后的数据接近 256 KiB 上限，请按完整支付周期拆分后重试。');
  return { data, analysis, privacy: { version: PRIVACY_VERSION, task_alias_count: taskCount, window_alias_count: windows.size, workflow_alias_count: workflows.size } };
}

/** Upload-only guard; local schema still accepts original local IDs for deduplication. */
export function assertUploadAliases(data) {
  const fail = path => { throw new ValidationError('LOCAL_ALIASES_REQUIRED', path, '请先使用本站的本地去标识预览：任务、窗口和工作流原标识不能直接提交。'); };
  for (const [index, row] of data.quota_samples.entries()) {
    if (!WINDOW_ALIAS.test(row.window_id)) fail(`$.quota_samples[${index}].window_id`);
    if (row.subject_kind === 'workflow' && !WORKFLOW_ALIAS.test(row.subject_id)) fail(`$.quota_samples[${index}].subject_id`);
  }
  for (const [index, row] of data.cost_periods.entries()) {
    if (row.subject_kind === 'workflow' && !WORKFLOW_ALIAS.test(row.subject_id)) fail(`$.cost_periods[${index}].subject_id`);
    for (const [taskIndex, task] of row.tasks.entries()) if (!TASK_ALIAS.test(task.task_id)) fail(`$.cost_periods[${index}].tasks[${taskIndex}].task_id`);
  }
}
