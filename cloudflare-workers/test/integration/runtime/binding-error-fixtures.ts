import { jsonValue } from '../../../../scripts/testing/Support/json.mts';
import { cacheServiceErrorsProbe } from '../../../../tests/runtime/harness.js';

export const probe = async (handle: unknown, command: string): Promise<unknown> =>
  jsonValue(await cacheServiceErrorsProbe(handle, command));

export async function withCache<T>(open: () => unknown, action: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(caches, 'open');
  Object.defineProperty(caches, 'open', { configurable: true, value: open });
  try {
    return await action();
  } finally {
    if (previous) {
      Object.defineProperty(caches, 'open', previous);
    } else {
      Reflect.deleteProperty(caches, 'open');
    }
  }
}

export const cacheProbe = (cache: unknown, command: string): Promise<unknown> =>
  withCache(
    () => cache,
    () => probe(null, command),
  );
export const emptyResponse = (): Response =>
  new Response(null, { status: 204, headers: { 'x-fixture': 'response' } });
