import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  defineWorker,
  unwrapWorkflowResult,
} from "@cloudflare-workers-hs/runtime";
import { createWorkflowReactor } from "./runtime";

export class ApprovalWorkflow extends WorkflowEntrypoint<Env, unknown> {
  async run(
    event: WorkflowEvent<unknown>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const reactor = await createWorkflowReactor();
    return unwrapWorkflowResult(
      await reactor.workflow(event, step, this.env, NonRetryableError),
      NonRetryableError,
    );
  }
}

export default defineWorker({
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const reactor = await createWorkflowReactor();
    return reactor.fetch(request, env, ctx);
  },
});
