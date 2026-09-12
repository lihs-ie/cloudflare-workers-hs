import {
  createReactor,
  bindExport,
  decodeResponse,
  decodeWorkflowResult,
  type WorkflowResult,
} from "@cloudflare-workers-hs/runtime";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import makeImports from "./workflow-example-jsffi.mjs";
import wasmModule from "./workflow-example.wasm";
export interface Exports {
  fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response>;
  workflow(
    event: WorkflowEvent<unknown>,
    step: WorkflowStep,
    env: Env,
    error: new (message: string) => Error,
  ): Promise<WorkflowResult<unknown>>;
}
/** Creates an isolated scheduler and JSFFI table for one event invocation. */
export function createWorkflowReactor(): Promise<Exports> {
  return createReactor(
  wasmModule,
  makeImports,
  (exports): Exports => {
    return {
      fetch: bindExport<
        Parameters<Exports["fetch"]>,
        Awaited<ReturnType<Exports["fetch"]>>
      >(exports, "fetch", decodeResponse),
      workflow: bindExport<
        Parameters<Exports["workflow"]>,
        Awaited<ReturnType<Exports["workflow"]>>
      >(exports, "workflow", decodeWorkflowResult),
    };
  },
);
}
