import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sourceHashes, verifyExampleBuild, writeExampleBuild } from '../example-build.mts';
import type { ExampleBuild } from '../example-build.mts';

function fixture(): { build: ExampleBuild; snapshot: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'example-build-'));
  mkdirSync(path.join(directory, 'worker/nested'), { recursive: true });
  writeFileSync(path.join(directory, 'worker/nested/build.json'), '{}');
  writeFileSync(path.join(directory, 'source.hs'), 'source');
  writeFileSync(path.join(directory, 'worker/example.wasm'), 'wasm');
  writeFileSync(path.join(directory, 'worker/example-jsffi.mjs'), 'glue');
  const build = { directory, components: ['example'], inputs: ['source.hs', 'worker'] };
  const snapshot = path.join(directory, 'inputs.json');
  writeFileSync(snapshot, JSON.stringify(sourceHashes(build)));
  return { build, snapshot };
}

for (const mutation of ['source', 'wasm', 'glue', 'missing-artifact', 'invalid-proof']) {
  void test(`build evidence rejects ${mutation} and preserves the last successful proof`, (context) => {
    const { build, snapshot } = fixture();
    context.after(() => rmSync(build.directory, { recursive: true, force: true }));
    writeExampleBuild(build, snapshot);
    verifyExampleBuild(build);
    const proof = path.join(build.directory, 'worker/build.json');
    const saved = readFileSync(proof, 'utf8');

    if (mutation === 'source') {
      writeFileSync(path.join(build.directory, 'source.hs'), 'changed');
      assert.throws(() => verifyExampleBuild(build), /stale/);
      assert.throws(() => writeExampleBuild(build, snapshot), /inputs changed/);
      assert.equal(readFileSync(proof, 'utf8'), saved);
    } else if (mutation === 'invalid-proof') {
      writeFileSync(proof, '{');
      assert.throws(() => verifyExampleBuild(build), SyntaxError);
    } else {
      const artifact = path.join(
        build.directory,
        mutation === 'glue' ? 'worker/example-jsffi.mjs' : 'worker/example.wasm',
      );

      if (mutation === 'missing-artifact') {
        rmSync(artifact);
      } else {
        writeFileSync(artifact, 'changed');
      }
      assert.throws(() => verifyExampleBuild(build), /digest mismatch|ENOENT/);
    }
  });
}

void test('authored JSON with a build filename remains an input outside the generated proof path', (context) => {
  const { build, snapshot } = fixture();
  context.after(() => rmSync(build.directory, { recursive: true, force: true }));
  writeExampleBuild(build, snapshot);
  verifyExampleBuild(build);

  writeFileSync(path.join(build.directory, 'worker/nested/build.json'), '{"changed":true}');

  assert.throws(() => verifyExampleBuild(build), /stale/);
  assert.throws(() => writeExampleBuild(build, snapshot), /inputs changed/);
});
