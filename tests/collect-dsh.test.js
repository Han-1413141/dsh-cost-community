import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { collectDshObservations, runCollectorCli } from '../client/collect-dsh.mjs';

test('DSH 本地采集：范围内日汇总一次、明细不叠加、缺项不猜、私人字段不导出、不改账本且零网络', async () => {
  const secret = 'DO-NOT-EXPORT-secret-value';
  const privateId = 'original-session-id-private';
  const privateKey = 'private-provider:/Users/private/project/key';
  const bucket = (input, output, calls, cost, apiCost) => ({ input, output, cacheRead: 3, cacheWrite: 1, reasoning: 2, calls, cost, apiCost });
  const first = bucket(100, 20, 2, 0.4, 0.3);
  const second = bucket(50, 10, 1, 0.2, 0.2);
  const ledger = {
    version: 1, config: { apiKey: secret, path: '/private/config', currency: 'CNY' }, balanceRef: { secret },
    planSamples: { secret }, days: {
      '2026-09-30': { ...bucket(999, 999, 99, 999, 999), date: '2026-09-30' },
      '2026-10-01': { ...first, date: '2026-10-01', title: secret, api_key: secret,
        byProviderModel: { [privateKey]: { ...first, secret, path: '/private/model' } },
        sessions: [{ ...first, id: privateId, title: secret, at: 1234567890, path: '/private/session', byProviderModel: { [privateKey]: { ...first, secret } } }] },
      '2026-10-02': { ...second, date: '2026-10-02', byProviderModel: { [privateKey]: second }, sessions: [{ ...second, id: privateId, byProviderModel: { [privateKey]: second } }] },
      '2026-10-03': { ...bucket(777, 777, 77, 777, 777), date: '2026-10-03' },
    },
  };
  const original = JSON.stringify(ledger);
  const draft = collectDshObservations(ledger, { start: '2026-10-01', end: '2026-10-02' });
  assert.equal(JSON.stringify(ledger), original);
  assert.equal(draft.schema_version, 'dsh-observations-1');
  assert.equal(draft.dataset_kind, 'local_observations');
  assert.equal(draft.upload_ready, false);
  assert.equal(draft.totals.input_tokens, 150);
  assert.equal(draft.totals.output_tokens, 30);
  assert.equal(draft.totals.model_call_count, 3);
  assert.equal(draft.totals.reasoning_tokens, 4);
  assert.ok(Math.abs(draft.totals.api_equivalent_usd - 0.6) < 1e-12);
  assert.equal(draft.totals.recorded_api_cost_estimate_usd, 0.5);
  assert.deepEqual(draft.observations.map(row => row.date), ['2026-10-01', '2026-10-02']);
  assert.equal(draft.observations[0].sessions[0].session_ref, draft.observations[1].sessions[0].session_ref);
  assert.equal(draft.observations[0].provider_models[0].provider_model_ref, draft.observations[1].provider_models[0].provider_model_ref);
  assert.equal(draft.coverage.complete_period, null);
  assert.equal(draft.semantics.normalized_total_tokens, null);
  assert.equal(draft.semantics.currency, 'USD');
  const encoded = JSON.stringify(draft);
  for (const forbidden of [secret, privateId, privateKey, '/private/', '1234567890', '"title"', '"config"', '"api_key"', '"tasks"', '"attempt_count"']) assert.ok(!encoded.includes(forbidden), forbidden);

  const missingLedger = structuredClone(ledger);
  delete missingLedger.days['2026-10-02'].apiCost;
  missingLedger.days['2026-10-02'].reasoning = null;
  missingLedger.days['2026-10-02'].output = '10';
  const missing = collectDshObservations(missingLedger, { start: '2026-10-01', end: '2026-10-04' });
  assert.equal(missing.totals.recorded_api_cost_estimate_usd, null);
  assert.equal(missing.totals.reasoning_tokens, null);
  assert.equal(missing.totals.output_tokens, null);
  assert.equal(missing.coverage.days_without_records, 1);
  assert.ok(missing.missing.some(item => item.scope === 'day-2' && item.field === 'recorded_api_cost_estimate_usd'));
  assert.throws(() => collectDshObservations(ledger, { start: '2026-02-30', end: '2026-03-01' }), { code: 'DATE_RANGE' });
  assert.throws(() => collectDshObservations({ version: 2, days: {} }, { start: '2026-10-01', end: '2026-10-02' }), { code: 'LEDGER_FORMAT' });

  const root = await mkdtemp(join(tmpdir(), 'dsh-collector-fixture-'));
  const ledgerDirectory = join(root, 'storages', 'cost-meter');
  const ledgerFile = join(ledgerDirectory, 'ledger.json');
  await mkdir(ledgerDirectory, { recursive: true });
  await writeFile(ledgerFile, original, 'utf8');
  let networkCalls = 0;
  const blocked = () => { networkCalls += 1; throw new Error('Network must not be used'); };
  const restored = [];
  for (const [object, key] of [[globalThis, 'fetch'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [net, 'connect'], [net, 'createConnection'], [tls, 'connect']]) {
    const old = object[key]; object[key] = blocked; restored.push(() => { object[key] = old; });
  }
  const output = [], errors = [];
  const io = { env: { DSH_HOME: root }, stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) } };
  try {
    const draftFile = join(root, 'observations.json');
    assert.equal(await runCollectorCli(['--start', '2026-10-01', '--end', '2026-10-02', '--out', draftFile], io), 0);
    assert.deepEqual(JSON.parse(await readFile(draftFile, 'utf8')), draft);
    assert.equal(await readFile(ledgerFile, 'utf8'), original);
    assert.equal(await runCollectorCli(['--dsh-home', root, '--start', '2026-10-01', '--end', '2026-10-02', '--out', ledgerFile], io), 1);
    assert.equal(await readFile(ledgerFile, 'utf8'), original);
    assert.equal(await runCollectorCli(['--start', '2026-10-01', '--end', '2026-10-02', '--out', draftFile], { ...io, env: {} }), 1);
    assert.equal(networkCalls, 0);
    for (const value of [...output, ...errors]) for (const forbidden of [root, secret, privateId, privateKey]) assert.ok(!value.includes(forbidden));
    assert.ok(errors.some(line => JSON.parse(line).error === 'OUTPUT_WRITE'));
    assert.ok(errors.some(line => JSON.parse(line).error === 'DSH_HOME_REQUIRED'));
  } finally {
    for (const restore of restored) restore();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(basename(root), /^dsh-collector-fixture-/);
    await rm(root, { recursive: true, force: true });
  }
});
