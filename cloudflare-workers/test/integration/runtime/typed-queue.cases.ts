import {
  jsonArray,
  jsonObject,
  jsonString,
  jsonValue,
} from '../../../../scripts/testing/Support/json.mts';
import { describe, expect, it } from 'vitest';
import { typedQueueProbe } from '../../../../tests/runtime/harness.js';

export function registerTypedQueueBoundaryCases(): void {
  it('keeps the decoder fixture required and rejects non-list input', async () => {
    expect(jsonValue(await typedQueueProbe('schema-contract'))).toEqual({
      outcome: 'ok',
      events: ['required', 'empty-list', 'non-list-rejected'],
    });
  });

  it('makes synchronous decode exception details available to the failure policy', async () => {
    const result = jsonValue(await typedQueueProbe('decode-diagnostic'));
    expect(jsonObject(result).outcome).toBe('ok');
    expect(
      jsonArray(jsonObject(result).events).filter((event) =>
        jsonString(event).startsWith('diagnostic:'),
      ),
    ).toHaveLength(2);
    expect(jsonArray(jsonObject(result).events)[0]).toContain('QueueDecodeException');
    expect(jsonArray(jsonObject(result).events)[0]).toContain('lazy decoded value');
    expect(jsonObject(result).events).not.toContain('unexpected-action');
    expect(
      jsonArray(jsonObject(result).events).filter((event) =>
        jsonString(event).startsWith('retry:'),
      ),
    ).toEqual(['retry:1:Nothing', 'retry:2:Nothing']);
  });

  describe('WASM typed Queue settlement', () => {
    const recovery = ['action:2', 'ack:2'];
    const cases: Array<[string, string[]]> = [
      ['success', ['action:1', 'ack:1', ...recovery]],
      ['malformed', ['failure:decode', 'retry:1:Nothing', ...recovery]],
      [
        'decode-lazy',
        [
          'failure:decode-exception',
          'retry:1:Nothing',
          'failure:decode-exception',
          'retry:2:Nothing',
        ],
      ],
      ['action-throws', ['action:1', 'failure:processing', 'retry:1:Nothing', ...recovery]],
      ['action-lazy', ['action:1', 'failure:processing', 'retry:1:Nothing', ...recovery]],
      ['default-policy', ['retry:1:Nothing', ...recovery]],
      ['policy-ack', ['failure:decode', 'ack:1', ...recovery]],
      ['delayed-retry', ['failure:decode', 'retry:1:Just 7', ...recovery]],
      ...['policy-throws', 'policy-lazy', 'options-lazy', 'delay-lazy', 'seconds-lazy'].map(
        (command): [string, string[]] => [
          command,
          ['failure:decode', 'retry:1:Nothing', ...recovery],
        ],
      ),
    ];
    for (const [command, events] of cases) {
      it(`${command} settles each message once and preserves the next message`, async () => {
        expect(jsonValue(await typedQueueProbe(command))).toEqual({
          outcome: 'ok',
          events,
        });
      });
    }
    for (const [command, outcome, events] of [
      ['action-async', 'ThreadKilled', ['action:1']],
      ['policy-async', 'UserInterrupt', ['failure:decode']],
    ] as const) {
      it(`${command} propagates cancellation without any settlement or next-message action`, async () => {
        expect(jsonValue(await typedQueueProbe(command))).toEqual({
          outcome,
          events,
        });
        expect(jsonValue(await typedQueueProbe('success'))).toEqual({
          outcome: 'ok',
          events: ['action:1', 'ack:1', ...recovery],
        });
      });
    }
    for (const [command, error, events] of [
      ['ack-throws', 'ack failed', ['action:1', 'ack:1']],
      ['retry-throws', 'retry failed', ['failure:decode', 'retry:1:Nothing']],
    ] as const) {
      it(`${command} escapes after one settlement attempt and stops the batch`, async () => {
        const result = jsonValue(await typedQueueProbe(command));
        expect(jsonObject(result).outcome).toContain(error);
        expect(jsonObject(result).events).toEqual(events);
        expect(jsonValue(await typedQueueProbe('success'))).toEqual({
          outcome: 'ok',
          events: ['action:1', 'ack:1', ...recovery],
        });
      });
    }
  });
}
