import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const example = path.join(root, "examples/quickstart");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.name.startsWith(".dev-test-") || entry.name.endsWith(".tix")) return [];
    if (["node_modules", ".wrangler", "dist-newstyle", "dist-newstyle-runtime", "test-artifacts", ".git", ".hpc"].includes(entry.name)) return [];
    return entry.isDirectory() ? files(filename) : [filename];
  }).sort();
}
function digest(filename: string): string {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}
export function buildInputs(): Record<string, string> {
  const inputs = ["cabal-wasm.project", "cabal-wasm-coverage.project", ...["cloudflare-workers", "servant-cloudflare-workers", "servant-cloudflare-workers-client", "servant-cloudflare-workers-access"].flatMap((name) => [name + "/" + name + ".cabal", ...files(path.join(root, name, "src")).map((f) => path.relative(root, f))]), ...["app", "src", "scripts", "apps", "workers", "packages", "migrations", "test/Support/Runtime"].flatMap((name) => files(path.join(example, name)).map((f) => path.relative(root, f))), ...["quickstart.cabal", "package.json", "wrangler.jsonc", "vitest.config.mts", "vitest.runtime.config.mts", "worker/wasm-exports.d.ts", "worker/quickstart-jsffi.d.mts", "worker/runtime-tests-jsffi.d.mts", "worker/wasm-module.d.ts", "tsconfig.json", "test/env.d.ts"].map((f) => "examples/quickstart/" + f)];
  inputs.push("examples/quickstart/test/Support/Coverage.hs");
  inputs.push("scripts/testing/typecheck.mjs", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json");
  inputs.push(...files(path.join(example, "worker")).filter((f) => /\.ts$/.test(f) && !f.endsWith(".d.ts")).map((f) => path.relative(root, f)));
  return Object.fromEntries([...new Set(inputs)].sort().map((name) => [name, digest(path.join(root, name))]));
}
export function captureBuildInputs(snapshot: string): void {
  writeFileSync(snapshot, JSON.stringify(buildInputs()));
}
export function writeBuild(target: string, snapshot: string): void {
  const initialInputs = JSON.parse(readFileSync(snapshot, "utf8"));
  if (JSON.stringify(initialInputs) !== JSON.stringify(buildInputs())) {
    throw new Error("Build inputs changed during compilation; rebuild before running tests");
  }
  writeFileSync(path.join(example, "worker", target + ".build.json"), JSON.stringify({ inputs: initialInputs, wasm: digest(path.join(example, "worker", target + ".wasm")), glue: digest(path.join(example, "worker/" + target + "-jsffi.mjs")) }, null, 2));
}
export function verifyBuild(target: string): void {
  const recorded = JSON.parse(readFileSync(path.join(example, "worker", target + ".build.json"), "utf8"));
  if (JSON.stringify(recorded.inputs) !== JSON.stringify(buildInputs()) || recorded.wasm !== digest(path.join(example, "worker", target + ".wasm")) || recorded.glue !== digest(path.join(example, "worker/" + target + "-jsffi.mjs"))) {
    throw new Error("Stale or modified WASM/glue: run bash scripts/build-wasm.sh");
  }
}

export function bundleFiles(directory: string): Record<string, string> {
  return Object.fromEntries(files(directory)
    .filter((filename) => path.basename(filename) !== "build-manifest.json")
    .map((filename) => [path.relative(directory, filename), digest(filename)]));
}
export function writeBundle(directory: string, initialInputs: Record<string, string>): void {
  verifyBuild("runtime-tests");
  if (JSON.stringify(initialInputs) !== JSON.stringify(buildInputs())) {
    throw new Error("Build inputs changed during bundling; rebuild the runtime and model bundle");
  }
  const outputs = bundleFiles(directory);
  if (!("harness.js" in outputs) || !Object.keys(outputs).some((name) => name.endsWith(".wasm"))) {
    throw new Error("Model bundle is missing its JavaScript or WASM artifact");
  }
  writeFileSync(path.join(directory, "build-manifest.json"), JSON.stringify({ inputs: initialInputs, outputs }, null, 2));
}
export function verifyBundle(directory: string): void {
  verifyBuild("runtime-tests");
  const recorded = JSON.parse(readFileSync(path.join(directory, "build-manifest.json"), "utf8"));
  if (JSON.stringify(recorded.inputs) !== JSON.stringify(buildInputs()) ||
      JSON.stringify(recorded.outputs) !== JSON.stringify(bundleFiles(directory))) {
    throw new Error("Stale or modified model bundle: run pnpm build:model");
  }
}
