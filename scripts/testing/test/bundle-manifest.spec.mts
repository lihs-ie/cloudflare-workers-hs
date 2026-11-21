import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeBundle, verifyBundle } from '../build-manifest.mts';
import type { BundleBuildContext } from '../build-manifest.mts';

for (const mutation of [
  'source',
  'javascript',
  'wasm',
  'nested-manifest',
  'missing-wasm',
] as const) {
  void test(`${mutation}: model evidence rejects altered inputs or outputs and keeps the previous proof`, (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'model-proof-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const bundle = path.join(directory, 'bundle');
    mkdirSync(path.join(bundle, 'nested'), { recursive: true });
    writeFileSync(path.join(directory, 'source.hs'), 'source');
    writeFileSync(path.join(bundle, 'harness.js'), 'export default {};');
    writeFileSync(path.join(bundle, 'runtime.wasm'), 'wasm');
    writeFileSync(path.join(bundle, 'nested/build-manifest.json'), '{}');
    let checks = 0;
    const build: BundleBuildContext = {
      verify(): void {
        checks++;
      },
      inputs: () => ({
        'source.hs': createHash('sha256')
          .update(readFileSync(path.join(directory, 'source.hs')))
          .digest('hex'),
      }),
    };
    const inputs = build.inputs();
    writeBundle(bundle, inputs, build);
    verifyBundle(bundle, build);
    const proof = path.join(bundle, 'build-manifest.json');
    const previous = readFileSync(proof, 'utf8');

    if (mutation === 'source') {
      writeFileSync(path.join(directory, 'source.hs'), 'changed');
      assert.throws(() => writeBundle(bundle, inputs, build), /inputs changed/);
    } else if (mutation === 'missing-wasm') {
      rmSync(path.join(bundle, 'runtime.wasm'));
      assert.throws(() => writeBundle(bundle, inputs, build), /missing its JavaScript or WASM/);
    } else {
      const filename = {
        javascript: 'harness.js',
        wasm: 'runtime.wasm',
        'nested-manifest': 'nested/build-manifest.json',
      }[mutation];
      writeFileSync(path.join(bundle, filename), 'changed');
    }

    assert.throws(() => verifyBundle(bundle, build), /Stale or modified model bundle/);
    assert.equal(readFileSync(proof, 'utf8'), previous);
    assert.ok(checks >= 3);
  });
}
