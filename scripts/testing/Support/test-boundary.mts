import { jsonObject } from './json.mts';

export async function loadTestModule(specifier: string): Promise<Record<string, unknown>> {
  const imported: unknown = await import(specifier);
  return jsonObject(imported);
}

export function constructTestBoundary(
  constructor: unknown,
  ...args: unknown[]
): Record<string, unknown> {
  if (typeof constructor !== 'function') {
    throw new TypeError('Expected a test boundary constructor');
  }

  const instance: unknown = Reflect.construct(constructor, args);
  return jsonObject(instance);
}

export function callTestBoundary(fn: unknown, ...args: unknown[]): unknown {
  if (typeof fn !== 'function') {
    throw new TypeError('Expected a callable test boundary');
  }

  return Reflect.apply(fn, undefined, args);
}

export function callTestMethod(receiver: unknown, name: unknown, ...args: unknown[]): unknown {
  if (typeof name !== 'string' && typeof name !== 'number' && typeof name !== 'symbol') {
    throw new TypeError('Expected a boundary method name');
  }

  if ((typeof receiver !== 'object' || receiver === null) && typeof receiver !== 'function') {
    throw new TypeError('Expected a boundary receiver');
  }

  const target = receiver;
  const method: unknown = Reflect.get(target, name);

  if (typeof method !== 'function') {
    throw new TypeError(`Expected test boundary method: ${String(name)}`);
  }

  return Reflect.apply(method, receiver, args);
}
