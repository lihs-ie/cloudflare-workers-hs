import { registerExportProducerCases } from "./boundaries/export-producer.cases.js";
import { exportProducerProbe } from "../../Support/Runtime/harness.js";
import { registerStoragePublicContractsCases } from "./boundaries/storage-public-contracts.cases.js";
import { storagePublicContractsProbe } from "../../Support/Runtime/harness.js";
import { registerExportRequestCodecCases } from "./boundaries/export-request-codec.cases.js";
import { exportRequestCodecProbe } from "../../Support/Runtime/harness.js";
import { registerGenerationAsyncCases } from "./boundaries/generation-async.cases.js";
import { registerQuickstartDatabaseCases } from "./boundaries/quickstart-database.cases.js";
import { generationAsyncProbe, quickstartDatabasePreparedProbe } from "../../Support/Runtime/harness.js";
import { registerEntrypointLifecycleErrorsCases } from "./boundaries/entrypoint-lifecycle-errors.cases.js";
import { registerRoutingCoverageCases } from "./boundaries/routing-coverage.cases.js";
import { registerClientRetryExtraCases } from "./boundaries/client-retry-extra.cases.js";
import { registerTransportExtraCases } from "./boundaries/transport-extra.cases.js";
import { registerWorkflowBoundaryExtraCases } from "./boundaries/workflow-boundary-extra.cases.js";
import { registerEntrypointErrorsCases } from "./boundaries/entrypoint-errors.cases.js";
import { registerCacheServiceErrorsCases } from "./boundaries/cache-service-errors.cases.js";
import { registerStorageObjectErrorCases } from "./boundaries/storage-object-errors.cases.js";
import { registerStorageErrorCases } from "./boundaries/storage-errors.cases.js";
import { registerTypedQueueBoundaryCases } from "./boundaries/typed-queue.cases.js";
import { registerSQLCases } from "./boundaries/sql.cases.js";
import { registerQuickstartLeaseBoundaries } from "./boundaries/quickstart-lease.cases.js";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  applyD1Migrations,
} from "cloudflare:test";
import {
  middlewareExtraProbe,
  quickstartManagementProbe,
  quickstartLeaseProbe,
} from "../../Support/Runtime/harness.js";
import { registerBindingEnvCases } from "./boundaries/binding-env.cases.js";
import { registerQuickstartManagementBoundaries } from "./boundaries/quickstart-management.cases.js";
import { registerMiddlewareExtraCases } from "./boundaries/middleware-extra.cases.js";
import { registerServantCases } from "./boundaries/servant.cases.js";
import { registerServantExtraCases } from "./boundaries/servant-extra.cases.js";
import { registerSocketStreamCases } from "./boundaries/socket-stream.cases.js";
import { registerStorageBoundaryCases } from "./boundaries/storage-boundaries.cases.js";
import { registerEnvelopeCases } from "./boundaries/envelope.cases.js";
import { registerContextCases } from "./boundaries/context.cases.js";
import { registerD1Cases } from "./boundaries/d1.cases.js";
import { registerRequestCases } from "./boundaries/request.cases.js";
import { registerStorageCases } from "./boundaries/storage.cases.js";

registerRequestCases();
registerStorageCases();

registerD1Cases();

registerContextCases();

registerEnvelopeCases();

registerSocketStreamCases();
registerStorageBoundaryCases();

registerServantCases();
registerServantExtraCases();

registerBindingEnvCases();
registerQuickstartManagementBoundaries(async () => {
  const database = env.RUNTIME_DB;
  await applyD1Migrations(database, env.TEST_MIGRATIONS);
  await database.batch(
    [
      "export_rows",
      "exports",
      "failed_events",
      "daily_clicks",
      "click_events",
      "admin_idempotency",
      "urls",
    ].map((table) => database.prepare(`DELETE FROM ${table}`)),
  );
  return {
    database,
    async send(mode, request) {
      const context = createExecutionContext();
      const response = await quickstartManagementProbe(
        database,
        mode,
        request,
        context,
      );
      await waitOnExecutionContext(context);
      return response;
    },
  };
});

registerQuickstartLeaseBoundaries(quickstartLeaseProbe);

registerMiddlewareExtraCases(middlewareExtraProbe);

registerSQLCases();

registerTypedQueueBoundaryCases();

registerStorageErrorCases();

registerStorageObjectErrorCases();

registerCacheServiceErrorsCases();

registerEntrypointErrorsCases();

registerWorkflowBoundaryExtraCases();

registerTransportExtraCases();

registerClientRetryExtraCases();

registerRoutingCoverageCases();

registerEntrypointLifecycleErrorsCases();

registerGenerationAsyncCases(generationAsyncProbe);
registerQuickstartDatabaseCases(() => quickstartDatabasePreparedProbe(env.RUNTIME_DB));

registerExportRequestCodecCases(exportRequestCodecProbe);

registerStoragePublicContractsCases(storagePublicContractsProbe);

registerExportProducerCases(exportProducerProbe);
