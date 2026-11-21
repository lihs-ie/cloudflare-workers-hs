type Handler = (...args: never[]) => unknown;
type WorkerEvent = 'fetch' | 'queue' | 'scheduled' | 'tail';

/** Validates and freezes a Worker event-handler registration. */
export function defineWorker<T extends Partial<Record<WorkerEvent, Handler>>>(
  handlers: T & Record<Exclude<keyof T, WorkerEvent>, never>,
): T {
  for (const [name, handler] of Object.entries(handlers)) {
    if (!['fetch', 'queue', 'scheduled', 'tail'].includes(name) || typeof handler !== 'function') {
      throw new TypeError(`Invalid Worker handler: ${name}`);
    }
  }
  return Object.freeze({ ...handlers });
}
