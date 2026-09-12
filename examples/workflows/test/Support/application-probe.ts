import production from "../../worker/entry";

/** Injects binding failures at the real application's boundary, retaining its router. */
export async function applicationProbe(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const scenario = url.searchParams.get("scenario");
  const operation = url.searchParams.get("operation") ?? "get";
  let calls = 0;
  const approvals = new Proxy(env.APPROVALS, {
    get(target, property) {
      if (property === operation) {
        return async () => {
          calls += 1;
          throw new Error(`fixture ${operation} unavailable`);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const database = new Proxy(env.AUDIT, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes("count(*)")) {
            return statement;
          }
          return new Proxy(statement, {
            get(prepared, member) {
              if (member === "bind") {
                return () => ({ first: async () => null });
              }
              const value = Reflect.get(prepared, member, prepared);
              return typeof value === "function" ? value.bind(prepared) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const fixtureEnv = new Proxy(env, {
    get(target, property) {
      if (scenario === "binding-error" && property === "APPROVALS") {
        return approvals;
      }
      if (scenario === "empty-audit" && property === "AUDIT") {
        return database;
      }
      return Reflect.get(target, property, target);
    },
  });
  const path = url.searchParams.get("path") ?? "/workflows/missing/audit";
  const forwarded = new Request(new URL(path, url), request);
  const response = await production.fetch(forwarded, fixtureEnv, context);
  return Response.json({ status: response.status, body: await response.text(), calls });
}
