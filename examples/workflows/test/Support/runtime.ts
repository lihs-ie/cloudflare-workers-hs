import {
  createReactor,
  bindExport,
  decodeString,
  decodeWorkflowResult,
} from "@cloudflare-workers-hs/runtime";
import type { Exports } from "../../worker/runtime";
import makeImports from "../../worker/workflow-example-fixture-jsffi.mjs";
import wasmModule from "../../worker/workflow-example-fixture.wasm";
export function createFixtureReactor() {
  return createReactor(
  wasmModule,
  makeImports,
  (exports) => ({
    workflowFixture: bindExport<
      Parameters<Exports["workflow"]>,
      Awaited<ReturnType<Exports["workflow"]>>
    >(exports, "workflowFixture", decodeWorkflowResult),
    workflowControlFixture: bindExport<[object, string], string>(exports, "workflowControlFixture", decodeString),
    d1QueryFixture: bindExport<[D1Database], string>(
      exports,
      "d1QueryFixture",
      decodeString,
    ),
  }),
);
}
