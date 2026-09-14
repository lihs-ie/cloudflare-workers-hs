/** Node contracts for actual reactor adapters; WASM loading is the only substituted boundary. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";
import * as runtime from "@cloudflare-workers-hs/runtime";
let serial = 0;
const fixtureURL = new URL("./runtime.ts", import.meta.url);
const applicationURL = new URL("../../worker/runtime.ts", import.meta.url);

async function withAdapter(url, options, inspect) {
  const calls = [];
  const names =
    url === fixtureURL
      ? [
          "miscSocketFailure",
          "miscStorageUnknown",
          "clientOptionDiagnostics",
          "attachmentMissingReader",
          "loggingUnknownRecovery",
          "clientDefaultOptions",
          "jobsFailure",
          "queueContract",
          "cachePurgeExample",
          "socketBoundary",
          "storageValidation",
          "r2Failure",
          "databaseFailureRecovery",
          "clientUploadLifecycle",
          "clientHTTPStreamLifecycle",
          "clientStreamLifecycle",
          "kvMalformedJSONRecovery",
          "drainStream",
          "socketFailure",
          "emptyResponse",
          "configurationFailure",
        ]
      : [
          "fetch",
          "tail",
          "jobsInitialize",
          "jobsCommit",
          "jobsStatus",
          "jobsSaveSettings",
          "jobsSettingsHistory",
          "queue",
          "processJob",
        ];
  const table = { memory: options.memory, coverage: options.coverage };
  for (const name of names) {
    table[name] = async (...args) => {
      calls.push([name, ...args]);
      if (options.failure) {
        throw options.failure;
      }
      if (options.invalidResult) {
        return 42;
      }
      if (
        [
          "fetch",
          "attachmentMissingReader",
          "emptyResponse",
          "configurationFailure",
        ].includes(name)
      ) {
        return new Response(name);
      }
      if (["tail", "jobsInitialize", "queue", "processJob"].includes(name)) {
        return undefined;
      }
      return name;
    };
  }
  const implementation = mock.module("@cloudflare-workers-hs/runtime", {
    namedExports: {
      ...runtime,
      createReactor: async (_wasm, _imports, bind) => bind(table),
    },
  });
  const hooks = registerHooks({
    load(path, context, nextLoad) {
      if (path.endsWith(".wasm")) {
        return {
          format: "module",
          source: "export default {};",
          shortCircuit: true,
        };
      }
      if (path.endsWith("-jsffi.mjs")) {
        return {
          format: "module",
          source: "export default function makeImports(){return {}}",
          shortCircuit: true,
        };
      }
      return nextLoad(path, context);
    },
  });
  try {
    await inspect(
      () => import(`${url.href}?contract=${++serial}`),
      calls,
      names,
    );
  } finally {
    hooks.deregister();
    implementation.restore();
  }
}

test("fixture adapter requires actual WASM memory and preserves optional coverage", async () => {
  for (const memory of [undefined, {}, new ArrayBuffer(8)]) {
    await withAdapter(fixtureURL, { memory }, async (load) => {
      await assert.rejects(load(), /Expected fixture WASM memory export/);
    });
  }
  for (const coverage of [undefined, 42, async () => "ticks"]) {
    const memory = new WebAssembly.Memory({ initial: 1 });
    await withAdapter(
      fixtureURL,
      { memory, coverage },
      async (load, calls, names) => {
        const { reactor } = await load();
        assert.equal(reactor.memory, memory);
        if (typeof coverage === "function") {
          assert.equal(await reactor.coverage(), "ticks");
        } else {
          assert.equal(reactor.coverage, undefined);
        }
        for (const name of names) {
          const marker = {};
          const result = await reactor[name](marker);
          assert.deepEqual(calls.pop(), [name, marker]);
          assert.equal(
            result instanceof Response ? await result.text() : result,
            name,
          );
        }
      },
    );
  }
});

test("application adapter supports uninstrumented exports and enforces result decoders", async () => {
  for (const coverage of [undefined, async () => "application ticks"]) {
    await withAdapter(
      applicationURL,
      { coverage },
      async (load, calls, names) => {
        const { reactor } = await load();
        if (coverage) {
          assert.equal(await reactor.coverage(), "application ticks");
        } else {
          assert.equal(reactor.coverage, undefined);
        }
        for (const name of names) {
          const marker = {};
          const result = await reactor[name](marker);
          assert.deepEqual(calls.pop(), [name, marker]);
          if (name === "fetch") {
            assert.equal(await result.text(), name);
          } else if (
            ["tail", "jobsInitialize", "queue", "processJob"].includes(name)
          ) {
            assert.equal(result, undefined);
          } else {
            assert.equal(result, name);
          }
        }
      },
    );
  }
  await withAdapter(applicationURL, { invalidResult: true }, async (load) => {
    const { reactor } = await load();
    await assert.rejects(reactor.fetch(), /Expected a Response/);
    await assert.rejects(reactor.jobsStatus(), /Expected a string/);
  });
});

test("both adapters propagate export failures and reject invalid coverage values", async () => {
  for (const url of [fixtureURL, applicationURL]) {
    const failure = new Error("WASM export rejected");
    const memory = new WebAssembly.Memory({ initial: 1 });
    await withAdapter(
      url,
      { memory, failure, coverage: async () => 42 },
      async (load, calls, names) => {
        const { reactor } = await load();
        await assert.rejects(reactor.coverage(), /Expected a string/);
        for (const name of names) {
          await assert.rejects(reactor[name](), (error) => error === failure);
          assert.deepEqual(calls.pop(), [name]);
        }
      },
    );
  }
});

test("fixture exports enforce every string and response decoder", async () => {
  await withAdapter(
    fixtureURL,
    {
      memory: new WebAssembly.Memory({ initial: 1 }),
      invalidResult: true,
    },
    async (load, _calls, names) => {
      const { reactor } = await load();
      for (const name of names) {
        await assert.rejects(
          reactor[name](),
          [
            "attachmentMissingReader",
            "emptyResponse",
            "configurationFailure",
          ].includes(name)
            ? /Expected a Response/
            : /Expected a string/,
        );
      }
    },
  );
});
