import { jsonValue } from '../../../scripts/testing/Support/json.mts';
import { resolve, dirname, basename } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from '../../../scripts/testing/build-manifest.mts';
import { Miniflare, Log, LogLevel } from 'miniflare';
import type { MiniflareOptions, WorkerdStructuredLog } from 'miniflare';

// A fresh runtime per invocation also resets state for every shrink candidate.
const bundle = process.env.RUNTIME_MODEL_BUNDLE
  ? resolve(process.env.RUNTIME_MODEL_BUNDLE)
  : fileURLToPath(new URL('../test-artifacts/runtime-bundle/harness.js', import.meta.url));
verifyBundle(dirname(bundle));
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const input = Buffer.concat(chunks).toString('utf8');
jsonValue(input);
const timeout = setTimeout(() => {
  process.stderr.write('Storage model runtime exceeded 60 seconds\n');
  process.exit(1);
}, 60_000);
try {
  const modules: Record<
    string,
    { type: 'esm' | 'wasm'; contents: string | Uint8Array<ArrayBuffer> }
  > = {};
  for (const filename of readdirSync(dirname(bundle))) {
    if (filename === basename(bundle)) {
      modules[filename] = { type: 'esm', contents: readFileSync(bundle, 'utf8') };
    } else if (filename.endsWith('.wasm')) {
      modules[filename] = {
        type: 'wasm',
        contents: readFileSync(resolve(dirname(bundle), filename)),
      };
    }
  }
  const options: MiniflareOptions = {
    log: new Log(LogLevel.NONE),
    handleStructuredLogs(log: WorkerdStructuredLog): void {
      process.stderr.write(log.message + '\n');
    },
    workers: [
      {
        config: {
          name: 'storage-model',
          compatibilityDate: '2026-07-01',
          compatibilityFlags: ['nodejs_compat'],
          manifest: { mainModule: basename(bundle), modulesRoot: dirname(bundle), modules },
          env: {
            STORAGE: {
              type: 'durable-object',
              worker: 'storage-model',
              exportName: 'StorageHarness',
            },
          },
          exports: { StorageHarness: { type: 'durable-object', storage: 'sqlite' } },
        },
      },
    ],
  };
  const runtime = new Miniflare(options);
  try {
    const response = await runtime.dispatchFetch('https://model.test/__model/storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: input,
    });

    if (!response.ok) {
      throw new Error(`Model harness returned ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    process.stdout.write(JSON.stringify(result));
  } finally {
    await runtime.dispose();
  }
} finally {
  clearTimeout(timeout);
}
