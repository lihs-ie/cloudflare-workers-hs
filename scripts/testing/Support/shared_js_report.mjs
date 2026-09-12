import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { instrumentationIdentity } from "./shared_js_instrumentation.mjs";

const require = createRequire(import.meta.url);
const { createCoverageMap } = createRequire(require.resolve("istanbul-lib-source-maps"))("istanbul-lib-coverage");
const { createSourceMapStore } = require("istanbul-lib-source-maps");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function assert(condition, message) {
  if (!condition) { throw new Error(message); }
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function checkedFile(directory, filename, digest) {
  assert(typeof filename === "string" && !path.isAbsolute(filename), "Expected relative evidence path");
  const base = await realpath(directory);
  const resolved = await realpath(path.resolve(base, filename));
  assert(resolved.startsWith(base + path.sep), "Evidence escapes its directory");
  const bytes = await readFile(resolved);
  assert(typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) && hash(bytes) === digest, `Hash mismatch: ${filename}`);
  return bytes;
}
function maps(entry) {
  return [entry.path, entry.statementMap, entry.branchMap, entry.fnMap, entry.inputSourceMap];
}
function counters(entry, expected) {
  assert(object(entry) && isDeepStrictEqual(maps(entry), maps(expected)), "Instrumentation maps differ");
  for (const metric of ["s", "f", "b"]) {
    assert(object(entry[metric]) && object(expected[metric]), "Missing counters");
    assert(isDeepStrictEqual(Object.keys(entry[metric]).sort(), Object.keys(expected[metric]).sort()), "Counter keys differ");
    for (const [identifier, value] of Object.entries(entry[metric])) {
      if (metric === "b") {
        assert(Array.isArray(value) && Array.isArray(expected.b[identifier]) && value.length === expected.b[identifier].length, "Branch arity differs");
      }
      for (const count of metric === "b" ? value : [value]) {
        assert(Number.isSafeInteger(count) && count >= 0, "Invalid counter");
      }
    }
  }
}
async function evidenceFiles(directory, prefix = "") {
  const found = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory()) { found.push(...await evidenceFiles(directory, name)); }
    else if (entry.name === "manifest.json" || name.startsWith("snapshots" + path.sep) && entry.name.endsWith(".json") || name === "snapshot.json") { found.push(name); }
  }
  return found.sort();
}
async function loadInput(directory, root, expectedIdentity) {
  const proofBytes = await readFile(path.join(directory, "proof.json"));
  const proof = JSON.parse(proofBytes);
  assert(proof.exit_code === 0 && Array.isArray(proof.errors) && proof.errors.length === 0, "Input proof failed");
  assert(object(proof.sources) && Object.keys(proof.sources).length > 0, "Missing sources");
  for (const [filename, digest] of Object.entries(proof.sources)) {
    await checkedFile(root, filename, digest);
  }
  assert(Array.isArray(proof.commands) && proof.commands.length > 0, "Missing commands");
  for (const command of proof.commands) {
    assert(command.exitCode === 0 && Array.isArray(command.command) && command.command.length > 0 && command.command.every((part) => typeof part === "string"), "Invalid command proof");
    await checkedFile(directory, command.log, command.logSha256);
  }
  await checkedFile(directory, "coverage-final.json", proof.sha256);
  assert(isDeepStrictEqual(await evidenceFiles(directory), [...Object.keys(proof.manifests ?? {}), ...Object.keys(proof.snapshots ?? {})].sort()), "Evidence inventory differs");
  const entries = new Map();
  assert(object(proof.manifests) && Object.keys(proof.manifests).length > 0, "Missing manifests");
  for (const [filename, digest] of Object.entries(proof.manifests)) {
    const manifest = JSON.parse(await checkedFile(directory, filename, digest));
    assert(object(manifest) && Object.keys(manifest).length > 0, "Empty manifest");
    for (const [name, item] of Object.entries(manifest)) {
      assert(object(item) && object(item.coverage) && item.coverage.path === name && typeof item.instrumentation === "string" && /^[a-f0-9]{64}$/.test(item.instrumentation), "Invalid manifest entry");
      assert(item.instrumentation === expectedIdentity, "Instrumentation identity differs from current compiler");
      assert(path.isAbsolute(name) && proof.sources[path.relative(root, name)] === item.sha256, "Manifest source not authenticated");
      counters(item.coverage, item.coverage);
      assert(["s", "f", "b"].every((metric) => Object.values(item.coverage[metric]).flat().every((count) => count === 0)), "Manifest counters are not zero");
      if (entries.has(name)) {
        assert(isDeepStrictEqual(entries.get(name), item), "Manifest instrumentation differs");
      }
      entries.set(name, item);
    }
  }
  assert(object(proof.snapshots) && Object.keys(proof.snapshots).length > 0, "Missing snapshots");
  const snapshots = [];
  for (const [filename, digest] of Object.entries(proof.snapshots)) {
    const record = JSON.parse(await checkedFile(directory, filename, digest));
    assert(object(record.coverage) && Object.keys(record.coverage).length > 0, "Empty snapshot");
    for (const [name, entry] of Object.entries(record.coverage)) {
      assert(entries.has(name), "Snapshot source is not in manifest");
      counters(entry, entries.get(name).coverage);
      snapshots.push(entry);
    }
  }
  return { proof, proofHash: hash(proofBytes), entries, snapshots };
}
async function report(inputs) {
  const coverage = createCoverageMap({});
  const known = new Map();
  for (const input of inputs) {
    for (const [name, item] of input.entries) {
      if (known.has(name)) {
        assert(isDeepStrictEqual(known.get(name), item), `Cross-runtime instrumentation mismatch: ${name}`);
      }
      known.set(name, item);
      coverage.addFileCoverage(structuredClone(item.coverage));
    }
    for (const entry of input.snapshots) {
      coverage.addFileCoverage(structuredClone(entry));
    }
  }
  return (await createSourceMapStore().transformCoverage(coverage)).toJSON();
}

