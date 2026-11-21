import type * as Module from 'node:module';
import { jsonArray, jsonObject, jsonString } from '../../../../scripts/testing/Support/json.mts';
import {
  callTestMethod,
  callTestBoundary,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
/** Node contracts for actual reactor adapters; WASM loading is the only substituted boundary. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mock, test } from 'node:test';
import * as runtime from '@cloudflare-workers-hs/runtime';
let serial = 0;
const fixtureURL = new URL('./runtime.ts', import.meta.url);
const applicationURL = new URL('../../worker/runtime.ts', import.meta.url);

async function withAdapter(
  url: URL,
  options: { memory?: unknown; coverage?: unknown; invalidResult?: unknown; failure?: unknown },
  inspect: (
    load: () => Promise<Record<string, unknown>>,
    calls: unknown[][],
    names: string[],
  ) => unknown,
): Promise<void> {
  const calls: unknown[][] = [];
  const names =
    url === fixtureURL
      ? [
          'miscSocketFailure',
          'miscStorageUnknown',
          'clientOptionDiagnostics',
          'attachmentMissingReader',
          'loggingUnknownRecovery',
          'clientDefaultOptions',

          'socketBoundary',
          'storageValidation',
          'r2Failure',
          'databaseFailureRecovery',
          'clientUploadLifecycle',
          'clientHTTPStreamLifecycle',
          'clientStreamLifecycle',
          'kvMalformedJSONRecovery',
          'drainStream',
          'socketFailure',
          'emptyResponse',
          'configurationFailure',
        ]
      : ['fetch', 'tail'];
  const table: Record<string, unknown> = { memory: options.memory, coverage: options.coverage };
  for (const name of names) {
    table[name] = async (...args: unknown[]) => {
      calls.push([name, ...args]);

      if (options.failure) {
        throw options.failure;
      }

      if (options.invalidResult) {
        return 42;
      }

      if (
        ['fetch', 'attachmentMissingReader', 'emptyResponse', 'configurationFailure'].includes(name)
      ) {
        return new Response(name);
      }

      if (name === 'tail') {
        return undefined;
      }

      return name;
    };
  }
  const implementation = mock.module('@cloudflare-workers-hs/runtime', {
    namedExports: {
      ...runtime,
      createReactor: async (
        _wasm: unknown,
        _imports: unknown,
        bind: (arg0: Record<string, unknown>) => unknown,
      ) => bind(table),
    },
  });
  const hooks = registerHooks({
    load(
      path: string,
      context: Module.LoadHookContext,
      nextLoad: (url: string, context?: Partial<Module.LoadHookContext>) => Module.LoadFnOutput,
    ): import('module').LoadFnOutput {
      if (path.endsWith('.wasm')) {
        return {
          format: 'module',
          source: 'export default {};',
          shortCircuit: true,
        };
      }

      if (path.endsWith('-jsffi.mjs')) {
        return {
          format: 'module',
          source: 'export default function makeImports(){return {}}',
          shortCircuit: true,
        };
      }

      return nextLoad(path, context);
    },
  });
  try {
    await inspect(() => loadTestModule(`${url.href}?contract=${++serial}`), calls, names);
  } finally {
    hooks.deregister();
    implementation.restore();
  }
}

void test('fixture adapter requires actual WASM memory and preserves optional coverage', async () => {
  for (const memory of [undefined, {}, new ArrayBuffer(8)]) {
    await withAdapter(fixtureURL, { memory }, async (load) => {
      await assert.rejects(
        Promise.resolve(callTestBoundary(load)),
        /Expected fixture WASM memory export/,
      );
    });
  }
  for (const coverage of [undefined, 42, async () => 'ticks']) {
    const memory = new WebAssembly.Memory({ initial: 1 });
    await callTestBoundary(
      withAdapter,
      fixtureURL,
      { memory, coverage },
      async (load: unknown, calls: unknown, names: unknown) => {
        const reactor = jsonObject(jsonObject(await callTestBoundary(load)).reactor);
        assert.equal(reactor.memory, memory);

        if (typeof coverage === 'function') {
          assert.equal(await callTestMethod(reactor, 'coverage'), 'ticks');
        } else {
          assert.equal(reactor.coverage, undefined);
        }
        for (const name of jsonArray(names)) {
          const marker = {};
          const result = await callTestMethod(reactor, name, marker);
          assert.deepEqual(jsonArray(calls).pop(), [name, marker]);
          assert.equal(
            result instanceof Response ? await callTestMethod(result, 'text') : result,
            name,
          );
        }
      },
    );
  }
});

void test('application adapter supports uninstrumented exports and enforces result decoders', async () => {
  for (const coverage of [undefined, async () => 'application ticks']) {
    await callTestBoundary(
      withAdapter,
      applicationURL,
      { coverage },
      async (load: unknown, calls: unknown, names: unknown) => {
        const reactor = jsonObject(jsonObject(await callTestBoundary(load)).reactor);

        if (coverage) {
          assert.equal(await callTestMethod(reactor, 'coverage'), 'application ticks');
        } else {
          assert.equal(reactor.coverage, undefined);
        }
        for (const name of jsonArray(names)) {
          const marker = {};
          const result = await callTestMethod(reactor, name, marker);
          assert.deepEqual(jsonArray(calls).pop(), [name, marker]);

          if (name === 'fetch') {
            assert.equal(await callTestMethod(result, 'text'), name);
          } else if (name === 'tail') {
            assert.equal(result, undefined);
          } else {
            assert.equal(result, name);
          }
        }
      },
    );
  }
  await withAdapter(applicationURL, { invalidResult: true }, async (load) => {
    const reactor = jsonObject(jsonObject(await callTestBoundary(load)).reactor);
    await assert.rejects(Promise.resolve(callTestMethod(reactor, 'fetch')), /Expected a Response/);
  });
});

void test('both adapters propagate export failures and reject invalid coverage values', async () => {
  for (const url of [fixtureURL, applicationURL]) {
    const failure = new Error('WASM export rejected');
    const memory = new WebAssembly.Memory({ initial: 1 });
    await callTestBoundary(
      withAdapter,
      url,
      { memory, failure, coverage: async () => 42 },
      async (load: unknown, calls: unknown, names: unknown) => {
        const reactor = jsonObject(jsonObject(await callTestBoundary(load)).reactor);
        await assert.rejects(
          Promise.resolve(callTestMethod(reactor, 'coverage')),
          /Expected a string/,
        );
        for (const name of jsonArray(names)) {
          await assert.rejects(
            Promise.resolve(callTestMethod(reactor, name)),
            (error) => error === failure,
          );
          assert.deepEqual(jsonArray(calls).pop(), [name]);
        }
      },
    );
  }
});

void test('fixture exports enforce every string and response decoder', async () => {
  await callTestBoundary(
    withAdapter,
    fixtureURL,
    {
      memory: new WebAssembly.Memory({ initial: 1 }),
      invalidResult: true,
    },
    async (load: unknown, _calls: unknown, names: unknown) => {
      const reactor = jsonObject(jsonObject(await callTestBoundary(load)).reactor);
      for (const name of jsonArray(names)) {
        await assert.rejects(
          Promise.resolve(callTestMethod(reactor, name)),
          ['attachmentMissingReader', 'emptyResponse', 'configurationFailure'].includes(
            jsonString(name),
          )
            ? /Expected a Response/
            : /Expected a string/,
        );
      }
    },
  );
});
