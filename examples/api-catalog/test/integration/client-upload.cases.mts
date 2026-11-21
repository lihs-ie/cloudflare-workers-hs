import { poll } from '../../../../scripts/testing/Support/polling.mts';
import { jsonNumber, jsonObject } from '../../../../scripts/testing/Support/json.mts';
import type { startRuntime } from '../Support/dev-runtime.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

export function registerClientUploadTests(
  getRuntime: () => Awaited<ReturnType<typeof startRuntime>>,
): void {
  void test('HTTP early response releases its finite producer and upload without replay', async () => {
    const runtime = getRuntime();
    const before = runtime.clientHttpFixture.uploads().length;
    runtime.clientHttpFixture.failNextUpload('early-success');
    const response = await fetch(runtime.base + '/__fixture/client-upload', {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(jsonObject(result).outcome, 'success');
    assert.equal(
      jsonObject(result).stopped,
      true,
      'source traversal must release its scope after the early response',
    );
    const atResponse = jsonNumber(jsonObject(result).atResponse);
    assert.ok(
      atResponse >= 1 && atResponse <= 10,
      'response observes a valid point in the finite producer',
    );
    const generated = jsonNumber(jsonObject(result).generated);
    assert.ok(generated >= atResponse && generated <= 10);
    const observed = await poll({
      observe: async () => runtime.clientHttpFixture.uploads().slice(before),
      complete: (uploads) => uploads.length === 1 && uploads[0].closed,
      timeout: 5000,
      interval: 10,
      diagnostic: (uploads) => `Upload did not close: ${JSON.stringify(uploads)}`,
    });
    assert.equal(observed.length, 1);
    assert.ok(
      typeof observed[0].responseAtBytes === 'number' &&
        observed[0].responseAtBytes > 0 &&
        observed[0].responseAtBytes < 30,
      'the peer must respond before it receives the complete upload',
    );
    assert.ok(observed[0].bytes > 0 && observed[0].bytes <= generated * 3);
    assert.equal(observed[0].closed, true);
  });
  void test('HTTP streaming upload preserves an error response without replay and recovers', async () => {
    const runtime = getRuntime();
    const fixture = runtime.clientHttpFixture;
    const before = fixture.uploads().length;
    fixture.failNextUpload('http-error');
    for (const outcome of ['unexpected-client-error', 'success']) {
      const response = await fetch(runtime.base + '/__fixture/client-upload', {
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), {
        outcome,
        stopped: true,
        generated: 10,
        atResponse: 10,
      });
    }
    const observed = fixture.uploads().slice(before);
    assert.equal(observed.length, 2, 'the failed streaming PUT must not be retried');
    assert.ok(observed.every((upload) => upload.ended && upload.bytes === 30));
  });
  for (const mode of ['after', 'during']) {
    void test(`HTTP streaming PUT stops its producer without replay on connection loss ${mode} upload`, async () => {
      const fixture = getRuntime().clientHttpFixture;
      const before = fixture.uploads().length;
      fixture.failNextUpload(mode);
      const invoke = async (): Promise<unknown> => {
        const response = await fetch(`${getRuntime().base}/__fixture/client-upload`, {
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      const failed = await invoke();
      assert.equal(jsonObject(failed).outcome, 'FetchNetworkFailure');
      assert.equal(jsonObject(failed).stopped, true, 'source traversal finally must have run');
      const observed = fixture.uploads().slice(before);
      assert.equal(observed.length, 1, 'even an idempotent PUT cannot replay a streaming source');
      assert.equal(observed[0].method, 'PUT');

      if (mode === 'during') {
        assert.ok(observed[0].bytes > 0 && observed[0].bytes < 30);
        assert.equal(observed[0].ended, false);
        assert.ok(
          jsonNumber(jsonObject(failed).generated) < 10,
          'producer must stop before exhausting its finite source',
        );
      } else {
        assert.equal(observed[0].bytes, 30);
        assert.equal(observed[0].ended, true);
        assert.equal(jsonObject(failed).generated, 10);
      }
      assert.deepEqual(await invoke(), {
        outcome: 'success',
        stopped: true,
        generated: 10,
        atResponse: 10,
      });
      const recovered = fixture.uploads().slice(before);
      assert.equal(recovered.length, 2);
      assert.equal(recovered[1].bytes, 30);
      assert.equal(recovered[1].ended, true);
    });
  }
}
