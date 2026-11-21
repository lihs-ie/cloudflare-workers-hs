import { jsonObject, jsonValue } from '../../../../scripts/testing/Support/json.mts';
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { bindingEnvProbe } from '../../../../tests/runtime/harness.js';

const required = {
  REQUIRED_VAR: 'configuration',
  REQUIRED_SECRET: 'private-value',
};
const configuration = async (env: unknown): Promise<unknown> =>
  jsonValue(await bindingEnvProbe(env, 'configuration'));

export function registerBindingEnvCases(): void {
  it('reports invalid consumer output and rejected RPC without poisoning typed bindings', async () => {
    const healthy = {
      KV: {
        async get(): Promise<string> {
          return 'restored';
        },
      },
      SERVICE: {
        async decorate(value: string): Promise<string> {
          return `service:${value}`;
        },
      },
    };
    for (const [bindings, diagnostic] of [
      [
        {
          ...healthy,
          KV: {
            async get(): Promise<null> {
              return null;
            },
          },
        },
        'Expected text configuration value',
      ],
      [
        {
          ...healthy,
          SERVICE: {
            async decorate(): Promise<never> {
              throw new Error('service-consumer-failed');
            },
          },
        },
        'service-consumer-failed',
      ],
    ] as const) {
      const rejected = jsonValue(await bindingEnvProbe(bindings, 'native-consumer'));
      expect(jsonObject(rejected).ok).toBe(false);
      expect(jsonObject(rejected).message).toContain(diagnostic);
      expect(jsonValue(await bindingEnvProbe(healthy, 'native-consumer'))).toEqual({
        ok: true,
        value: { configuration: 'restored', decorated: 'service:restored' },
      });
    }
  });
  it('reports typed namespace RPC failure and recovers through the same accessor', async () => {
    const rejected = jsonValue(
      await bindingEnvProbe(
        {
          ROOMS: {
            getByName(): { operation(): Promise<never> } {
              return {
                async operation(): Promise<never> {
                  throw new Error('namespace-consumer-failed');
                },
              };
            },
          },
        },
        'namespace-rpc',
      ),
    );
    expect(jsonObject(rejected).ok).toBe(false);
    expect(jsonObject(rejected).message).toContain('namespace-consumer-failed');
    expect(
      jsonValue(
        await bindingEnvProbe(
          {
            ROOMS: {
              getByName(): { operation(): Promise<number[]> } {
                return {
                  async operation(): Promise<number[]> {
                    return [1, 2, 3];
                  },
                };
              },
            },
          },
          'namespace-rpc',
        ),
      ),
    ).toEqual({ ok: true, value: { persisted: '[1,2,3]' } });
  });
  it('rejects unknown environment commands and accepts a following valid command', async () => {
    const rejected = jsonValue(await bindingEnvProbe({}, 'unknown-command'));
    expect(jsonObject(rejected).ok).toBe(false);
    expect(jsonObject(rejected).message).toContain('Unknown binding environment scenario');
    expect(jsonValue(await bindingEnvProbe({}, 'empty'))).toEqual({
      ok: true,
      value: { bindings: 0, namespaces: 0 },
    });
  });
  it('handles a missing binding by its exact exception type and recovers after configuration is supplied', async () => {
    expect(jsonValue(await bindingEnvProbe({}, 'typed-missing'))).toEqual({
      ok: true,
      value: { missing: 'REQUIRED_VAR', recoverable: true },
    });
    // A malformed present value is a different failure and must not be mistaken
    // for missing configuration by the typed catch.
    const malformed = jsonValue(await bindingEnvProbe({ REQUIRED_VAR: 7 }, 'typed-missing'));
    expect(jsonObject(malformed).ok).toBe(false);
    expect(jsonObject(malformed).message).toContain('Expected a string configuration binding');
    expect(jsonValue(await bindingEnvProbe({ REQUIRED_VAR: 'restored' }, 'typed-missing'))).toEqual(
      {
        ok: true,
        value: { value: 'restored' },
      },
    );
  });
  it('uses converted KV and service bindings through typed consumers', async () => {
    const calls: string[] = [];
    const bindings = {
      KV: {
        value: 'configured-value',
        async get(key: string, options: { type: string }): Promise<string> {
          calls.push(`get:${key}:${options.type}`);
          return this.value;
        },
      },
      SERVICE: {
        prefix: 'service:',
        async decorate(value: string): Promise<string> {
          calls.push(`decorate:${value}`);
          return this.prefix + value;
        },
      },
    };
    expect(jsonValue(await bindingEnvProbe(bindings, 'native-consumer'))).toEqual({
      ok: true,
      value: { configuration: 'configured-value', decorated: 'service:configured-value' },
    });
    expect(calls).toEqual(['get:configuration-key:text', 'decorate:configured-value']);
  });
  it('reports manually constructed missing and wrong Dynamic bindings without poisoning later calls', async () => {
    for (const [mode, message] of [
      ['missing-map', 'no binding registered'],
      ['wrong-type', 'unexpected runtime type'],
      ['missing-namespace', 'no dos binding registered'],
    ] as const) {
      const result = jsonValue(await bindingEnvProbe({}, mode));
      expect(jsonObject(result).ok).toBe(false);
      expect(jsonObject(result).message).toContain(message);
      expect(jsonObject(await configuration(required)).ok).toBe(true);
    }
  });
  it('uses the typed namespace accessor to call a real Durable Object with persisted bytes', async () => {
    const stub = env.STORAGE.getByName('env-proof');
    await stub.operation('put', 'env-proof-key', [0, 128, 255]);
    try {
      const result = jsonValue(await bindingEnvProbe({ ROOMS: env.STORAGE }, 'namespace-rpc'));
      expect(jsonObject(result).ok).toBe(true);
      expect(jsonValue(jsonObject(jsonObject(result).value).persisted)).toEqual([0, 128, 255]);
    } finally {
      await stub.operation('delete', 'env-proof-key', []);
    }
  });
  const bindingNames = [
    'ASSETS',
    'DB',
    'ROOMS',
    'STORAGE',
    'KV',
    'QUEUE',
    'BUCKET',
    'SERVICE',
    'WORKFLOW',
  ];
  it('requires every declared native binding and recovers with a complete configuration', async () => {
    const complete = Object.fromEntries(bindingNames.map((name) => [name, {}]));
    for (const name of bindingNames) {
      const incomplete = { ...complete };
      delete incomplete[name];
      const rejected = jsonValue(await bindingEnvProbe(incomplete, 'native'));
      expect(jsonObject(rejected).ok).toBe(false);
      expect(jsonObject(rejected).message).toContain(name);
      expect(jsonValue(await bindingEnvProbe(complete, 'native'))).toEqual({
        ok: true,
        value: { names: [...bindingNames].sort() },
      });
    }
  });
  describe('Typed environment boundaries through WASM', () => {
    it('preserves empty required values and distinguishes absent optional values', async () => {
      expect(await configuration({ REQUIRED_VAR: '', REQUIRED_SECRET: '' })).toEqual({
        ok: true,
        value: {
          requiredVar: '',
          requiredSecretLength: 0,
          optionalVar: null,
          optionalSecretLength: null,
        },
      });
      expect(
        await configuration({
          ...required,
          OPTIONAL_VAR: '',
          OPTIONAL_SECRET: '',
        }),
      ).toEqual({
        ok: true,
        value: {
          requiredVar: 'configuration',
          requiredSecretLength: 13,
          optionalVar: '',
          optionalSecretLength: 0,
        },
      });
      const present = await configuration({
        ...required,
        OPTIONAL_VAR: 'optional',
        OPTIONAL_SECRET: 'hidden',
      });
      expect(jsonObject(jsonObject(present).value).optionalVar).toBe('optional');
      expect(jsonObject(jsonObject(present).value).optionalSecretLength).toBe(6);
    });
    for (const value of [null, undefined]) {
      it(`accepts optional ${String(value)} without coercing it`, async () => {
        const result = await configuration({
          ...required,
          OPTIONAL_VAR: value,
          OPTIONAL_SECRET: value,
        });
        expect(jsonObject(result).ok).toBe(true);
        expect(jsonObject(jsonObject(result).value).optionalVar).toBeNull();
        expect(jsonObject(jsonObject(result).value).optionalSecretLength).toBeNull();
      });
    }
    for (const name of ['REQUIRED_VAR', 'REQUIRED_SECRET'] as const) {
      it(`reports missing ${name} and recovers`, async () => {
        const env: Partial<typeof required> = { ...required };
        delete env[name];
        const result = await configuration(env);
        expect(jsonObject(result).ok).toBe(false);
        expect(jsonObject(result).message).toContain(name);
        expect(jsonObject(await configuration(required)).ok).toBe(true);
      });
    }
    for (const name of ['REQUIRED_VAR', 'REQUIRED_SECRET', 'OPTIONAL_VAR', 'OPTIONAL_SECRET']) {
      it(`rejects non-string ${name} without disclosing configuration`, async () => {
        const invalid: unknown[] = [
          1,
          false,
          [],
          { secret: 'do-not-disclose' },
          new String('do-not-disclose'),
        ];

        if (name.startsWith('REQUIRED')) {
          invalid.push(null, undefined);
        }

        for (const value of invalid) {
          const result = await configuration({ ...required, [name]: value });
          expect(jsonObject(result).ok).toBe(false);
          expect(jsonObject(result).message).toContain('Expected a string configuration binding');
          expect(jsonObject(result).message).not.toContain('do-not-disclose');
          expect(jsonObject(result).message).not.toContain(required.REQUIRED_SECRET);
        }
        expect(jsonObject(await configuration(required)).ok).toBe(true);
      });
    }
    it('uses only enumerable own properties and evaluates getters once', async () => {
      expect(jsonObject(await configuration(Object.create(required))).ok).toBe(false);
      let reads = 0;
      const env = {
        ...required,
        get OPTIONAL_VAR(): string {
          reads += 1;
          return 'once';
        },
      };
      Object.defineProperty(env, 'OPTIONAL_SECRET', {
        value: 'not-enumerated',
        enumerable: false,
      });
      const result = await configuration(env);
      expect(jsonObject(jsonObject(result).value).optionalVar).toBe('once');
      expect(jsonObject(jsonObject(result).value).optionalSecretLength).toBeNull();
      expect(reads).toBe(1);
    });
    it('keeps invalid environments and throwing property traps inside the reactor boundary', async () => {
      const unprintable = {
        toString(): never {
          throw new Error('do-not-disclose');
        },
      };
      const broken = [
        null,
        undefined,
        {
          get REQUIRED_SECRET(): void {
            throw unprintable;
          },
        },
        new Proxy(
          {},
          {
            ownKeys(): never {
              throw unprintable;
            },
          },
        ),
      ];
      for (const value of broken) {
        const result = await configuration(value);
        expect(jsonObject(result).ok).toBe(false);
        expect(jsonObject(result).message).toContain('Could not read Worker environment');
        expect(jsonObject(result).message).not.toContain('do-not-disclose');
        expect(jsonObject(await configuration(required)).ok).toBe(true);
      }
    });
    it('builds an empty binding set and checks required DO namespaces', async () => {
      expect(jsonValue(await bindingEnvProbe({}, 'empty'))).toEqual({
        ok: true,
        value: { bindings: 0, namespaces: 0 },
      });
      const missing = jsonValue(await bindingEnvProbe({}, 'namespace'));
      expect(jsonObject(missing).ok).toBe(false);
      expect(jsonObject(missing).message).toContain('ROOMS');
      expect(jsonValue(await bindingEnvProbe({ ROOMS: {} }, 'namespace'))).toEqual({
        ok: true,
        value: { names: ['ROOMS'] },
      });
    });
  });
}
