import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync } from "node:fs";
import { buildInputs, verifyBuild, writeBundle } from "./build-manifest.mts";

const example = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("../../../test-artifacts/runtime-bundle/", import.meta.url));
verifyBuild("runtime-tests");
const inputs = buildInputs();
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const result = spawnSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--config", "test/Support/Runtime/wrangler.jsonc", "--outdir", output], { cwd: example, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Model bundling failed (${result.status ?? result.signal})`);
writeBundle(output, inputs);
