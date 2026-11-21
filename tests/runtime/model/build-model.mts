import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync } from 'node:fs';
import { buildInputs, verifyBuild, writeBundle } from '../../../scripts/testing/build-manifest.mts';

const runtimeDirectory = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../test-artifacts/runtime-bundle/', import.meta.url));
verifyBuild('library-runtime');
const inputs = buildInputs('library-runtime');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const result = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'deploy', '--dry-run', '--config', 'wrangler.jsonc', '--outdir', output],
  { cwd: runtimeDirectory, stdio: 'inherit' },
);

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  throw new Error(`Model bundling failed (${result.status ?? result.signal})`);
}

writeBundle(output, inputs);
