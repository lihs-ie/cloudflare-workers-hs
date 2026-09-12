import {
  createReactor,
  bindExport,
  decodeResponse,
} from "@cloudflare-workers-hs/runtime";
import makeImports from "./minimal-worker-jsffi.mjs";
import wasmModule from "./minimal-worker.wasm";
export interface Exports {
  fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response>;
}
export const reactor = await createReactor(
  wasmModule,
  makeImports,
  (exports): Exports => {
    return {
      fetch: bindExport<
        Parameters<Exports["fetch"]>,
        Awaited<ReturnType<Exports["fetch"]>>
      >(exports, "fetch", decodeResponse),
    };
  },
);
