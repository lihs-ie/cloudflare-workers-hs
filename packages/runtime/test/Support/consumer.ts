import {
  bindExport,
  decodeResponse,
  decodeString,
  initializeObject,
  runObject,
  unwrapWorkflowResult,
  decodeWorkflowResult,
} from '@cloudflare-workers-hs/runtime';
const table: Record<string, unknown> = {};
const fetch = bindExport<[Request, { value: string }], Response>(table, 'fetch', decodeResponse);
const response: Promise<Response> = fetch(new Request('https://example.com'), {
  value: 'ok',
});
// @ts-expect-error The adapter preserves required environment bindings.
void fetch(new Request('https://example.com'), {});
// @ts-expect-error A string decoder cannot claim to return Response.
bindExport<[Request], Response>(table, 'fetch', decodeString);
class Context {
  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
const context = new Context();
initializeObject(context, async () => undefined);
const output: Promise<string> = runObject(context, async () => 'ok', true);
const result: unknown = unwrapWorkflowResult(
  decodeWorkflowResult({ ok: true, value: 'ok' }),
  Error,
);
void response;
void output;
void result;
