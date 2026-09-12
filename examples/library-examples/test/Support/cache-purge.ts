/** Custom-capability fixture, never an assertion of native Cloudflare support. */
export async function exerciseCachePurge(
  invoke: (context: object, operation: string) => Promise<string>,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const scenario = url.searchParams.get("scenario") ?? "success";
  const operation = url.searchParams.get("operation") ?? "tags";
  const calls: unknown[] = [];
  const context =
    scenario === "missing"
      ? {}
      : {
          cache: {
            async purge(options: unknown): Promise<unknown> {
              calls.push(options);
              if (scenario === "throw") {
                throw new Error("injected custom purge capability failure");
              }
              if (scenario === "malformed-success") {
                return { success: "true", errors: [] };
              }
              if (scenario === "null") {
                return null;
              }
              if (scenario === "rejected") {
                return {
                  success: false,
                  errors: [{ code: 1001, message: "fixture policy refusal" }],
                };
              }
              return { success: true, errors: [] };
            },
          },
        };
  const outcome: unknown = JSON.parse(await invoke(context, operation));
  return Response.json({ outcome, calls });
}
