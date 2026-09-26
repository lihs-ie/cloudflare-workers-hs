import {
  createReactor,
  bindExport,
  decodeResponse,
  decodeString,
} from "@cloudflare-workers-hs/runtime";
import type { connect } from "cloudflare:sockets";
import makeImports from "../../worker/library-examples-fixtures-jsffi.mjs";
import wasmModule from "../../worker/library-examples-fixtures.wasm";

/** Test-only entry points compiled independently of the production worker. */
export const reactor = await createReactor(
  wasmModule,
  makeImports,
  (exports) => {
    if (!(exports.memory instanceof WebAssembly.Memory)) {
      throw new TypeError("Expected fixture WASM memory export");
    }
    return {
      memory: exports.memory,
      clientOptionDiagnostics: bindExport<[], string>(
        exports,
        "clientOptionDiagnostics",
        decodeString,
      ),
      miscStorageUnknown: bindExport<[], string>(
        exports,
        "miscStorageUnknown",
        decodeString,
      ),
      miscSocketFailure: bindExport<[() => object, string], string>(
        exports,
        "miscSocketFailure",
        decodeString,
      ),
      attachmentMissingReader: bindExport<[R2Bucket], Response>(
        exports,
        "attachmentMissingReader",
        decodeResponse,
      ),
      loggingUnknownRecovery: bindExport<[], string>(
        exports,
        "loggingUnknownRecovery",
        decodeString,
      ),
      clientDefaultOptions: bindExport<[string], string>(
        exports,
        "clientDefaultOptions",
        decodeString,
      ),
      jobsFailure: bindExport<[string, object, string], string>(
        exports,
        "jobsFailure",
        decodeString,
      ),
      coverage:
        typeof exports.coverage === "function"
          ? bindExport<[], string>(exports, "coverage", decodeString)
          : undefined,
      queueContract: bindExport<
        [string, object, object, ExecutionContext],
        string
      >(exports, "queueContract", decodeString),
      cachePurgeExample: bindExport<[object, string], string>(
        exports,
        "cachePurgeExample",
        decodeString,
      ),
      socketBoundary: bindExport<[typeof connect, string, string], string>(
        exports,
        "socketBoundary",
        decodeString,
      ),
      storageValidation: bindExport<[object, string], string>(
        exports,
        "storageValidation",
        decodeString,
      ),
      r2Failure: bindExport<[R2Bucket, string], string>(
        exports,
        "r2Failure",
        decodeString,
      ),
      databaseFailureRecovery: bindExport<[D1Database], string>(
        exports,
        "databaseFailureRecovery",
        decodeString,
      ),
      clientUploadLifecycle: bindExport<[string], string>(
        exports,
        "clientUploadLifecycle",
        decodeString,
      ),
      clientHTTPStreamLifecycle: bindExport<[string], string>(
        exports,
        "clientHTTPStreamLifecycle",
        decodeString,
      ),
      clientStreamLifecycle: bindExport<
        [{ fetch(request: Request): Promise<Response> }, number],
        string
      >(exports, "clientStreamLifecycle", decodeString),
      kvMalformedJSONRecovery: bindExport<[KVNamespace], string>(
        exports,
        "kvMalformedJSONRecovery",
        decodeString,
      ),
      drainStream: bindExport<[ReadableStream<Uint8Array>, number], string>(
        exports,
        "drainStream",
        decodeString,
      ),
      socketFailure: bindExport<[typeof connect], string>(
        exports,
        "socketFailure",
        decodeString,
      ),
      emptyResponse: bindExport<[number, number], Response>(
        exports,
        "emptyResponse",
        decodeResponse,
      ),
      configurationFailure: bindExport<
        [Request, Env, ExecutionContext],
        Response
      >(exports, "configurationFailure", decodeResponse),
      workersAIProbe: bindExport<
        [Request, Record<string, unknown>, ExecutionContext],
        Response
      >(exports, "workersAIProbe", decodeResponse),
    };
  },
);
