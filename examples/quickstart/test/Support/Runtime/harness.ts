import { DurableObject } from "cloudflare:workers";
import {
  createReactor,
  bindExport,
  decodeString,
  decodeResponse,
} from "@cloudflare-workers-hs/runtime";
import makeImports from "../../../worker/runtime-tests-jsffi.mjs";
import wasmModule from "../../../worker/runtime-tests.wasm";
interface RuntimeEnv {
  STORAGE: DurableObjectNamespace<StorageHarness>;
  RUNTIME_DB: D1Database;
}
const exports = await createReactor(wasmModule, makeImports, (table) => ({
  storagePublicContractsProbe: bindExport<[string], string>(table, "storagePublicContractsProbe", decodeString),
  exportRequestCodecProbe: bindExport<[string], string>(table, "exportRequestCodecProbe", decodeString),
  exportProducerProbe: bindExport<[string], string>(table, "exportProducerProbe", decodeString),
  quickstartDatabasePreparedProbe: bindExport<[D1Database], string>(table, "quickstartDatabasePreparedProbe", decodeString),
  generationAsyncProbe: bindExport<[unknown, unknown, ExecutionContext, { isReady: () => boolean; unblock: () => void }], string>(table, "generationAsyncProbe", decodeString),
  entrypointLifecycleErrorsProbe: bindExport<[string, unknown, unknown, unknown], string>(table, "entrypointLifecycleErrorsProbe", decodeString),
  routingCoverageProbe: bindExport<[string, Request, ExecutionContext, ReadableStream<Uint8Array>], Response>(table, "routingCoverageProbe", decodeResponse),
  clientRetryExtraProbe: bindExport<[unknown, string], string>(table, "clientRetryExtraProbe", decodeString),
  transportExtraProbe: bindExport<[unknown, string], string>(table, "transportExtraProbe", decodeString),
  workflowBoundaryExtraProbe: bindExport<[unknown, unknown, string], string>(table, "workflowBoundaryExtraProbe", decodeString),
  entrypointErrorsProbe: bindExport<[string, unknown, unknown, unknown], string>(table, "entrypointErrorsProbe", decodeString),
  cacheServiceErrorsProbe: bindExport<[unknown, string], string>(table, "cacheServiceErrorsProbe", decodeString),
  storageObjectErrors: bindExport<[unknown, string], string>(table, "storageObjectErrors", decodeString),
  storageErrorProbe: bindExport<[unknown, string], string>(table, "storageErrorProbe", decodeString),
  accessVerificationProbe: bindExport<[string, unknown], string>(table, "accessVerificationProbe", decodeString),
  accessRoutesProbe: bindExport<[Request, ExecutionContext], Response>(table, "accessRoutesProbe", decodeResponse),
  typedQueueProbe: bindExport<[string], string>(table, "typedQueueProbe", decodeString),
  sqlProbe: bindExport<[unknown, string], string>(table, "sqlProbe", decodeString),
  middlewareExtraProbe: bindExport<[Request, ExecutionContext], Response>(table, "middlewareExtraProbe", decodeResponse),
  bindingEnvProbe: bindExport<[unknown, string], string>(table, "bindingEnvProbe", decodeString),
  quickstartManagementProbe: bindExport<[D1Database, number, Request, ExecutionContext], Response>(table, "quickstartManagementProbe", decodeResponse),
  quickstartLeaseProbe: bindExport<[unknown, number], string>(table, "quickstartLeaseProbe", decodeString),
  clientServiceProbe: bindExport<[unknown, string], string>(table, "clientServiceProbe", decodeString),
  socketProbe: bindExport<[unknown, string], string>(table, "socketProbe", decodeString),
  routingProbe: bindExport<[string, Request, ExecutionContext], Response>(table, "routingProbe", decodeResponse),
  envelopeProbe: bindExport<[unknown], string>(table, "envelopeProbe", decodeString),
  storageNativeProbe: bindExport<[unknown, string], string>(table, "storageNativeProbe", decodeString),
  queueOutcome: bindExport<[unknown, string], string>(table, "queueOutcome", decodeString),
  d1DecoderBoundaries: bindExport<[], string>(table, "d1DecoderBoundaries", decodeString),
  waitUntilContext: bindExport<[Pick<ExecutionContext, "waitUntil">, () => void | Promise<void>], string>(table, "waitUntilContext", decodeString),
  passThroughContext: bindExport<[Pick<ExecutionContext, "passThroughOnException">], string>(table, "passThroughContext", decodeString),
  coverage: bindExport<[], string>(table, "coverage", decodeString),
  d1Lookup: bindExport<[D1Database, string], string>(
    table,
    "d1Lookup",
    decodeString,
  ),
  jwtVerifyConfigured: bindExport<[string], string>(table, "jwtVerifyConfigured", decodeString),
  jwtVerify: bindExport<[string], string>(table, "jwtVerify", decodeString),
  cryptoVerify: bindExport<[string, Uint8Array, Uint8Array], string>(
    table,
    "cryptoVerify",
    decodeString,
  ),
  fetch: bindExport<[Request, RuntimeEnv, ExecutionContext], Response>(
    table,
    "fetch",
    decodeResponse,
  ),
  storage: bindExport<
    [DurableObjectStorage, string, string, Uint8Array],
    unknown
  >(table, "storage", (value) => value),
}));
export async function waitUntilContext(context: Pick<ExecutionContext, "waitUntil">, action: () => void | Promise<void>): Promise<void> {
  const result = await exports.waitUntilContext(context, action);
  if (result !== "ok") {
    throw new Error(result);
  }
}
export async function passThroughContext(context: Pick<ExecutionContext, "passThroughOnException">): Promise<void> {
  const result = await exports.passThroughContext(context);
  if (result !== "ok") {
    throw new Error(result);
  }
}
export async function lookupD1(
  database: D1Database,
  key: string,
): Promise<string> {
  return exports.d1Lookup(database, key);
}
export class StorageHarness extends DurableObject {
  async operation(command: string, key: string, bytes: number[]) {
    const result = await exports.storage(
      this.ctx.storage,
      command,
      key,
      new Uint8Array(bytes),
    );
    if (command === "rollback") {
      return result;
    }
    if (command === "put" || command === "transaction") {
      return null;
    }
    if (command === "delete") {
      return result === "True";
    }
    if (result === "absent") {
      return null;
    }
    if (result instanceof Uint8Array) {
      return Array.from(result);
    }
    throw new Error("Unexpected storage result");
  }
}
export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/__coverage") {
      return new Response(await exports.coverage());
    }
    if (new URL(request.url).pathname === "/__access/configured") {
      return Response.json({ identity: await exports.jwtVerifyConfigured(await request.text()) });
    }
    if (new URL(request.url).pathname === "/__access/verify") {
      const input = await request.json<{ token: string }>();
      const result = await exports.jwtVerify(input.token);
      return Response.json({ identity: result });
    }
    if (new URL(request.url).pathname === "/__crypto/verify") {
      const input = await request.json<{
        jwk: unknown;
        signature: number[];
        message: number[];
      }>();
      const result = await exports.cryptoVerify(
        JSON.stringify(input.jwk),
        new Uint8Array(input.signature),
        new Uint8Array(input.message),
      );
      return Response.json({ valid: result === "valid" });
    }
    if (new URL(request.url).pathname === "/__model/storage") {
      const commands =
        await request.json<
          { command: string; key: string; bytes: number[] }[]
        >();
      const stub = env.STORAGE.get(env.STORAGE.newUniqueId());
      const results: unknown[] = [];
      for (const command of commands)
        results.push(
          await stub.operation(command.command, command.key, command.bytes),
        );
      return Response.json(results);
    }
    return exports.fetch(request, env, ctx);
  },
};

