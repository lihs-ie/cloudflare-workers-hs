/** Haskell Workflow outcome transferred across the WASM boundary. */
export type WorkflowResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      message: string;
      nonRetryable?: boolean;
      nativeError?: unknown;
    };

/** Converts a Workflow outcome into a return value or a native throw. */
export function unwrapWorkflowResult<T>(
  result: WorkflowResult<T>,
  NonRetryableError: new (message: string) => Error,
): T {
  if (result.ok) {
    return result.value;
  }

  if (Object.prototype.hasOwnProperty.call(result, 'nativeError')) {
    throw result.nativeError;
  }

  if (result.nonRetryable) {
    throw new NonRetryableError(result.message);
  }

  throw new Error(result.message);
}

/** Validates a Workflow result envelope while retaining an opaque success value. */
export function decodeWorkflowResult(value: unknown): WorkflowResult<unknown> {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    throw new TypeError('Expected a Workflow result object');
  }

  if (
    value.ok === true &&
    'value' in value &&
    Object.prototype.hasOwnProperty.call(value, 'value')
  ) {
    return { ok: true, value: value.value };
  }

  if (value.ok !== false || !('message' in value) || typeof value.message !== 'string') {
    throw new TypeError('Invalid Workflow result fields');
  }

  if ('nonRetryable' in value && typeof value.nonRetryable !== 'boolean') {
    throw new TypeError('Invalid Workflow nonRetryable flag');
  }

  const failure: WorkflowResult<never> = { ok: false, message: value.message };

  if ('nonRetryable' in value && typeof value.nonRetryable === 'boolean') {
    failure.nonRetryable = value.nonRetryable;
  }

  if ('nativeError' in value && Object.hasOwn(value, 'nativeError')) {
    failure.nativeError = value.nativeError;
  }
  return failure;
}
