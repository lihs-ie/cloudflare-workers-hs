import {
  createReactor,
  bindExport,
  decodeResponse,
} from "@cloudflare-workers-hs/runtime";
import makeImports from "./static-assets-worker-jsffi.mjs";
import wasmModule from "./static-assets-worker.wasm";
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
