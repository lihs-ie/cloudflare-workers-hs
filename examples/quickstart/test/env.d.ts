import type { applyD1Migrations } from "cloudflare:test";
import type { ExportCoordinator } from "../worker/export-coordinator.js";
import type { StorageHarness } from "./Support/Runtime/harness.js";

// Bindings supplied by the production and runtime Vitest configurations.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      EXPORTS: R2Bucket;
      CLICKS: Queue;
      EXPORT_QUEUE: Queue;
      COORDINATOR: DurableObjectNamespace<ExportCoordinator>;
      TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
      RUNTIME_DB: D1Database;
      STORAGE: DurableObjectNamespace<StorageHarness>;
    }
  }
}
