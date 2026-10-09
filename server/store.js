import pg from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { communityFromRows } from '../shared/analysis.js';
export class StorageUnavailable extends Error { constructor() { super('Persistent storage unavailable'); this.code = 'STORAGE_UNAVAILABLE'; } }
export class DuplicateContribution extends Error { constructor() { super('Duplicate contribution'); this.code = 'DUPLICATE_CONTRIBUTION'; } }
export class UnconfiguredStore {
  kind = 'unconfigured';
  async health() { return false; }
  async create() { throw new StorageUnavailable(); }
  async withdraw() { throw new StorageUnavailable(); }
  async community() { throw new StorageUnavailable(); }
  async close() {}
}
export class PgStore {
  kind = 'postgres';
  constructor(connectionString, { schema = null } = {}) {
    if (schema !== null && !/^test_[a-f0-9]{16,32}$/.test(schema)) throw new Error('Test schema name must be generated and begin with test_');
    this.testSchema = schema;
    this.pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, statement_timeout: 10000, ...(schema ? { options: `-c search_path=${schema},pg_catalog` } : {}) });
    this.pool.on('error', () => {}); // Requests expose only a stable storage error; never log connection strings.
    this.initialized = false; this.initializing = null;
  }
  async initialize() {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock($1)', [192613724]);
        // Only the controlled test constructor can create a separate schema; production uses its configured default schema.
        if (this.testSchema) await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.testSchema}"`);
        await client.query(`CREATE TABLE IF NOT EXISTS contributions (
          id uuid PRIMARY KEY, withdrawal_hash char(64) NOT NULL,
          content_fingerprint char(64) UNIQUE NOT NULL,
          dataset_kind text NOT NULL CHECK (dataset_kind = 'user_reported'),
          consent_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS quota_samples (
          id bigserial PRIMARY KEY, contribution_id uuid NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
          source_fingerprint char(64) UNIQUE NOT NULL, summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object')
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS cost_periods (
          id bigserial PRIMARY KEY, contribution_id uuid NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
          source_fingerprint char(64) UNIQUE NOT NULL, summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object')
        )`);
        await client.query('CREATE INDEX IF NOT EXISTS quota_contribution_idx ON quota_samples(contribution_id)');
        await client.query('CREATE INDEX IF NOT EXISTS cost_contribution_idx ON cost_periods(contribution_id)');
        await client.query('COMMIT'); this.initialized = true;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
    })();
    try { await this.initializing; } finally { this.initializing = null; }
  }
  async health() { try { await this.initialize(); await this.pool.query('SELECT 1'); return true; } catch { return false; } }
  async create(record) {
    try { await this.initialize(); } catch { throw new StorageUnavailable(); }
    let client;
    try {
      client = await this.pool.connect(); await client.query('BEGIN');
      const inserted = await client.query('INSERT INTO contributions(id, withdrawal_hash, content_fingerprint, dataset_kind, consent_version) VALUES ($1,$2,$3,$4,$5) RETURNING created_at', [record.id, record.withdrawalHash, record.fingerprint, 'user_reported', record.consentVersion]);
      for (let i = 0; i < record.summary.quota_results.length; i++) await client.query('INSERT INTO quota_samples(contribution_id,source_fingerprint,summary) VALUES($1,$2,$3)', [record.id, record.fingerprints.quota[i], JSON.stringify(record.summary.quota_results[i])]);
      for (let i = 0; i < record.summary.cost_results.length; i++) await client.query('INSERT INTO cost_periods(contribution_id,source_fingerprint,summary) VALUES($1,$2,$3)', [record.id, record.fingerprints.cost[i], JSON.stringify(record.summary.cost_results[i])]);
      await client.query('COMMIT'); return { created_at: inserted.rows[0].created_at.toISOString() };
    } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') throw new DuplicateContribution(); throw new StorageUnavailable(); } finally { client?.release(); }
  }
  async withdraw(id, hash) {
    try { await this.initialize(); } catch { throw new StorageUnavailable(); }
    let client;
    try {
      client = await this.pool.connect(); await client.query('BEGIN');
      const result = await client.query('SELECT withdrawal_hash FROM contributions WHERE id=$1 FOR UPDATE', [id]);
      const actual = result.rows[0]?.withdrawal_hash;
      if (!actual || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(hash, 'hex'))) { await client.query('ROLLBACK'); return false; }
      await client.query('DELETE FROM contributions WHERE id=$1', [id]); await client.query('COMMIT'); return true;
    } catch { if (client) await client.query('ROLLBACK').catch(() => {}); throw new StorageUnavailable(); } finally { client?.release(); }
  }
  async community() {
    try {
      await this.initialize();
      // One statement gives a consistent snapshot during concurrent contributions and withdrawals.
      const result = await this.pool.query(`SELECT c.id, c.dataset_kind,
        COALESCE((SELECT jsonb_agg(q.summary ORDER BY q.id) FROM quota_samples q WHERE q.contribution_id=c.id),'[]'::jsonb) AS quota_results,
        COALESCE((SELECT jsonb_agg(p.summary ORDER BY p.id) FROM cost_periods p WHERE p.contribution_id=c.id),'[]'::jsonb) AS cost_results
        FROM contributions c WHERE c.dataset_kind='user_reported' ORDER BY c.created_at,c.id`);
      return communityFromRows(result.rows.map(row => ({ id: row.id, dataset_kind: row.dataset_kind, summary: { quota_results: row.quota_results, cost_results: row.cost_results } })));
    } catch { throw new StorageUnavailable(); }
  }
  async close() { await this.pool.end(); }
}
