import type * as Module from 'node:module';
import { jsonArray, jsonObject, jsonValue } from '../../../../../scripts/testing/Support/json.mts';
import {
  callTestBoundary,
  callTestMethod,
  loadTestModule,
} from '../../../../../scripts/testing/Support/test-boundary.mts';
/** Local boundary contracts only: no real R2, network, WASM or encryption proof. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';
import { registerHooks } from 'node:module';
import type { BinaryLike } from 'crypto';
let serial = 0;
const archiveKey = 'archives/encrypted/remote-archive.bin';
const probeURL = new URL('./ssec-probe.ts', import.meta.url);

async function withProbe(
  mode: string,
  action: (probe: unknown, env: unknown, calls: unknown[][], receipts: unknown[]) => Promise<void>,
): Promise<void> {
  const calls: unknown[][] = [],
    receipts: unknown[] = [];
  let secret: BinaryLike | undefined;
  let archiveReads = 0;
  const upload = {
    key: archiveKey,
    uploadId: 'fake-upload',
    async uploadPart(
      part: unknown,
      bytes: { byteLength: unknown },
    ): Promise<{ partNumber: unknown; etag: string }> {
      calls.push(['part', part, bytes.byteLength]);
      return { partNumber: part, etag: 'fake' };
    },
    async complete(parts: unknown): Promise<{}> {
      calls.push(['complete', parts]);
      return {};
    },
    async abort(): Promise<void> {
      calls.push(['abort']);
    },
  };
  function result(
    key: unknown,
    recovered: boolean,
  ): { ssecKeyMd5: unknown; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null {
    if (mode === 'null-objects') {
      return null;
    }

    const bytes = new Uint8Array(5242883);
    bytes.fill(65, 0, 5242880);
    bytes.set([0, 128, 255], 5242880);

    if (mode === 'bad-archive') {
      bytes[0] = 0;
    }

    if (mode === 'bad-recovery' && recovered) {
      bytes[1] = 0;
    }

    return {
      ssecKeyMd5: callTestMethod(
        callTestMethod(createHash('md5'), 'update', secret),
        'digest',
        'hex',
      ),
      async text(): Promise<string> {
        return mode === 'bad-attachment' ? 'bad' : 'x'.repeat(4096);
      },
      async arrayBuffer(): Promise<ArrayBuffer> {
        return bytes.buffer;
      },
    };
  }
  const bucket = {
    async put(): Promise<{}> {
      calls.push(['put']);
      return {};
    },
    async get(
      key: string,
      options?: { ssecKey: AllowSharedBufferSource | undefined },
    ): Promise<{
      ssecKeyMd5: unknown;
      text(): Promise<string>;
      arrayBuffer(): Promise<ArrayBuffer>;
    } | null> {
      const keyText = new TextDecoder().decode(options?.ssecKey);

      if (keyText !== secret) {
        if (mode === 'wrong-key-returned') {
          return null;
        }

        throw new Error(
          mode === 'classified-error' ? 'fake transport (10001)' : 'fake unknown failure',
        );
      }

      if (key === archiveKey) {
        archiveReads += 1;
      }

      return result(key, archiveReads > 1);
    },
    async createMultipartUpload(key: unknown): Promise<{
      key: string;
      uploadId: string;
      uploadPart(
        part: unknown,
        bytes: { byteLength: unknown },
      ): Promise<{ partNumber: unknown; etag: string }>;
      complete(parts: unknown): Promise<{}>;
      abort(): Promise<void>;
    }> {
      calls.push(['create', key]);
      return upload;
    },
    resumeMultipartUpload(
      key: unknown,
      identifier: unknown,
    ): {
      key: string;
      uploadId: string;
      uploadPart(
        part: unknown,
        bytes: { byteLength: unknown },
      ): Promise<{ partNumber: unknown; etag: string }>;
      complete(parts: unknown): Promise<{}>;
      abort(): Promise<void>;
    } {
      calls.push(['resume', key, identifier]);
      return upload;
    },
  };
  async function reactorFetch(
    request: { method: string; headers: { has: (arg0: string) => unknown } },
    env: {
      ATTACHMENT_SSEC_KEY: BinaryLike | undefined;
      EXAMPLE_BUCKET: {
        put: (arg0: string, arg1: string) => unknown;
        createMultipartUpload: (arg0: string, arg1: {}) => unknown;
        resumeMultipartUpload: (
          arg0: string,
          arg1: string,
        ) => { (): unknown; new (): unknown; abort: { (): unknown; new (): unknown } };
        get: (arg0: string, arg1: { ssecKey: ArrayBuffer }) => unknown;
      };
    },
  ): Promise<Response> {
    if (request.method === 'PUT') {
      secret = env.ATTACHMENT_SSEC_KEY;
      await env.EXAMPLE_BUCKET.put('fake', 'body');

      if (mode === 'put-fails') {
        return new Response(null, { status: 500 });
      }

      return new Response(null, { status: 201 });
    }

    if (request.method === 'POST') {
      const multipart = await env.EXAMPLE_BUCKET.createMultipartUpload(
        mode === 'unexpected-key' ? 'forbidden' : archiveKey,
        {},
      );
      const part = await callTestMethod(
        jsonObject(multipart),
        'uploadPart',
        1,
        new Uint8Array([1]).buffer,
      );
      await callTestMethod(jsonObject(multipart), 'complete', [part]);
      await env.EXAMPLE_BUCKET.resumeMultipartUpload(archiveKey, 'fake-upload').abort();
      return new Response(null, { status: mode === 'bad-archive-status' ? 500 : 201 });
    }

    if (!request.headers.has('X-Attachment-Encryption')) {
      return new Response(null, { status: 404 });
    }

    if (!env.ATTACHMENT_SSEC_KEY) {
      return new Response(null, { status: 503 });
    }

    if (env.ATTACHMENT_SSEC_KEY !== secret) {
      return new Response(null, { status: 502 });
    }

    await callTestMethod(env.EXAMPLE_BUCKET, 'get', 'attachments/encrypted/remote-probe.bin', {
      ssecKey: jsonObject(callTestMethod(new TextEncoder(), 'encode', secret)).buffer,
    });
    return new Response('x'.repeat(4096), {
      headers: {
        'Content-Type': mode === 'bad-metadata' ? 'text/plain' : 'application/octet-stream',
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'attachment; filename="remote-probe.bin"',
        ETag: 'fake',
      },
    });
  }
  const runtime = mock.module('@cloudflare-workers-hs/runtime', {
    namedExports: {
      async createReactor(_wasm: unknown, imports: () => void, bind: unknown): Promise<unknown> {
        imports();
        return callTestBoundary(bind, { fetch: reactorFetch });
      },
      bindExport(
        exports: Record<string, unknown>,
        name: string,
        decode: unknown,
      ): (...args: unknown[]) => Promise<unknown> {
        return async (...args: unknown[]) =>
          callTestBoundary(decode, await callTestBoundary(exports[name], ...args));
      },
      decodeResponse(value: unknown): unknown {
        return value;
      },
    },
  });
  const glue = mock.module(new URL('../../../worker/api-catalog-jsffi.mjs', import.meta.url).href, {
    defaultExport: () => ({}),
  });
  const wasmURL = new URL('../../../worker/api-catalog.wasm', import.meta.url).href;
  const wasm = registerHooks({
    load(
      url: string,
      context: Module.LoadHookContext,
      nextLoad: (url: string, context?: Partial<Module.LoadHookContext>) => Module.LoadFnOutput,
    ): import('module').LoadFnOutput {
      if (url === wasmURL) {
        return { format: 'module', source: 'export default {};', shortCircuit: true };
      }

      return nextLoad(url, context);
    },
  });
  const fetch = mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string }) => {
    const record = jsonValue(init.body);
    receipts.push(record);
    return new Response(null, {
      status: mode === `receipt-${jsonObject(record).phase}` ? 503 : 204,
    });
  });
  const randomness = mock.method(crypto, 'getRandomValues', (array: number[]) =>
    array.fill(mode === 'zero-key' ? 0 : 1),
  );
  try {
    const { default: probe } = await loadTestModule(probeURL.href + `?contract=${++serial}`);
    await action(
      probe,
      {
        EXAMPLE_BUCKET: bucket,
        RECEIPT_URL: 'https://unused.invalid/receipt',
        EXAMPLE_MODE: 'fixture',
        EXAMPLE_SECRET: 'unused',
      },
      calls,
      receipts,
    );
  } finally {
    randomness.mock.restore();
    fetch.mock.restore();
    wasm.deregister();
    glue.restore();
    runtime.restore();
  }
}

for (const mode of [
  'happy',
  'zero-key',
  'wrong-key-returned',
  'classified-error',
  'null-objects',
  'bad-archive',
  'bad-recovery',
  'bad-attachment',
  'bad-metadata',
  'bad-archive-status',
  'put-fails',
  'unexpected-key',
  'receipt-intent',
  'receipt-created',
  'receipt-closed',
]) {
  void test(`SSE-C probe local boundary contract: ${mode}`, async () => {
    await callTestBoundary(
      withProbe,
      mode,
      async (probe: unknown, env: unknown, calls: unknown, receipts: unknown) => {
        assert.equal(
          jsonObject(
            await callTestMethod(
              jsonObject(probe),
              'fetch',
              new Request('https://probe.invalid/health'),
              env,
              {},
            ),
          ).status,
          200,
        );
        assert.equal(
          jsonObject(
            await callTestMethod(
              jsonObject(probe),
              'fetch',
              new Request('https://probe.invalid/run'),
              env,
              {},
            ),
          ).status,
          404,
        );
        assert.equal(
          jsonObject(
            await callTestMethod(
              jsonObject(probe),
              'fetch',
              new Request('https://probe.invalid/other', { method: 'POST' }),
              env,
              {},
            ),
          ).status,
          404,
        );
        const response = await callTestMethod(
          jsonObject(probe),
          'fetch',
          new Request('https://probe.invalid/run', { method: 'POST' }),
          env,
          {},
        );
        assert.equal(
          jsonObject(response).status,
          500,
          'local contracts must never claim verified encryption rejection',
        );
        const body = await callTestMethod(response, 'json');
        assert.equal(jsonObject(body).passed, false);

        if (
          [
            'put-fails',
            'unexpected-key',
            'receipt-intent',
            'receipt-created',
            'receipt-closed',
          ].includes(mode)
        ) {
          assert.deepEqual(body, { passed: false, stage: 'ssec-probe' });
        } else {
          assert.equal(jsonObject(body).negativeProof, 'unverified');
          assert.equal(
            jsonObject(body).positiveChecksPassed,
            ['happy', 'zero-key', 'wrong-key-returned', 'classified-error'].includes(mode),
          );
        }

        if (mode === 'receipt-created') {
          assert.ok(jsonArray(calls).some((call) => jsonArray(call)[0] === 'abort'));
        }

        for (const receipt of jsonArray(receipts)) {
          assert.equal(jsonObject(receipt).key, archiveKey);
          assert.deepEqual(
            Object.keys(jsonObject(receipt)).sort(),
            jsonObject(receipt).phase === 'intent'
              ? ['key', 'phase']
              : ['identifier', 'key', 'phase'],
          );
        }
        assert.equal(
          jsonObject(
            await callTestMethod(
              jsonObject(probe),
              'fetch',
              new Request('https://probe.invalid/run', { method: 'POST' }),
              env,
              {},
            ),
          ).status,
          404,
        );
      },
    );
  });
}
