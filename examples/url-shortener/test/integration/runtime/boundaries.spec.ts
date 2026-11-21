import { registerExportProducerCases } from './boundaries/export-producer.cases.js';
import { exportProducerProbe } from '../../Support/Runtime/harness.js';
import { registerExportRequestCodecCases } from './boundaries/export-request-codec.cases.js';
import { exportRequestCodecProbe } from '../../Support/Runtime/harness.js';
import { registerGenerationAsyncCases } from './boundaries/generation-async.cases.js';
import { registerUrlShortenerDatabaseCases } from './boundaries/url-shortener-database.cases.js';
import {
  generationAsyncProbe,
  urlShortenerDatabasePreparedProbe,
} from '../../Support/Runtime/harness.js';
import { registerUrlShortenerLeaseBoundaries } from './boundaries/url-shortener-lease.cases.js';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  applyD1Migrations,
} from 'cloudflare:test';
import {
  urlShortenerManagementProbe,
  urlShortenerLeaseProbe,
} from '../../Support/Runtime/harness.js';
import { registerUrlShortenerManagementBoundaries } from './boundaries/url-shortener-management.cases.js';

registerUrlShortenerManagementBoundaries(async () => {
  const database = env.RUNTIME_DB;
  await applyD1Migrations(database, env.TEST_MIGRATIONS);
  await database.batch(
    [
      'export_rows',
      'exports',
      'failed_events',
      'daily_clicks',
      'click_events',
      'admin_idempotency',
      'urls',
    ].map((table) => database.prepare(`DELETE FROM ${table}`)),
  );
  return {
    database,
    async send(mode: number, request: Request<unknown, CfProperties<unknown>>): Promise<Response> {
      const context = createExecutionContext();
      const response = await urlShortenerManagementProbe(database, mode, request, context);
      await waitOnExecutionContext(context);
      return response;
    },
  };
});

registerUrlShortenerLeaseBoundaries(urlShortenerLeaseProbe);

registerGenerationAsyncCases(generationAsyncProbe);
registerUrlShortenerDatabaseCases(() => urlShortenerDatabasePreparedProbe(env.RUNTIME_DB));

registerExportRequestCodecCases(exportRequestCodecProbe);

registerExportProducerCases(exportProducerProbe);
