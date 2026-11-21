import { jsonValue } from '../../../../../scripts/testing/Support/json.mts';
import {
  createReactor,
  bindExport,
  decodeString,
  decodeResponse,
} from '@cloudflare-workers-hs/runtime';
import makeImports from '../../../worker/runtime-tests-jsffi.mjs';
import wasmModule from '../../../worker/runtime-tests.wasm';

const exports = await createReactor(wasmModule, makeImports, (table) => ({
  urlShortenerLeaseProbe: bindExport<[unknown, number], string>(
    table,
    'urlShortenerLeaseProbe',
    decodeString,
  ),
  urlShortenerDatabasePreparedProbe: bindExport<[D1Database], string>(
    table,
    'urlShortenerDatabasePreparedProbe',
    decodeString,
  ),
  exportProducerProbe: bindExport<[string], string>(table, 'exportProducerProbe', decodeString),
  urlShortenerManagementProbe: bindExport<
    [D1Database, number, Request, ExecutionContext],
    Response
  >(table, 'urlShortenerManagementProbe', decodeResponse),
  exportRequestCodecProbe: bindExport<[string], string>(
    table,
    'exportRequestCodecProbe',
    decodeString,
  ),
  generationAsyncProbe: bindExport<
    [unknown, unknown, ExecutionContext, { isReady: () => boolean; unblock: () => void }],
    string
  >(table, 'generationAsyncProbe', decodeString),
  coverage: bindExport<[], string>(table, 'coverage', decodeString),
}));

export const urlShortenerManagementProbe = exports.urlShortenerManagementProbe;
export const exportRequestCodecProbe = exports.exportRequestCodecProbe;
export const generationAsyncProbe = exports.generationAsyncProbe;
export const urlShortenerLeaseProbe = exports.urlShortenerLeaseProbe;
export const exportProducerProbe = exports.exportProducerProbe;

export async function urlShortenerDatabasePreparedProbe(
  database: D1Database,
): Promise<{ label: string; count: number }> {
  const value: unknown = jsonValue(await exports.urlShortenerDatabasePreparedProbe(database));

  if (
    typeof value !== 'object' ||
    value === null ||
    !('label' in value) ||
    typeof value.label !== 'string' ||
    !('count' in value) ||
    typeof value.count !== 'number'
  ) {
    throw new TypeError('Expected prepared query result');
  }

  return { label: value.label, count: value.count };
}

export default {
  async fetch(): Promise<Response> {
    return new Response(await exports.coverage());
  },
};
