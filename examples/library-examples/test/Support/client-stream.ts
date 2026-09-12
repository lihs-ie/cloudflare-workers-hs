import { reactor } from "./runtime";

/** Native stream with controlled producer failures; the binding itself is a fixture. */
export async function inspectClientStream(
  mode: string | null,
): Promise<Response> {
  const callbackModes = new Map([
    ["eof", 0],
    ["early", 1],
    ["early-empty", 1],
    ["early-read-failure", 1],
    ["consumer-before", 2],
    ["consumer-after", 3],
    ["read-failure", 0],
    ["cancel-failure", 3],
    ["http-error", 0],
  ]);
  const callbackMode = mode === null ? undefined : callbackModes.get(mode);
  if (callbackMode === undefined) {
    return new Response("Unknown stream fixture", { status: 400 });
  }
  let cancelled = 0;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      if (mode === "read-failure" || mode === "early-read-failure") {
        controller.error(new Error("original producer failure"));
        return;
      }
      if (mode === "early-empty") {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array([0, 128, 255]));
      if (mode === "eof" || mode === "http-error") {
        controller.close();
      }
    },
    cancel() {
      cancelled += 1;
      if (mode === "cancel-failure") {
        throw new Error("cleanup must not replace consumer failure");
      }
    },
  });
  const nativeResponse = new Response(input, {
    status: mode === "http-error" ? 409 : 200,
  });
  const result = JSON.parse(
    await reactor.clientStreamLifecycle(
      {
        fetch: async () => nativeResponse,
      },
      callbackMode,
    ),
  );
  return Response.json({
    ...result,
    locked: input.locked,
    inputLocked: input.locked,
    cancelled,
  });
}
