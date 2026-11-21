import {
  jsonString,
  jsonArray,
  jsonObject,
  jsonSequence,
} from '../../../../scripts/testing/Support/json.mts';
import {
  callTestBoundary,
  callTestMethod,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const request = (path: string, options?: RequestInit): Request<unknown, CfProperties<unknown>> =>
  new Request('https://fixture.test' + path, options);
import { archiveFixture } from './archive-fixture.ts';
import { exerciseClientPolicy } from './client-policy.ts';
void test('archive routing isolates key overrides and preserves request contents', async () => {
  const env = { ATTACHMENT_SSEC_KEY: 'original', other: 42 };
  assert.equal(
    await callTestBoundary(archiveFixture, request('/archives/encrypted/a'), env),
    undefined,
  );
  for (const [variant, key] of [
    ['valid-key', '0123456789abcdef0123456789abcdef'],
    ['wrong-key', 'fedcba9876543210fedcba9876543210'],
    ['missing-key', undefined],
  ] as const) {
    const result = await callTestBoundary(
      archiveFixture,
      request(`/__fixture/archives/${variant}/infrequent/a?x=1`, {
        method: 'PUT',
        body: 'content',
      }),
      env,
      async (forwarded: unknown, bindings: unknown) => {
        assert.equal(
          new URL(jsonString(jsonObject(forwarded).url)).pathname,
          '/archives/infrequent/a',
        );
        assert.equal(new URL(jsonString(jsonObject(forwarded).url)).search, '?x=1');
        assert.equal(await callTestMethod(forwarded, 'text'), 'content');
        assert.equal(jsonObject(forwarded).method, 'PUT');
        assert.equal(jsonObject(bindings).ATTACHMENT_SSEC_KEY, key);
        assert.equal(
          Object.hasOwn(jsonObject(bindings), 'ATTACHMENT_SSEC_KEY'),
          variant !== 'missing-key',
        );
        assert.equal(jsonObject(bindings).other, 42);
        return new Response('forwarded');
      },
    );
    assert.equal(await callTestMethod(jsonObject(result), 'text'), 'forwarded');
    assert.equal(env.ATTACHMENT_SSEC_KEY, 'original');
  }
});

void test('archive cleanup enforces DELETE and reports independently observed deletion', async () => {
  const calls: unknown[][] = [];
  let present = true;
  const env = {
    EXAMPLE_BUCKET: {
      async delete(key: unknown): Promise<void> {
        jsonArray(calls).push(key);
      },
      async head(): Promise<{} | null> {
        return present ? {} : null;
      },
    },
  };
  const path = '/__fixture/archives/cleanup/encrypted/a';
  assert.equal(jsonObject(await callTestBoundary(archiveFixture, request(path), env)).status, 405);
  assert.deepEqual(calls, []);
  assert.deepEqual(
    await callTestMethod(
      await callTestBoundary(archiveFixture, request(path, { method: 'DELETE' }), env),
      'json',
    ),
    { deleted: false },
  );
  present = false;
  assert.deepEqual(
    await callTestMethod(
      await callTestBoundary(archiveFixture, request(path, { method: 'DELETE' }), env),
      'json',
    ),
    { deleted: true },
  );
  assert.deepEqual(calls, ['archives/encrypted/a', 'archives/encrypted/a']);
});

void test('archive inspection handles missing objects, read failures and metadata', async () => {
  for (const outcome of ['missing', 'throw', 'body-throw', 'readable']) {
    const options: unknown[] = [];
    const env = {
      EXAMPLE_BUCKET: {
        async head(): Promise<{ storageClass: string; ssecKeyMd5: string } | null> {
          return outcome === 'missing'
            ? null
            : { storageClass: 'InfrequentAccess', ssecKeyMd5: 'digest' };
        },
        async get(
          key: unknown,
          option: unknown,
        ): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
          assert.equal(key, 'archives/encrypted/a');
          options.push(option);

          if (outcome === 'missing') {
            return null;
          }

          if (outcome === 'throw') {
            throw new Error('denied');
          }

          return {
            async arrayBuffer(): Promise<ArrayBuffer> {
              if (outcome === 'body-throw') {
                throw new Error('stream failed');
              }

              return new ArrayBuffer(0);
            },
          };
        },
      },
    };
    const body = await callTestMethod(
      await callTestBoundary(
        archiveFixture,
        request('/__fixture/archives/inspect/encrypted/a'),
        env,
      ),
      'json',
    );
    assert.deepEqual(body, {
      storageClass: outcome === 'missing' ? null : 'InfrequentAccess',
      keyMetadataPresent: outcome !== 'missing',
      wrongKeyReadable: outcome === 'readable',
      noKeyReadable: outcome === 'readable',
    });
    assert.equal(
      callTestMethod(new TextDecoder(), 'decode', jsonObject(options[0]).ssecKey),
      'fedcba9876543210fedcba9876543210',
    );
    assert.equal(options[1], undefined);
  }
});

