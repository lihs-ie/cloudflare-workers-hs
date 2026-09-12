/** Fault injection stays scoped to one Worker invocation; global fetch is intact. */
export async function exerciseClientPolicy(
  worker: {
    fetch: (
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ) => Promise<Response>;
  },
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const transportAttempts: {
    path: string;
    method: string;
    key: string | null;
    body: string;
  }[] = [];
  const counts = new Map<string, number>();
  const httpFailure = new URL(request.url).searchParams.get("fixture") === "http-error";
  const fetchWithFaults = async (input: Request): Promise<Response> => {
    const path = new URL(input.url).pathname;
    const attempt = (counts.get(path) ?? 0) + 1;
    counts.set(path, attempt);
    transportAttempts.push({
      path,
      method: input.method,
      key: input.headers.get("Idempotency-Key"),
      body: await input.clone().text(),
    });
    if (httpFailure) {
      return new Response("destination unavailable", {
        status: 503, headers: { "Content-Type": "text/plain" },
      });
    }
    if (
      (path === "/client-target/retry" && attempt <= 2) ||
      path === "/client-target/no-retry" ||
      path === "/client-target/exhausted"
    ) {
      throw new Error(
        "injected network interruption before destination dispatch",
      );
    }
    const response = await env.GUIDE.fetch(input);
    if (path === "/client-target/malformed") {
      // Ensure this remains an actual successful Service Binding round-trip.
      if (response.status !== 200) {
        throw new Error(`destination returned ${response.status}`);
      }
      await response.arrayBuffer();
      return new Response("{invalid-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return response;
  };
  const binding = new Proxy(env.GUIDE, {
    get(target, key) {
      if (key === "fetch") {
        return fetchWithFaults;
      }
      return Reflect.get(target, key);
    },
  });
  const response = await worker.fetch(request, { ...env, GUIDE: binding }, ctx);
  if (response.status !== 200) {
    return response;
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TypeError("Expected client policy response object");
  }
  return Response.json({ ...body, transportAttempts });
}
