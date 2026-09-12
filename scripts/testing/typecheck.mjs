#!/usr/bin/env node
/** Generate config-specific runtime types without committing generated libraries. */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const examples = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../examples",
);
const arguments_ = process.argv.slice(2);
const check = arguments_.includes("--check");
const names = arguments_.filter((argument) => argument !== "--check");
const selected = names.length
  ? names
  : [
      "minimal",
      "library-examples",
      "realtime",
      "workflows",
      "static-assets",
      "quickstart",
    ];
const allowed = new Set([
  "minimal",
  "library-examples",
  "realtime",
  "workflows",
  "static-assets",
  "quickstart",
]);
for (const name of selected) {
  if (!allowed.has(name)) {
    throw new Error(`Unknown example: ${name}`);
  }
  const directory = path.join(examples, name);
  mkdirSync(path.join(directory, ".wrangler/types"), { recursive: true });
  const configs =
    name === "quickstart"
      ? [
          ["wrangler.jsonc", "Env", "worker-configuration.d.ts", true],
          [
            "apps/management/wrangler.jsonc",
            "ManagementEnv",
            ".wrangler/types/management.d.ts",
            false,
          ],
          [
            "apps/export/wrangler.jsonc",
            "ExportEnv",
            ".wrangler/types/export.d.ts",
            false,
          ],
          [
            "apps/recovery/wrangler.jsonc",
            "RecoveryEnv",
            ".wrangler/types/recovery.d.ts",
            false,
          ],
          [
            "workers/aggregation/wrangler.jsonc",
            "AggregationEnv",
            ".wrangler/types/aggregation.d.ts",
            false,
          ],
          [
            "workers/export-generation/wrangler.jsonc",
            "GenerationEnv",
            ".wrangler/types/generation.d.ts",
            false,
          ],
          [
            "workers/recovery-ingest/wrangler.jsonc",
            "RecoveryIngestEnv",
            ".wrangler/types/recovery-ingest.d.ts",
            false,
          ],
          [
            "workers/maintenance/wrangler.jsonc",
            "MaintenanceEnv",
            ".wrangler/types/maintenance.d.ts",
            false,
          ],
          [
            "workers/export-coordinator/wrangler.jsonc",
            "CoordinatorEnv",
            ".wrangler/types/coordinator.d.ts",
            false,
          ],
        ]
      : [
          [
            "wrangler.jsonc",
            "Env",
            ".wrangler/types/worker-configuration.d.ts",
            true,
          ],
        ];
  for (const [executable, args] of [
    ...configs.map(([config, envInterface, output, runtime]) => [
      "wrangler",
      [
        "types",
        output,
        "--config",
        config,
        "--env-interface",
        envInterface,
        "--include-runtime",
        String(runtime),
        "--strict-vars",
        "false",
        ...(check ? ["--check"] : []),
      ],
    ]),
    ["tsc", ["--project", "tsconfig.json", "--noEmit"]],
  ]) {
    const result = spawnSync(
      path.join(examples, "quickstart/node_modules/.bin", executable),
      args,
      {
        cwd: directory,
        env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
        stdio: "inherit",
      },
    );
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
  console.log(`PASS ${name}: Wrangler types and TypeScript`);
}
