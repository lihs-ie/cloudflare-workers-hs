import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { verifyBuild } from "./test/Support/Runtime/build-manifest.mts";
import { accessTeam, accessAudience, jwksURL } from "./test/Support/Production/auth.js";

export default defineConfig(async () => {
  verifyBuild("quickstart");
  const migrations = await readD1Migrations("./migrations");
  return {
    define: process.env.WASM_COVERAGE_ENDPOINT ? { WASM_COVERAGE_ENDPOINT: JSON.stringify(process.env.WASM_COVERAGE_ENDPOINT) } : {},
    plugins: [cloudflareTest({
      main: "./worker/export-coordinator.ts",
      wrangler: { configPath: "./apps/management/wrangler.jsonc" },
      miniflare: {
        durableObjects: { COORDINATOR: { className: "ExportCoordinator", useSQLite: true } },
        d1Databases: ["DB"], r2Buckets: ["EXPORTS"], queueProducers: ["CLICKS", "EXPORT_QUEUE"],
        bindings: { TEST_MIGRATIONS: migrations, ACCESS_TEAM: accessTeam, ACCESS_AUDIENCE: accessAudience, ACCESS_JWKS_URL: jwksURL },
      },
    })],
    test: {
      include: ["test/integration/production/**/*.spec.ts"],
      passWithNoTests: false, retry: 0, fileParallelism: false,
      coverage: {
        provider: "custom" as const,
        customProviderModule: "./test/Support/Coverage/provider.mjs",
        reportsDirectory: "test-artifacts/coverage/production",
        reporter: ["text", "json", "json-summary", "html"],
        // Shared Fixtures are canonical in the runtime report. Node-only
        // helpers are measured with c8, never merged across different maps.
        include: ["worker/**/*.ts", "test/integration/production/**/*.ts", "test/Support/Production/**/*.ts"],
        exclude: ["**/*.d.ts", "**/*.d.mts"],
        reportOnFailure: true,
      },
    },
  };
});
