import {
  createReactor,
  bindExport,
  decodeResponse,
  decodeVoid,
} from "@cloudflare-workers-hs/runtime";
import makeGHCWasmJSFFIImports from "./quickstart-jsffi.mjs";
import quickstartModule from "./quickstart.wasm";
import type { WasmExports } from "./wasm-exports.js";

export const wasmExports = await createReactor(
  quickstartModule,
  makeGHCWasmJSFFIImports,
  (exports): WasmExports => ({
    fetch: bindExport<
      Parameters<WasmExports["fetch"]>,
      Awaited<ReturnType<WasmExports["fetch"]>>
    >(exports, "fetch", decodeResponse),
    management: bindExport<
      Parameters<WasmExports["management"]>,
      Awaited<ReturnType<WasmExports["management"]>>
    >(exports, "management", decodeResponse),
    exportApi: bindExport<
      Parameters<WasmExports["exportApi"]>,
      Awaited<ReturnType<WasmExports["exportApi"]>>
    >(exports, "exportApi", decodeResponse),
    recovery: bindExport<
      Parameters<WasmExports["recovery"]>,
      Awaited<ReturnType<WasmExports["recovery"]>>
    >(exports, "recovery", decodeResponse),
    aggregation: bindExport<
      Parameters<WasmExports["aggregation"]>,
      Awaited<ReturnType<WasmExports["aggregation"]>>
    >(exports, "aggregation", decodeVoid),
    quickstartGeneration: bindExport<
      Parameters<WasmExports["quickstartGeneration"]>,
      Awaited<ReturnType<WasmExports["quickstartGeneration"]>>
    >(exports, "quickstartGeneration", decodeVoid),
    recoveryIngest: bindExport<
      Parameters<WasmExports["recoveryIngest"]>,
      Awaited<ReturnType<WasmExports["recoveryIngest"]>>
    >(exports, "recoveryIngest", decodeVoid),
    maintenance: bindExport<
      Parameters<WasmExports["maintenance"]>,
      Awaited<ReturnType<WasmExports["maintenance"]>>
    >(exports, "maintenance", decodeVoid),
    coordinator: bindExport<
      Parameters<WasmExports["coordinator"]>,
      Awaited<ReturnType<WasmExports["coordinator"]>>
    >(exports, "coordinator", decodeResponse),
    coordinatorAlarm: bindExport<
      Parameters<WasmExports["coordinatorAlarm"]>,
      Awaited<ReturnType<WasmExports["coordinatorAlarm"]>>
    >(exports, "coordinatorAlarm", decodeVoid),
  }),
);
