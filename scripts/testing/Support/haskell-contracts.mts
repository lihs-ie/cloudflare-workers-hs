import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { digest, jsonFile, textFile } from './cli.mts';
import {
  commandProof,
  equals,
  sourceSnapshot,
  successfulProof,
  verifiedFile,
  type Sources,
} from './evidence-io.mts';
import { successfulSummaries } from './hpc.mts';
import { hpcProof } from './proof-inputs.mts';
import { integer, list, object, string, strings } from './validation.mts';
import type { Evidence, Source } from './coverage-scope.mts';

export const compilerRuntimes = ['host', 'wasm'] as const;
export type CompilerRuntime = (typeof compilerRuntimes)[number];
export const privateModules = [
  'Cloudflare.Workers.Internal.Abort',
  'Cloudflare.Workers.Internal.NativeResponse',
  'Cloudflare.Workers.Internal.WorkersAI',
  'Servant.Cloudflare.Workers.Access.Internal.JWKSCache',
];
export const discoveryPragma = '{-# OPTIONS_GHC -F -pgmF sydtest-discover-layer #-}';

export interface Parent {
  path: string;
  data: Record<string, unknown>;
  executable: string;
  cabal: string;
  commands: Record<string, unknown>[];
  searchPath?: string;
}

export function loadParent(
  root: string,
  path: string,
  runtime: CompilerRuntime,
  sources: Sources,
): Parent {
  const authenticated = hpcProof(root, path, sources, runtime);
  if (authenticated.compiler === undefined) {
    throw new Error('Missing parent compiler');
  }

  const data = object(jsonFile(path));
  const details = object(data.compiler);
  return {
    path,
    data,
    executable: authenticated.compiler.path,
    cabal: runtime === 'host' ? 'cabal' : string(details.cabal_path),
    commands: list(data.commands).map(object),
    searchPath: typeof details.search_path === 'string' ? details.search_path : undefined,
  };
}

export function discoveryExecution(parent: Parent, target: string): Record<string, unknown> {
  const listings = parent.commands.filter(({ command }) =>
    equals(strings(command).slice(0, 3), ['cabal', 'list-bin', target]),
  );
  if (listings.length !== 1) {
    throw new Error('Discovery contract has no unique component: ' + target);
  }

  const directory = dirname(parent.path);
  const binary = textFile(verifiedFile(directory, listings[0].log, listings[0].logSha256)).trim();
  const runs = parent.commands.filter(({ command }) => strings(command)[0] === binary);
  if (runs.length !== 1) {
    throw new Error('Discovery contract has no unique execution: ' + target);
  }

  const run = runs[0];
  const log = textFile(verifiedFile(directory, run.log, run.logSha256));
  if (!successfulSummaries(log, 1)) {
    throw new Error('Discovery contract requires nonempty successful execution');
  }

  return {
    target,
    passed: Number(/^\s*Passed:\s+(\d+)/m.exec(log)?.[1]),
    log: run.log,
    logSha256: run.logSha256,
  };
}

export function validateInterfaceDump(source: string, dump: string): boolean {
  const module = /^module\s+([A-Z][\w.]*)/m.exec(textFile(source))?.[1];
  const fingerprint = createHash('md5').update(readFileSync(source)).digest('hex');
  return (
    module !== undefined &&
    new RegExp(`^interface ${RegExp.escape(module)} `, 'm').test(dump) &&
    new RegExp(`^\\s*src hash: ${fingerprint}\\s*$`, 'm').test(dump)
  );
}

function artifact(directory: string, value: unknown): string {
  const result = object(value);
  return verifiedFile(directory, result.path, result.sha256);
}

