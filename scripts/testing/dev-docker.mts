import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  command,
  repositoryRoot,
  runCli,
  textFile,
  withTemp,
  writeJson,
  type CommandRunner,
} from './Support/cli.mts';

export function runDockerTests(
  root: string,
  parameters: readonly string[],
  run: CommandRunner = command,
): number {
  function required(argv: readonly string[]): string {
    const result = run(argv, { cwd: root });
    if (result.code !== 0) {
      throw new Error(`${argv.join(' ')} failed (exit ${result.code})\n${result.stderr}`);
    }

    return result.stdout.trim();
  }

  required(['docker', 'info']);
  return withTemp('workers-docker-', (directory) => {
    const imageFile = join(directory, 'image');
    required(['docker', 'build', '--iidfile', imageFile, '-f', 'docker/dev-tests.Dockerfile', '.']);
    const image = textFile(imageFile).trim();
    const container = required(['docker', 'create', image, ...parameters]);
    try {
      const result = run(['docker', 'start', '--attach', container], { stdio: 'inherit' });
      const directory = join(root, 'artifacts/testing/docker');
      mkdirSync(directory, { recursive: true });
      const copied = run(['docker', 'cp', `${container}:/work/artifacts/testing/.`, directory], {
        stdio: 'inherit',
      });
      const exitCode = result.code || copied.code;
      const stamp = new Date().toISOString().replace(/[-:.]/g, '');
      writeJson(join(directory, `run-${stamp}.json`), {
        image,
        container,
        command: ['node', 'scripts/testing/docker-suites.mts'],
        exitCode,
        artifactCopyExitCode: copied.code,
      });
      return exitCode;
    } finally {
      required(['docker', 'rm', '--force', container]);
    }
  });
}

runCli(import.meta.url, () => runDockerTests(repositoryRoot, process.argv.slice(2)));
