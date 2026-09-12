/** Container entry: run all real-dev suites and preserve each exit status/log. */
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
const evidence = `/work/artifacts/testing/docker-suites-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
await mkdir(evidence, { recursive: true });
const results: { suite: string; exitCode: number | null; signal: string | null }[] = [];
async function testFiles(example: string) {
  const directory = `examples/${example}/test/integration`;
  const files = (await readdir(directory)).filter(name => name.endsWith(".spec.mjs")).sort();
  if (files.length === 0) throw new Error(`No integration tests found: ${directory}`);
  return files.map(name => `${directory}/${name}`);
}
for (const [suite, command] of [
  ["quickstart", ["examples/quickstart/test/Support/Dev/run.mts"]],
  ["static-assets", ["--test", "--test-concurrency=1", ...await testFiles("static-assets")]],
  ["realtime", ["--test", "--test-concurrency=1", ...await testFiles("realtime")]],
  ["workflows", ["--test", "--test-concurrency=1", ...await testFiles("workflows")]],
  ["minimal", ["--test", "--test-concurrency=1", ...await testFiles("minimal")]],
  ["library-examples", ["--test", "--test-concurrency=1", ...await testFiles("library-examples")]],
] as const) {
  let output = "";
  const child = spawn(process.execPath, [...command], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
  const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  results.push({ suite, exitCode, signal: child.signalCode });
  await writeFile(`${evidence}/${suite}.log`, output);
}
const complete = results.every((result) => result.exitCode === 0 && result.signal === null);
await writeFile(`${evidence}/results.json`, JSON.stringify({ complete, results }, null, 2));
process.exitCode = complete ? 0 : 1;
