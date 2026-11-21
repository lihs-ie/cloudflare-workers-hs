import { buildInputs as targetInputs } from '../../../../../scripts/testing/build-manifest.mts';
import type { BuildTarget, InputHashes } from '../../../../../scripts/testing/build-manifest.mts';

export {
  verifyBuild,
  writeBuild,
  captureBuildInputs,
} from '../../../../../scripts/testing/build-manifest.mts';

export function buildInputs(target: BuildTarget = 'runtime-tests'): InputHashes {
  return targetInputs(target);
}
