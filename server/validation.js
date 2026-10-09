import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { analyzeDataset, ValidationError, CONSENT_VERSION } from '../shared/analysis.js';
import { assertUploadAliases } from '../shared/privacy.js';
const schema = JSON.parse(readFileSync(new URL('../shared/schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: true, allErrors: false }).compile(schema);
export function validateContribution(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['consent', 'data'].includes(key))) throw new ValidationError('REQUEST_SCHEMA', '$', '提交只接受 consent 和 data。');
  const consent = body.consent;
  if (!consent || typeof consent !== 'object' || Array.isArray(consent) || Object.keys(consent).some(key => !['accepted', 'version'].includes(key)) || consent.accepted !== true || consent.version !== CONSENT_VERSION) throw new ValidationError('CONSENT_REQUIRED', '$.consent', '请明确同意当前版本的数据贡献说明。');
  if (!validate(body.data)) {
    const error = validate.errors[0];
    throw new ValidationError(error.keyword === 'additionalProperties' ? 'UNKNOWN_FIELD' : 'SCHEMA', `$${error.instancePath}`, '数据不符合允许字段和类型要求；未接收原文件或自由文本。');
  }
  if (body.data.dataset_kind !== 'user_reported') throw new ValidationError('SYNTHETIC_NOT_ALLOWED', '$.data.dataset_kind', '构造数据仅用于本地演示，不能进入真实贡献统计。');
  const result = analyzeDataset(body.data);
  assertUploadAliases(body.data);
  return result;
}
