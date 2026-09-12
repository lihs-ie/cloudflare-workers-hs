import {
  createReactor,
  bindExport,
  decodeResponse,
  decodeString,
  decodeVoid,
} from "@cloudflare-workers-hs/runtime";
import type { connect } from "cloudflare:sockets";
import makeImports from "./library-examples-jsffi.mjs";
import wasmModule from "./library-examples.wasm";
export const reactor = await createReactor(
  wasmModule,
  makeImports,
  (exports) => ({
    coverage: typeof exports.coverage === "function"
      ? bindExport<[], string>(exports, "coverage", decodeString)
      : undefined,
    fetch: bindExport<
      [Request, Env & { SOCKET_CONNECT: typeof connect }, ExecutionContext],
      Response
    >(exports, "fetch", decodeResponse),
    tail: bindExport<[TraceItem[], Env, ExecutionContext], void>(
      exports,
      "tail",
      decodeVoid,
    ),
    jobsInitialize: bindExport<[DurableObjectStorage], void>(
      exports,
      "jobsInitialize",
      decodeVoid,
    ),
    jobsCommit: bindExport<[DurableObjectStorage, string], string>(
      exports,
      "jobsCommit",
      decodeString,
    ),
    jobsStatus: bindExport<[DurableObjectStorage, string], string>(
      exports,
      "jobsStatus",
      decodeString,
    ),
    jobsSaveSettings: bindExport<[DurableObjectStorage, string], string>(
      exports,
      "jobsSaveSettings",
      decodeString,
    ),
    jobsSettingsHistory: bindExport<[DurableObjectStorage], string>(
      exports,
      "jobsSettingsHistory",
      decodeString,
    ),
    queue: bindExport<[MessageBatch<unknown>, Env, ExecutionContext], void>(
      exports,
      "queue",
      decodeVoid,
    ),
    processJob: bindExport<[Env, string], void>(
      exports,
      "processJob",
      decodeVoid,
    ),
  }),
);
