export interface CoverageObserverOptions {
  endpoint: string;
  bundle: string;
  readCoverage(): unknown;
  send?: typeof fetch;
  identify?: () => string;
}

export interface CoverageObserver {
  flush(): Promise<void>;
  wrapHandler(value: unknown): unknown;
  wrapClass(value: unknown): unknown;
}

export function createCoverageObserver(options: CoverageObserverOptions): CoverageObserver {
  let isolate: string | undefined;
  let sequence = 0;
  const wrapped = new WeakSet<object>();

  async function flush(): Promise<void> {
    const coverage = options.readCoverage();

    if (!coverage) {
      throw new Error('Missing workerd instrumentation');
    }

    isolate ??= (options.identify ?? (() => crypto.randomUUID()))();
    const body = JSON.stringify({
      bundle: options.bundle,
      isolate,
      sequence: ++sequence,
      coverage,
    });
    const response = await (options.send ?? fetch)(options.endpoint, { method: 'POST', body });

    if (!response.ok) {
      throw new Error(`Coverage collector failed: ${response.status}`);
    }
  }

  function observe(
    fn: (...args: unknown[]) => unknown,
  ): (this: unknown, ...args: unknown[]) => Promise<unknown> {
    return async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      try {
        return await Reflect.apply(fn, this, args);
      } finally {
        await flush();
      }
    };
  }

  function wrapMethods(value: object): void {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (!descriptor || key === 'constructor' || typeof descriptor.value !== 'function') {
        continue;
      }

      const method = descriptor.value;
      const replacement = observe(method);
      Object.defineProperty(value, key, { ...descriptor, value: replacement });
    }
  }

  function wrapClass(value: unknown): unknown {
    if (typeof value !== 'function') {
      return value;
    }

    const prototypes: object[] = [];
    let prototype: unknown = Reflect.get(value, 'prototype');
    while (typeof prototype === 'object' && prototype !== null) {
      const constructor: unknown = Reflect.get(prototype, 'constructor');
      const name: unknown = typeof constructor === 'function' ? constructor.name : undefined;
      // A cancelled Workflow cannot perform I/O in its finalizer. Its counters
      // remain in the isolate and are included in the next handler snapshot.
      if (name === 'WorkflowEntrypoint') {
        return value;
      }

      if (
        typeof name === 'string' &&
        ['Object', 'DurableObject', 'WorkerEntrypoint'].includes(name)
      ) {
        break;
      }

      prototypes.push(prototype);
      prototype = Object.getPrototypeOf(prototype);
    }

    for (const prototype of prototypes) {
      if (!wrapped.has(prototype)) {
        wrapped.add(prototype);
        wrapMethods(prototype);
      }
    }

    return value;
  }

  function wrapHandler(value: unknown): unknown {
    if (typeof value === 'function') {
      return wrapClass(value);
    }

    if (typeof value !== 'object' || value === null) {
      return value;
    }

    const copy: object = {};
    Object.setPrototypeOf(copy, Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        continue;
      }

      const method: unknown = descriptor.value;
      if (typeof method === 'function') {
        descriptor.value = observe((...args: unknown[]): unknown =>
          Reflect.apply(method, value, args),
        );
      }
      Object.defineProperty(copy, key, descriptor);
    }

    if (!Object.isExtensible(value)) {
      Object.preventExtensions(copy);
    }
    return copy;
  }

  return { flush, wrapHandler, wrapClass };
}
