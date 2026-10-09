import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgStore, DuplicateContribution } from '../server/store.js';
import { analyzeDataset } from '../shared/analysis.js';
import { fingerprint, recordFingerprints, hashWithdrawalKey } from '../server/fingerprint.js';
import { fixture } from './fixtures.js';

// Explicit only: never fall back to DATABASE_URL. All rows live in one random test schema.
const testUrl = process.env.TEST_DATABASE_URL;
test('真实Postgres：独立随机schema内集中验证持久化、唯一约束、汇总与事务撤回', { skip: !testUrl, timeout: 60000 }, async () => {
  const schema = `test_${randomBytes(12).toString('hex')}`;
  assert.match(schema, /^test_[a-f0-9]{24}$/);
  let store = new PgStore(testUrl, { schema });
  const admin = new pg.Pool({ connectionString: testUrl, max: 1, connectionTimeoutMillis: 5000 });
  const records = [];
  try {
    assert.equal(await store.health(), true);
    assert.equal((await store.community()).totals.contributions, 0);
    for (let i = 0; i < 5; i++) {
      const data = fixture(i), key = randomBytes(32).toString('base64url');
      const record = { id: randomUUID(), withdrawalHash: hashWithdrawalKey(key), fingerprint: fingerprint(data), fingerprints: recordFingerprints(data), consentVersion: '2026-10-09', summary: analyzeDataset(data) };
      await store.create(record); records.push(record);
    }
    assert.equal((await store.community()).cost_groups[0].published, true);
    await assert.rejects(store.create({ ...records[0], id: randomUUID() }), DuplicateContribution);
    const data = fixture(8); data.quota_samples = fixture(0).quota_samples;
    await assert.rejects(store.create({ id: randomUUID(), withdrawalHash: records[0].withdrawalHash, fingerprint: fingerprint(data), fingerprints: recordFingerprints(data), consentVersion: '2026-10-09', summary: analyzeDataset(data) }), DuplicateContribution);
    assert.equal((await store.community()).totals.contributions, 5, '失败插入须回滚，不残留空贡献');
    await store.close(); store = new PgStore(testUrl, { schema });
    assert.equal((await store.community()).totals.contributions, 5, '新连接仍能读取先前记录');
    assert.equal(await store.withdraw(records[0].id, hashWithdrawalKey('wrong')), false);
    assert.equal(await store.withdraw(records[0].id, records[0].withdrawalHash), true);
    const result = await store.community(); assert.equal(result.totals.contributions, 4); assert.equal(result.cost_groups[0].metrics, null);
    const leaked = await store.pool.query('SELECT summary FROM cost_periods');
    assert.ok(!JSON.stringify(leaked.rows).includes('task_id')); assert.ok(!JSON.stringify(leaked.rows).includes('withdrawal_key'));
    const children = await store.pool.query('SELECT COUNT(*)::int AS count FROM quota_samples WHERE contribution_id=$1', [records[0].id]);
    assert.equal(children.rows[0].count, 0, '级联删除必须在同一事务完成');
  } finally {
    await store.close();
    // schema is generated above and strictly validated; never accept a user-provided identifier here.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
