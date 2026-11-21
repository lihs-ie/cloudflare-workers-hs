import { dirname, extname, join, relative, resolve, isAbsolute } from 'node:path';
import { digest, isFile, jsonFile, textFile } from './cli.mts';
import { childPath, equals, verifiedFile } from './evidence-io.mts';
import { list, nonnegative, object, string, strings, stringsByName } from './validation.mts';
import type { Evidence, Source } from './coverage-scope.mts';

type RecordEvidence = Evidence & Record<string, unknown>;

export function compilerConfigDependencies(
  root: string,
  command: Record<string, unknown>,
): Set<string> {
  const argv = strings(command.argv);
  const projects = argv.flatMap((arg, index) => {
    if (arg === '--project' || arg === '-p') {
      return [string(argv[index + 1])];
    }

    return arg.startsWith('--project=') ? [arg.slice('--project='.length)] : [];
  });
  if (projects.length !== 1) {
    throw new Error('Compile proof requires one explicit project and working directory');
  }

  const pending = new Set<string>();
  const dependencies = new Set<string>();
  function visit(path: string): void {
    const safePath = childPath(root, path);
    const name = relative(root, safePath);
    if (pending.has(name)) {
      throw new Error('Compiler extends cycle');
    }

    if (dependencies.has(name)) {
      return;
    }

    pending.add(name);
    const config = object(jsonFile(safePath));
    const parents =
      typeof config.extends === 'string' ? [config.extends] : strings(config.extends ?? []);
    for (const parent of parents) {
      if (!parent.startsWith('.')) {
        throw new Error('Unresolved compiler extends dependency');
      }

      visit(resolve(dirname(safePath), extname(parent) ? parent : parent + '.json'));
    }

    pending.delete(name);
    dependencies.add(name);
  }

  visit(resolve(root, string(command.cwd), projects[0]));
  return dependencies;
}

function checkedInputs(
  root: string,
  sources: Source[],
  proof: Record<string, unknown>,
  required: readonly string[],
): Record<string, string> {
  const fingerprints = stringsByName(proof.sources);
  for (const [name, sha256] of Object.entries(fingerprints)) {
    verifiedFile(root, name, sha256);
  }

  for (const name of [...sources.map((source) => source.path), ...required]) {
    if (!Object.hasOwn(fingerprints, name)) {
      throw new Error('Compile proof omits source or configuration: ' + name);
    }
  }

  const scope = 'scripts/testing/runtime-scope.json';
  if (isFile(join(root, scope)) && !Object.hasOwn(fingerprints, scope)) {
    throw new Error('Compile proof omits scope configuration');
  }

  return fingerprints;
}

function compilerCommands(proof: Record<string, unknown>): Record<string, unknown>[] {
  const commands = list(proof.commands).map(object);
  if (
    (proof.exit_code ?? 0) !== 0 ||
    !equals(proof.errors ?? [], []) ||
    commands.length === 0 ||
    commands.some(({ exitCode }) => exitCode !== 0)
  ) {
    throw new Error('Compile proof records a failed validation');
  }

  return commands;
}

