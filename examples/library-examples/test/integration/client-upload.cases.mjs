import { test } from "node:test";
import assert from "node:assert/strict";

export function registerClientUploadTests(getRuntime) {
  test("HTTP early response is retained while native transport finishes a finite upload", async () => {
    const runtime = getRuntime();
    const before = runtime.clientHttpFixture.uploads().length;
    runtime.clientHttpFixture.failNextUpload("early-success");
    const response = await fetch(runtime.base + "/__fixture/client-upload", {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.outcome, "success");
    assert.equal(
      result.stopped,
      true,
      "source traversal must finish after the early response",
    );
    assert.equal(
      result.atResponse,
      10,
      "local transport has consumed this finite source when Haskell receives the response",
    );
    assert.equal(result.generated, 10);
    const observed = runtime.clientHttpFixture.uploads().slice(before);
    assert.equal(observed.length, 1);
    assert.ok(
      observed[0].responseAtBytes > 0 && observed[0].responseAtBytes < 30,
      "the peer must respond before it receives the complete upload",
    );
    assert.equal(observed[0].bytes, 30);
    assert.equal(observed[0].ended, true);
  });
  test("HTTP streaming upload preserves an error response without replay and recovers", async () => {
    const runtime = getRuntime();
    const fixture = runtime.clientHttpFixture;
    const before = fixture.uploads().length;
    fixture.failNextUpload("http-error");
    for (const outcome of ["unexpected-client-error", "success"]) {
      const response = await fetch(runtime.base + "/__fixture/client-upload", {
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), {
        outcome, stopped: true, generated: 10, atResponse: 10,
      });
    }
    const observed = fixture.uploads().slice(before);
    assert.equal(observed.length, 2, "the failed streaming PUT must not be retried");
    assert.ok(observed.every(upload => upload.ended && upload.bytes === 30));
  });
  for (const mode of ["after", "during"]) {
    test(`HTTP streaming PUT stops its producer without replay on connection loss ${mode} upload`, async () => {
      const fixture = getRuntime().clientHttpFixture;
      const before = fixture.uploads().length;
      fixture.failNextUpload(mode);
      const invoke = async () => {
        const response = await fetch(
          `${getRuntime().base}/__fixture/client-upload`,
          {
            signal: AbortSignal.timeout(10000),
          },
        );
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      const failed = await invoke();
      assert.equal(failed.outcome, "FetchNetworkFailure");
      assert.equal(
        failed.stopped,
        true,
        "source traversal finally must have run",
      );
      const observed = fixture.uploads().slice(before);
      assert.equal(
        observed.length,
        1,
        "even an idempotent PUT cannot replay a streaming source",
      );
      assert.equal(observed[0].method, "PUT");
      if (mode === "during") {
        assert.ok(observed[0].bytes > 0 && observed[0].bytes < 30);
        assert.equal(observed[0].ended, false);
        assert.ok(
          failed.generated < 10,
          "producer must stop before exhausting its finite source",
        );
      } else {
        assert.equal(observed[0].bytes, 30);
        assert.equal(observed[0].ended, true);
        assert.equal(failed.generated, 10);
      }
      assert.deepEqual(await invoke(), {
        outcome: "success",
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
