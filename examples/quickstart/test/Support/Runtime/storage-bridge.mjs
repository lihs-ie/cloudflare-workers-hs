import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBundle } from "./build-manifest.mts";
import { Miniflare, Log, LogLevel } from "miniflare";

// A fresh runtime per invocation also resets state for every shrink candidate.
const bundle = process.env.RUNTIME_MODEL_BUNDLE
  ? resolve(process.env.RUNTIME_MODEL_BUNDLE)
  : fileURLToPath(
      new URL(
        "../../../test-artifacts/runtime-bundle/harness.js",
        import.meta.url,
      ),
    );
verifyBundle(dirname(bundle));
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const input = Buffer.concat(chunks).toString("utf8");
JSON.parse(input);
const timeout = setTimeout(() => {
  process.stderr.write("Storage model runtime exceeded 60 seconds\n");
  process.exit(1);
}, 60_000);
try {
  const runtime = new Miniflare({
    log: new Log(LogLevel.NONE),
    handleRuntimeStdio: (stdout, stderr) => {
      stdout.pipe(process.stderr, { end: false });
      stderr.pipe(process.stderr, { end: false });
    },
    modules: true,
    scriptPath: bundle,
    modulesRoot: dirname(bundle),
    modulesRules: [
      { type: "CompiledWasm", include: ["**/*.wasm"], fallthrough: true },
    ],
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      STORAGE: { className: "StorageHarness", useSQLite: true },
    },
  });
  try {
    const response = await runtime.dispatchFetch(
      "https://model.test/__model/storage",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: input,
      },
    );
    if (!response.ok) {
      throw new Error(
        `Model harness returned ${response.status}: ${await response.text()}`,
      );
    }
    const result = await response.json();
    process.stdout.write(JSON.stringify(result));
  } finally {
    await runtime.dispose();
  }
} finally {
  clearTimeout(timeout);
}
