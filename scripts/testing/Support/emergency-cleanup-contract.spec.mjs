import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

/** Reject incomplete, ambiguous or partially successful child TAP summaries. */
function requireSuccessfulContractRun(stdout, stderr) {
  const summary = new Map();
  for (const [, name, raw] of stdout.matchAll(
    /^# (tests|pass|fail|cancelled|skipped) ([0-9]+)$/gm,
  )) {
    assert.equal(
      summary.has(name),
      false,
      `duplicate TAP summary field: ${name}`,
    );
    const count = Number(raw);
    assert.ok(Number.isSafeInteger(count), `unsafe TAP count: ${name}`);
    summary.set(name, count);
  }
  assert.equal(summary.size, 5, "incomplete TAP summary");
  for (const name of ["fail", "cancelled", "skipped"]) {
    assert.equal(summary.get(name), 0, `child ${name} must be zero`);
  }
  assert.ok(summary.get("tests") > 0, "child must execute tests");
  assert.equal(
    summary.get("tests"),
    summary.get("pass"),
    "every child test must pass",
  );
  assert.equal(
    [...stderr.matchAll(/^preexisting environment restored$/gm)].length,
    1,
    "exactly one restoration marker required",
  );
  return summary.get("pass");
}

const validSummary =
  "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n";
for (const [name, output, diagnostic, expected] of [
  ["missing", "", "preexisting environment restored", /incomplete TAP summary/],
  [
    "empty suite",
    validSummary.replaceAll("2", "0"),
    "preexisting environment restored",
    /child must execute tests/,
  ],
  [
    "partial pass",
    validSummary.replace("pass 2", "pass 1"),
    "preexisting environment restored",
    /every child test must pass/,
  ],
  [
    "failure",
    validSummary.replace("fail 0", "fail 1"),
    "preexisting environment restored",
    /child fail must be zero/,
  ],
  [
    "cancelled",
    validSummary.replace("cancelled 0", "cancelled 1"),
    "preexisting environment restored",
    /child cancelled must be zero/,
  ],
  [
    "skipped",
    validSummary.replace("skipped 0", "skipped 1"),
    "preexisting environment restored",
    /child skipped must be zero/,
  ],
  [
    "duplicate",
    validSummary + "# pass 2\n",
    "preexisting environment restored",
    /duplicate TAP summary field/,
  ],
  [
    "unsafe count",
    validSummary.replace("tests 2", "tests 9007199254740992"),
    "preexisting environment restored",
    /unsafe TAP count/,
  ],
  [
    "malformed count",
    validSummary.replace("tests 2", "tests unavailable"),
    "preexisting environment restored",
    /incomplete TAP summary/,
  ],
  ["missing restoration", validSummary, "", /exactly one restoration marker/],
  [
    "duplicate restoration",
    validSummary,
    "preexisting environment restored\npreexisting environment restored",
    /exactly one restoration marker/,
  ],
]) {
  test(`child summary rejects ${name}`, () => {
    assert.throws(
      () => requireSuccessfulContractRun(output, diagnostic),
      expected,
    );
  });
}

test("child summary accepts changing positive test counts", () => {
  assert.equal(
    requireSuccessfulContractRun(
      validSummary,
      "preexisting environment restored",
    ),
    2,
  );
  assert.equal(
    requireSuccessfulContractRun(
      validSummary.replaceAll("2", "109"),
      "preexisting environment restored",
    ),
    109,
  );
});

