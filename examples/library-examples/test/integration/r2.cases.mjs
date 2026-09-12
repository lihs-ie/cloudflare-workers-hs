import { test } from "node:test";
import assert from "node:assert/strict";

export function registerR2Tests({ request }) {
  test("R2 conditional reads distinguish body, unchanged, mismatch and missing", async () => {
    assert.deepEqual(await request("/r2/conditional", "POST"), {
      matched: [0, 128, 255, 65], changed: [0, 128, 255, 65], wrongMatchHasNoBody: true,
      unchangedHasNoBody: true, headerConditionHasNoBody: true, missing: true,
      contentType: "application/octet-stream", customMetadata: "library-example",
    });
  });
  test("R2 prefix listing follows cursors with metadata and batch deletion", async () => {
    const result = await request("/r2/listing", "POST");
    assert.deepEqual(result, { pages: 3, objects: ["listing/a", "listing/b", "listing/c"].map(key => ({
      key, contentType: "application/octet-stream", purpose: "library-example",
    })), deleted: true });
  });
  test("R2 range reads cover offset+length, offset, length and suffix", async () => {
    assert.deepEqual(await request("/r2/range", "POST"), {
      middle: [4,5,6,7,8], offset: [12,13,14,15], prefix: [0,1,2], suffix: [13,14,15], invalidRangeRejected: true,
    });
  });
  test("R2 multipart resumes native upload and completes two parts with binary tail", async () => {
    assert.deepEqual(await request("/r2/multipart", "POST"), {
      size: 5 * 1024 * 1024 + 3, tail: [65,65,65,65,0,128,255], resumedSameUpload: true,
      partNumbers: [1,2], metadata: "multipart-example", latePartRejected: true, repeatCompleteRejected: true,
    });
  });
  test("R2 abort leaves no object and cannot be resurrected by resume", async () => {
    assert.deepEqual(await request("/r2/abort", "POST"), {
      objectAbsent: true, repeatAbortRejected: true, resumeAbortedRejected: true,
    });
  });
  test("R2 failed completion retains handle for retry with correct part ETag", async () => {
    assert.deepEqual(await request("/r2/retry-complete", "POST"), {
      failedCompleteRejected: true, size: 10, bytes: Array.from(new TextEncoder().encode("retry-safe")),
    });
  });
  test("R2 native body readers consume once and blob/stream/null writes roundtrip", async () => {
    assert.deepEqual(await request("/r2/readers", "POST"), {
      text: '{"enabled":true}', json: '{"enabled":true}', arrayEqualsBlob: true,
      unusedBefore: true, usedAfter: true, stream: '{"enabled":true}', empty: true,
    });
  });
  test("R2 conditional updates preserve the last accepted bytes", async () => {
    assert.deepEqual(await request("/r2/write-options", "POST"), {
      accepted: true, staleRejected: true, unchanged: true,
    });
  });
  test("R2 failed multipart transfer aborts the native upload and rejects resumed writes", async () => {
    assert.deepEqual(await request("/__fixture/r2/multipart-cleanup", "POST"), {
      transferFailed: true, resumeRejected: true, objectAbsent: true,
    });
  });
  test("R2 validates all five checksum algorithms against known digest vectors", async () => {
    assert.deepEqual(await request("/r2/checksums", "POST"), {
      verified: ["md5", "sha1", "sha256", "sha384", "sha512"].map(algorithm => ({ algorithm, recorded: true })),
    });
  });
  test("R2 delimiter/startAfter, complete HTTP metadata, and UTC conditions roundtrip", async () => {
    assert.deepEqual(await request("/r2/browse-options", "POST"), {
      objects: ["browse/a", "browse/b"], folders: ["browse/folder/"],
      after: ["browse/b", "browse/folder/c"], metadataPreserved: true,
      beforeFuture: true, afterPast: true, beforePastRejected: true, afterFutureRejected: true,
    });
  });
  test("R2 native malformed JSON and consumed-body readers reject", async () => {
    assert.deepEqual(await request("/__fixture/r2/reader-rejections", "POST"), {
      consumedRejected: true, malformedJSONRejected: true,
    });
  });
  test("R2 invalid checksum and oversized deletion batches reject before mutation", async () => {
    assert.deepEqual(await request("/__fixture/r2/write-rejections", "POST"), {
      checksumRejected: true, checksumObjectAbsent: true, batchCount: 1001,
      batchInvalid: true, invalidBatchRejected: true,
    });
  });
  test("R2 rejects unknown-length producer streams without creating an object", async () => {
    assert.deepEqual(await request("/__fixture/r2/unknown-length-stream", "POST"), {
      unknownLengthRejected: true, objectAbsent: true,
    });
  });
}