function compilerCommandProof(
  directory: string,
  parents: Record<CompilerRuntime, Parent>,
  value: unknown,
): Record<string, unknown>[] {
  const commands = commandProof(directory, value);
  for (const record of commands) {
    const runtime = compilerRuntimes.find((item) => item === record.runtime);
    if (runtime === undefined) {
      throw new Error('Unknown Haskell compiler runtime');
    }

    const parent = parents[runtime];
    const argv = strings(record.command);
    if (argv[0] !== parent.executable && !equals(argv.slice(0, 2), [parent.cabal, 'exec'])) {
      throw new Error('Unbound Haskell contract compiler');
    }

    if (record.input !== undefined) {
      artifact(directory, record.input);
    }

    if ((integer(record.processExitCode) === 0) !== record.expectedSuccess) {
      throw new Error('Haskell consumer result differs from expectation');
    }

    if (record.expectedSuccess === false) {
      const log = textFile(verifiedFile(directory, record.log, record.logSha256)).toLowerCase();
      if (
        !log.includes(string(record.expectedDiagnostic).toLowerCase()) ||
        !/hidden module|not exposed|not in scope/.test(log)
      ) {
        throw new Error('Haskell negative probe failed for an unrelated reason');
      }
    }
  }

  for (const runtime of compilerRuntimes) {
    const roles = [
      ['public', true],
      ...['router-constructor', ...privateModules].map((name) => [name, false]),
    ];
    for (const [name, expected] of roles) {
      if (
        !commands.some(
          (entry) =>
            entry.runtime === runtime && entry.probe === name && entry.expectedSuccess === expected,
        )
      ) {
        throw new Error('Missing Haskell compiler control: ' + name);
      }
    }
  }

  return commands;
}

function checkInterfaces(
  directory: string,
  parents: Record<CompilerRuntime, Parent>,
  commands: Record<string, unknown>[],
  source: string,
  review: Record<string, unknown>,
  value: unknown,
): void {
  const entries = Object.entries(object(value));
  if (!equals(entries.map(([name]) => name).sort(), strings(review.compiler_runtimes).sort())) {
    throw new Error('Haskell interface compiler lanes differ from review');
  }

  for (const [name, entry] of entries) {
    const runtime = compilerRuntimes.find((item) => item === name);
    if (runtime === undefined) {
      throw new Error('Unapproved Haskell compiler runtime');
    }

    const records = object(entry);
    const iface = artifact(directory, records.interface);
    const dump = artifact(directory, records.dump);
    if (!validateInterfaceDump(source, textFile(dump))) {
      throw new Error('Compiler interface does not match the reviewed source bytes');
    }

    if (
      !commands.some(
        (item) =>
          equals(item.command, [parents[runtime].executable, '--show-iface', iface]) &&
          item.log === object(records.dump).path,
      )
    ) {
      throw new Error('Missing recorded compiler interface dump');
    }
  }
}

export function haskellContractEvidence(
  root: string,
  sources: Source[],
  path?: string,
): Record<string, Evidence & Record<string, unknown>> {
  if (path === undefined) {
    return {};
  }

  const proof = object(jsonFile(path));
  const snapshot = sourceSnapshot(root);
  successfulProof(proof, snapshot);
  const provenance = object(proof.parents);
  const parents = {
    host: loadParent(root, artifact(root, provenance.host), 'host', snapshot),
    wasm: loadParent(root, artifact(root, provenance.wasm), 'wasm', snapshot),
  };
  const directory = dirname(path);
  const commands = compilerCommandProof(directory, parents, proof.commands);
  const known = new Map(sources.map((source) => [source.path, source]));
  const validated: Record<string, Evidence & Record<string, unknown>> = {};
  for (const entry of list(proof.validated).map(object)) {
    const name = string(entry.path);
    const review = known.get(name)?.validation_basis;
    if (review === undefined || entry.kind !== review.kind || Object.hasOwn(validated, name)) {
      throw new Error('Unapproved or duplicate Haskell compiler contract');
    }

    const source = verifiedFile(root, name, review.source_sha256);

    if (entry.kind === 'haskell-test-entry') {
      if (
        textFile(source).trim() !== discoveryPragma ||
        !equals(entry.execution, discoveryExecution(parents.host, string(review.target)))
      ) {
        throw new Error('Discovery proof does not match its source or component execution');
      }
    } else if (entry.kind === 'haskell-interface') {
      checkInterfaces(directory, parents, commands, source, review, entry.interfaces);
    } else {
      throw new Error('Unapproved Haskell compiler contract kind');
    }

    validated[name] = {
      status: 'validated',
      complete: true,
      kind: entry.kind,
      source_sha256: digest(source),
      proof_sha256: digest(path),
      execution: entry.execution,
      note: 'Compiler/API or real discovery evidence; no runtime coverage percentage.',
    };
  }

  return validated;
}
