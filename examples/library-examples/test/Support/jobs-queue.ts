import { consumeJobs } from "../../worker/jobs-consumer.js";

async function prepare(database: D1Database): Promise<void> {
  await database.exec(
    "CREATE TABLE IF NOT EXISTS queue_fixture_delivery (sequence INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL, identifier TEXT NOT NULL, attempts INTEGER NOT NULL, batch TEXT NOT NULL)",
  );
}

function identifierOf(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    "identifier" in body &&
    typeof body.identifier === "string"
  ) {
    return body.identifier;
  }
  return undefined;
}

/** Observe actual native deliveries without replacing ack, retry, or the consumer. */
export async function consumeObservedJobs(
  batch: MessageBatch<unknown>,
  env: Env,
  context: ExecutionContext,
): Promise<void> {
  await prepare(env.JOBS_DB);
  const identifiers = batch.messages.map(
    (message) => identifierOf(message.body) ?? "unidentified",
  );
  for (const message of batch.messages) {
    const identifier = identifierOf(message.body);
    if (identifier?.startsWith("queue-contract-")) {
      await env.JOBS_DB.prepare(
        "INSERT INTO queue_fixture_delivery (queue, identifier, attempts, batch) VALUES (?, ?, ?, ?)",
      )
        .bind(
          batch.queue,
          identifier,
          message.attempts,
          JSON.stringify(identifiers),
        )
        .run();
    }
  }
  if (batch.queue === "library-jobs-dlq") {
    // Persist evidence before acknowledging actual DLQ delivery.
    batch.ackAll();
    return;
  }
  await consumeJobs(batch, env, context);
}

/** Test-only ingress bypasses validation so a poison body reaches native Queue. */
export async function jobsQueueFixture(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const run = url.searchParams.get("run");
  if (!run || !/^[a-zA-Z0-9-]{1,50}$/.test(run)) {
    return new Response("Invalid run", { status: 400 });
  }
  const prefix = `queue-contract-${run}`;
  if (
    request.method === "POST" &&
    url.pathname === "/__fixture/jobs/queue/mixed"
  ) {
    await env.JOBS_QUEUE.sendBatch([
      {
        body: { identifier: `${prefix}-good-a`, payload: "first valid job" },
        contentType: "json",
      },
      {
        body: { identifier: `${prefix}-poison`, payload: 123 },
        contentType: "json",
      },
      {
        body: { identifier: `${prefix}-good-b`, payload: "second valid job" },
        contentType: "json",
      },
    ]);
    return Response.json({ prefix }, { status: 202 });
  }
  if (
    request.method === "GET" &&
    url.pathname === "/__fixture/jobs/queue/deliveries"
  ) {
    await prepare(env.JOBS_DB);
    const rows = await env.JOBS_DB.prepare(
      "SELECT queue, identifier, attempts, batch FROM queue_fixture_delivery WHERE identifier IN (?, ?, ?) ORDER BY sequence",
    )
      .bind(`${prefix}-good-a`, `${prefix}-poison`, `${prefix}-good-b`)
      .all();
    return Response.json(rows.results);
  }
  return new Response("Not found", { status: 404 });
}
