/** Binds an ABI function and decodes every resolved result. */
export function bindExport<Args extends unknown[], Result>(
  exports: Record<string, unknown>,
  name: string,
  decode: (value: unknown) => Result,
): (...args: Args) => Promise<Result> {
  const callable = exports[name];
  if (typeof callable !== 'function') {
    throw new TypeError(`Reactor must export function ${name}`);
  }

  return async (...args: Args): Promise<Result> => {
    const result: unknown = await callable(...args);
    return decode(result);
  };
}

/** Validates a native Response returned by a reactor. */
export function decodeResponse(value: unknown): Response {
  if (!(value instanceof Response)) {
    throw new TypeError('Expected a Response from reactor');
  }

  return value;
}

/** Validates a string returned by a reactor. */
export function decodeString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Expected a string from reactor');
  }

  return value;
}

/** Validates an operation that returns no value. */
export function decodeVoid(value: unknown): void {
  if (value !== undefined) {
    throw new TypeError('Expected undefined from reactor');
  }
}
