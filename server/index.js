import { createApp } from './app.js';
import { PgStore, UnconfiguredStore } from './store.js';
const port = Number(process.env.PORT || 3000);
const appOrigin = process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
const store = process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : new UnconfiguredStore();
const app = createApp({ store, appOrigin, trustProxy: process.env.RENDER ? 1 : false, anonymizationSecret: process.env.ANONYMIZATION_SECRET || null, trialExpiresAt: process.env.TRIAL_STORAGE_EXPIRES_AT || null });
const server = app.listen(port, '0.0.0.0', () => { console.log(`Application listening on port ${port}; storage=${store.kind}`); });
async function shutdown() { server.close(async () => { await store.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
