import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const example = fileURLToPath(new URL("../../../", import.meta.url));
const directory = path.join(example, "test-artifacts/coverage/runtime");
const coverage = JSON.parse(readFileSync(path.join(directory, "coverage-final.json"), "utf8")) as Record<string, { s: Record<string, number>; b: Record<string, number[]> }>;
function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(name) : [name];
  });
}
const candidates = ["worker", "test", "scripts"].flatMap((name) => walk(path.join(example, name))).concat(readdirSync(example).filter((name) => /^vitest.*\.mts$/.test(name)).map((name) => path.join(example, name)));
const files = candidates.filter((name) => /\.(?:ts|mts|mjs)$/.test(name) && !/\.d\.(?:ts|mts)$/.test(name) && !/worker\/.*-jsffi\.mjs$/.test(name)).sort().map((name) => {
  const report = coverage[name];
  return { file: path.relative(example, name), status: !report ? "unmeasured" : Object.keys(report.s).length === 0 ? "no-instrumentation-points" : Object.values(report.s).some((hits) => hits > 0) ? "executed" : "unexecuted", statements: report ? { total: Object.keys(report.s).length, covered: Object.values(report.s).filter((hits) => hits > 0).length } : null, branches: report ? { total: Object.values(report.b).flat().length, covered: Object.values(report.b).flat().filter((hits) => hits > 0).length } : null };
});
writeFileSync(path.join(directory, "inventory.json"), JSON.stringify({ runtime: "workerd TypeScript/JavaScript only", wasmInternalCoverage: "unmeasured", files }, null, 2));
console.log(`Coverage inventory: ${files.length} authored files; ${files.filter((file) => file.status === "unmeasured").length} unmeasured`);
