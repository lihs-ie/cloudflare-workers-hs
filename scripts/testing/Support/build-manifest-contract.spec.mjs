import { moduleBoundary } from "./module-boundaries.mjs";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test, mock } from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let serial = 0;

// Redirect filesystem boundaries only: the original manifest module and SHA-256
// implementation execute unchanged. No compiler or deployed Worker is involved.
for (const example of ["minimal", "realtime", "static-assets", "workflows", "library-examples"]) {
  test(`${example}: build proof rejects stale inputs, altered artifacts and incomplete output`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-contract-"));
    const source = path.join(root, "examples", example, "test/Support/build-manifest.mjs");
    const original = fs.readFileSync(source, "utf8");
    const exampleRoot = path.join(root, "examples", example);
    const relocate = (filename) => path.join(directory, path.relative(root, filename));
    const put = (filename, content = "fixture\n") => {
      const output = relocate(filename);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, content);
    };
    const inputs = [...original.match(/const inputs = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    for (const input of inputs) {
      const absolute = path.resolve(exampleRoot, input);
      if (fs.statSync(absolute).isDirectory()) {
        put(path.join(absolute, "nested/input.txt"));
        put(path.join(absolute, ".dev-test-transient"), "ignored");
      } else {
        put(absolute);
      }
    }
    const artifacts = [...original.match(/function artifactHashes\(\) \{([\s\S]*?)\n\}/)[1].matchAll(/"(worker\/[^"]+)"/g)].map((match) => match[1]);
    for (const artifact of artifacts) {
      put(path.join(exampleRoot, artifact));
    }
    const boundary = moduleBoundary("node:fs", { namedExports: {
      readFileSync: (filename, ...args) => fs.readFileSync(relocate(filename), ...args),
      writeFileSync: (filename, ...args) => fs.writeFileSync(relocate(filename), ...args),
      statSync: (filename, ...args) => fs.statSync(relocate(filename), ...args),
      readdirSync: (filename, ...args) => fs.readdirSync(relocate(filename), ...args),
    } });
    const argv = process.argv;
    const cli = async (operation, snapshot) => {
      process.argv = [process.execPath, source, operation, snapshot];
      try {
        return await import(`${pathToFileURL(source)}?contract=${serial++}`);
      } finally {
        process.argv = argv;
      }
    };
    try {
      const api = await import(`${pathToFileURL(source)}?contract=${serial++}`);
      const snapshot = path.join(exampleRoot, "snapshot.json");
      const proof = relocate(path.join(exampleRoot, "worker/build.json"));
      await cli("capture", snapshot);
      const captured = JSON.parse(fs.readFileSync(relocate(snapshot), "utf8"));
      assert.ok(Object.keys(captured).length > 10);
      assert.ok(Object.keys(captured).every((name) => !name.includes(".dev-test-")));
      await cli("write", snapshot);
      api.verifyBuild();
      const saved = fs.readFileSync(proof, "utf8");
      const changed = path.join(exampleRoot, "package.json");
      put(changed, "changed input");
      assert.throws(() => api.verifyBuild(), /stale/i);
      await assert.rejects(cli("write", snapshot), /inputs changed/i);
      assert.equal(fs.readFileSync(proof, "utf8"), saved, "failed write preserves the last proof");
      put(changed);
      const artifact = path.join(exampleRoot, artifacts[0]);
      put(artifact, "corrupt wasm");
      assert.throws(() => api.verifyBuild(), /digest mismatch/);
      fs.rmSync(relocate(artifact));
      assert.throws(() => api.verifyBuild(), /ENOENT/);
      await assert.rejects(cli("write", snapshot), /ENOENT/);
      assert.equal(fs.readFileSync(proof, "utf8"), saved);
      await assert.rejects(cli("invalid", snapshot), /Expected capture or write/);
      put(path.join(exampleRoot, "worker/build.json"), "not JSON");
      assert.throws(() => api.verifyBuild(), SyntaxError);
    } finally {
      boundary.restore();
      process.argv = argv;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const scenario of ["success", "spawn-error", "exit-code", "signal", "stale-build"]) {
  test(`quickstart model bundler: ${scenario} publishes only successful validated output`, async () => {
    const calls = [];
    const failure = new Error("launch failed");
    const inputs = { "worker/input.ts": "digest" };
    const manifest = path.join(root, "examples/quickstart/test/Support/Runtime/build-manifest.mts");
    const boundaries = [
      moduleBoundary(pathToFileURL(manifest), { namedExports: {
        verifyBuild: (target) => { assert.equal(target, "runtime-tests"); calls.push("verify"); if (scenario === "stale-build") { throw new Error("stale build"); } },
        buildInputs: () => { calls.push("inputs"); return inputs; },
        writeBundle: (directory, recorded) => { assert.match(directory, /runtime-bundle/); assert.equal(recorded, inputs); calls.push("publish"); },
      } }),
      moduleBoundary("node:fs", { namedExports: {
        rmSync: (directory, options) => { assert.equal(options.force, true); assert.match(directory, /runtime-bundle/); calls.push("remove"); },
        mkdirSync: (directory, options) => { assert.equal(options.recursive, true); calls.push("mkdir"); },
      } }),
      moduleBoundary("node:child_process", { namedExports: { spawnSync: (command, args, options) => {
        assert.equal(command, "pnpm");
        assert.deepEqual(args.slice(0, 5), ["exec", "wrangler", "deploy", "--dry-run", "--config"]);
        assert.match(options.cwd, /examples\/quickstart\/$/);
        calls.push("spawn");
        return scenario === "spawn-error" ? { error: failure } : scenario === "signal" ? { status: null, signal: "SIGTERM" } : { status: scenario === "exit-code" ? 7 : 0 };
      } } }),
    ];
    try {
      const execute = import(`${pathToFileURL(path.join(root, "examples/quickstart/test/Support/Runtime/build-model.mts"))}?contract=${serial++}`);
      if (scenario === "success") {
        await execute;
        assert.deepEqual(calls, ["verify", "inputs", "remove", "mkdir", "spawn", "publish"]);
      } else {
        await assert.rejects(execute, scenario === "spawn-error" ? (error) => error === failure : scenario === "signal" ? /SIGTERM/ : scenario === "exit-code" ? /7/ : /stale/);
        assert.ok(!calls.includes("publish"));
        if (scenario === "stale-build") { assert.deepEqual(calls, ["verify"]); }
      }
    } finally {
      for (const boundary of boundaries) { boundary.restore(); }
    }
  });
}
