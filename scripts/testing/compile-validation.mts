import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { absolutePath, jsonFile, repositoryRoot, runCli } from './Support/cli.mts';
import { compilerConfigDependencies } from './Support/compile-evidence.mts';
import {
  equals,
  evidencePath,
  loggedCommand,
  publish,
  sourceSnapshot,
} from './Support/evidence-io.mts';
import { manifestEntries } from './Support/coverage-scope.mts';
import { object, string } from './Support/validation.mts';

const root = repositoryRoot;

export function validationProject(entry: Record<string, unknown>): [string, string] {
  if (entry.compiler_project !== undefined && entry.compiler_project !== 'examples/url-shortener') {
    throw new Error('Unapproved explicit compiler project');
  }

  const path = string(entry.path);
  const [top, name] = path.split('/');

  if (entry.compiler_project === 'examples/url-shortener') {
    return [entry.compiler_project, 'tsconfig.json'];
  }

  if (
    (top === 'examples' && path.split('/').length >= 3) ||
    (top === 'tests' && name === 'runtime')
  ) {
    return [`${top}/${name}`, 'tsconfig.json'];
  }

  if (top === 'packages' && name === 'worker-runtime') {
    return ['packages/worker-runtime', 'tsconfig.check.json'];
  }

  throw new Error('No approved compiler project for ' + path);
}

interface CompileCommand {
  argv: string[];
  cwd: string;
  exitCode: number;
  inputs: string[];
  log: string;
  logSha256: string;
}

function collect(output: string): number {
  const sources = sourceSnapshot(root);
  const validations = [
    ...manifestEntries(
      object(jsonFile(join(root, 'scripts/testing/runtime-scope.json'))),
      'validations',
    ),
  ]
    .map(([, entry]) => entry)
    .filter(({ kind }) => kind === 'declaration' || kind === 'type-contract');
  const proof = {
    schema: 1,
    sources,
    commands: [] as CompileCommand[],
    validated: [] as { path: string; kind: unknown; commandIndex: number }[],
    errors: [] as string[],
    exit_code: 1,
  };
  const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };

  function execute(argv: string[], cwd: string, compiler: boolean = false): CompileCommand {
    const log = String(proof.commands.length).padStart(2, '0') + '.log';
    const result = loggedCommand(output, log, argv, { cwd, env, timeout: 180_000 });
    const inputs = compiler
      ? result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(isAbsolute)
          .map((path) => relative(root, absolutePath(resolve(path))))
          .filter((path) => Object.hasOwn(sources, path))
      : [];
    const command = {
      argv,
      cwd: relative(root, cwd),
      exitCode: result.code,
      inputs: [...new Set(inputs)].sort(),
      log,
      logSha256: result.logSha256,
    };
    proof.commands.push(command);

    if (result.code !== 0 || (compiler && inputs.length === 0)) {
      throw new Error('Compiler/type-generation validation failed: ' + argv.join(' '));
    }

    return command;
  }

  try {
    if (validations.length === 0) {
      throw new Error('No reviewed compile validations');
    }

    const projects = new Map(validations.map(validationProject));
    const names = [...projects.keys()]
      .filter((name) => name.startsWith('examples/'))
      .map((name) => name.split('/')[1]);
    if (names.length > 0) {
      execute(['node', 'scripts/testing/typecheck.mts', '--check', ...names], root);
    }

    for (const [project, config] of projects) {
      const binary =
        project === 'packages/worker-runtime'
          ? join(root, project, 'node_modules/.bin/tsc')
          : join(root, 'node_modules/.bin/tsc');
      const index = proof.commands.length;
      const command = execute(
        [binary, '--project', config, '--noEmit', '--listFiles'],
        join(root, project),
        true,
      );
      if (
        [...compilerConfigDependencies(root, { ...command })].some(
          (path) => !Object.hasOwn(sources, path),
        )
      ) {
        throw new Error('Compiler configuration missing from source snapshot');
      }

      for (const entry of validations.filter((item) => validationProject(item)[0] === project)) {
        const path = string(entry.path);
        if (!command.inputs.includes(path)) {
          throw new Error('Reviewed contract is not a compiler input: ' + path);
        }

        proof.validated.push({ path, kind: entry.kind, commandIndex: index });
      }
    }

    if (proof.validated.length !== validations.length || !equals(sources, sourceSnapshot(root))) {
      throw new Error('Validation contracts or sources changed during compiler run');
    }

    proof.exit_code = 0;
  } catch (error) {
    proof.errors.push(error instanceof Error ? error.message : String(error));
  }

  publish(root, output, 'compile-validation', proof);
  console.log('Compile validation: ' + output);
  return proof.exit_code;
}

runCli(import.meta.url, '[--output DIR]', () => {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  return collect(evidencePath(root, 'compile-validation', values.output));
});
