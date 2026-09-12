import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { startRuntime } from "../Support/dev-runtime.mjs";
let runtime;
before(
  async () => {
    runtime = await startRuntime();
  },
  { timeout: 125000 },
);
after(async () => {
  await runtime?.close();
});
async function scenario(name) {
  const response = await fetch(
    `${runtime.base}/${["validation", "cache-validation", "cache-method"].includes(name) ? "__fixture/storage" : "storage"}/${name}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
test("KV bulk metadata preserves missing keys, paginates and deletes", async () => {
  const result = await scenario("metadata");
  assert.deepEqual(
    result.batch.map((item) => ({
      ...item,
      metadata: item.metadata === null ? null : JSON.parse(item.metadata),
    })),
    [
      { key: "metadata:a", value: "guide", metadata: { version: 2 } },
      { key: "metadata:missing", value: null, metadata: null },
    ],
  );
  assert.deepEqual(result.first, ["metadata:a"]);
  assert.deepEqual(result.second, ["metadata:b"]);
  assert.equal(result.firstComplete, false);
  assert.equal(result.deleted, true);
});
test("KV reads JSON and binary and writes/reads a native stream", async () => {
  const result = await scenario("formats");
  assert.deepEqual(JSON.parse(result.json), { enabled: true });
  assert.deepEqual(result.binary, [0, 128, 255]);
  assert.equal(
    new TextDecoder().decode(new Uint8Array(result.stream)),
    "stream value",
  );
});
test("named Cache expires by elapsed time without explicit invalidation", async () => {
  assert.deepEqual(await scenario("cache-write"), { hit: true });
  await delay(2500);
  assert.deepEqual(await scenario("cache-read"), { hit: false });
});
test(
  "KV TTL really expires after the supported minimum 60 seconds",
  { timeout: 85000 },
  async () => {
    const started = Math.floor(Date.now() / 1000);
    const { expirations } = await scenario("ttl-write");
    assert.equal(expirations.length, 1);
    assert.ok(
      expirations[0] >= started + 59 &&
        expirations[0] <= Math.floor(Date.now() / 1000) + 61,
    );
    assert.deepEqual(await scenario("ttl-read"), { value: "temporary" });
    await delay(Math.max(0, expirations[0] * 1000 - Date.now()) + 1500);
    assert.deepEqual(await scenario("ttl-read"), { value: null });
  },
);

test("native KV malformed JSON is KVGetFailed and the same key recovers", async () => {
  const response = await fetch(`${runtime.base}/__fixture/kv-json-recovery`, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.classification, "KVGetFailed");
  assert.deepEqual(JSON.parse(result.json), { recovered: true });
});

test("KV native TTL and malformed JSON failures preserve subsequent reads; local option guards reject boundaries", async () => {
  assert.deepEqual(await scenario("validation"), {
    farFutureRejected: true,
    farFutureAbsent: true,
    ttlRejected: true,
    ttlAbsent: true,
    jsonRejected: true,
    cacheTtlRejected: true,
    batchRejected: true,
    acceptedBatchCount: 100,
    duplicateValues: ["not JSON", "not JSON", null],
    zeroLimitKeys: ["validation:json"],
    malformedCursorKeys: [],
    malformedCursorAccepted: true,
    negativeLimitAccepted: true,
    recovered: "not JSON",
  });
});
test("KV single and bulk JSON metadata retain absent entries", async () => {
  const started = Math.floor(Date.now() / 1000);
  const result = await scenario("json-metadata");
  assert.equal(result.expiration.length, 1);
  assert.ok(result.expiration[0] >= started + 120);
  assert.ok(result.expiration[0] <= Math.floor(Date.now() / 1000) + 120);
  assert.deepEqual(result.listedMetadata.map(JSON.parse), [{ revision: 1 }]);
  assert.deepEqual(JSON.parse(result.value), { enabled: true });
  assert.deepEqual(JSON.parse(result.metadata), { revision: 1 });
  assert.equal(result.missing, true);
  assert.deepEqual(
    result.bulk.map(({ key, value }) => ({
      key,
      value: value === null ? null : JSON.parse(value),
    })),
    [
      { key: "jsonmeta:value", value: { enabled: true } },
      { key: "jsonmeta:missing", value: null },
    ],
  );
  assert.deepEqual(
    result.metadataBulk.map(({ key, value, metadata }) => ({
      key,
      value: value === null ? null : JSON.parse(value),
      metadata: metadata === null ? null : JSON.parse(metadata),
    })),
    [
      {
        key: "jsonmeta:value",
        value: { enabled: true },
        metadata: { revision: 1 },
      },
      { key: "jsonmeta:missing", value: null, metadata: null },
    ],
  );
});
test("native Cache rejects partial and wildcard responses then recovers and deletes exactly once", async () => {
  assert.deepEqual(await scenario("cache-validation"), {
    partialClassification: "CachePutPartialResponse",
    varyClassification: "CachePutVaryWildcard",
    partialRejected: true,
    varyRejected: true,
    absent: true,
    recovered: true,
    deleted: true,
    deletedAgain: false,
  });
});

test("native CacheRequest enforces GET and ignoreMethod controls matching and deletion", async () => {
  assert.deepEqual(await scenario("cache-method"), {
    putRejected: true,
    classification: "CachePutInvalidMethod",
    message: "TypeError: Cannot cache response to non-GET request.",
    strictMiss: true,
    ignoredHit: true,
    strictDelete: false,
    ignoredDelete: true,
    absent: true,
  });
});

test("private and no-store guides render policy and tags without entering the native cache", async () => {
  assert.deepEqual(await scenario("cache-policy"), {
    policies: [
      { policy: "private, max-age=60", hit: false },
      { policy: "no-store", hit: false },
    ],
    tag: ["Cache-Tag", "guide,settings"],
    emptyTag: null,
  });
});

test("regional KV scenarios preserve updates and expose an absolute expiration", { timeout: 80000 }, async () => {
  try {
    await scenario("propagation-write");
    assert.equal((await scenario("propagation-read")).value, "initial");
    await scenario("propagation-update");
    const deadline = Date.now() + 65000;
    let value;
    do {
      value = (await scenario("propagation-read")).value;
      if (value === "updated") {
        break;
      }
      assert.equal(value, "initial");
      await delay(1000);
    } while (Date.now() < deadline);
    assert.equal(value, "updated");
    const before = Math.floor(Date.now() / 1000);
    const { expiration } = await scenario("absolute-write");
    assert.ok(expiration >= before + 120 && expiration <= Math.floor(Date.now() / 1000) + 120);
    assert.equal((await scenario("absolute-read")).value, "temporary");
  } finally {
    await scenario("regional-cleanup");
  }
});

test("regional Cache scenarios retain and delete the local entry", async () => {
  try {
    assert.equal((await scenario("regional-cache-write")).hit, true);
    assert.equal((await scenario("regional-cache-read")).hit, true);
    assert.equal((await scenario("regional-cache-delete")).deleted, true);
    assert.equal((await scenario("regional-cache-read")).hit, false);
  } finally {
    await scenario("regional-cache-delete");
  }
});