/** Merge authenticated counters before source-map remapping; retain workerd-only results. */
export async function mergeReports(workerdDirectory, nodeDirectory, outputDirectory, { root = repositoryRoot, expectedIdentity = instrumentationIdentity } = {}) {
  const inputs = await Promise.all([loadInput(workerdDirectory, root, expectedIdentity), loadInput(nodeDirectory, root, expectedIdentity)]);
  assert(isDeepStrictEqual(inputs[0].proof.sources, inputs[1].proof.sources), "Input source snapshots differ");
  const combined = JSON.stringify(await report(inputs));
  const workerd = JSON.stringify(await report([inputs[0]]));
  await mkdir(outputDirectory, { recursive: false });
  await writeFile(path.join(outputDirectory, "coverage-final.json"), combined);
  await writeFile(path.join(outputDirectory, "workerd-only.json"), workerd);
  const proof = {
    schema: 1, sources: inputs[0].proof.sources, exit_code: 0, errors: [],
    inputs: inputs.map((input, index) => ({ kind: index === 0 ? "workerd" : "node", proof: path.resolve(index === 0 ? workerdDirectory : nodeDirectory, "proof.json"), sha256: input.proofHash, reportSha256: input.proof.sha256 })),
    sha256: hash(combined), workerdOnlySha256: hash(workerd),
    semantics: "Authenticated identical instrumentation counters merged before remapping; workerd-only coverage is reported separately.",
  };
  await writeFile(path.join(outputDirectory, "proof.json"), JSON.stringify(proof, null, 2));
  return proof;
}
/** Reconstruct both reports from authenticated raw evidence before accepting a merged proof. */
export async function validateMergedReport(proofPath, { root = repositoryRoot, expectedIdentity = instrumentationIdentity } = {}) {
  const proof = JSON.parse(await readFile(proofPath));
  assert(proof.exit_code === 0 && Array.isArray(proof.errors) && proof.errors.length === 0, "Merged proof failed");
  assert(Array.isArray(proof.inputs) && proof.inputs.length === 2 && proof.inputs[0].kind === "workerd" && proof.inputs[1].kind === "node", "Invalid merged inputs");
  const inputs = [];
  for (const input of proof.inputs) {
    assert(typeof input.proof === "string" && path.isAbsolute(input.proof) && path.basename(input.proof) === "proof.json", "Invalid input proof path");
    const loaded = await loadInput(path.dirname(input.proof), root, expectedIdentity);
    assert(loaded.proofHash === input.sha256 && loaded.proof.sha256 === input.reportSha256, "Input proof hash differs");
    assert(isDeepStrictEqual(loaded.proof.sources, proof.sources), "Merged source snapshots differ");
    inputs.push(loaded);
  }
  const combined = await checkedFile(path.dirname(proofPath), "coverage-final.json", proof.sha256);
  const workerd = await checkedFile(path.dirname(proofPath), "workerd-only.json", proof.workerdOnlySha256);
  assert(isDeepStrictEqual(JSON.parse(combined), JSON.parse(JSON.stringify(await report(inputs)))), "Combined report differs from raw evidence");
  assert(isDeepStrictEqual(JSON.parse(workerd), JSON.parse(JSON.stringify(await report([inputs[0]])))), "Workerd-only report differs from raw evidence");
  return { sources: proof.sources, sha256: proof.sha256, workerdOnlySha256: proof.workerdOnlySha256, inputs: proof.inputs };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--verify") {
    assert(process.argv.length === 4, "Usage: shared_js_report.mjs --verify PROOF");
    process.stdout.write(JSON.stringify(await validateMergedReport(process.argv[3])) + "\n");
  } else {
    assert(process.argv.length === 5, "Usage: shared_js_report.mjs WORKERD_DIRECTORY NODE_DIRECTORY NEW_OUTPUT_DIRECTORY");
    await mergeReports(...process.argv.slice(2));
  }
}
