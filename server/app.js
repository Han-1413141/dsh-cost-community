import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { validateContribution } from './validation.js';
import { fingerprint, recordFingerprints, hashWithdrawalKey } from './fingerprint.js';
import { UnconfiguredStore, StorageUnavailable, DuplicateContribution } from './store.js';
import { anonymizeAnalysis, ValidationError, CONSENT_VERSION, LIMITS } from '../shared/analysis.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function error(res, status, code, message, at) { return res.status(status).json({ ok: false, error: { code, message, ...(at ? { path: at } : {}) } }); }
export function createApp({ store = new UnconfiguredStore(), appOrigin = 'http://localhost:3000', trustProxy = false, writeLimit = 30, anonymizationSecret = null, trialExpiresAt = null } = {}) {
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', trustProxy);
  const allowedOrigin = new URL(appOrigin).origin;
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"], upgradeInsecureRequests: null } }, referrerPolicy: { policy: 'no-referrer' } }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (req.get('Origin') !== allowedOrigin) return error(res, 403, 'ORIGIN_DENIED', '写入请求必须来自本站。');
    if (req.method === 'POST' && !req.is('application/json')) return error(res, 415, 'CONTENT_TYPE', '仅接受 application/json。');
    next();
  });
  const writeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: writeLimit, standardHeaders: 'draft-8', legacyHeaders: false, handler: (_req, res) => error(res, 429, 'RATE_LIMITED', '操作过于频繁，请稍后重试。') });
  app.use('/api/contributions', writeLimiter);
  app.use(express.json({ limit: LIMITS.bytes, strict: true }));
  const trial = { enabled: Boolean(trialExpiresAt), storage_expires_at: trialExpiresAt || null };
  app.get('/api/health', async (_req, res) => { const ready = await store.health(); res.json({ ok: true, status: ready ? 'ready' : 'degraded', storage: store.kind, database_available: ready, contributions_enabled: ready, workflow_contributions_enabled: ready && Boolean(anonymizationSecret), trial }); });
  app.get('/api/community', async (_req, res, next) => { try { res.json(await store.community()); } catch (e) { next(e); } });
  app.post('/api/contributions', async (req, res, next) => {
    try {
      const analysis = validateContribution(req.body);
      const eligibleIndices = analysis.quota_results.map((row, i) => row.community_eligible ? i : -1).filter(i => i >= 0);
      if (!eligibleIndices.length && !analysis.cost_results.length) throw new ValidationError('NO_COMMUNITY_ELIGIBLE_RECORDS', '$.data', '本地估算、滚动窗口或覆盖不完整的额度记录只用于个人计算，不能上传为公开比较样本。');
      if (!anonymizationSecret && [...analysis.quota_results, ...analysis.cost_results].some(row => row.subject_kind === 'workflow')) return error(res, 503, 'CONFIGURATION_REQUIRED', '工作流匿名标识服务尚未配置，本次未保存。');
      const publicRow = row => row.subject_kind !== 'workflow' ? row : { ...row, subject_id: `workflow-${createHmac('sha256', anonymizationSecret).update([row.provider_id, row.plan_id, row.subject_id].join('|')).digest('hex').slice(0, 20)}` };
      const stored = { ...analysis, quota_results: eligibleIndices.map(i => publicRow(analysis.quota_results[i])), cost_results: analysis.cost_results.map(publicRow) };
      stored.totals = { ...analysis.totals, quota_samples: stored.quota_results.length };
      const fingerprints = recordFingerprints(req.body.data); fingerprints.quota = eligibleIndices.map(i => fingerprints.quota[i]);
      const key = randomBytes(32).toString('base64url'), id = randomUUID();
      const saved = await store.create({ id, withdrawalHash: hashWithdrawalKey(key), fingerprint: fingerprint(req.body.data), fingerprints, consentVersion: CONSENT_VERSION, summary: stored });
      const receipt = { contribution_id: id, withdrawal_key: key, created_at: saved.created_at, consent_version: CONSENT_VERSION };
      res.status(201).json({ ok: true, contribution_id: id, withdrawal_key: key, receipt, summary: anonymizeAnalysis(stored) });
    } catch (e) { next(e); }
  });
  app.delete('/api/contributions/:id', async (req, res, next) => {
    try {
      const id = req.params.id, header = req.get('Authorization') || '', match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !match) return error(res, 404, 'NOT_FOUND', '贡献编号或撤回凭证无效。');
      if (!await store.withdraw(id, hashWithdrawalKey(match[1]))) return error(res, 404, 'NOT_FOUND', '贡献编号或撤回凭证无效。');
      res.json({ ok: true, withdrawn: true });
    } catch (e) { next(e); }
  });
  app.use('/api', (_req, res) => error(res, 404, 'NOT_FOUND', '接口不存在。'));
  app.use('/shared', express.static(path.join(root, 'shared'), { dotfiles: 'deny', index: false, maxAge: 0 }));
  app.use(express.static(path.join(root, 'public'), { dotfiles: 'deny', maxAge: 0 }));
  app.get(['/', '/calculator', '/contribute', '/withdraw', '/method', '/demo'], (_req, res, next) => res.sendFile(path.join(root, 'public/index.html'), err => err ? next(err) : undefined));
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return;
    if (err.type === 'entity.too.large') return error(res, 413, 'PAYLOAD_TOO_LARGE', '文件超过 256 KiB。');
    if (err.type === 'entity.parse.failed') return error(res, 400, 'INVALID_JSON', '正文不是有效 JSON。');
    if (err instanceof ValidationError) return error(res, ['CONSENT_REQUIRED', 'WORK_SUMMARY_REVIEW_REQUIRED'].includes(err.code) ? 403 : 422, err.code, err.message, err.path);
    if (err instanceof DuplicateContribution) return error(res, 409, err.code, '贡献或其中的样本已存在，请勿重复上传。');
    if (err instanceof StorageUnavailable) return error(res, 503, 'STORAGE_UNAVAILABLE', '持久数据库未配置或暂不可用，本次操作未完成。');
    if (err.code === 'ENOENT') return error(res, 404, 'NOT_FOUND', '页面尚未部署。');
    return error(res, 500, 'INTERNAL_ERROR', '服务暂时无法完成操作。');
  });
  return app;
}
