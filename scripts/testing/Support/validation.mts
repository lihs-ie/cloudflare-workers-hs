export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an object');
  }

  return value as Record<string, unknown>;
}

export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Expected an array');
  }

  return value;
}

export function string(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Expected a string');
  }

  return value;
}

export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('Expected a safe integer');
  }

  return value;
}

export function nonnegative(value: unknown): number {
  const number = integer(value);
  if (number < 0) {
    throw new RangeError('Expected a non-negative integer');
  }

  return number;
}

export function strings(value: unknown): string[] {
  return list(value).map(string);
}

export function stringsByName(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value)).map(([key, item]) => [key, string(item)]),
  );
}
