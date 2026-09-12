import { reactor } from "./runtime";

const job = { identifier: "boundary-job", payload: "work" };
const encodedJob = JSON.stringify(job);
const encode = (value: string) => new TextEncoder().encode(value);

/** Synthetic boundary failures run through the unchanged Haskell Jobs functions. */
export async function inspectJobsFailure(scenario: string): Promise<Response> {
  const invoke = async (mode: string, boundary: object, input: string) =>
    JSON.parse(await reactor.jobsFailure(mode, boundary, input));
  const rpcScenarios: Record<string, [string, string]> = {
    "process-input": ["process", "{}"],
    "process-conflict": ["process", encodedJob],
    "process-rpc": ["process", encodedJob],
    "read-json": ["read", job.identifier],
    "read-null": ["read", job.identifier],
    "read-rpc": ["read", job.identifier],
    "update-json": ["update", "{}"],
    "update-rpc": ["update", "{}"],
    "history-json": ["history-rpc", ""],
    "history-rpc": ["history-rpc", ""],
  };
  const rpcScenario = rpcScenarios[scenario];
  if (Object.hasOwn(rpcScenarios, scenario)) {
    const [mode, input] = rpcScenario;
    const calls: { method: string; args: string[] }[] = [];
    let failing = true;
    const call = (method: string, ...args: string[]) => {
      calls.push({ method, args });
      if (failing && scenario.endsWith("-rpc")) {
        throw new Error("injected RPC failure");
      }
      if (failing) {
        return scenario === "read-null" ? "null" : "not-json";
      }
      if (method === "commit") {
        return "committed";
      }
      if (method === "status") {
        return JSON.stringify({ ...job, updates: 1 });
      }
      return method === "history" ? "[]" : '{"revision":1,"settings":{}}';
    };
    const namespace = {
      getByName(name: string) {
        if (name !== "jobs") {
          throw new Error("Unexpected namespace name");
        }
        return {
          commit: (...args: string[]) => call("commit", ...args),
          status: (...args: string[]) => call("status", ...args),
          saveSettings: (...args: string[]) => call("saveSettings", ...args),
          history: (...args: string[]) => call("history", ...args),
        };
      },
    };
    const rejected = await invoke(mode, namespace, input);
    const rejectedCalls = calls.length;
    failing = false;
    const recovered = await invoke(
      mode,
      namespace,
      mode === "process" ? encodedJob : input,
    );
    return Response.json({ rejected, recovered, rejectedCalls, calls });
  }

  if (
    ["commit-input", "commit-conflict", "commit-sql", "state-shape"].includes(
      scenario,
    )
  ) {
    let failing = true;
    const statements: string[] = [];
    const storage = {
      transactionSync<T>(action: () => T): T {
        return action();
      },
      sql: {
        exec(statement: string) {
          statements.push(statement);
          if (failing && scenario === "commit-sql") {
            throw new Error("injected SQL execution failure");
          }
          const stateQuery = statement.startsWith("SELECT identifier");
          const verifyQuery = statement.startsWith("SELECT payload");
          const rows = stateQuery
            ? failing
              ? [[job.identifier, job.payload, "unexpected text"]]
              : [[job.identifier, job.payload, 1]]
            : verifyQuery
              ? [[failing ? "conflicting payload" : job.payload]]
              : [];
          return {
            columnNames: stateQuery
              ? ["identifier", "payload", "updates"]
              : verifyQuery
                ? ["payload"]
                : [],
            rowsRead: rows.length,
            rowsWritten: statement.startsWith("INSERT") ? 1 : 0,
            raw() {
              return rows.values();
            },
          };
        },
      },
    };
    const mode = scenario === "state-shape" ? "state" : "commit";
    const rejected = await invoke(
      mode,
      storage,
      scenario === "commit-input" ? "{" : encodedJob,
    );
    const rejectedCalls = statements.length;
    failing = false;
    const recovered = await invoke(mode, storage, encodedJob);
    return Response.json({ rejected, recovered, rejectedCalls, statements });
  }

  const storageScenarios = [
    "save-input",
    "save-current-json",
    "save-current-schema",
    "save-transaction",
    "save-prune",
    "history-record",
  ];
  if (!storageScenarios.includes(scenario)) {
    return new Response("Unknown Jobs failure scenario", { status: 400 });
  }
  let records = new Map<string, Uint8Array>();
  const key = (revision: number) =>
    `settings:history:${String(revision).padStart(12, "0")}`;
  if (scenario === "save-current-json") {
    records.set("settings:current", encode("{"));
  } else if (scenario === "save-current-schema") {
    records.set("settings:current", encode('{"revision":"invalid"}'));
  } else if (scenario === "history-record") {
    records.set(key(1), encode("{"));
  } else if (scenario === "save-prune") {
    for (let revision = 1; revision <= 3; revision++) {
      const value = encode(JSON.stringify({ revision, settings: {} }));
      records.set(key(revision), value);
      records.set("settings:current", value);
    }
  }
  let failing = true;
  let transactions = 0;
  let deletions = 0;
  const storage = {
    async get(name: string) {
      return records.get(name);
    },
    async list(options: {
      prefix?: string;
      reverse?: boolean;
      limit?: number;
    }) {
      const entries = [...records.entries()].filter(([name]) =>
        name.startsWith(options.prefix ?? ""),
      );
      entries.sort(([left], [right]) => left.localeCompare(right));
      if (options.reverse) {
        entries.reverse();
      }
      return new Map(entries.slice(0, options.limit));
    },
    async delete(name: string) {
      deletions++;
      if (failing && scenario === "save-prune") {
        throw new Error("injected prune failure");
      }
      return records.delete(name);
    },
    async transaction(
      action: (transaction: {
        put: (name: string, value: Uint8Array) => Promise<void>;
      }) => Promise<void>,
    ) {
      transactions++;
      const pending = new Map(records);
      await action({
        async put(name, value) {
          pending.set(name, value);
        },
      });
      if (failing && scenario === "save-transaction") {
        throw new Error("injected commit failure");
      }
      records = pending;
    },
  };
  const mode = scenario === "history-record" ? "history" : "save";
  const rejected = await invoke(
    mode,
    storage,
    scenario === "save-input" ? "{" : "{}",
  );
  const afterRejected = {
    keys: [...records.keys()].sort(),
    transactions,
    deletions,
  };
  failing = false;
  if (
    scenario === "save-current-json" ||
    scenario === "save-current-schema" ||
    scenario === "history-record"
  ) {
    records.clear();
  }
  const recovered = await invoke(mode, storage, "{}");
  const history = await invoke("history", storage, "");
  return Response.json({
    rejected,
    recovered,
    afterRejected,
    history,
    transactions,
    deletions,
  });
}
