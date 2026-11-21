import { jsonValue, jsonObject } from '../../../../scripts/testing/Support/json.mts';
import { setTimeout as delay } from 'node:timers/promises';

/** Read only flat JSON or Wrangler's flat, unescaped string-field display. */
export function logRecordsFor(logs: string, identifier: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const plain = logs.replace(/\u001b\[[0-9;]*m/g, '');
  for (const [block] of plain.matchAll(/\{[^{}]*\}/g)) {
    let record;
    try {
      record = jsonValue(block);
    } catch {
      const entries: [string, string | number][] = [];
      let valid = true;
      for (const line of block.slice(1, -1).split('\n')) {
        if (line.trim() === '') {
          continue;
        }

        // This intentionally does not interpret JavaScript, escapes, nested
        // values or truncated output. The fixture's fields are plain strings.
        const field = /^\s*([a-z_]+): (?:'([^'\\\r\n]*)'|(-?\d+(?:\.\d+)?)),?\s*$/.exec(line);

        if (field === null || entries.some(([key]) => key === field[1])) {
          valid = false;
          break;
        }

        const value = field[2] ?? Number(field[3]);

        if (typeof value === 'number' && !Number.isFinite(value)) {
          valid = false;
          break;
        }

        entries.push([field[1], value]);
      }

      if (!valid || entries.length === 0) {
        continue;
      }

      record = Object.fromEntries(entries);
    }

    if (
      typeof record === 'object' &&
      record !== null &&
      !Array.isArray(record) &&
      'request_id' in record &&
      record.request_id === identifier
    ) {
      records.push(jsonObject(record));
    }
  }
  return records;
}

/** Wait for the completion of this request, not a duration from an older one. */
export async function waitForRequestCompletion(
  readLogs: () => Promise<string>,
  identifier: string,
  timeout: number = 5000,
): Promise<{ logs: string; completion: Record<string, unknown> }> {
  const deadline = Date.now() + timeout;
  do {
    const logs = await readLogs();
    const completion = logRecordsFor(logs, identifier).find(
      (record) =>
        record.message === 'request completed' &&
        typeof record.duration_ms === 'number' &&
        typeof record.status === 'number',
    );

    if (completion) {
      return { logs, completion };
    }

    if (Date.now() >= deadline) {
      break;
    }

    await delay(50);
  } while (Date.now() <= deadline);
  throw new Error(`No completion record for request ${identifier}`);
}
