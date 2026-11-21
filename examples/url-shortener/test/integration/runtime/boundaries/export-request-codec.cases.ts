import {
  jsonArray,
  jsonObject,
  jsonValue,
} from '../../../../../../scripts/testing/Support/json.mts';
import { expect, it } from 'vitest';

type Probe = (input: string) => Promise<string>;

export function registerExportRequestCodecCases(probe: Probe): void {
  it('roundtrips saved export request batches through the public Haskell wire codec', async () => {
    const requests = [
      { startDay: '2024-02-29', endDay: '2024-02-29' },
      { startDay: '2024-01-01', endDay: '2024-12-31' },
    ];
    const result = jsonValue(await probe(JSON.stringify(requests)));
    expect(result).toMatchObject({ valid: true, requests, values: requests });
    expect(jsonValue(jsonObject(result).encoded)).toEqual(requests);
    expect(jsonArray(jsonObject(result).singleWires).map((wire) => jsonValue(wire))).toEqual(
      requests,
    );
    expect(jsonValue(await probe('[]'))).toMatchObject({
      valid: true,
      requests: [],
      encoded: '[]',
    });
  });
  it.each(
    [
      [{}],
      [{ startDay: '2024-01-01' }],
      [{ startDay: null, endDay: '2024-01-01' }],
      [{ startDay: '2023-02-29', endDay: '2024-01-01' }],
      [{ startDay: '2024-01-01', endDay: 42 }],
    ].map((requests) => ({ requests })),
  )('rejects malformed persisted export request batches: %j', async ({ requests }) => {
    expect(jsonValue(await probe(JSON.stringify(requests)))).toEqual({ valid: false });
  });
}
