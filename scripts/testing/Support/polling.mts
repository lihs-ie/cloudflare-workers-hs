import { setTimeout as delay } from 'node:timers/promises';

export interface PollOptions<T> {
  observe(): Promise<T>;
  complete(value: T): boolean;
  timeout: number;
  interval?: number;
  diagnostic(last: T | undefined): string;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<unknown>;
}

export async function poll<T>(options: PollOptions<T>): Promise<T> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeout;
  let last: T | undefined;
  while (now() < deadline) {
    last = await options.observe();

    if (options.complete(last)) {
      return last;
    }

    await (options.wait ?? delay)(options.interval ?? 100);
  }

  throw new Error(options.diagnostic(last));
}
