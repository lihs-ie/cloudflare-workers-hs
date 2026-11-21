import {
  createReactor,
  bindExport,
  decodeString,
  decodeWorkflowResult,
} from '@cloudflare-workers-hs/runtime';
import type { Exports } from '../../worker/runtime';
import makeImports from '../../worker/workflow-example-fixture-jsffi.mjs';
import wasmModule from '../../worker/workflow-example-fixture.wasm';
export function createFixtureReactor(): Promise<{
  workflowFixture: Exports['workflow'];
  workflowControlFixture(raw: object, method: string): Promise<string>;
}> {
  return createReactor(wasmModule, makeImports, (exports) => ({
    workflowFixture: bindExport<
      Parameters<Exports['workflow']>,
      Awaited<ReturnType<Exports['workflow']>>
    >(exports, 'workflowFixture', decodeWorkflowResult),
    workflowControlFixture: bindExport<[object, string], string>(
      exports,
      'workflowControlFixture',
      decodeString,
    ),
  }));
}
