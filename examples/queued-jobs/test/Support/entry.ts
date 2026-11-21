import {
  createReactor,
  bindExport,
  decodeString,
  decodeResponse,
} from '@cloudflare-workers-hs/runtime';
import makeImports from '../../worker/queued-jobs-jsffi.mjs';
import wasmModule from '../../worker/queued-jobs.wasm';
const fixture = await createReactor(wasmModule, makeImports, (table) => ({
  coverage:
    typeof table.coverage === 'function'
      ? bindExport<[], string>(table, 'coverage', decodeString)
      : undefined,
  fetch: bindExport<[Request, Record<string, unknown>, ExecutionContext], Response>(
    table,
    'fetch',
    decodeResponse,
  ),
}));
export { JobsState } from './jobs-state.js';
import { consumeObservedJobs, jobsQueueFixture } from './jobs-queue.js';
import { inspectJobsFailure } from './jobs-failures.js';
import { inspectQueueContract } from './queue-contracts.js';
import { changeJobSettings, observeJobSubmission } from './jobs-settings.js';
import worker from '../../worker/entry.js';
import { reactor as application } from '../../worker/runtime.js';
import { reactor } from './runtime.js';

export default {
  queue: consumeObservedJobs,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__fixture/coverage') {
      if (!application.coverage || !reactor.coverage || !fixture.coverage) {
        return new Response('Coverage build required', { status: 503 });
      }

      return Response.json([
        await application.coverage(),
        await reactor.coverage(),
        await fixture.coverage(),
      ]);
    }

    if (url.pathname === '/__fixture/process-job') {
      try {
        await application.processJob(env, await request.text());
        return Response.json({ processed: true });
      } catch {
        return Response.json({ processed: false }, { status: 400 });
      }
    }

    if (url.pathname.startsWith('/__fixture/jobs/failure/')) {
      return inspectJobsFailure(url.pathname.slice('/__fixture/jobs/failure/'.length));
    }

    if (url.pathname.startsWith('/__fixture/queue-example-metrics/')) {
      const mode = url.pathname.slice('/__fixture/queue-example-metrics/'.length);
      const producer =
        mode === 'unsupported'
          ? {}
          : {
              async metrics(): Promise<{
                backlogCount: number;
                backlogBytes: number;
                oldestMessageTimestamp: Date;
              }> {
                if (mode === 'failed') {
                  throw new Error('synthetic metrics failure');
                }

                return {
                  backlogCount: 7,
                  backlogBytes: 8192,
                  oldestMessageTimestamp: new Date(1234),
                };
              },
            };
      const forwarded = new Request(new URL('/queue-examples/diagnostics/metrics', request.url));
      return fixture.fetch(forwarded, { ...env, JOBS_QUEUE: producer }, ctx);
    }

    if (url.pathname.startsWith('/__fixture/queue-contract/')) {
      return inspectQueueContract(url.pathname.slice('/__fixture/queue-contract/'.length), ctx);
    }

    if (url.pathname.startsWith('/__fixture/jobs/queue/')) {
      return jobsQueueFixture(request, env);
    }

    if (request.method === 'POST' && url.pathname.startsWith('/__fixture/jobs/settings/')) {
      return changeJobSettings(env.JOBS_DB, url.pathname.slice('/__fixture/jobs/settings/'.length));
    }

    if (request.method === 'POST' && url.pathname === '/jobs') {
      return observeJobSubmission(request, env, ctx, (target, observed, context) =>
        worker.fetch(target, observed, context),
      );
    }

    return worker.fetch(request, env, ctx);
  },
};
