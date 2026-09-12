/** Inject native R2 contract outcomes into the actual application boundary. */
export async function r2ExampleExtraFixture(
  request: Request,
  env: Env,
  forward: (request: Request, bindings: Record<string, unknown>) => Promise<Response>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = /^\/__fixture\/r2-extra\/(archive-error|archive-precondition|attachment-error|attachment-precondition|attachment-conflict|multipart-abort|list-missing|list-repeat|list-bound|store-rejected|reader-missing|checksum-rejected|infrequent-rejected|conditional-ignored|browse-ignored|body-missing|range-ignored|write-reversed)$/.exec(url.pathname);
  if (!match) {
    return undefined;
  }
  const mode = match[1];
  const calls: string[] = [];
  const seed = "wave6-r2-extra-meta";
  await env.EXAMPLE_BUCKET.put(seed, "metadata fixture");
  const metadata = await env.EXAMPLE_BUCKET.head(seed);
  if (!metadata) {
    throw new Error("R2 fixture metadata missing");
  }
  let pages = 0;
  let writes = 0;
  const bucket = new Proxy(env.EXAMPLE_BUCKET, {
    get(target, property) {
      if (property === "get" && (mode.endsWith("error") || mode.endsWith("precondition"))) {
        return async () => {
          calls.push("get");
          if (mode.endsWith("error")) {
            throw new Error("private-native-r2-marker");
          }
          return metadata;
        };
      }
      if (property === "put" && mode === "write-reversed") {
        return async (key: string, value: Parameters<R2Bucket["put"]>[1]) => {
          writes++;
          calls.push("put");
          if (writes === 2) {
            return null;
          }
          return target.put(key, value);
        };
      }
      if (property === "get" && ["conditional-ignored", "browse-ignored", "body-missing", "range-ignored"].includes(mode)) {
        return async (key: string) => {
          calls.push("get");
          if (mode === "body-missing") {
            return null;
          }
          if (key === "never-created.bin") {
            return metadata;
          }
          return target.get(key);
        };
      }
      if (property === "get" && mode === "reader-missing") {
        return async () => { calls.push("get"); return null; };
      }
      if (property === "put" && ["attachment-conflict", "store-rejected", "checksum-rejected", "infrequent-rejected"].includes(mode)) {
        return async () => { calls.push("put"); return null; };
      }
      if (property === "createMultipartUpload" && mode === "multipart-abort") {
        return async () => ({
          key: "archives/encrypted/wave6.bin",
          uploadId: "wave6-upload",
          async uploadPart() { calls.push("uploadPart"); throw new Error("private-native-r2-marker"); },
          async abort() { calls.push("abort"); },
        });
      }
      if (property === "list" && mode.startsWith("list-")) {
        return async () => {
          pages++;
          calls.push("list");
          return {
            objects: [],
            truncated: true,
            delimitedPrefixes: [],
            ...(mode === "list-missing" ? {} : { cursor: mode === "list-repeat" ? "same" : `page-${pages}` }),
          };
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pathname = mode === "write-reversed" ? "/r2/write-options"
    : mode === "range-ignored" ? "/r2/range"
    : mode === "browse-ignored" ? "/r2/browse-options"
    : ["store-rejected", "conditional-ignored", "body-missing"].includes(mode) ? "/r2/conditional"
    : mode === "reader-missing" ? "/r2/readers"
    : mode === "checksum-rejected" ? "/r2/checksums"
    : mode.startsWith("list-") ? "/r2/listing"
    : mode.startsWith("attachment-") ? "/attachments/wave6.bin"
    : mode === "multipart-abort" ? "/archives/encrypted/wave6.bin"
    : "/archives/infrequent/wave6.bin";
  const method = mode.startsWith("list-") || ["multipart-abort", "store-rejected", "reader-missing", "checksum-rejected", "infrequent-rejected", "conditional-ignored", "browse-ignored", "body-missing", "range-ignored", "write-reversed"].includes(mode) ? "POST"
    : mode === "attachment-conflict" ? "PUT" : "GET";
  try {
    const response = await forward(new Request(new URL(pathname, url), {
      method,
      ...(method === "PUT" ? { body: new Uint8Array([65]) } : {}),
    }), {
      ...env,
      EXAMPLE_BUCKET: bucket,
      ATTACHMENT_SSEC_KEY: "0123456789abcdef0123456789abcdef",
    });
    return Response.json({ status: response.status, body: await response.text(), calls });
  } finally {
    await env.EXAMPLE_BUCKET.delete([seed, "listing/a", "listing/b", "listing/c", "unrelated/a", "conditional.bin", "ranges.bin"]);
  }
}

/** Test-only failure scenarios receive controlled native results, not production routes. */
export async function r2FailureExtraFixture(
  request: Request,
  env: Env,
  run: (bucket: R2Bucket, mode: string) => Promise<string>,
): Promise<Response | undefined> {
  const mode = new URL(request.url).pathname.split("/__fixture/r2-failure-extra/")[1];
  if (!mode || !["unknown", "reader-missing", "stream-supported"].includes(mode)) {
    return undefined;
  }
  const bucket = new Proxy(env.EXAMPLE_BUCKET, {
    get(target, property) {
      if (property === "get" && mode === "reader-missing") {
        return async () => null;
      }
      if (property === "put" && mode === "stream-supported") {
        return (key: string) => target.put(key, "payload");
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const result = await run(bucket, mode === "reader-missing" ? "reader-rejections"
      : mode === "stream-supported" ? "unknown-length-stream" : "unknown-wave6");
    return Response.json({ result: JSON.parse(result) });
  } catch (error) {
    return Response.json({ rejected: true, message: String(error) });
  }
}
