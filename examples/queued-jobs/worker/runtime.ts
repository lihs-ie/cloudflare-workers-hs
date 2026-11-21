import {
  createReactor,
  bindExport,
  decodeResponse,
  decodeString,
  decodeVoid,
} from '@cloudflare-workers-hs/runtime';
import makeImports from './queued-jobs-jsffi.mjs';
import wasmModule from './queued-jobs.wasm';
export const reactor = await createReactor(wasmModule, makeImports, (exports) => ({
  coverage:
    typeof exports.coverage === 'function'
      ? bindExport<[], string>(exports, 'coverage', decodeString)
      : undefined,
  fetch: bindExport<[Request, Env, ExecutionContext], Response>(exports, 'fetch', decodeResponse),
  jobsInitialize: bindExport<[DurableObjectStorage], void>(exports, 'jobsInitialize', decodeVoid),
  jobsCommit: bindExport<[DurableObjectStorage, string], string>(
    exports,
    'jobsCommit',
    decodeString,
  ),
  jobsStatus: bindExport<[DurableObjectStorage, string], string>(
    exports,
    'jobsStatus',
    decodeString,
  ),
  jobsSaveSettings: bindExport<[DurableObjectStorage, string], string>(
    exports,
    'jobsSaveSettings',
    decodeString,
  ),
  jobsSettingsHistory: bindExport<[DurableObjectStorage], string>(
    exports,
    'jobsSettingsHistory',
    decodeString,
  ),
  queue: bindExport<[MessageBatch<unknown>, Env, ExecutionContext], void>(
    exports,
    'queue',
    decodeVoid,
  ),
  processJob: bindExport<[Env, string], void>(exports, 'processJob', decodeVoid),
}));
