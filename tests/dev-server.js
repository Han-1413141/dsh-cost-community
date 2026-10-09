// Isolated browser-integration instance. Never use this file as a Render start command.
import { createApp } from '../server/app.js';
import { MemoryTestStore } from './memory-store.js';
const port = Number(process.env.TEST_PORT || 4317), origin = `http://127.0.0.1:${port}`;
const app = createApp({ store: new MemoryTestStore(), appOrigin: origin, anonymizationSecret: 'isolated-browser-test-only-not-a-production-secret', trialExpiresAt: '2026-11-08T09:11:00Z', writeLimit: 100 });
const server = app.listen(port, '127.0.0.1', () => console.log(`ISOLATED TEST INSTANCE: ${origin}; empty in-memory data; no database connection`));
process.on('SIGTERM', () => server.close()); process.on('SIGINT', () => server.close());
