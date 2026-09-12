import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const inputs = ["tsconfig.json", "../../scripts/testing/typecheck.mjs", "worker/minimal-worker-jsffi.d.mts", "../../pnpm-lock.yaml", "../../pnpm-workspace.yaml", "../../package.json", "package.json", "app", "src", "scripts", "test", "worker/index.ts", "worker/runtime.ts", "minimal-worker.cabal", "../../cabal.project", "../../cabal-wasm.project", "../../cabal-wasm-coverage.project", "wrangler.jsonc",
  "../quickstart/package.json",
  "../../cloudflare-workers/src", "../../cloudflare-workers/shim", "../../cloudflare-workers/cloudflare-workers.cabal",
  "../../servant-cloudflare-workers/src", "../../servant-cloudflare-workers/servant-cloudflare-workers.cabal"];
function digest(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function files(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).filter(name => !name.startsWith(".dev-test-")).sort().flatMap(name => files(resolve(path, name)));
}
export function sourceHashes() {
  return Object.fromEntries(inputs.flatMap(path => files(resolve(root, path))).sort().map(path => [relative(root, path), digest(path)]));
}
function artifactHashes() {
  return Object.fromEntries(["worker/minimal-worker.wasm", "worker/minimal-worker-jsffi.mjs"].map(path => [path, digest(resolve(root, path))]));
}
export function verifyBuild() {
  const proof = JSON.parse(readFileSync(resolve(root, "worker/build.json"), "utf8"));
  if (JSON.stringify(proof.sources) !== JSON.stringify(sourceHashes())) throw new Error("Minimal worker WASM is stale; run bash examples/minimal/scripts/build.sh");
  if (JSON.stringify(proof.artifacts) !== JSON.stringify(artifactHashes())) throw new Error("Minimal worker WASM/glue digest mismatch");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, path] = process.argv.slice(2);
  if (operation === "capture") writeFileSync(path, JSON.stringify(sourceHashes()));
  else if (operation === "write") {
    const before = JSON.parse(readFileSync(path, "utf8"));
    const after = sourceHashes();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Minimal worker inputs changed while compiling; rebuild");
    writeFileSync(resolve(root, "worker/build.json"), JSON.stringify({ sources: after, artifacts: artifactHashes() }, null, 2) + "\n");
  } else throw new Error("Expected capture or write");
}
