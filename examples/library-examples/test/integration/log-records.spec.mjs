import { test } from "node:test";
import assert from "node:assert/strict";
import {
  logRecordsFor,
  waitForRequestCompletion,
} from "../Support/log-records.mjs";

test("completion waiting ignores a previous request and a truncated current record", async () => {
  const previous = JSON.stringify({
    request_id: "previous",
    message: "request completed",
    duration_ms: 9,
    status: 200,
  });
  const started = JSON.stringify({
    request_id: "current",
    message: "request started",
  });
  const completed =
    "{\n duration_ms: 1,\n message: 'request completed',\n request_id: 'current',\n status: 500\n}";
  const chunks = [
    previous + started,
    previous + started + completed.slice(0, -1),
    previous + started + completed,
  ];
  let reads = 0;
  const result = await waitForRequestCompletion(
    async () => chunks[Math.min(reads++, chunks.length - 1)],
    "current",
  );
  assert.equal(reads, 3);
  assert.equal(result.completion.status, 500);
  assert.equal(result.completion.duration_ms, 1);
});

test("missing correlated completion fails instead of accepting unrelated timing", async () => {
  await assert.rejects(
    waitForRequestCompletion(
      async () =>
        '{"request_id":"other","message":"request completed","duration_ms":2,"status":200}',
      "current",
      0,
    ),
    /No completion record/,
  );
});

test("log parsing rejects executable text and duplicate or nested fields", () => {
  for (const text of [
    "{request_id: 'current', status: process.exit()}",
    "{\nrequest_id: 'current',\nrequest_id: 'current'\n}",
    "{request_id: 'current', nested: {status: 500}}",
  ]) {
    assert.deepEqual(logRecordsFor(text, "current"), []);
  }
});

test("completion requires a message, numeric duration and numeric status for this request", async () => {
  const cases = [
    { message: "request started", duration_ms: 2, status: 200 },
    { message: "request completed", duration_ms: "2", status: 200 },
    { message: "request completed", duration_ms: 2, status: "200" },
  ];
  for (const record of cases) {
    await assert.rejects(
      waitForRequestCompletion(
        async () => JSON.stringify({ request_id: "current", ...record }),
        "current",
        0,
      ),
      /No completion record/,
    );
  }
});
