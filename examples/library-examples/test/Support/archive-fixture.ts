/** Local-only configuration injection and independent native R2 observations. */
export async function archiveFixture(
  request: Request,
  env: Env,
  forward: (request: Request, bindings: Record<string, unknown>) => Promise<Response>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = /^\/__fixture\/archives\/(valid-key|wrong-key|missing-key|inspect|cleanup)\/(encrypted|infrequent)\/([a-zA-Z0-9_.-]+)$/.exec(url.pathname);
  if (!match) {
    return undefined;
  }
  const variant = match[1];
  const policy = match[2];
  const identifier = match[3];
  const objectKey = `archives/${policy}/${identifier}`;
  if (variant === "cleanup") {
    if (request.method !== "DELETE") {
      return new Response("Method not allowed", { status: 405 });
    }
    await env.EXAMPLE_BUCKET.delete(objectKey);
    return Response.json({ deleted: (await env.EXAMPLE_BUCKET.head(objectKey)) === null });
  }
  if (variant === "inspect") {
    const meta = await env.EXAMPLE_BUCKET.head(objectKey);
    const wrongKey = new TextEncoder().encode("fedcba9876543210fedcba9876543210").buffer;
    const readable = async (key?: ArrayBuffer) => {
      try {
        const result = await env.EXAMPLE_BUCKET.get(objectKey, key ? { ssecKey: key } : undefined);
        if (!result) {
          return false;
        }
        await result.arrayBuffer();
        return true;
      } catch {
        return false;
      }
    };
    return Response.json({
      storageClass: meta?.storageClass ?? null,
      keyMetadataPresent: typeof meta?.ssecKeyMd5 === "string",
      wrongKeyReadable: await readable(wrongKey),
      noKeyReadable: await readable(),
    });
  }
  const bindings: Record<string, unknown> = { ...env };
  if (variant === "missing-key") {
    delete bindings.ATTACHMENT_SSEC_KEY;
  } else {
    bindings.ATTACHMENT_SSEC_KEY = variant === "valid-key"
      ? "0123456789abcdef0123456789abcdef"
      : "fedcba9876543210fedcba9876543210";
  }
  url.pathname = `/archives/${policy}/${identifier}`;
  return forward(new Request(url, request), bindings);
}
