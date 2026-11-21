import {
  createReactor,
  bindExport,
  decodeResponse,
  decodeString,
  decodeVoid,
} from '@cloudflare-workers-hs/runtime';
import type { connect } from 'cloudflare:sockets';
import makeImports from './api-catalog-jsffi.mjs';
import wasmModule from './api-catalog.wasm';
export const reactor = await createReactor(wasmModule, makeImports, (exports) => ({
  coverage:
    typeof exports.coverage === 'function'
      ? bindExport<[], string>(exports, 'coverage', decodeString)
      : undefined,
  fetch: bindExport<
    [Request, Env & { SOCKET_CONNECT: typeof connect }, ExecutionContext],
    Response
  >(exports, 'fetch', decodeResponse),
  tail: bindExport<[TraceItem[], Env, ExecutionContext], void>(exports, 'tail', decodeVoid),
}));
