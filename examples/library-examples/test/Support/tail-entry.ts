import worker from "../../worker/entry";
// Observe the runtime's real envelope without replacing or modifying it.
export default {
  async tail(events: TraceItem[], env: Env, ctx: ExecutionContext) {
    console.log(
      "native-tail-envelope " +
        JSON.stringify(
          events.map((event) => ({
            outcome: event.outcome,
            timestamp: event.eventTimestamp,
            scriptName: event.scriptName ?? null,
            requestURL:
              event.event && "request" in event.event
                ? event.event.request.url
                : null,
          })),
        ),
    );
    await worker.tail(events, env, ctx);
  },
};
