import { z } from 'zod';
import type { WorkerProcess } from './worker-process.mts';

export function collectCoverageOnClose<T extends WorkerProcess>(runtime: T, reactors: number): T {
  let closing: Promise<void> | undefined;

  async function finish(): Promise<void> {
    const failures: unknown[] = [];
    const endpoint = process.env.WASM_COVERAGE_ENDPOINT;
    if (endpoint) {
      try {
        const response = await fetch(`${runtime.base}/__fixture/coverage`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
          throw new Error(`WASM coverage snapshot failed: ${response.status}`);
        }

        const snapshots = z
          .array(z.string())
          .length(reactors)
          .parse(await response.json());
        for (const body of snapshots) {
          const saved = await fetch(endpoint, {
            method: 'POST',
            body,
            signal: AbortSignal.timeout(10000),
          });
          if (!saved.ok) {
            throw new Error(`WASM coverage upload failed: ${saved.status}`);
          }
        }
      } catch (error) {
        failures.push(error);
      }
    }

    try {
      await runtime.close();
    } catch (error) {
      failures.push(error);
    }

    if (failures.length) {
      throw new AggregateError(failures, 'Coverage collection and Worker cleanup failed');
    }
  }

  return {
    ...runtime,
    close(): Promise<void> {
      return (closing ??= finish());
    },
  };
}
