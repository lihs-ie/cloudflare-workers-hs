export { JobsState } from './jobs-state.js';
import { consumeJobs } from './jobs-consumer.js';
import { reactor } from './runtime.js';

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return reactor.fetch(request, env, context);
  },
  queue: consumeJobs,
};
