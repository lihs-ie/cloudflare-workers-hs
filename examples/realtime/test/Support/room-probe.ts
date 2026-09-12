import { reactor } from "../../worker/runtime";

/** Fault injection uses real room callbacks and native SQL, never production routes. */
export async function roomProbe(
  scenario: string,
  context: DurableObjectState,
  env: Env,
): Promise<unknown> {
  if (scenario === "malformed-count") {
    const sql = new Proxy(context.storage.sql, {
      get(target, property) {
        if (property === "exec") {
          return (query: string, ...bindings: (string | number | null | ArrayBuffer)[]) => {
            if (query.includes("COUNT(*)")) {
              return { columnNames: ["COUNT(*)"], raw: () => [["not-a-number"]], rowsRead: 1, rowsWritten: 0 };
            }
            return target.exec(query, ...bindings);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const storage = new Proxy(context.storage, {
      get(target, property) {
        if (property === "sql") {
          return sql;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await reactor.roomFetch(storage, context, new Request("https://room/connections"), env, context);
    return { status: response.status, body: await response.json() };
  }
  const socket = context.getWebSockets("chat")[0];
  if (socket === undefined) {
    throw new Error("Room probe requires an active chat client");
  }
  if (scenario === "direct-oversize") {
    await reactor.roomOversizeCheck(context.storage, context, socket);
    return { dispatched: true };
  }
  let failures = 0;
  const failed = new Proxy(socket, {
    get(target, property) {
      if (property === "deserializeAttachment" && scenario === "message-failure") {
        return () => null;
      }
      if (property === "send" || property === "close") {
        return () => {
          failures += 1;
          throw new Error("fixture peer already closed");
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  if (scenario === "message-failure") {
    try {
      await reactor.roomMessage(context.storage, context, failed, "must not persist", env);
      return { rejected: false, failures };
    } catch (error) {
      return { rejected: true, failures, message: String(error) };
    }
  }
  if (scenario === "broadcast-failure") {
    const state = new Proxy(context, {
      get(target, property) {
        if (property === "getWebSockets") {
          return () => [failed, ...target.getWebSockets("chat")];
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await reactor.roomMessage(context.storage, state, socket, "survives failed peer", env);
  } else if (scenario === "close-failure") {
    await reactor.roomClose(context.storage, failed, 1000, "already closed", true, env);
  } else {
    throw new Error("Unknown room probe");
  }
  return {
    failures,
    closed: context.storage.sql.exec("SELECT COUNT(*) AS total FROM events WHERE kind = 'closed'").one().total,
  };
}