void test('client policy injects transport faults per path without changing original binding', async () => {
  const forwarded: unknown[] = [];
  const guide = {
    marker: 12,
    async fetch(input: { url: string | URL }): Promise<Response> {
      jsonArray(forwarded).push(new URL(input.url).pathname);
      return Response.json({ ok: true });
    },
  };
  const originalFetch = globalThis.fetch;
  const response = await callTestBoundary(
    exerciseClientPolicy,
    {
      async fetch(_request: unknown, env: unknown, ctx: unknown): Promise<Response> {
        assert.equal(jsonObject(ctx).marker, 1);
        assert.equal(jsonObject(jsonObject(env).GUIDE).marker, 12);
        for (const path of ['retry', 'no-retry', 'exhausted']) {
          await assert.rejects(
            Promise.resolve(
              callTestMethod(jsonObject(env).GUIDE, 'fetch', request(`/client-target/${path}`)),
            ),
            /network interruption/,
          );
        }
        await assert.rejects(
          Promise.resolve(
            callTestMethod(jsonObject(env).GUIDE, 'fetch', request('/client-target/retry')),
          ),
          /network interruption/,
        );
        assert.equal(
          jsonObject(
            await callTestMethod(
              jsonObject(jsonObject(env).GUIDE),
              'fetch',
              request('/client-target/retry', {
                method: 'POST',
                body: 'payload',
                headers: { 'Idempotency-Key': 'key' },
              }),
            ),
          ).status,
          200,
        );
        assert.equal(
          await callTestMethod(
            jsonObject(
              await callTestMethod(
                jsonObject(env).GUIDE,
                'fetch',
                request('/client-target/malformed'),
              ),
            ),
            'text',
          ),
          '{invalid-json',
        );
        return Response.json({ ok: true });
      },
    },
    request('/'),
    { GUIDE: guide },
    { marker: 1 },
  );
  const body = await callTestMethod(jsonObject(response), 'json');
  assert.equal(jsonObject(body).ok, true);
  assert.equal(jsonSequence(jsonObject(body).transportAttempts).length, 6);
  assert.deepEqual(jsonArray(jsonObject(body).transportAttempts)[4], {
    path: '/client-target/retry',
    method: 'POST',
    key: 'key',
    body: 'payload',
  });
  assert.deepEqual(forwarded, ['/client-target/retry', '/client-target/malformed']);
  assert.equal(globalThis.fetch, originalFetch);
});

void test('client policy preserves errors and rejects malformed successful envelopes', async () => {
  const failed = new Response('failure', { status: 503 });
  assert.equal(
    await callTestBoundary(
      exerciseClientPolicy,
      { fetch: async () => failed },
      request('/'),
      { GUIDE: {} },
      {},
    ),
    failed,
  );
  for (const value of [null, [], 'text', 1]) {
    await assert.rejects(
      Promise.resolve(
        callTestBoundary(
          exerciseClientPolicy,
          { fetch: async () => Response.json(value) },
          request('/'),
          { GUIDE: {} },
          {},
        ),
      ),
      /Expected client policy response object/,
    );
  }
  await assert.rejects(
    Promise.resolve(
      callTestBoundary(
        exerciseClientPolicy,
        {
          async fetch(_request: unknown, env: unknown): Promise<unknown> {
            return callTestMethod(
              jsonObject(env).GUIDE,
              'fetch',
              request('/client-target/malformed'),
            );
          },
        },
        request('/'),
        { GUIDE: { fetch: async () => new Response(null, { status: 503 }) } },
        {},
      ),
    ),
    /destination returned 503/,
  );
});

void test('misc fixture rejects malformed configuration and preserves proxied database contracts', async () => {
  const { miscExampleFixture } = await loadTestModule(
    new URL('./misc-example-fixture.ts', import.meta.url).href,
  );
  let forwarded = 0;
  const observeForward = async (): Promise<Response> => {
    forwarded++;
    return new Response('observed');
  };
  for (const [path, env, status] of [
    ['database', {}, 500],
    ['database', { CATALOG_DB: null }, 500],
    ['socket?path=/unexpected', {}, 400],
    ['unknown', {}, 400],
  ] as const) {
    const response = await callTestBoundary(
      miscExampleFixture,
      request(`/__fixture/misc/${path}`),
      env,
      observeForward,
    );
    assert.equal(jsonObject(response).status, status);
  }
  assert.equal(forwarded, 0);
  await callTestBoundary(
    miscExampleFixture,
    request('/__fixture/misc/configuration'),
    {},
    observeForward,
  );
  assert.equal(forwarded, 1);
  await callTestBoundary(
    miscExampleFixture,
    request('/__fixture/misc/configuration'),
    {},
    async (_request: unknown, env: unknown) => {
      assert.equal(jsonObject(env).EXAMPLE_MODE, '');
      assert.equal(jsonObject(env).EXAMPLE_SECRET, '');
      return new Response('configured');
    },
  );
  const statement: TestStatement = {
    label: 'statement',
    first(): string {
      return this.label;
    },
    bind(): TestStatement {
      return this;
    },
  };
  const database: { label: string; prepare(): TestStatement; exec?: () => Promise<void> } = {
    label: 'database',
    prepare(): TestStatement {
      assert.equal(this, database);
      return statement;
    },
  };
  await callTestBoundary(
    miscExampleFixture,
    request('/__fixture/misc/database'),
    { CATALOG_DB: database },
    async (_request: unknown, env: unknown) => {
      assert.equal(jsonObject(jsonObject(env).CATALOG_DB).label, 'database');
      const prepared = callTestMethod(
        callTestMethod(jsonObject(jsonObject(env).CATALOG_DB), 'prepare', 'SELECT 1'),
        'bind',
      );
      assert.equal(jsonObject(prepared).label, 'statement');
      await assert.rejects(
        Promise.resolve(callTestMethod(prepared, 'first')),
        /Missing database exec/,
      );
      database.exec = async () => {};
      assert.equal(await callTestMethod(prepared, 'first'), 'statement');
      return new Response('checked');
    },
  );
});

