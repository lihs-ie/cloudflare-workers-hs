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
const suites = [
  ["quickstart", ["examples/quickstart/test/Support/Dev/run.mts"]],
  ["static-assets", ["--test", "--test-concurrency=1", ...await testFiles("static-assets")]],
  ["realtime", ["--test", "--test-concurrency=1", ...await testFiles("realtime")]],
  ["workflows", ["--test", "--test-concurrency=1", ...await testFiles("workflows")]],
  ["minimal", ["--test", "--test-concurrency=1", ...await testFiles("minimal")]],
  ["library-examples", ["--test", "--test-concurrency=1", ...await testFiles("library-examples")]],
] as const;
// Separate examples have isolated ports/state; keep files within each suite serial.
const executions = suites.map(async ([suite, command]) => {
  let output = "";
  const child = spawn(process.execPath, [...command], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
  const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  await writeFile(`${evidence}/${suite}.log`, output);
  return { suite, exitCode, signal: child.signalCode };
});
// Drain every child before reporting a launch failure or finishing the container.
const settled = await Promise.allSettled(executions);
for (const result of settled) {
  if (result.status === "rejected") throw result.reason;
  results.push(result.value);
}
const complete = results.every((result) => result.exitCode === 0 && result.signal === null);
await writeFile(`${evidence}/results.json`, JSON.stringify({ complete, results }, null, 2));
process.exitCode = complete ? 0 : 1;
