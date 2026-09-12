import coverageUpload from "./coverage-upload";
import { applicationProbe } from "./application-probe";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { unwrapWorkflowResult } from "@cloudflare-workers-hs/runtime";
import { ApprovalWorkflow as ProductionWorkflow } from "../../worker/entry";
import production from "../../worker/entry";
import { NonRetryableError } from "cloudflare:workflows";
import { createFixtureReactor } from "./runtime";
import { controlProbe } from "./control-probe";
export class ApprovalWorkflow extends ProductionWorkflow {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const payload = event.payload;
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("behavior" in payload) ||
      typeof payload.behavior !== "string" ||
      ![
        "timeout",
        "lazy-output",
        "lazy-step",
        "unsafe-integer",
        "event-timeout",
        "event-payload",
        "backoff-constant",
        "backoff-linear",
        "backoff-exponential",
      ].includes(payload.behavior)
    ) {
      return super.run(event, step);
    }
    const reactor = await createFixtureReactor();
    const result = await reactor.workflowFixture(
      event,
      step,
      this.env,
      NonRetryableError,
    );
    return unwrapWorkflowResult(result, NonRetryableError);
  }
}
export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    if (new URL(request.url).pathname === "/__coverage/upload-failure") {
      return coverageUpload.fetch(request, env, context);
    }
    if (new URL(request.url).pathname === "/__fixture/application") {
      return applicationProbe(request, env, context);
    }
    if (new URL(request.url).pathname === "/__fixture/control") {
      return controlProbe(new URL(request.url).searchParams.get("scenario") ?? "");
    }
    if (new URL(request.url).pathname === "/__fixture/d1-query") {
      const reactor = await createFixtureReactor();
      return Response.json(JSON.parse(await reactor.d1QueryFixture(env.AUDIT)));
    }
    if (new URL(request.url).pathname === "/__fixture/event") {
      const input: unknown = await request.json();
      if (
        typeof input !== "object" ||
        input === null ||
        !("identifier" in input) ||
        typeof input.identifier !== "string" ||
        !("type" in input) ||
        typeof input.type !== "string" ||
        !("payload" in input)
      ) {
        return new Response("Invalid fixture event", { status: 400 });
      }
      const instance = await env.APPROVALS.get(input.identifier);
      await instance.sendEvent({ type: input.type, payload: input.payload });
      return Response.json({ accepted: true });
    }
    if (new URL(request.url).pathname === "/__fixture/create") {
      const input: unknown = await request.json();
      if (
        typeof input !== "object" ||
        input === null ||
        !("identifier" in input) ||
        typeof input.identifier !== "string" ||
        !("parameters" in input) ||
        typeof input.parameters !== "object" ||
        input.parameters === null ||
        Array.isArray(input.parameters)
      ) {
        return new Response("Invalid fixture input", { status: 400 });
      }
      const instance = await env.APPROVALS.create({
        id: input.identifier,
        params: input.parameters,
      });
      return Response.json({ identifier: instance.id });
    }
    return production.fetch(request, env, context);
  },
};