void test('R2 extra fixture rejects absent metadata and preserves native data properties', async () => {
  const { r2ExampleExtraFixture } = await loadTestModule(
    new URL('./r2-example-extra.ts', import.meta.url).href,
  );
  const input = callTestBoundary(request, '/__fixture/r2-extra/archive-error');
  let forwards = 0;
  const forward = async (
    _request: unknown,
    env: { EXAMPLE_BUCKET: { label: unknown } },
  ): Promise<Response> => {
    forwards++;
    assert.equal(env.EXAMPLE_BUCKET.label, 'native bucket');
    return new Response('forwarded');
  };
  await assert.rejects(
    Promise.resolve(
      callTestBoundary(
        r2ExampleExtraFixture,
        input,
        { EXAMPLE_BUCKET: { put: async () => {}, head: async () => null } },
        forward,
      ),
    ),
    /R2 fixture metadata missing/,
  );
  assert.equal(forwards, 0);
  const deletions = [];
  const bucket = {
    label: 'native bucket',
    put: async () => {},
    head: async () => ({}),
    delete: async (keys: unknown) => {
      deletions.push(keys);
    },
  };
  const response = await callTestBoundary(
    r2ExampleExtraFixture,
    input,
    { EXAMPLE_BUCKET: bucket },
    forward,
  );
  assert.equal(jsonObject(await callTestMethod(jsonObject(response), 'json')).body, 'forwarded');
  assert.equal(deletions.length, 1);
  assert.equal(forwards, 1);
});

void test('new storage and R2 proxies preserve native properties and valid list requests', async () => {
  const { miscExampleFixture } = await loadTestModule(
    new URL('./misc-example-fixture.ts', import.meta.url).href,
  );
  const { r2FailureExtraFixture } = await loadTestModule(
    new URL('./r2-example-extra.ts', import.meta.url).href,
  );
  const invoke = async (): Promise<Response> => new Response('forwarded');
  assert.equal(
    await callTestMethod(
      await callTestBoundary(
        miscExampleFixture,
        request('/__fixture/misc/configuration'),
        {},
        invoke,
      ),
      'text',
    ),
    'forwarded',
  );
  const support = async (namespace: {
    label: unknown;
    list: (arg0?: { limit: number; cursor: string } | null | undefined) => unknown;
  }): Promise<string> => {
    assert.equal(namespace.label, 'KV');
    assert.deepEqual(await callTestMethod(namespace, 'list'), { options: undefined });
    assert.deepEqual(await namespace.list(null), { options: null });
    assert.deepEqual(await namespace.list({ limit: 1, cursor: 'valid' }), {
      options: { limit: 1, cursor: 'valid' },
    });
    return '{}';
  };
  for (const value of [null, undefined]) {
    assert.equal(
      jsonObject(
        await callTestBoundary(
          miscExampleFixture,
          request('/__fixture/misc/storage-refusal'),
          { SETTINGS: value },
          invoke,
          undefined,
          support,
        ),
      ).status,
      500,
    );
  }
  const namespace = {
    label: 'KV',
    async list(options: unknown): Promise<{ options: unknown }> {
      assert.equal(this, namespace);
      return { options };
    },
  };
  assert.equal(
    jsonObject(
      await callTestBoundary(
        miscExampleFixture,
        request('/__fixture/misc/storage-refusal'),
        { SETTINGS: namespace },
        invoke,
        undefined,
        support,
      ),
    ).status,
    200,
  );
  const response = await callTestBoundary(
    miscExampleFixture,
    request('/__fixture/misc/support-socket'),
    {},
    invoke,
    async (_connector: unknown, scenario: string) => {
      assert.equal(scenario, 'unknown');
      return '{}';
    },
  );
  assert.equal(jsonObject(response).status, 200);
  const bucket = { label: 'bucket' };
  assert.equal(
    jsonObject(
      await callTestBoundary(
        r2FailureExtraFixture,
        request('/__fixture/r2-failure-extra/unknown'),
        { EXAMPLE_BUCKET: bucket },
        async (controlled: unknown) => {
          assert.equal(jsonObject(controlled).label, 'bucket');
          return '{}';
        },
      ),
    ).status,
    200,
  );
});

interface TestStatement {
  label: string;
  first(): string;
  bind(): TestStatement;
}
