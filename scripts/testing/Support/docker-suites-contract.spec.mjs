import { moduleBoundary } from "./module-boundaries.mjs";
import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { test, mock } from "node:test";
const source = fileURLToPath(new URL("../../../examples/quickstart/test/Support/Dev/docker.mts", import.meta.url));
for (const scenario of ["success", "failure", "signal", "empty", "spawn-error"]) {
  test(`Docker suite orchestration: ${scenario}`, async () => {
    const records = new Map();
    const launches = [];
    const exitCode = process.exitCode;
    const boundaries = [
      moduleBoundary("node:fs/promises", { namedExports: {
        mkdir: async () => {},
        readdir: async () => scenario === "empty" ? ["README.md"] : ["z.spec.mjs", "README.md", "a.spec.mjs"],
        writeFile: async (filename, data) => { records.set(path.basename(filename), data); },
      } }),
      moduleBoundary("node:child_process", { namedExports: { spawn: (command, args, options) => {
        assert.equal(command, process.execPath);
        launches.push(args);
        const code = launches.length === 2 && scenario === "failure" ? "process.exit(7)" : launches.length === 2 && scenario === "signal" ? "process.kill(process.pid,'SIGTERM')" : "process.stdout.write('out');process.stderr.write('err')";
        return realSpawn(scenario === "spawn-error" ? "/nonexistent/docker-contract-command" : process.execPath, ["-e", code], options);
      } } }),
    ];
    try {
      const execution = import(`${pathToFileURL(source)}?scenario=${scenario}`);
      if (["empty", "spawn-error"].includes(scenario)) {
        await assert.rejects(execution, scenario === "empty" ? /No integration tests/ : /ENOENT/);
        assert.equal(records.has("results.json"), false);
        if (scenario === "empty") { assert.equal(launches.length, 0); }
      } else {
        await execution;
        const result = JSON.parse(records.get("results.json"));
        assert.equal(launches.length, 6, "one suite failure does not skip remaining suites");
        assert.equal(result.results.length, 6);
        assert.equal(result.complete, scenario === "success");
        assert.equal(process.exitCode, scenario === "success" ? 0 : 1);
        assert.deepEqual(launches[1].slice(0, 2), ["--test", "--test-concurrency=1"]);
        assert.ok(launches[1][2].endsWith("a.spec.mjs"));
        assert.ok(launches[1][3].endsWith("z.spec.mjs"));
        assert.equal(records.get("quickstart.log").includes("out"), true);
        assert.equal(records.get("quickstart.log").includes("err"), true);
        if (scenario === "failure") { assert.equal(result.results[1].exitCode, 7); }
        if (scenario === "signal") { assert.equal(result.results[1].signal, "SIGTERM"); }
      }
    } finally {
      process.exitCode = exitCode;
      for (const boundary of boundaries) { boundary.restore(); }
    }
  });
}