// Exercise last-resort cleanup only on processes created by the isolated child.
for (const [file, name, api, start] of [
  [
    "dev-lifecycle-contract.spec.mjs",
    "minimal: healthy closes process and releases state",
    "examples/minimal/test/Support/dev.mjs",
    "startDev",
  ],
  [
    "runtime-lifecycle-contract.spec.mjs",
    "workflows runtime: healthy preserves cleanup and diagnostic contract",
    "examples/workflows/test/Support/dev-runtime.mjs",
    "startRuntime",
  ],
]) {
  test(`assertion failure still kills the owned process group: ${file}`, () => {
    const source = new URL(file, import.meta.url).href;
    const apiURL = new URL(`../../../${api}`, import.meta.url).href;
    const program = `
      import nativeTest, { mock } from 'node:test';
      import { registerHooks } from 'node:module';
      import { spawn } from 'node:child_process';
      import assert from 'node:assert/strict';
      import { once } from 'node:events';
      const cases=new Map(), children=[], kills=[];
      globalThis.nativeTest=nativeTest; globalThis.nativeMock=mock;
      globalThis.register=(name,...args)=>cases.set(name,args.at(-1));
      globalThis.ownedSpawn=(...args)=>{const child=spawn(args[0],args[1],{...args[2],detached:true});children.push(child);return child;};
      globalThis.injectFailure=async()=>{
        const original=await import(${JSON.stringify(apiURL + "?emergency-real")});
        const runtime=await original.${start}();
        runtime.close=async()=>{assert.fail('injected failure before normal close');};
        return runtime;
      };
      const data=source=>'data:text/javascript,'+encodeURIComponent(source);
      registerHooks({resolve(specifier,context,next){
        if(specifier==='node:test') {return {url:data('export default globalThis.nativeTest; export const mock=globalThis.nativeMock; export const test=globalThis.register;'),shortCircuit:true};}
        if(context.parentURL===${JSON.stringify(source)} && specifier==='node:child_process') {return {url:data('export const spawn=globalThis.ownedSpawn;'),shortCircuit:true};}
        if(specifier.startsWith(${JSON.stringify(apiURL + "?")}) && !specifier.endsWith('?emergency-real')) {return {url:data('export const ${start}=globalThis.injectFailure;'),shortCircuit:true};}
        return next(specifier,context);
      }});
      const realKill=process.kill.bind(process);
      process.kill=(identifier, signal)=>{
        assert.ok(children.some(child=>child.pid===-identifier),'cleanup may target only an owned process group');
        kills.push([identifier,signal]); return realKill(identifier,signal);
      };
      try {
        await import(${JSON.stringify(source)});
        await assert.rejects(cases.get(${JSON.stringify(name)})(), /injected failure before normal close/);
        assert.ok(children.length>=1);
        assert.equal(kills.length,1);
        assert.equal(kills[0][1],'SIGKILL');
        const child=children.find(child=>child.pid===-kills[0][0]);
        if(child.exitCode===null && child.signalCode===null) {await once(child,'exit');}
        assert.equal(child.signalCode,'SIGKILL');
        console.error('injected failure before normal close; owned process group terminated with SIGKILL');
        process.exitCode=1;
      } finally {
        for(const child of children) {
          if(child.pid && child.exitCode===null && child.signalCode===null) { try { realKill(-child.pid,'SIGKILL'); } catch(error) { if(error.code!=='ESRCH') { throw error; } } }
        }
      }
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        "--input-type=module",
        "--eval",
        program,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      result.stderr,
      /injected failure before normal close; owned process group terminated with SIGKILL/,
    );
  });
}

const seededEnvironment = {
  WASM_COVERAGE: "restoration-contract",
  WASM_COVERAGE_ENDPOINT: "https://restoration.invalid/wasm",
  WORKERD_JS_COVERAGE_ENDPOINT: "https://restoration.invalid/js",
  WORKERD_JS_COVERAGE_DIRECTORY: "/unused-restoration-contract",
};
for (const [file, seedGlobal = false] of [
  ["dev-lifecycle-contract.spec.mjs"],
  ["runtime-lifecycle-contract.spec.mjs"],
  ["quickstart-config-contract.spec.mjs"],
  ["dev-run-contract.spec.mjs"],
  ["vitest-config-contract.spec.mjs"],
  [
    "../../../examples/workflows/test/Support/coverage-upload-contract.spec.mjs",
    true,
  ],
]) {
  test(`preexisting environment survives all contracts: ${file}`, (context) => {
    const program = `
      import assert from 'node:assert/strict';
      import { after } from 'node:test';
      const globalDescriptor={value:'https://restoration.invalid/global-wasm',writable:true,configurable:true,enumerable:true};
      ${seedGlobal ? "Object.defineProperty(globalThis,'WASM_COVERAGE_ENDPOINT',globalDescriptor);" : ""}
      after(()=>{
        for(const [name, value] of Object.entries(${JSON.stringify(seededEnvironment)})) {
          assert.equal(process.env[name],value,'environment restoration: '+name);
        }
        ${seedGlobal ? "assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,'WASM_COVERAGE_ENDPOINT'),globalDescriptor,'global endpoint descriptor restoration');" : ""}
        console.error('preexisting environment restored');
      });
      await import(${JSON.stringify(new URL(file, import.meta.url).href)});
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        "--test-reporter=tap",
        "--input-type=module",
        "--eval",
        program,
      ],
      {
        encoding: "utf8",
        timeout: 60000,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => name !== "NODE_TEST_CONTEXT",
            ),
          ),
          ...seededEnvironment,
        },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const passed = requireSuccessfulContractRun(result.stdout, result.stderr);
    context.diagnostic(
      `${passed} child contracts passed with preexisting environment`,
    );
  });
}
