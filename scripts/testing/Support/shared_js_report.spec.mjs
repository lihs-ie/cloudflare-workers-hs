import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { instrumentationIdentity } from "./shared_js_instrumentation.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mergeReports, validateMergedReport } from "./shared_js_report.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const reporter = fileURLToPath(
  new URL("./shared_js_report.mjs", import.meta.url),
);
async function fixture(t, mutate = () => {}, cli = false) {
  const root = await mkdtemp(
    path.join(
      cli ? path.join(repositoryRoot, "artifacts/testing") : os.tmpdir(),
      "shared-js-report-",
    ),
  );
  const sourceRoot = cli ? repositoryRoot : root;
  const identity = cli ? instrumentationIdentity : "a".repeat(64);
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.js");
  await writeFile(source, "export const x = 1;\n");
  const sourceHash = hash(await readFile(source));
  for (const kind of ["workerd", "node"]) {
    const directory = path.join(root, kind);
    await mkdir(directory);
    const entry = {
      path: source,
      statementMap: {
        0: { start: { line: 1, column: 0 }, end: { line: 1, column: 19 } },
      },
      fnMap: {},
      branchMap: {},
      s: { 0: 0 },
      f: {},
      b: {},
    };
    const manifest = {
      [source]: {
        sha256: sourceHash,
        coverage: entry,
        instrumentation: identity,
      },
    };
    const snapshot = {
      coverage: {
        [source]: { ...entry, s: { 0: kind === "workerd" ? 2 : 3 } },
      },
    };
    const proof = {
      sources: { [path.relative(sourceRoot, source)]: sourceHash },
      exit_code: 0,
      errors: [],
      commands: [
        {
          command: ["node", "test"],
          exitCode: 0,
          log: "test.log",
          logSha256: hash("passed"),
        },
      ],
      sha256: hash("{}"),
      manifests: {},
      snapshots: {},
    };
    mutate({ kind, proof, manifest, snapshot, source });
    for (const [filename, value] of [
      ["manifest.json", manifest],
      ["snapshot.json", snapshot],
    ]) {
      const bytes = JSON.stringify(value);
      await writeFile(path.join(directory, filename), bytes);
      proof[filename === "manifest.json" ? "manifests" : "snapshots"][
        filename
      ] = hash(bytes);
    }
    await writeFile(path.join(directory, "test.log"), "passed");
    await writeFile(path.join(directory, "coverage-final.json"), "{}");
    await writeFile(path.join(directory, "proof.json"), JSON.stringify(proof));
  }
  return {
    root,
    run: () =>
      mergeReports(
        path.join(root, "workerd"),
        path.join(root, "node"),
        path.join(root, "merged"),
        { root, expectedIdentity: "a".repeat(64) },
      ),
  };
}
test("sums identical counters while retaining workerd-only results and proof links", async (t) => {
  const { root, run } = await fixture(t);
  const proof = await run();
  const combined = JSON.parse(
    await readFile(path.join(root, "merged/coverage-final.json")),
  );
  const workerd = JSON.parse(
    await readFile(path.join(root, "merged/workerd-only.json")),
  );
  assert.equal(combined[path.join(root, "source.js")].s[0], 5);
  assert.equal(workerd[path.join(root, "source.js")].s[0], 2);
  assert.equal(proof.inputs.length, 2);
  assert.equal(
    proof.sha256,
    hash(await readFile(path.join(root, "merged/coverage-final.json"))),
  );
  await assert.rejects(run(), /EEXIST/);
});
for (const [name, mutation, pattern] of [
  [
    "failed run",
    ({ proof }) => {
      proof.exit_code = 1;
    },
    /failed/,
  ],
  [
    "boolean command exit",
    ({ proof }) => {
      proof.commands[0].exitCode = false;
    },
    /command/,
  ],
  [
    "missing commands",
    ({ proof }) => {
      proof.commands = [];
    },
    /commands/,
  ],
  [
    "changed log",
    ({ proof }) => {
      proof.commands[0].logSha256 = "0".repeat(64);
    },
    /Hash/,
  ],
  [
    "escaped log",
    ({ proof }) => {
      proof.commands[0].log = "../source.js";
    },
    /escapes/,
  ],
  [
    "wrong source",
    ({ manifest, source }) => {
      manifest[source].sha256 = "0".repeat(64);
    },
    /authenticated/,
  ],
  [
    "missing identity",
    ({ manifest, source }) => {
      delete manifest[source].instrumentation;
    },
    /manifest/,
  ],
  [
    "mixed compiler",
    ({ kind, manifest, source }) => {
      if (kind === "node") {
        manifest[source].instrumentation = "b".repeat(64);
      }
    },
    /identity/,
  ],
  [
    "negative counter",
    ({ snapshot, source }) => {
      snapshot.coverage[source].s[0] = -1;
    },
    /counter/,
  ],
  [
    "boolean counter",
    ({ snapshot, source }) => {
      snapshot.coverage[source].s[0] = true;
    },
    /counter/,
  ],
  [
    "counter keys",
    ({ snapshot, source }) => {
      snapshot.coverage[source].s[1] = 1;
    },
    /keys/,
  ],
  [
    "empty snapshot",
    ({ snapshot }) => {
      snapshot.coverage = {};
    },
    /Empty/,
  ],
  [
    "unknown source",
    ({ snapshot, source }) => {
      snapshot.coverage[source + "x"] = snapshot.coverage[source];
    },
    /manifest/,
  ],
  [
    "changed map",
    ({ snapshot, source }) => {
      snapshot.coverage[source].statementMap = {};
    },
    /maps/,
  ],
]) {
  test(`rejects ${name}`, async (t) => {
    const { run } = await fixture(t, mutation);
    await assert.rejects(run(), pattern);
  });
}
test("rejects source edits after capture", async (t) => {
  const { root, run } = await fixture(t);
  await writeFile(path.join(root, "source.js"), "changed");
  await assert.rejects(run(), /Hash/);
});
test("rejects changed snapshot bytes and report bytes", async (t) => {
  for (const filename of [
    "snapshot.json",
    "coverage-final.json",
    "manifest.json",
  ]) {
    const { root, run } = await fixture(t);
    await writeFile(path.join(root, "node", filename), "{}");
    if (filename === "coverage-final.json") {
      await writeFile(path.join(root, "node", filename), "{ }");
    }
    await assert.rejects(run(), /Hash/);
  }
});
test("rejects branch arity and fractional counters", async (t) => {
  for (const malformed of [[1], [1, 0.5]]) {
    const { run } = await fixture(t, ({ manifest, snapshot, source }) => {
      manifest[source].coverage.b = { 0: [0, 0] };
      snapshot.coverage[source].b = { 0: malformed };
    });
    await assert.rejects(run(), /arity|counter/);
  }
});
test("rejects differing source inventories even when every listed hash is valid", async (t) => {
  const { root, run } = await fixture(t);
  await writeFile(path.join(root, "extra.js"), "extra");
  const proofPath = path.join(root, "node/proof.json");
  const proof = JSON.parse(await readFile(proofPath));
  proof.sources["extra.js"] = hash("extra");
  await writeFile(proofPath, JSON.stringify(proof));
  await assert.rejects(run(), /snapshots differ/);
});
test("verifier reconstructs reports and rejects altered input proof", async (t) => {
  const { root, run } = await fixture(t);
  await run();
  const proofPath = path.join(root, "merged/proof.json");
  const options = { root, expectedIdentity: "a".repeat(64) };
  const verified = await validateMergedReport(proofPath, options);
  assert.equal(verified.inputs.length, 2);
  const inputPath = path.join(root, "node/proof.json");
  await writeFile(inputPath, (await readFile(inputPath, "utf8")) + "\n");
  await assert.rejects(validateMergedReport(proofPath, options), /proof hash/);
});
test("verifier rejects forged report even if its proof hash is updated", async (t) => {
  const { root, run } = await fixture(t);
  await run();
  const proofPath = path.join(root, "merged/proof.json");
  const proof = JSON.parse(await readFile(proofPath));
  await writeFile(path.join(root, "merged/coverage-final.json"), "{}");
  proof.sha256 = hash("{}");
  await writeFile(proofPath, JSON.stringify(proof));
  await assert.rejects(
    validateMergedReport(proofPath, { root, expectedIdentity: "a".repeat(64) }),
    /raw evidence/,
  );
});
test("rejects unlisted snapshot evidence", async (t) => {
  const { root, run } = await fixture(t);
  await mkdir(path.join(root, "node/snapshots"));
  await writeFile(path.join(root, "node/snapshots/omitted.json"), "{}");
  await assert.rejects(run(), /inventory/);
});

