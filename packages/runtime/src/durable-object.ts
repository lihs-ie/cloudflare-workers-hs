/** Native context supporting event serialization. */
export interface ObjectContext {
  /** Delegates event blocking to the native context. */
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

/** Registers initialization with native Durable Object event blocking. */
export function initializeObject(context: ObjectContext, initialize: () => Promise<unknown>): void {
  void context.blockConcurrencyWhile(initialize);
}

/** Runs a native object operation with optional event serialization. */
export async function runObject<T>(
  context: ObjectContext,
  operation: () => Promise<T>,
  serialize: boolean = false,
): Promise<T> {
  if (serialize) {
    return context.blockConcurrencyWhile(operation);
  }

  return operation();
}
