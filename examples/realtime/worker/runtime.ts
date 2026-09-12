import {
  createReactor,
  bindExport,
  decodeResponse,
  decodeString,
  decodeVoid,
} from "@cloudflare-workers-hs/runtime";
import makeImports from "./realtime-worker-jsffi.mjs";
import wasmModule from "./realtime-worker.wasm";
export interface Exports {
  roomOversizeCheck(storage: DurableObjectStorage, state: DurableObjectState, socket: WebSocket): Promise<void>;
  fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response>;
  roomFetch(
    storage: DurableObjectStorage,
    state: DurableObjectState,
    request: Request,
    env: Env,
    context: DurableObjectState,
  ): Promise<Response>;
  initializeRoom(
    storage: DurableObjectStorage,
    state: DurableObjectState,
  ): Promise<void>;
  roomMessage(
    storage: DurableObjectStorage,
    state: DurableObjectState,
    socket: WebSocket,
    message: string | ArrayBuffer,
    env: Env,
  ): Promise<void>;
  roomClose(
    storage: DurableObjectStorage,
    socket: WebSocket,
    code: number,
    reason: string,
    clean: boolean,
    env: Env,
  ): Promise<void>;
  sqlChecks(storage: DurableObjectStorage): Promise<string>;
  upgradeChecks(): Promise<string>;
}
export const reactor = await createReactor(
  wasmModule,
  makeImports,
  (exports): Exports => {
    return {
      roomOversizeCheck: bindExport<[DurableObjectStorage, DurableObjectState, WebSocket], void>(exports, "roomOversizeCheck", decodeVoid),
      fetch: bindExport<
        Parameters<Exports["fetch"]>,
        Awaited<ReturnType<Exports["fetch"]>>
      >(exports, "fetch", decodeResponse),
      roomFetch: bindExport<
        Parameters<Exports["roomFetch"]>,
        Awaited<ReturnType<Exports["roomFetch"]>>
      >(exports, "roomFetch", decodeResponse),
      initializeRoom: bindExport<
        Parameters<Exports["initializeRoom"]>,
        Awaited<ReturnType<Exports["initializeRoom"]>>
      >(exports, "initializeRoom", decodeVoid),
      roomMessage: bindExport<
        Parameters<Exports["roomMessage"]>,
        Awaited<ReturnType<Exports["roomMessage"]>>
      >(exports, "roomMessage", decodeVoid),
      roomClose: bindExport<
        Parameters<Exports["roomClose"]>,
        Awaited<ReturnType<Exports["roomClose"]>>
      >(exports, "roomClose", decodeVoid),
      sqlChecks: bindExport<
        Parameters<Exports["sqlChecks"]>,
        Awaited<ReturnType<Exports["sqlChecks"]>>
      >(exports, "sqlChecks", decodeString),
      upgradeChecks: bindExport<
        Parameters<Exports["upgradeChecks"]>,
        Awaited<ReturnType<Exports["upgradeChecks"]>>
      >(exports, "upgradeChecks", decodeString),
    };
  },
);
