import type { applyD1Migrations } from 'cloudflare:test';
import type { StorageHarness } from './harness.js';

declare global {
  namespace Cloudflare {
    interface Env {
      RUNTIME_DB: D1Database;
      STORAGE: DurableObjectNamespace<StorageHarness>;
      TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
    }
  }
}