export const probeEnvelope = exports.envelopeProbe;
export const probeQueueOutcome = exports.queueOutcome;
export const probeD1DecoderBoundaries = exports.d1DecoderBoundaries;

function decodeProbeList(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) {
    throw new TypeError("Expected probe string array");
  }
  return parsed;
}
export async function socketProbe(socket: unknown, command: string): Promise<string[]> {
  return decodeProbeList(await exports.socketProbe(socket, command));
}
export const routingProbe = exports.routingProbe;
export const queueOutcome = exports.queueOutcome;
export const d1DecoderBoundaries = exports.d1DecoderBoundaries;

export const clientServiceProbe = exports.clientServiceProbe;

export const storageNativeProbe = exports.storageNativeProbe;

export const bindingEnvProbe = exports.bindingEnvProbe;
export const quickstartManagementProbe = exports.quickstartManagementProbe;
export const quickstartLeaseProbe = exports.quickstartLeaseProbe;

export const accessVerificationProbe = exports.accessVerificationProbe;

export const accessRoutesProbe = exports.accessRoutesProbe;

export const middlewareExtraProbe = exports.middlewareExtraProbe;

export const sqlProbe = exports.sqlProbe;

export const typedQueueProbe = exports.typedQueueProbe;

export const storageErrorProbe = exports.storageErrorProbe;

export const storageObjectErrors = exports.storageObjectErrors;

export const cacheServiceErrorsProbe = exports.cacheServiceErrorsProbe;

export const entrypointErrorsProbe = exports.entrypointErrorsProbe;

export const workflowBoundaryExtraProbe = exports.workflowBoundaryExtraProbe;

export async function transportExtraProbe(source: unknown, command: string): Promise<string[]> {
  return decodeProbeList(await exports.transportExtraProbe(source, command));
}

export const clientRetryExtraProbe = exports.clientRetryExtraProbe;

export const routingCoverageProbe = exports.routingCoverageProbe;

export const entrypointLifecycleErrorsProbe = exports.entrypointLifecycleErrorsProbe;

export const generationAsyncProbe = exports.generationAsyncProbe;
export async function quickstartDatabasePreparedProbe(database: D1Database): Promise<{label: string; count: number}> {
  const value: unknown = JSON.parse(await exports.quickstartDatabasePreparedProbe(database));
  if (typeof value !== "object" || value === null || !("label" in value) || typeof value.label !== "string" || !("count" in value) || typeof value.count !== "number") {
    throw new TypeError("Expected prepared query result");
  }
  return {label: value.label, count: value.count};
}

export const exportRequestCodecProbe = exports.exportRequestCodecProbe;

export const storagePublicContractsProbe = exports.storagePublicContractsProbe;

export const exportProducerProbe = exports.exportProducerProbe;
