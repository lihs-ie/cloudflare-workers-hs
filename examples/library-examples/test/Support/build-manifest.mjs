import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const inputs = ["wrangler.jobs.jsonc", "migrations", "worker/jobs-state.ts", "worker/jobs-service.ts", "worker/jobs-consumer.ts", "tsconfig.json", "../../scripts/testing/typecheck.mjs", "worker/library-examples-jsffi.d.mts", "worker/library-examples-fixtures-jsffi.d.mts", "../../pnpm-lock.yaml", "../../pnpm-workspace.yaml", "../../package.json", "package.json", "app", "src", "scripts", "test", "worker/entry.ts", "worker/runtime.ts", "library-examples.cabal", "../../cabal.project", "../../cabal-wasm.project", "../../cabal-wasm-coverage.project", "wrangler.jsonc", "wrangler.guide.jsonc", "wrangler.tail.jsonc",
  "../quickstart/package.json",
  "../../cloudflare-workers/src", "../../cloudflare-workers/shim", "../../cloudflare-workers/cloudflare-workers.cabal",
  "../../servant-cloudflare-workers/src", "../../servant-cloudflare-workers/servant-cloudflare-workers.cabal",
  "../../servant-cloudflare-workers-client/src", "../../servant-cloudflare-workers-client/servant-cloudflare-workers-client.cabal"];
function digest(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function files(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).filter(name => !name.startsWith(".dev-test-")).sort().flatMap(name => files(resolve(path, name)));
}
export function sourceHashes() {
  return Object.fromEntries(inputs.flatMap(path => files(resolve(root, path))).sort().map(path => [relative(root, path), digest(path)]));
}
function artifactHashes() {
  return Object.fromEntries(["worker/library-examples.wasm", "worker/library-examples-jsffi.mjs", "worker/library-examples-fixtures.wasm", "worker/library-examples-fixtures-jsffi.mjs"].map(path => [path, digest(resolve(root, path))]));
}
export function verifyBuild() {
  const proof = JSON.parse(readFileSync(resolve(root, "worker/build.json"), "utf8"));
  if (JSON.stringify(proof.sources) !== JSON.stringify(sourceHashes())) throw new Error("Library examples WASM is stale; run bash examples/library-examples/scripts/build.sh");
  if (JSON.stringify(proof.artifacts) !== JSON.stringify(artifactHashes())) throw new Error("Library examples WASM/glue digest mismatch");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, path] = process.argv.slice(2);
  if (operation === "capture") writeFileSync(path, JSON.stringify(sourceHashes()));
  else if (operation === "write") {
    const before = JSON.parse(readFileSync(path, "utf8"));
    const after = sourceHashes();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Library example inputs changed while compiling; rebuild");
    writeFileSync(resolve(root, "worker/build.json"), JSON.stringify({ sources: after, artifacts: artifactHashes() }, null, 2) + "\n");
  } else throw new Error("Expected capture or write");
}
