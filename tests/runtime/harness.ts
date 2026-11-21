import { exerciseCachePurge } from '../../cloudflare-workers/test/Support/Runtime/cache-purge.js';
import { inspectImages } from '../../cloudflare-workers/test/Support/Runtime/images.js';
import { inspectWorkersAI } from '../../cloudflare-workers/test/Support/Runtime/workers-ai.js';
import { jsonArray, jsonString, jsonValue } from '../../scripts/testing/Support/json.mts';
import { DurableObject } from 'cloudflare:workers';
import {
  createReactor,
  bindExport,
  decodeString,
  decodeResponse,
} from '@cloudflare-workers-hs/runtime';
import makeImports from './worker/library-runtime-jsffi.mjs';
import wasmModule from './worker/library-runtime.wasm';
interface RuntimeEnv {
  STORAGE: DurableObjectNamespace<StorageHarness>;
  RUNTIME_DB: D1Database;
}
const exports = await createReactor(wasmModule, makeImports, (table) => ({
  cachePurgeExample: bindExport<[object, string], string>(table, 'cachePurgeExample', decodeString),
  streamingProbe: bindExport<[Request, object, ExecutionContext], Response>(
    table,
    'streamingProbe',
    decodeResponse,
  ),
  jwksCacheScenarios: bindExport<[], string>(table, 'jwksCacheScenarios', decodeString),
  imagesProbe: bindExport<[Request, { IMAGES: unknown }, ExecutionContext], Response>(
    table,
    'imagesProbe',
    decodeResponse,
  ),
  workersAIProbe: bindExport<[Request, { AI: unknown }, ExecutionContext], Response>(
    table,
    'workersAIProbe',
    decodeResponse,
  ),
  sqlChecks: bindExport<[DurableObjectStorage], string>(table, 'sqlChecks', decodeString),
  upgradeChecks: bindExport<[], string>(table, 'upgradeChecks', decodeString),
  storagePublicContractsProbe: bindExport<[string], string>(
    table,
    'storagePublicContractsProbe',
    decodeString,
  ),
  entrypointLifecycleErrorsProbe: bindExport<[string, unknown, unknown, unknown], string>(
    table,
    'entrypointLifecycleErrorsProbe',
    decodeString,
  ),
  routingCoverageProbe: bindExport<
    [string, Request, ExecutionContext, ReadableStream<Uint8Array>],
    Response
  >(table, 'routingCoverageProbe', decodeResponse),
  clientRetryExtraProbe: bindExport<[unknown, string], string>(
    table,
    'clientRetryExtraProbe',
    decodeString,
  ),
  transportExtraProbe: bindExport<[unknown, string], string>(
    table,
    'transportExtraProbe',
    decodeString,
  ),
  workflowBoundaryExtraProbe: bindExport<[unknown, unknown, string], string>(
    table,
    'workflowBoundaryExtraProbe',
    decodeString,
  ),
  entrypointErrorsProbe: bindExport<[string, unknown, unknown, unknown], string>(
    table,
    'entrypointErrorsProbe',
    decodeString,
  ),
  cacheServiceErrorsProbe: bindExport<[unknown, string], string>(
    table,
    'cacheServiceErrorsProbe',
    decodeString,
  ),
  storageObjectErrors: bindExport<[unknown, string], string>(
    table,
    'storageObjectErrors',
    decodeString,
  ),
  storageErrorProbe: bindExport<[unknown, string], string>(
    table,
    'storageErrorProbe',
    decodeString,
  ),
  accessVerificationProbe: bindExport<[string, unknown], string>(
    table,
    'accessVerificationProbe',
    decodeString,
  ),
  accessRoutesProbe: bindExport<[Request, ExecutionContext], Response>(
    table,
    'accessRoutesProbe',
    decodeResponse,
  ),
  typedQueueProbe: bindExport<[string], string>(table, 'typedQueueProbe', decodeString),
  sqlProbe: bindExport<[unknown, string], string>(table, 'sqlProbe', decodeString),
  middlewareExtraProbe: bindExport<[Request, ExecutionContext], Response>(
    table,
    'middlewareExtraProbe',
    decodeResponse,
  ),
  bindingEnvProbe: bindExport<[unknown, string], string>(table, 'bindingEnvProbe', decodeString),
  clientServiceProbe: bindExport<[unknown, string], string>(
    table,
    'clientServiceProbe',
    decodeString,
  ),
  socketProbe: bindExport<[unknown, string], string>(table, 'socketProbe', decodeString),
  routingProbe: bindExport<[string, Request, ExecutionContext], Response>(
    table,
    'routingProbe',
    decodeResponse,
  ),
  envelopeProbe: bindExport<[unknown], string>(table, 'envelopeProbe', decodeString),
  storageNativeProbe: bindExport<[unknown, string], string>(
    table,
    'storageNativeProbe',
    decodeString,
  ),
  queueOutcome: bindExport<[unknown, string], string>(table, 'queueOutcome', decodeString),
  d1DecoderBoundaries: bindExport<[], string>(table, 'd1DecoderBoundaries', decodeString),
  waitUntilContext: bindExport<
    [Pick<ExecutionContext, 'waitUntil'>, () => void | Promise<void>],
    string
  >(table, 'waitUntilContext', decodeString),
  passThroughContext: bindExport<[Pick<ExecutionContext, 'passThroughOnException'>], string>(
    table,
    'passThroughContext',
    decodeString,
  ),
  coverage: bindExport<[], string>(table, 'coverage', decodeString),
  d1QueryFixture: bindExport<[D1Database], string>(table, 'd1QueryFixture', decodeString),
  d1Lookup: bindExport<[D1Database, string], string>(table, 'd1Lookup', decodeString),
  jwtVerifyConfigured: bindExport<[string], string>(table, 'jwtVerifyConfigured', decodeString),
  jwtVerify: bindExport<[string], string>(table, 'jwtVerify', decodeString),
  cryptoVerify: bindExport<[string, Uint8Array, Uint8Array], string>(
    table,
    'cryptoVerify',
    decodeString,
  ),
  fetch: bindExport<[Request, RuntimeEnv, ExecutionContext], Response>(
    table,
    'fetch',
    decodeResponse,
  ),
  storage: bindExport<[DurableObjectStorage, string, string, Uint8Array], unknown>(
    table,
    'storage',
    (value) => value,
  ),
}));
export async function streamingProbe(
  request: Request,
  context: ExecutionContext,
): Promise<Response> {
  return exports.streamingProbe(request, {}, context);
}

