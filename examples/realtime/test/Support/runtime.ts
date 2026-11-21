import { createReactor, bindExport, decodeVoid } from '@cloudflare-workers-hs/runtime';
import makeImports from '../../worker/realtime-fixtures-jsffi.mjs';
import wasmModule from '../../worker/realtime-fixtures.wasm';

export const reactor = await createReactor(wasmModule, makeImports, (table) => ({
  roomOversizeCheck: bindExport<[DurableObjectStorage, DurableObjectState, WebSocket], void>(
    table,
    'roomOversizeCheck',
    decodeVoid,
  ),
}));
