/** Apply controlled corruption to the real local D1 database, never a mock row. */
export async function changeJobSettings(
  database: D1Database,
  scenario: string,
): Promise<Response> {
  let statement: string;
  switch (scenario) {
    case "description-present":
      statement = "UPDATE processing_settings SET description='native description 日本語' WHERE identifier='default'";
      break;
    case "enabled-invalid":
      statement =
        "UPDATE processing_settings SET enabled=2 WHERE identifier='default'";
      break;
    case "limit-zero":
      statement = "UPDATE processing_settings SET batch_limit=0 WHERE identifier='default'";
      break;
    case "score-negative":
      statement = "UPDATE processing_settings SET score=-0.25 WHERE identifier='default'";
      break;
    case "missing":
      statement = "UPDATE processing_settings SET identifier='fixture-hidden-default' WHERE identifier='default'";
      break;
    case "disabled":
      statement =
        "UPDATE processing_settings SET enabled=0 WHERE identifier='default'";
      break;
    case "limit-invalid":
      statement =
        "UPDATE processing_settings SET batch_limit=101 WHERE identifier='default'";
      break;
    case "score-invalid":
      statement =
        "UPDATE processing_settings SET score=1.25 WHERE identifier='default'";
      break;
    case "blob-invalid":
      statement =
        "UPDATE processing_settings SET attachment='not a blob' WHERE identifier='default'";
      break;
    case "restore":
      statement =
        "UPDATE processing_settings SET identifier='default',enabled=1,batch_limit=25,score=0.75,description=NULL,attachment=X'007FFF' WHERE identifier IN ('default','fixture-hidden-default')";
      break;
    default:
      return new Response("Unknown settings fixture", { status: 400 });
  }
  await database.prepare(statement).run();
  return new Response(null, { status: 204 });
}

/** Count producer calls in this request while forwarding unchanged to native Queue. */
export async function observeJobSubmission(
  request: Request,
  env: Env,
  context: ExecutionContext,
  fetchHandler: (
    request: Request,
    env: Env,
    context: ExecutionContext,
  ) => Promise<Response>,
): Promise<Response> {
  let producerCalls = 0;
  const producer: Queue = {
    metrics: () => env.JOBS_QUEUE.metrics(),
    send: (message, options) => {
      producerCalls += 1;
      return env.JOBS_QUEUE.send(message, options);
    },
    sendBatch: (messages, options) => {
      producerCalls += 1;
      return env.JOBS_QUEUE.sendBatch(messages, options);
    },
  };
  const validator = new URL(request.url).searchParams.get("fixture") === "validator-failure"
    ? new Proxy(env.JOBS_VALIDATOR, {
        get(target, key) {
          if (key === "validate") {
            return async () => { throw new Error("private-validator-marker"); };
          }
          return Reflect.get(target, key);
        },
      })
    : env.JOBS_VALIDATOR;
  const response = await fetchHandler(
    request,
    { ...env, JOBS_QUEUE: producer, JOBS_VALIDATOR: validator },
    context,
  );
  const headers = new Headers(response.headers);
  headers.set("X-Fixture-Queue-Producer-Calls", String(producerCalls));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
