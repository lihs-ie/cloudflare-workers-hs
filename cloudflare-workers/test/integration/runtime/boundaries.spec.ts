import { registerCachePurgeTests } from './cache-purge.cases.js';
import { registerWorkersAICases } from './workers-ai.cases.js';
import { SELF } from 'cloudflare:test';
import { middlewareExtraProbe } from '../../../../tests/runtime/harness.js';
import { registerBindingEnvCases } from './binding-env.cases.js';
import { registerCacheErrorsCases } from './cache-errors.cases.js';
import { registerAssetsErrorsCases } from './assets-errors.cases.js';
import { registerServiceBindingErrorsCases } from './service-binding-errors.cases.js';
import { registerBindingErrorDiagnosticsCases } from './binding-error-diagnostics.cases.js';
import { registerContextCases } from './context.cases.js';
import { registerD1Cases } from './d1.cases.js';
import { registerEntrypointErrorsCases } from './entrypoint-errors.cases.js';
import { registerEntrypointLifecycleErrorsCases } from './entrypoint-lifecycle-errors.cases.js';
import { registerEnvelopeCases } from './envelope.cases.js';
import { registerMiddlewareExtraCases } from './middleware-extra.cases.js';
import { registerRequestCases } from './request.cases.js';
import { registerSocketStreamCases } from './socket-stream.cases.js';
import { registerSQLCases } from './sql.cases.js';
import { registerStorageBoundaryCases } from './storage-boundaries.cases.js';
import { registerStorageErrorCases } from './storage-errors.cases.js';
import { registerStorageObjectErrorCases } from './storage-object-errors.cases.js';
import { registerStoragePublicContractsCases } from './storage-public-contracts.cases.js';
import { storagePublicContractsProbe } from '../../../../tests/runtime/harness.js';
import { registerStorageCases } from './storage.cases.js';
import { registerTransportExtraCases } from './transport-extra.cases.js';
import { registerTypedQueueBoundaryCases } from './typed-queue.cases.js';
import { registerWorkflowBoundaryExtraCases } from './workflow-boundary-extra.cases.js';

registerBindingEnvCases();
registerCacheErrorsCases();
registerAssetsErrorsCases();
registerServiceBindingErrorsCases();
registerBindingErrorDiagnosticsCases();
registerContextCases();
registerD1Cases();
registerEntrypointErrorsCases();
registerEntrypointLifecycleErrorsCases();
registerEnvelopeCases();
registerMiddlewareExtraCases(middlewareExtraProbe);
registerRequestCases();
registerSocketStreamCases();
registerSQLCases();
registerStorageBoundaryCases();
registerStorageErrorCases();
registerStorageObjectErrorCases();
registerStoragePublicContractsCases(storagePublicContractsProbe);
registerStorageCases();
registerTransportExtraCases();
registerTypedQueueBoundaryCases();
registerWorkflowBoundaryExtraCases();

registerCachePurgeTests();
registerWorkersAICases({
  async request(path: string): Promise<unknown> {
    const response = await SELF.fetch('https://fixture.invalid' + path);
    return response.json();
  },
});
