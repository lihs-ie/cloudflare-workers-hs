import { readdirSync } from 'node:fs';
import {
  exampleBuild,
  manifestCLI,
  verifyExampleBuild,
  sourceHashes as hashes,
} from '../../../../scripts/testing/example-build.mts';

const build = exampleBuild(import.meta.url, 'workflow-example', [
  'workflow-example',
  'workflow-example-fixture',
]);
build.inputs.push(
  ...readdirSync(build.directory).filter((name) => /^wrangler.*\.jsonc$/.test(name)),
);

if (readdirSync(build.directory).includes('migrations')) {
  build.inputs.push('migrations');
}

export function verifyBuild(): void {
  verifyExampleBuild(build);
}

export function sourceHashes(): Record<string, string> {
  return hashes(build);
}

manifestCLI(import.meta.url, build);
