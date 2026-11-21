import type * as Module from 'node:module';
import {
  callTestMethod,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
import { jsonObject, jsonString } from '../../../../scripts/testing/Support/json.mts';
declare global {
  var WASM_COVERAGE_ENDPOINT: string | undefined;
}
/** Actual upload helpers with reactor doubles: Node coverage, not WASM/platform proof. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

for (const example of ['minimal', 'static-assets', 'realtime', 'workflows']) {
  void test(`${example} upload interception restores fetch and preserves recovery`, async () => {
    const slot = Symbol.for('upload-helper-contract');
    const originalFetch = globalThis.fetch;
    const endpointDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'WASM_COVERAGE_ENDPOINT',
    );
    const forwarded = [];
    // Each behavior is explicitly installed before its first invocation.
    const boundary: Record<string, unknown> = {};
    Reflect.set(globalThis, slot, boundary);
    const source = `/* ${example} */` + "const b=globalThis[Symbol.for('upload-helper-contract')];";
    const hooks = registerHooks({
      resolve(
        specifier: string,
        context: Module.ResolveHookContext,
        next: (
          specifier: string,
          context?: Partial<Module.ResolveHookContext>,
        ) => Module.ResolveFnOutput,
      ): import('module').ResolveFnOutput {
        if (specifier.startsWith('../../worker') && !specifier.endsWith('runtime')) {
          return {
            url: `data:text/javascript,${encodeURIComponent(source + 'export default {fetch:(...args)=>b.fetch(...args)}')}`,
            shortCircuit: true,
          };
        }

        if (specifier === './runtime' || specifier === '../../worker/runtime') {
          return {
            url: `data:text/javascript,${encodeURIComponent(source + 'export async function createFixtureReactor(){return b.reactor} export async function createWorkflowReactor(){return b.reactor}')}`,
            shortCircuit: true,
          };
        }

        return next(specifier, context);
      },
    });
    globalThis.fetch = async (input, init) => {
      forwarded.push([input, init]);
      return Response.json({ ok: true });
    };
    const restored = globalThis.fetch;
    const env = {};
    const context = {};
    try {
      const url = new URL(`../../../${example}/test/Support/coverage-upload.ts`, import.meta.url);
      const { default: helper } = await loadTestModule(url.href);
      const invoke = (mode: string = 'production'): unknown =>
        callTestMethod(
          jsonObject(helper),
          'fetch',
          new Request(`https://helper.test/__coverage/upload-failure?mode=${mode}`),
          env,
          context,
        );
      const request = new Request('https://helper.test/normal');
      boundary.fetch = async (...args: unknown[]) => {
        assert.deepEqual(args, [request, env, context]);
        return new Response('forwarded');
      };
      assert.equal(
        await callTestMethod(
          await callTestMethod(jsonObject(helper), 'fetch', request, env, context),
          'text',
        ),
        'forwarded',
      );
      delete globalThis.WASM_COVERAGE_ENDPOINT;
      assert.equal(jsonObject(await invoke()).status, 409);
      globalThis.WASM_COVERAGE_ENDPOINT = 'https://collector.test/upload';
      const upload = async (requestObject: boolean): Promise<void> => {
        const input = requestObject
          ? new Request(jsonString(globalThis.WASM_COVERAGE_ENDPOINT))
          : jsonString(globalThis.WASM_COVERAGE_ENDPOINT);
        const response = await globalThis.fetch(input);

        if (!response.ok) {
          throw new Error(`Coverage upload failed: ${response.status}`);
        }
      };
      for (const rejection of [new Error('expected failure'), 'primitive failure', undefined]) {
        boundary.fetch = async () => {
          assert.equal(
            (await globalThis.fetch(new Request(jsonString(globalThis.WASM_COVERAGE_ENDPOINT))))
              .status,
            503,
          );
          assert.equal(
            (await globalThis.fetch(jsonString(globalThis.WASM_COVERAGE_ENDPOINT))).status,
            503,
          );
          await globalThis.fetch('https://ordinary.test', { method: 'POST' });

          if (rejection !== undefined) {
            throw rejection;
          }

          return new Response('ok');
        };
        const result = await callTestMethod(await invoke(), 'json');
        assert.equal(jsonObject(result).attempts, 2);
        assert.equal(jsonObject(result).rejected, rejection !== undefined);

        if (rejection !== undefined) {
          assert.equal(
            jsonObject(result).message,
            rejection instanceof Error ? rejection.message : rejection,
          );
        }

        assert.equal(globalThis.fetch, restored);
      }
      assert.equal(forwarded.length, 3);
      const defaultMode = await callTestMethod(
        jsonObject(helper),
        'fetch',
        new Request('https://helper.test/__coverage/upload-failure'),
        env,
        context,
      );
      assert.equal(jsonObject(await callTestMethod(defaultMode, 'json')).rejected, false);
      assert.equal(globalThis.fetch, restored);

      if (example === 'workflows') {
        for (const mode of ['fixture', 'production-reactor']) {
          boundary.reactor = {
            async workflowControlFixture(
              binding: { get: () => unknown },
              operation: string | number,
            ): Promise<string> {
              const handle = await binding.get();
              assert.equal(jsonObject(handle).id, 'coverage-upload-contract');
              await callTestMethod(jsonObject(handle), operation);
              assert.deepEqual(await callTestMethod(jsonObject(handle), 'status'), {
                status: 'paused',
              });
              await globalThis.fetch('https://ordinary.test');
              await upload(true);
              return JSON.stringify({ status: 'paused' });
            },
            async fetch(): Promise<Response> {
              await globalThis.fetch('https://ordinary.test');
              await upload(false);
              return Response.json({ ok: true });
            },
          };
          const result = await callTestMethod(await invoke(mode), 'json');
          assert.equal(jsonObject(result).rejected, true);
          assert.equal(jsonObject(result).attempts, 1);
          assert.equal(jsonObject(result).operations, 3);
          assert.equal(jsonObject(result).message, 'Coverage upload failed: 503');
          assert.deepEqual(jsonObject(result).recovered, jsonObject(result).confirmed);
          assert.equal(globalThis.fetch, restored);
        }
        jsonObject(boundary.reactor).fetch = async () => new Response('bad', { status: 502 });
        await assert.rejects(
          Promise.resolve(invoke('production-reactor')),
          /Unexpected health status: 502/,
        );
        assert.equal(globalThis.fetch, restored);
        let calls = 0;
        jsonObject(boundary.reactor).workflowControlFixture = async () => {
          if (++calls === 1) {
            throw 'primitive rejection';
          }

          return '{}';
        };
        const primitive = await callTestMethod(await invoke('fixture'), 'json');
        assert.equal(jsonObject(primitive).message, 'primitive rejection');
        jsonObject(boundary.reactor).workflowControlFixture = async () => '{}';
        assert.equal(
          jsonObject(await callTestMethod(await invoke('fixture'), 'json')).rejected,
          false,
        );
      }
    } finally {
      hooks.deregister();
      globalThis.fetch = originalFetch;

      if (endpointDescriptor) {
        Object.defineProperty(globalThis, 'WASM_COVERAGE_ENDPOINT', endpointDescriptor);
      } else {
        delete globalThis.WASM_COVERAGE_ENDPOINT;
      }
      Reflect.deleteProperty(globalThis, slot);
    }
  });
}