export async function jwksCacheScenarios(): Promise<string[]> {
  return jsonArray(jsonValue(await exports.jwksCacheScenarios())).map(jsonString);
}

export async function waitUntilContext(
  context: Pick<ExecutionContext, 'waitUntil'>,
  action: () => void | Promise<void>,
): Promise<void> {
  const result = await exports.waitUntilContext(context, action);

  if (result !== 'ok') {
    throw new Error(result);
  }
}
export async function passThroughContext(
  context: Pick<ExecutionContext, 'passThroughOnException'>,
): Promise<void> {
  const result = await exports.passThroughContext(context);

  if (result !== 'ok') {
    throw new Error(result);
  }
}
export async function lookupD1(database: D1Database, key: string): Promise<string> {
  return exports.d1Lookup(database, key);
}
export class StorageHarness extends DurableObject {
  sqlChecks(): Promise<string> {
    return exports.sqlChecks(this.ctx.storage);
  }

  async operation(command: string, key: string, bytes: number[]): Promise<unknown> {
    const result = await exports.storage(this.ctx.storage, command, key, new Uint8Array(bytes));

    if (command === 'rollback') {
      return result;
    }

    if (command === 'put' || command === 'transaction') {
      return null;
    }

    if (command === 'delete') {
      return result === 'True';
    }

    if (result === 'absent') {
      return null;
    }

    if (result instanceof Uint8Array) {
      return Array.from(result);
    }

    throw new Error('Unexpected storage result');
  }
}
export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/__fixture/cache-purge') {
      return exerciseCachePurge(exports.cachePurgeExample, request);
    }

    if (new URL(request.url).pathname.startsWith('/__fixture/images/')) {
      return inspectImages(request, ctx, exports.imagesProbe);
    }

    if (new URL(request.url).pathname.startsWith('/__fixture/workers-ai/')) {
      return inspectWorkersAI(request, ctx, exports.workersAIProbe);
    }

    if (new URL(request.url).pathname === '/__fixture/d1-query') {
      return Response.json(jsonValue(await exports.d1QueryFixture(env.RUNTIME_DB)));
    }

    if (new URL(request.url).pathname === '/__sql') {
      return new Response(await env.STORAGE.getByName('sql-fixture').sqlChecks(), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (new URL(request.url).pathname === '/__upgrade') {
      return new Response(await exports.upgradeChecks(), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (new URL(request.url).pathname === '/__coverage') {
      return new Response(await exports.coverage());
    }

    if (new URL(request.url).pathname === '/__access/configured') {
      return Response.json({ identity: await exports.jwtVerifyConfigured(await request.text()) });
    }

    if (new URL(request.url).pathname === '/__access/verify') {
      const input = await request.json<{ token: string }>();
      const result = await exports.jwtVerify(input.token);
      return Response.json({ identity: result });
    }

    if (new URL(request.url).pathname === '/__crypto/verify') {
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
      return Response.json({ valid: result === 'valid' });
    }

    if (new URL(request.url).pathname === '/__model/storage') {
      const commands = await request.json<{ command: string; key: string; bytes: number[] }[]>();
      const stub = env.STORAGE.get(env.STORAGE.newUniqueId());
      const results: unknown[] = [];
      for (const command of commands) {
        results.push(await stub.operation(command.command, command.key, command.bytes));
      }
      return Response.json(results);
    }

    return exports.fetch(request, env, ctx);
  },
};

export const probeEnvelope = exports.envelopeProbe;
export const probeQueueOutcome = exports.queueOutcome;
export const probeD1DecoderBoundaries = exports.d1DecoderBoundaries;

function decodeProbeList(value: string): string[] {
  const parsed: unknown = jsonValue(value);

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new TypeError('Expected probe string array');
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

export const storagePublicContractsProbe = exports.storagePublicContractsProbe;
