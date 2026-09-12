import { r2ExampleExtraFixture, r2FailureExtraFixture } from "./r2-example-extra.js";
import { miscExampleFixture } from "./misc-example-fixture.js";
import { inspectJobsFailure } from "./jobs-failures.js";
import { archiveFixture } from "./archive-fixture";
export { JobsState } from "./jobs-state.js";
import { consumeObservedJobs, jobsQueueFixture } from "./jobs-queue.js";
import {
  createReactor,
  bindExport,
  decodeResponse,
  decodeString,
} from "@cloudflare-workers-hs/runtime";
import makeImports from "../../worker/library-examples-jsffi.mjs";
import wasmModule from "../../worker/library-examples.wasm";
// Invalid binding fixtures intentionally enter the real WASM decoder with unknown values.
const fixture = await createReactor(wasmModule, makeImports, (table) => ({
  coverage: typeof table.coverage === "function"
    ? bindExport<[], string>(table, "coverage", decodeString)
    : undefined,
  fetch: bindExport<
    [Request, Record<string, unknown>, ExecutionContext],
    Response
  >(table, "fetch", decodeResponse),
}));
import { inspectQueueContract } from "./queue-contracts.js";
import { exerciseCachePurge } from "./cache-purge";
import { inspectClientStream } from "./client-stream";
import { exerciseClientPolicy } from "./client-policy";
import { changeJobSettings, observeJobSubmission } from "./jobs-settings.js";
import { connect } from "cloudflare:sockets";
import worker from "../../worker/entry";
import { reactor as application } from "../../worker/runtime";
import { reactor } from "./runtime";
export default {
  queue: consumeObservedJobs,
  async fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
    const env = {
      ...bindings,
      EXAMPLE_SECRET: "configuration-secret-fixture-never-log",
    };
    const url = new URL(request.url);
    if (url.pathname === "/__fixture/tail-no-script") {
      await application.tail([{
        event: null, eventTimestamp: 123456, logs: [], exceptions: [], diagnosticsChannelEvents: [],
        scriptName: null, outcome: "fixture-no-script", executionModel: "stateless", truncated: false,
        cpuTime: 0, wallTime: 0,
      }], env, ctx);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__fixture/client-option-diagnostics") {
      return Response.json(JSON.parse(await reactor.clientOptionDiagnostics()));
    }
    if (url.pathname === "/__fixture/misc-storage-unknown") {
      return Response.json(JSON.parse(await reactor.miscStorageUnknown()));
    }
    if (url.pathname === "/__fixture/process-job") {
      try {
        await application.processJob(env, await request.text());
        return Response.json({ processed: true });
      } catch {
        return Response.json({ processed: false }, { status: 400 });
      }
    }
    if (url.pathname === "/__fixture/misc-logging") {
      return Response.json(JSON.parse(await reactor.loggingUnknownRecovery()));
    }
    if (url.pathname === "/__fixture/attachment-missing-reader") {
      return reactor.attachmentMissingReader(bindings.EXAMPLE_BUCKET);
    }
    const r2FailureExtra = await r2FailureExtraFixture(request, env, (bucket, mode) => reactor.r2Failure(bucket, mode));
    if (r2FailureExtra) {
      return r2FailureExtra;
    }
    const r2Extra = await r2ExampleExtraFixture(request, env, (target, overrides) =>
      fixture.fetch(target, { ...overrides, SOCKET_CONNECT: connect }, ctx));
    if (r2Extra) {
      return r2Extra;
    }
    const miscExtra = await miscExampleFixture(request, env, (target, overrides) =>
      fixture.fetch(target, { ...overrides, SOCKET_CONNECT: overrides.SOCKET_CONNECT ?? connect }, ctx),
      (connector, scenario) => reactor.miscSocketFailure(connector, scenario),
      (namespace, mode) => reactor.storageValidation(namespace, mode));
    if (miscExtra) {
      return miscExtra;
    }
    if (url.pathname.startsWith("/__fixture/jobs/failure/")) {
      return inspectJobsFailure(url.pathname.slice("/__fixture/jobs/failure/".length));
    }
    if (url.pathname === "/__fixture/client-default-options") {
      const origin: unknown = Reflect.get(bindings, "CLIENT_ORIGIN");
      if (typeof origin !== "string") {
        return new Response("Missing HTTP fixture origin", { status: 500 });
      }
      return Response.json(JSON.parse(await reactor.clientDefaultOptions(origin)));
    }
    if (url.pathname.startsWith("/__fixture/queue-example-metrics/")) {
      const mode = url.pathname.slice("/__fixture/queue-example-metrics/".length);
      const producer = mode === "unsupported" ? {} : {
        async metrics() {
          if (mode === "failed") {
            throw new Error("synthetic metrics failure");
          }
          return { backlogCount: 7, backlogBytes: 8192, oldestMessageTimestamp: new Date(1234) };
        },
      };
      const forwarded = new Request(new URL("/queue-examples/diagnostics/metrics", request.url));
      return fixture.fetch(forwarded, { ...env, JOBS_QUEUE: producer, SOCKET_CONNECT: connect }, ctx);
    }
    if (url.pathname === "/__fixture/coverage") {
      if (!application.coverage || !reactor.coverage || !fixture.coverage) {
        return new Response("Coverage build required", { status: 503 });
      }
      return Response.json([
        await application.coverage(),
        await reactor.coverage(),
        await fixture.coverage(),
      ]);
    }
    const archiveResponse = await archiveFixture(request, env, (target, configured) => fixture.fetch(target, { ...configured, SOCKET_CONNECT: connect }, ctx));
    if (archiveResponse) {
      return archiveResponse;
    }
    if (url.pathname === "/__fixture/r2/upload-part-key-contract") {
      return Response.json(JSON.parse(await reactor.uploadPartKeyContract()));
    }
    if (url.pathname.startsWith("/__fixture/queue-contract/")) {
      return inspectQueueContract(
        url.pathname.slice("/__fixture/queue-contract/".length),
        ctx,
      );
    }
    if (url.pathname.startsWith("/__fixture/socket/")) {
      const scenario = url.pathname.slice("/__fixture/socket/".length);
      const variable =
        scenario === "untrusted"
          ? "UNTRUSTED_TLS_ADDRESS"
          : scenario === "peer-disconnect"
            ? "INTERRUPTED_TCP_ADDRESS"
            : scenario === "close-race"
              ? "TCP_ADDRESS"
              : undefined;
      const address: unknown =
        variable === undefined ? undefined : Reflect.get(bindings, variable);
      if (typeof address !== "string") {
        return new Response("Unknown socket fixture", { status: 400 });
      }
      return Response.json(
        JSON.parse(await reactor.socketBoundary(connect, scenario, address)),
      );
    }
    if (url.pathname === "/__fixture/cache-purge") {
      return exerciseCachePurge(reactor.cachePurgeExample, request);
    }
    if (url.pathname.startsWith("/__fixture/storage/")) {
      return Response.json(
        JSON.parse(
          await reactor.storageValidation(
            bindings.SETTINGS,
            url.pathname.slice("/__fixture/storage/".length),
          ),
        ),
      );
    }
    if (url.pathname.startsWith("/__fixture/r2/")) {
      return Response.json(
        JSON.parse(
          await reactor.r2Failure(
            bindings.EXAMPLE_BUCKET,
            url.pathname.slice("/__fixture/r2/".length),
          ),
        ),
      );
    }
    if (url.pathname === "/__fixture/database-failure") {
      return Response.json(
        JSON.parse(await reactor.databaseFailureRecovery(bindings.JOBS_DB)),
      );
    }
    if (url.pathname.startsWith("/__fixture/jobs/queue/")) {
      return jobsQueueFixture(request, env);
    }
    if (
      url.pathname === "/__fixture/client-upload" ||
      url.pathname === "/__fixture/client-http-stream"
    ) {
      const origin: unknown = Reflect.get(bindings, "CLIENT_ORIGIN");
      if (typeof origin !== "string") {
        return new Response("Missing HTTP fixture origin", { status: 500 });
      }
      const result =
        url.pathname === "/__fixture/client-upload"
          ? await reactor.clientUploadLifecycle(origin)
          : await reactor.clientHTTPStreamLifecycle(origin);
      return Response.json(JSON.parse(result));
    }
    if (url.pathname === "/__fixture/client-stream") {
      return inspectClientStream(url.searchParams.get("mode"));
    }
    if (url.pathname === "/__fixture/kv-json-recovery") {
      return Response.json(
        JSON.parse(await reactor.kvMalformedJSONRecovery(bindings.SETTINGS)),
      );
    }
    if (
      request.method === "POST" &&
      url.pathname.startsWith("/__fixture/jobs/settings/")
    ) {
      return changeJobSettings(
        env.JOBS_DB,
        url.pathname.slice("/__fixture/jobs/settings/".length),
      );
    }
    if (request.method === "POST" && url.pathname === "/jobs") {
      return observeJobSubmission(
        request,
        env,
        ctx,
        (target, observed, context) => worker.fetch(target, observed, context),
      );
    }
    if (url.pathname === "/__fixture/attachments/capability") {
      const bucket = bindings.EXAMPLE_BUCKET;
      const key = "attachments/capability-probe";
      const first = new TextEncoder().encode(
        "0123456789abcdef0123456789abcdef",
      ).buffer;
      const second = new TextEncoder().encode(
        "fedcba9876543210fedcba9876543210",
      ).buffer;
      try {
        const stored = await bucket.put(key, "capability-probe", {
          ssecKey: first,
        });
        const readable = async (ssecKey?: ArrayBuffer) => {
          try {
            const object = await bucket.get(
              key,
              ssecKey ? { ssecKey } : undefined,
            );
            return object
              ? (await object.text()) === "capability-probe"
              : false;
          } catch {
            return false;
          }
        };
        return Response.json({
          keyMetadataPresent: typeof stored?.ssecKeyMd5 === "string",
          correctKeyReadable: await readable(first),
          wrongKeyReadable: await readable(second),
          noKeyReadable: await readable(),
        });
      } finally {
        await bucket.delete(key);
      }
    }
    const attachmentFixture =
      /^\/__fixture\/attachments\/(missing-key|invalid-key|valid-key|wrong-key)\/([^/]+)$/.exec(
        url.pathname,
      );
    if (attachmentFixture) {
      const fixtureBindings: Record<string, unknown> = {
        ...env,
        SOCKET_CONNECT: connect,
      };
      const variant = attachmentFixture[1];
      if (variant === "missing-key") {
        delete fixtureBindings.ATTACHMENT_SSEC_KEY;
      } else if (variant === "invalid-key") {
        fixtureBindings.ATTACHMENT_SSEC_KEY = "invalid";
      } else if (variant === "wrong-key") {
        fixtureBindings.ATTACHMENT_SSEC_KEY =
          "fedcba9876543210fedcba9876543210";
      } else {
        fixtureBindings.ATTACHMENT_SSEC_KEY =
          "0123456789abcdef0123456789abcdef";
      }
      const target = new URL(url);
      target.pathname = `/attachments/${attachmentFixture[2]}`;
      return fixture.fetch(new Request(target, request), fixtureBindings, ctx);
    }
    if (url.pathname === "/__fixture/configuration-invalid") {
      const invalid: Record<string, unknown> = { ...env };
      const binding = url.searchParams.get("binding");
      if (binding !== "EXAMPLE_SECRET" && binding !== "EXAMPLE_MODE") {
        return new Response("Invalid fixture binding", { status: 400 });
      }
      const values = new Map<string, unknown>([
        ["undefined", undefined],
        ["null", null],
        ["number", 123],
        ["boolean", false],
        ["object", {}],
      ]);
      const kind = url.searchParams.get("kind");
      if (kind === "missing") {
        delete invalid[binding];
      } else if (kind && values.has(kind)) {
        invalid[binding] = values.get(kind);
      } else {
        return new Response("Invalid fixture kind", { status: 400 });
      }
      return fixture.fetch(
        new Request(new URL("/configuration", url), request),
        invalid,
        ctx,
      );
    }
    if (url.pathname === "/__fixture/configuration-missing") {
      const missing: Record<string, unknown> = { ...env };
      delete missing.EXAMPLE_SECRET;
      return fixture.fetch(
        new Request(new URL("/configuration", url), request),
        missing,
        ctx,
      );
    }
    if (url.pathname === "/__fixture/configuration-failure") {
      return reactor.configurationFailure(request, env, ctx);
    }
    if (url.pathname === "/client-policy") {
      return exerciseClientPolicy(worker, request, env, ctx);
    }
    if (url.pathname === "/__fixture/empty-response") {
      const response = await reactor.emptyResponse(
        Number(url.searchParams.get("status")),
        Number(url.searchParams.get("variant")),
      );
      return Response.json({
        status: response.status,
        nullBody: response.body === null,
        header: response.headers.get("X-Fixture"),
        body: await response.text(),
      });
    }
    if (url.pathname === "/__fixture/socket-failure") {
      return Response.json(JSON.parse(await reactor.socketFailure(connect)));
    }
    if (url.pathname === "/__fixture/stream") {
      const mode = url.searchParams.get("mode");
      let cancelled = 0;
      let cancellationFinished = false;
      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === "failure") {
            return controller.error(new Error("original stream failure"));
          }
          if (
            mode === "limit" ||
            mode === "cancel-failure" ||
            mode === "cancel-delayed" ||
            mode === "cancel-delayed-failure"
          ) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024));
          } else {
            controller.enqueue(new Uint8Array(0));
            controller.enqueue(new Uint8Array([0, 128, 255]));
            controller.close();
          }
        },
        async cancel() {
          cancelled++;
          if (mode === "cancel-failure") {
            throw new Error("cancel failure must not replace limit");
          }
          if (mode === "cancel-delayed" || mode === "cancel-delayed-failure") {
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          cancellationFinished = true;
          if (mode === "cancel-delayed-failure") {
            throw new Error("late cancel failure must not replace limit");
          }
        },
      });
      const before = reactor.memory.buffer.byteLength;
      const result = JSON.parse(await reactor.drainStream(input, 4));
      return Response.json({
        ...result,
        cancelled,
        cancellationFinished,
        locked: input.locked,
        memoryGrowth: reactor.memory.buffer.byteLength - before,
      });
    }
    if (url.pathname === "/__fixture/tail") {
      await worker.tail(
        [
          {
            scriptName: "library-tail-fixture",
            outcome: "ok",
            eventTimestamp: 1788739200000,
            logs: [],
            exceptions: [],
            diagnosticsChannelEvents: [],
            event: null,
            executionModel: "stateless",
            truncated: false,
            cpuTime: 0,
            wallTime: 0,
          },
        ],
        env,
        ctx,
      );
      return Response.json({ delivered: true });
    }
    return worker.fetch(request, env, ctx);
  },
};