for (const differs of [false, true]) {
  test(`duplicate manifests in one input ${differs ? "reject inconsistent maps" : "retain counts without duplication"}`, async (t) => {
    const { root, run } = await fixture(t);
    const directory = path.join(root, "node");
    const manifest = JSON.parse(
      await readFile(path.join(directory, "manifest.json")),
    );
    if (differs) {
      manifest[
        path.join(root, "source.js")
      ].coverage.statementMap[0].end.column += 1;
    }
    await mkdir(path.join(directory, "second"));
    const bytes = JSON.stringify(manifest);
    await writeFile(path.join(directory, "second/manifest.json"), bytes);
    const proofPath = path.join(directory, "proof.json");
    const proof = JSON.parse(await readFile(proofPath));
    proof.manifests["second/manifest.json"] = hash(bytes);
    await writeFile(proofPath, JSON.stringify(proof));
    if (differs) {
      await assert.rejects(run(), /Manifest instrumentation differs/);
    } else {
      await run();
      const report = JSON.parse(
        await readFile(path.join(root, "merged/coverage-final.json")),
      );
      assert.equal(report[path.join(root, "source.js")].s[0], 5);
    }
  });
}
for (const inventory of ["manifests", "snapshots"]) {
  for (const missing of [false, true]) {
    test(`rejects ${missing ? "missing" : "null"} ${inventory} inventory`, async (t) => {
      const { root, run } = await fixture(t);
      const proofPath = path.join(root, "node/proof.json");
      const proof = JSON.parse(await readFile(proofPath));
      if (missing) {
        delete proof[inventory];
      } else {
        proof[inventory] = null;
      }
      await writeFile(proofPath, JSON.stringify(proof));
      await assert.rejects(run(), /Evidence inventory differs/);
    });
  }
}
test("CLI merges and verifies authenticated inputs, rejecting tampered evidence", async (t) => {
  const { root } = await fixture(t, () => {}, true);
  const invoke = (...args) =>
    spawnSync(process.execPath, [reporter, ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
  const merged = path.join(root, "merged");
  const result = invoke(
    path.join(root, "workerd"),
    path.join(root, "node"),
    merged,
  );
  assert.equal(result.status, 0, result.stderr);
  const proofPath = path.join(merged, "proof.json");
  const verified = invoke("--verify", proofPath);
  assert.equal(verified.status, 0, verified.stderr);
  const proof = JSON.parse(await readFile(proofPath));
  assert.equal(JSON.parse(verified.stdout).sha256, proof.sha256);
  assert.equal(JSON.parse(verified.stdout).inputs.length, 2);
  await writeFile(path.join(root, "node/test.log"), "tampered");
  const rejected = invoke("--verify", proofPath);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Hash mismatch/);
  const rejectedMerge = invoke(
    path.join(root, "workerd"),
    path.join(root, "node"),
    path.join(root, "rejected"),
  );
  assert.notEqual(rejectedMerge.status, 0);
  assert.match(rejectedMerge.stderr, /Hash mismatch/);
});
for (const args of [
  [],
  ["one"],
  ["one", "two"],
  ["one", "two", "three", "four"],
  ["--verify"],
  ["--verify", "one", "two"],
]) {
  test(`CLI rejects invalid arity ${JSON.stringify(args)}`, () => {
    const result = spawnSync(process.execPath, [reporter, ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: shared_js_report/);
  });
}
