import assert from "node:assert/strict";
import { mock, test } from "node:test";
const pack = new URL("../pack-consumer.mjs", import.meta.url);
const typecheck = new URL("../typecheck.mjs", import.meta.url);
let serial = 0;

for (const scenario of ["success", "spawn-error", "exit-failure", "no-archive"]) {
  test(`pack consumer contains ${scenario} and always removes its isolated workspace`, async () => {
    const calls = [];
    const error = new Error("spawn denied");
    const processes = mock.module("node:child_process", { namedExports: { spawnSync(command, args, options) {
      calls.push({ command, args, options });
      if (scenario === "spawn-error") { return { error }; }
      return { status: scenario === "exit-failure" ? 2 : 0 };
    } } });
    let removed;
    const files = mock.module("node:fs", { namedExports: {
      mkdtempSync() { return "/isolated-fixture"; }, readFileSync() { return "readme"; },
      readdirSync() { return scenario === "no-archive" ? [] : ["package.tgz"]; },
      rmSync(path, options) { removed = { path, options }; }, writeFileSync() {},
    } });
    try {
      const operation = import(pack.href + `?fixture=${++serial}`);
      if (scenario === "success") { await operation; assert.equal(calls.length, 4); }
      else { await assert.rejects(operation, scenario === "spawn-error" ? error : /failed|archive/); }
      assert.deepEqual(removed, { path: "/isolated-fixture", options: { recursive: true, force: true } });
    } finally { files.restore(); processes.restore(); }
  });
}

for (const scenario of ["all", "selected-check", "unknown", "spawn-error", "exit-failure", "signal-exit"]) {
  test(`typecheck command preserves ${scenario} outcome`, async () => {
    const previous = process.argv;
    const calls = [];
    const exit = new Error("exited");
    const originalExit = process.exit;
    const error = new Error("cannot spawn");
    const directories = mock.module("node:fs", { namedExports: { mkdirSync() {} } });
    const processes = mock.module("node:child_process", { namedExports: { spawnSync(command, args, options) {
      calls.push({ command, args, options });
      if (scenario === "spawn-error") { return { error }; }
      return { status: scenario === "exit-failure" ? 2 : scenario === "signal-exit" ? null : 0 };
    } } });
    let exitCode;
    process.exit = (code) => { exitCode = code; throw exit; };
    process.argv = [process.execPath, typecheck.pathname, ...(scenario === "all" ? [] : scenario === "unknown" ? ["../invalid"] : ["minimal", "--check"])];
    try {
      const operation = import(typecheck.href + `?fixture=${++serial}`);
      if (["all", "selected-check"].includes(scenario)) {
        await operation;
        assert.ok(calls.some(call => call.command.endsWith("tsc")));
        assert.equal(calls.filter(call => call.command.endsWith("wrangler")).every(call => call.args.includes("--check")), scenario === "selected-check");
      } else if (scenario === "unknown") { await assert.rejects(operation, /Unknown/); }
      else if (scenario === "spawn-error") { await assert.rejects(operation, error); }
      else { await assert.rejects(operation, exit); assert.equal(exitCode, scenario === "exit-failure" ? 2 : 1); }
    } finally { process.argv = previous; process.exit = originalExit; processes.restore(); directories.restore(); }
  });
}
