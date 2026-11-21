import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capture, repositoryRoot, runCli, withTemp, writeJson } from './Support/cli.mts';

const runtimePackage = '@cloudflare-workers-hs/runtime';
const runtimePath = '/packages/runtime';

runCli(import.meta.url, '', () => {
  const revision = capture(['git', '-C', repositoryRoot, 'rev-parse', 'HEAD']).trim();
  const dependency = `git+${pathToFileURL(repositoryRoot)}#${revision}&path:${runtimePath}`;

  return withTemp('cloudflare-workers-hs-consumer-', (consumer) => {
    writeJson(join(consumer, 'package.json'), {
      name: 'runtime-distribution-smoke',
      private: true,
      type: 'module',
      dependencies: { [runtimePackage]: dependency },
    });
    writeFileSync(
      join(consumer, 'pnpm-workspace.yaml'),
      `allowBuilds:\n  ${JSON.stringify(`${runtimePackage}@${dependency}`)}: true\n`,
    );
    const smoke = join(consumer, 'consumer.mts');
    copyFileSync(new URL('./git-runtime-consumer.mts', import.meta.url), smoke);

    capture(['pnpm', 'install', '--no-frozen-lockfile'], { cwd: consumer });
    console.log(capture([process.execPath, smoke], { cwd: consumer }).trim());

    return 0;
  });
});
