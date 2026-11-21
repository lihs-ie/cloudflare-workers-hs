import { jsonString } from '../../../../scripts/testing/Support/json.mts';
import { jsonArray, jsonObject, jsonValue } from '../../../../scripts/testing/Support/json.mts';
import { expect, it } from 'vitest';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  sqlProbe,
  storageErrorProbe,
  storageObjectErrors,
  storageNativeProbe,
  queueOutcome,
  workflowBoundaryExtraProbe,
} from '../../../../tests/runtime/harness.js';

type Probe = (mode: string) => Promise<string>;

export function registerStoragePublicContractsCases(probe: Probe): void {
  it('detects storage snapshots and configuration changes without losing diagnostic suffixes', async () => {
    const result = jsonValue(await probe('snapshots'));
    expect(jsonObject(result).contracts).toHaveLength(44);
    expect(jsonObject(result).multipartDeduplicated).toBe(true);
    for (const contract of jsonArray(jsonObject(result).contracts)) {
      expect(contract, jsonString(jsonObject(contract).name)).toMatchObject({
        same: true,
        changed: true,
        batch: true,
        embedded: true,
      });
      expect(jsonObject(contract).diagnostic, jsonString(jsonObject(contract).name)).toMatch(
        /^\[.+,.+\]$/,
      );
    }
    expect(
      jsonObject(
        jsonArray(jsonObject(result).contracts).find(
          (contract) => jsonObject(contract).name === 'R2UploadedPart',
        ),
      ).diagnostic,
    ).toContain('r2UploadedPartEtag = "etag-b"');
  });

  it('recovers each typed storage failure with its original payload and printable batch diagnostic', async () => {
    const result = jsonValue(await probe('exceptions'));
    expect(jsonObject(result).exceptions).toHaveLength(9);
    for (const failure of jsonArray(jsonObject(result).exceptions)) {
      expect(jsonObject(failure).recovered, jsonString(jsonObject(failure).name)).toBe(true);
      expect(jsonObject(failure).values, jsonString(jsonObject(failure).name)).toMatchObject({
        same: true,
        changed: true,
        batch: true,
        embedded: true,
      });
    }
  });

  it('selects inclusive workflow identifier ranges and deduplicates persisted identifier batches', async () => {
    const result = jsonValue(await probe('ordering'));
    expect(result).toMatchObject({
      contained: true,
      strict: true,
      compare: true,
      endpoints: true,
      deduplicated: true,
    });
    for (const contract of jsonArray(jsonObject(result).contracts)) {
      expect(contract).toMatchObject({ same: true, changed: true, batch: true, embedded: true });
    }
  });

  it('preserves required SQL/job JSON fields and validates bulk workflow records', async () => {
    const result = jsonValue(await probe('json-contracts'));
    expect(result).toMatchObject({
      rowsRead: 3,
      scalar: true,
      values: true,
      statements: true,
      retainedValue: true,
      retainedStatement: true,
      envelopeJSON: true,
      envelopeListJSON: true,
      envelopeListEncoding: true,
      nestedEncoding: true,
      envelopeListDecode: true,
    });
    expect(jsonObject(result).nestedMissingDiagnostic).toMatch(
      /^Error in \$:.*key "required" not found$/,
    );
    expect(jsonObject(result).required).toHaveLength(6);
    for (const field of jsonArray(jsonObject(result).required)) {
      expect(jsonObject(field).present, jsonString(jsonObject(field).name)).toBe(true);
      expect(jsonObject(field).missingDiagnostic, jsonString(jsonObject(field).name)).toMatch(
        /^Error in \$:.*key "required" not found$/,
      );
    }
    expect(jsonObject(result).bulk).toHaveLength(4);
    for (const batch of jsonArray(jsonObject(result).bulk)) {
      expect(jsonObject(batch).matches, jsonString(jsonObject(batch).name)).toBe(true);
      expect(jsonObject(batch).malformedDiagnostic, jsonString(jsonObject(batch).name)).toBe(
        `Error in $[0]: parsing ${jsonObject(batch).name} failed, expected Object, but encountered Boolean`,
      );
    }
  });

  it('compares unwrapped synthetic encryption keys and renders their diagnostic batch', async () => {
    const result = jsonValue(await probe('ssec-diagnostics'));
    expect(result).toMatchObject({ same: true, changed: true, batch: true, embedded: true });
    expect(jsonObject(result).diagnostic).toMatch(/^\[R2SsecKey .+,R2SsecKey .+\]$/);
  });

  it('rejects an unknown public contract probe mode', async () => {
    await expect(probe('invalid-mode')).rejects.toThrow('Unknown storage public contract mode');
  });

  it('observes successful SQL batch defaults and storage diagnostic fallback inputs', async () => {
    const seen: unknown[][] = [];
    const storage = {
      transactionSync: (action: () => unknown) => action(),
      sql: {
        exec: (...args: unknown[]) => {
          seen.push(args);
          return {
            columnNames: ['value'],
            rowsRead: 1,
            rowsWritten: 0,
            raw: () => [[1.5, 'text', null]],
          };
        },
      },
    };
    expect(await sqlProbe(storage, 'default-batch')).toBe(
      '[SQLResult {columns = ["value"], rows = [[SQLNumber 1.5,SQLText "text",SQLNull]], rowsRead = 1, rowsWritten = 0}]',
    );
    expect(seen).toEqual([['SELECT ?', 1.5, 'text', null]]);
    expect(await storageErrorProbe({ get: () => null }, 'kv-get')).toBe('missing');
    expect(
      await storageErrorProbe(
        {
          put: () => {
            throw new Error('put unavailable');
          },
        },
        'kv-put-text',
      ),
    ).toContain('KVPutFailed');
    expect(await storageErrorProbe({}, 'invalid-command')).toBe(
      'user error (unknown storage error command)',
    );
    expect(await storageObjectErrors({}, 'invalid-command')).toBe(
      'user error (unknown storage object command)',
    );
    expect(await storageNativeProbe({}, 'invalid-command')).toBe(
      'user error (unknown storage probe)',
    );
    for (const command of ['public-send', 'public-batch']) {
      const producer = {
        send: () => {
          throw new Error('queue unavailable');
        },
        sendBatch: () => {
          throw new Error('queue unavailable');
        },
      };
      expect(await queueOutcome(producer, command)).toContain(
        command === 'public-batch' ? 'QueueSendBatchFailed' : 'QueueSendFailed',
      );
    }
  });

  it('observes multipart success, terminal failure, and active upload after repeated completion failures', async () => {
    const metadata = {
      key: 'key',
      version: 'version',
      size: 3,
      etag: 'etag',
      httpEtag: '\"etag\"',
      checksums: {},
      uploaded: new Date(123),
      storageClass: 'Standard',
    };
    const calls: unknown[][] = [];
    const upload = {
      key: 'key',
      uploadId: 'upload',
      uploadPart: async (part: number, body: Uint8Array) => {
        calls.push([part, Array.from(body)]);
        return { partNumber: part, etag: 'part-etag' };
      },
    };
    expect(await storageNativeProbe({ createMultipartUpload: () => upload }, 'r2-create')).toBe(
      'ok',
    );
    expect(await storageNativeProbe({ resumeMultipartUpload: () => upload }, 'r2-upload')).toBe(
      'R2UploadedPart {r2UploadedPartNumber = 1, r2UploadedPartEtag = "part-etag"}',
    );
    expect(calls).toEqual([[1, [97, 98, 99]]]);
    expect(
      await storageNativeProbe(
        { resumeMultipartUpload: () => ({ ...upload, complete: () => metadata }) },
        'r2-complete-retry',
      ),
    ).toBe('(Right "version",Left "R2MultipartTerminal",Left R2MultipartTerminal)');
    const failed = await storageNativeProbe(
      {
        resumeMultipartUpload: () => ({
          ...upload,
          complete: () => {
            throw new Error('completion unavailable');
          },
        }),
      },
      'r2-complete-retry',
    );
    expect(failed).toBe(
      String.raw`(Left "R2MultipartFailed \"Error: completion unavailable\"",Left "R2MultipartFailed \"Error: completion unavailable\"",Right (R2UploadedPart {r2UploadedPartNumber = 2, r2UploadedPartEtag = "part-etag"}))`,
    );
    expect(calls).toEqual([
      [1, [97, 98, 99]],
      [2, [98, 111, 100, 121]],
    ]);
    expect(
      await storageNativeProbe(
        { get: () => ({ ...metadata, body: new ReadableStream() }) },
        'r2-body-unknown',
      ),
    ).toBe('user error (unknown body method)');
    expect(await storageNativeProbe({ get: () => null }, 'r2-body-text')).toBe(
      'user error (expected R2 object body)',
    );
  });

  it('validates workflow configuration errors and executes callbacks with each retry strategy', async () => {
    const run = async (raw: unknown, config: string): Promise<unknown> =>
      jsonValue(await workflowBoundaryExtraProbe(raw, NonRetryableError, config));
    const malformed = await run({}, '{');
    expect(jsonObject(malformed).ok).toBe(false);
    expect(jsonObject(malformed).message).toBe(
      'user error (Unexpected end-of-input, expecting record key literal or })',
    );
    const missing = await run({}, '{}');
    expect(missing).toEqual({
      ok: false,
      message: 'user error (Error in $: key "operation" not found)',
    });
    const nonObject = await run({}, '[]');
    expect(nonObject).toEqual({
      ok: false,
      message:
        'user error (Error in $: parsing config failed, expected Object, but encountered Array)',
    });
    expect(await run({}, '{"operation":"unknown"}')).toEqual({
      ok: false,
      message: 'user error (Unknown workflow boundary operation)',
    });
    const seen: unknown[] = [];
    const step = {
      do: async (
        _name: string,
        options: unknown,
        action: (context: unknown) => Promise<number>,
      ) => {
        seen.push(options);
        return action({ step: { name: 'send', count: 1 }, attempt: 2 });
      },
    };
    expect(await run(step, '{"operation":"defaults"}')).toEqual({ ok: true, value: 1 });
    for (const backoff of ['linear', 'exponential']) {
      expect(
        await run(step, JSON.stringify({ operation: 'do', backoff, duration: 1000, retry: 2 })),
      ).toEqual({ ok: true, value: 9 });
    }
    expect(seen).toEqual([
      { retries: { limit: 5, delay: 1000, backoff: 'exponential' }, timeout: 60000 },
      { retries: { limit: 2, delay: 1000, backoff: 'linear' }, timeout: 1000 },
      { retries: { limit: 2, delay: 1000, backoff: 'exponential' }, timeout: 1000 },
    ]);
  });
}
