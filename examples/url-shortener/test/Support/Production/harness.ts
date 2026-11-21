import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  applyD1Migrations,
} from 'cloudflare:test';
import { vi } from 'vitest';
import redirect from '../../../worker/redirect.js';
import management from '../../../worker/management.js';
import exports from '../../../worker/export.js';
import recovery from '../../../worker/recovery.js';
import { createAccessFixture, jwksURL } from './auth.js';
import type { Application, Send } from './http-contract.js';

export const productionEnv = env;
const applications = { redirect, management, export: exports, recovery };
let fixturePromise: ReturnType<typeof createAccessFixture> | undefined;
export async function setupProduction(): Promise<{
  jwks: {
    keys: {
      kid: string;
      alg: string;
      use: string;
      crv?: string | undefined;
      d?: string | undefined;
      dp?: string | undefined;
      dq?: string | undefined;
      e?: string | undefined;
      ext?: boolean | undefined;
      k?: string | undefined;
      key_ops?: string[] | undefined;
      kty?: string | undefined;
      n?: string | undefined;
      oth?: RsaOtherPrimesInfo[] | undefined;
      p?: string | undefined;
      q?: string | undefined;
      qi?: string | undefined;
      x?: string | undefined;
      y?: string | undefined;
    }[];
  };
  token: (overrides?: Record<string, unknown>) => Promise<string>;
}> {
  await applyD1Migrations(productionEnv.DB, productionEnv.TEST_MIGRATIONS);
  const fixture = await (fixturePromise ??= createAccessFixture());
  const original = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (
      input: string | Request<unknown, CfProperties<unknown>> | URL,
      init?: RequestInit<CfProperties<unknown>> | undefined,
    ) => {
      const request = new Request(input, init);

      if (request.url === jwksURL && request.method === 'GET') {
        return Response.json(fixture.jwks);
      }

      return original(input, init);
    },
  );
  return fixture;
}
export const send: Send = async (application: Application, pathname, init) => {
  const context = createExecutionContext();
  const response = await applications[application].fetch(
    new Request(`https://url-shortener.example${pathname}`, init),
    productionEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
};