export function compileEvidence(
  root: string,
  sources: Source[],
  path?: string,
  scopePath?: string,
): Record<string, RecordEvidence> {
  if (path === undefined) {
    return {};
  }

  const proof = object(jsonFile(path));
  const commands = compilerCommands(proof);
  if (commands.some(({ argv }) => strings(argv).length === 0 || strings(argv).includes(''))) {
    throw new Error('Invalid compiler command arguments');
  }

  const required = scopePath && isFile(scopePath) ? [relative(root, scopePath)] : [];
  const fingerprints = checkedInputs(root, sources, proof, required);
  const locations = new Map(sources.map((source) => [source.path, source]));
  const validations: Record<string, RecordEvidence> = {};
  for (const record of list(proof.validated).map(object)) {
    const name = string(record.path);
    const source = locations.get(name);
    if (
      source?.validation_basis === undefined ||
      source.validation_basis.kind !== record.kind ||
      !source.required_runtimes.includes('compile') ||
      Object.hasOwn(validations, name)
    ) {
      throw new Error('Unapproved or duplicate compile validation: ' + name);
    }

    const command = commands[nonnegative(record.commandIndex)];
    if (command === undefined) {
      throw new Error('Invalid compile command reference: ' + name);
    }

    const dependencies = compilerConfigDependencies(root, command);
    dependencies.add(string(source.validation_basis.evidence));
    const inputs = strings(command.inputs);
    if (
      !inputs.includes(name) ||
      [...dependencies, ...inputs].some((item) => !Object.hasOwn(fingerprints, item))
    ) {
      throw new Error(
        'Compile validation is not a recorded compiler input or omits configuration: ' + name,
      );
    }

    validations[name] = {
      status: 'validated',
      complete: true,
      kind: record.kind,
      command,
      source_sha256: fingerprints[name],
      proof_sha256: digest(path),
      note: 'Compile validation only; no runtime coverage percentage.',
    };
  }

  return validations;
}

export function nativeCompileEvidence(
  root: string,
  sources: Source[],
  path?: string,
): Record<string, RecordEvidence> {
  if (path === undefined) {
    return {};
  }

  const proof = object(jsonFile(path));
  const commands = compilerCommands(proof);
  const fingerprints = checkedInputs(root, sources, proof, [
    'cabal.project',
    'cloudflare-workers/cloudflare-workers.cabal',
  ]);
  const validations: Record<string, RecordEvidence> = {};
  for (const record of list(proof.compileValidations ?? []).map(object)) {
    const name = string(record.path);
    const source = sources.find((item) => item.path === name);
    if (
      name !== 'cloudflare-workers/shim/compat/GHC/Wasm/Prim.hs' ||
      source?.validation_basis?.kind !== 'haskell-reexport' ||
      record.kind !== 'haskell-reexport' ||
      Object.hasOwn(validations, name)
    ) {
      throw new Error('Unapproved native compile contract');
    }

    const sourceBody = textFile(join(root, name)).trim().replace(/\s+/g, ' ');
    if (
      sourceBody !== 'module GHC.Wasm.Prim (JSVal) where import GHC.Wasm.Prim.Host.Internal (JSVal)'
    ) {
      throw new Error('Reviewed re-export gained source declarations');
    }

    function artifact(value: unknown): string {
      const entry = object(value);
      return verifiedFile(dirname(path ?? ''), entry.path, entry.sha256);
    }

    const iface = artifact(record.interface);
    const dump = textFile(artifact(record.dump));
    const probe = textFile(artifact(record.probe)).trim();
    const compiler = object(record.compiler);
    const executable = string(compiler.path);
    if (
      !isAbsolute(executable) ||
      digest(executable) !== compiler.sha256 ||
      !string(compiler.version)
    ) {
      throw new Error('Native compiler executable changed');
    }

    const declarations = [...dump.matchAll(/^  ([\w$]+) ::/gm)].map((match) => match[1]);
    if (
      !/^interface GHC\.Wasm\.Prim /m.test(dump) ||
      !dump.includes('GHC.Wasm.Prim.Host.Internal.JSVal') ||
      declarations.length === 0 ||
      declarations.some((item) => !/^\$trModule\d*$/.test(item))
    ) {
      throw new Error('Interface does not prove metadata-only local declarations');
    }

    if (
      probe !== 'plugin probe passed' ||
      !commands.some(({ command }) => equals(command, ['ghc', '--show-iface', iface]))
    ) {
      throw new Error('Native interface/compiler behavior command is missing');
    }

    validations[name] = {
      status: 'validated',
      complete: true,
      kind: 'haskell-reexport',
      local_executable_declarations: 0,
      compiler_metadata_declarations: declarations,
      source_sha256: fingerprints[name],
      proof_sha256: digest(path),
      note: 'Fresh compiler/type-interface validation; no runtime coverage percentage.',
    };
  }

  return validations;
}
