import { createReactor, bindExport, decodeString } from '@cloudflare-workers-hs/runtime';
import makeImports from '../../worker/queued-jobs-fixtures-jsffi.mjs';
import wasmModule from '../../worker/queued-jobs-fixtures.wasm';

export const reactor = await createReactor(wasmModule, makeImports, (table) => ({
  coverage:
    typeof table.coverage === 'function'
      ? bindExport<[], string>(table, 'coverage', decodeString)
      : undefined,
  jobsFailure: bindExport<[string, object, string], string>(table, 'jobsFailure', decodeString),
  queueContract: bindExport<[string, object, object, ExecutionContext], string>(
    table,
    'queueContract',
    decodeString,
  ),
}));
