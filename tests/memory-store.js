// Test-only adapter. Production entry point can instantiate only PgStore or UnconfiguredStore.
import { timingSafeEqual } from 'node:crypto';
import { communityFromRows } from '../shared/analysis.js';
import { DuplicateContribution } from '../server/store.js';
export class MemoryTestStore {
  kind = 'test-memory'; records = new Map();
  async health() { return true; }
  async create(record) {
    const existing = [...this.records.values()];
    if (existing.some(r => r.fingerprint === record.fingerprint || r.fingerprints.quota.some(f => record.fingerprints.quota.includes(f)) || r.fingerprints.cost.some(f => record.fingerprints.cost.includes(f)))) throw new DuplicateContribution();
    const created_at = new Date().toISOString(); this.records.set(record.id, structuredClone({ ...record, created_at })); return { created_at };
  }
  async withdraw(id, hash) { const r = this.records.get(id); if (!r || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(r.withdrawalHash, 'hex'))) return false; this.records.delete(id); return true; }
  async community() { return communityFromRows([...this.records.values()].map(r => ({ id: r.id, dataset_kind: 'user_reported', summary: r.summary }))); }
  async close() {}
}
