import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { command, repositoryRoot, withTemp } from '../Support/cli.mts';

for (const [name, parameter] of [
  ['registration', '--layer'],
  ['test-boundaries', '--root'],
  ['internal-module-boundaries', 'manifest|consumer'],
  ['hlint-multiline-javascript-ffi', '< HASKELL_FILE'],
  ['dependency-audit', '--base-sha'],
  ['run', '--report-only'],
  ['coverage', '--output'],
  ['compile-validation', '--output'],
  ['haskell-validation', '--host-proof'],
  ['wasm-coverage', '--all-examples'],
  ['workerd-js-coverage', '--example'],
  ['shared-node-coverage', '--workerd'],
  ['example-node-coverage', '--tools-only'],
  ['mutations', '--mutation'],
  ['native-tools-coverage', '--output'],
  ['shell-coverage', '--image'],
  ['api-example-inventory', '--output'],
  ['public-api-operation-inventory', '--output'],
  ['api-execution-evidence', '--inventory'],
  ['remote-r2', 'plan|execute|cleanup'],
]) {
  void test(`${name} prints help without starting external commands or creating files`, () => {
    withTemp('testing-help-', (cwd) => {
      const tool = join(repositoryRoot, 'scripts/testing', name + '.mts');

      const result = command([process.execPath, tool, '--help'], {
        cwd,
        env: { ...process.env, PATH: '' },
        timeout: 5000,
      });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^Usage: node scripts\/testing\//);
      assert.ok(result.stdout.includes(parameter));
      assert.deepEqual(readdirSync(cwd), []);
    });
  });
}
