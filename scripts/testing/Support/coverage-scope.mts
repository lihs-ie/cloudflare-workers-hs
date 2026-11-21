import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { absolutePath, digest, isFile, jsonFile, textFile, within } from './cli.mts';
import { childPath, equals, trackedFiles, verifiedFile } from './evidence-io.mts';
import { createHash } from 'node:crypto';
import { list, object, string, strings } from './validation.mts';

export type Runtime = 'host' | 'wasm' | 'javascript' | 'shell' | 'compile';
export type Language = 'haskell' | 'javascript' | 'tooling';

export interface Metric {
  covered: number;
  total: number;
  percent: number | null;
}

export type Metrics = Record<string, Metric>;

export interface Evidence {
  status: 'measured' | 'unmeasured' | 'validated';
  complete?: boolean;
  metrics?: Metrics;
  modules?: unknown[];
  projection?: Record<string, unknown>;
}

export interface Source {
  source_kind: string;
  provenance_status: string;
  package: string | null;
  package_root: string | null;
  path: string;
  sha256: string;
  language: Language;
  module: string | null;
  host: string;
  wasm: string;
  required_runtimes: Runtime[];
  evidence: Partial<Record<Runtime, Evidence>>;
  exclusion?: Record<string, unknown>;
  runtime_basis?: Record<string, unknown>;
  validation_basis?: Record<string, unknown>;
  javascript_execution?: Record<string, unknown>;
}

const haskell = ['.hs', '.lhs'];
const javascript = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];
const declarations = ['.d.ts', '.d.mts', '.d.cts'];
const haskellContracts = ['haskell-reexport', 'haskell-interface', 'haskell-test-entry'];

function sourceLanguage(extension: string): Language | undefined {
  if (haskell.includes(extension)) {
    return 'haskell';
  }

  if (javascript.includes(extension)) {
    return 'javascript';
  }

  return extension === '.sh' ? 'tooling' : undefined;
}

export function measurement(covered: number, total: number): Metric {
  if (
    !Number.isSafeInteger(covered) ||
    !Number.isSafeInteger(total) ||
    covered < 0 ||
    covered > total
  ) {
    throw new Error(`Invalid coverage count: ${covered}/${total}`);
  }

  return { covered, total, percent: total > 0 ? (100 * covered) / total : null };
}

export function hits(values: readonly (number | bigint)[]): Metric {
  return measurement(values.filter((count) => count > 0).length, values.length);
}

export function full(metrics: Metrics): boolean {
  const values = Object.values(metrics);
  return (
    values.some(({ total }) => total > 0) && values.every(({ covered, total }) => covered === total)
  );
}

export function inventory(root: string): Source[] {
  const files = trackedFiles(root);
  const packages = files
    .filter((name) => name.endsWith('.cabal'))
    .flatMap((path) => {
      const name = /^name:\s*(\S+)/im.exec(textFile(join(root, path)))?.[1];
      return name === undefined ? [] : [{ name, root: dirname(path) }];
    });
  return files.flatMap((name) => {
    const extension = extname(name);
    const language = sourceLanguage(extension);
    if (language === undefined) {
      return [];
    }

    const path = join(root, name);
    const declaration = declarations.some((suffix) => name.endsWith(suffix));
    const owner = packages
      .filter((item) => within(item.root, name))
      .toSorted((a, b) => b.root.split(sep).length - a.root.split(sep).length)[0];
    const module =
      /^module\s+([A-Z][\w.]*)/m.exec(textFile(path))?.[1] ?? (extension === '.hs' ? 'Main' : null);
    const source: Source = {
      source_kind: declaration ? 'type-declaration' : 'executable-or-configuration',
      provenance_status: declaration ? 'requires-manifest' : 'authored-or-unclassified',
      package: owner?.name ?? null,
      package_root: owner?.root ?? null,
      path: name,
      sha256: digest(path),
      language,
      module,
      host: 'unmeasured',
      wasm: language === 'haskell' ? 'unmeasured' : 'not-applicable',
      required_runtimes: [],
      evidence: { host: { status: 'unmeasured' } },
    };
    return [source];
  });
}

export function manifestEntries(
  manifest: Record<string, unknown>,
  key: string,
): Map<string, Record<string, unknown>> {
  const entries = list(manifest[key] ?? []).map(object);
  const byPath = new Map(entries.map((entry) => [string(entry.path), entry]));
  if (byPath.size !== entries.length) {
    throw new Error('Duplicate scope manifest path: ' + key);
  }

  return byPath;
}

function defaultRuntimes(source: Source): Runtime[] {
  if (source.language === 'javascript') {
    return ['javascript'];
  }

  if (source.language === 'tooling') {
    return ['shell'];
  }

  const name = '/' + source.path;
  const wasm =
    (name.includes('/src/') || name.startsWith('/examples/')) &&
    !name.startsWith('/conformance-oracle/') &&
    !name.includes('/host-testkit/') &&
    !name.includes('/test/');
  return wasm ? ['host', 'wasm'] : ['host'];
}

function reviewedRuntime(source: Source, value: unknown): Runtime[] {
  const allowed: Runtime[] =
    source.language === 'haskell' ? ['host', 'wasm'] : defaultRuntimes(source);
  const selected = strings(value);
  const runtimes = selected.map((item) => allowed.find((entry) => entry === item));
  if (
    selected.length === 0 ||
    new Set(selected).size !== selected.length ||
    runtimes.some((item) => item === undefined)
  ) {
    throw new Error('Invalid required runtimes: ' + source.path);
  }

  return runtimes.filter((item) => item !== undefined);
}

function validateScopeEvidence(
  root: string,
  source: Source,
  entry: Record<string, unknown>,
): string {
  if (!string(entry.reason) || !string(entry.evidence)) {
    throw new Error('Manifest requires reason and evidence: ' + source.path);
  }

  const path = childPath(root, string(entry.evidence));
  if (
    !isFile(path) ||
    (entry.evidence_sha256 !== undefined && digest(path) !== entry.evidence_sha256)
  ) {
    throw new Error('Manifest evidence fingerprint changed: ' + source.path);
  }

  return path;
}

export function validateGeneratedBundle(root: string, sourceName: string, proofPath: string): void {
  const proof = object(jsonFile(proofPath));
  if (proof.schema !== 1 || proof.kind !== 'generated' || proof.artifact !== sourceName) {
    throw new Error('Generated bundle provenance does not match source');
  }

  const fingerprints = object(proof.files);
  if (!(sourceName in fingerprints)) {
    throw new Error('Generated bundle fingerprint missing');
  }

  for (const [name, fingerprint] of Object.entries(fingerprints)) {
    verifiedFile(root, name, fingerprint);
  }

  const metadata = object(proof.sourceMap);
  const name = string(metadata.path);
  const mapPath = verifiedFile(root, name, fingerprints[name]);
  const map = object(jsonFile(mapPath));
  if (map.version !== 3 || !/^[A-Za-z0-9+/;,]+$/.test(string(map.mappings))) {
    throw new Error('Invalid generated source map');
  }

  const names = strings(map.sources);
  const contents = strings(map.sourcesContent);
  const embedded = names.map((name, index) => ({
    name,
    embeddedSourceSha256: createHash('sha256')
      .update(contents[index] ?? '')
      .digest('hex'),
  }));
  if (
    names.length === 0 ||
    names.length !== contents.length ||
    !equals(embedded, metadata.sources)
  ) {
    throw new Error('Generated source map embedded sources changed');
  }

  const suffix = relative(dirname(mapPath), mapPath);
  if (
    !new RegExp(`^//[#@] sourceMappingURL=${RegExp.escape(suffix)}\\s*$`, 'm').test(
      textFile(join(root, sourceName)),
    )
  ) {
    throw new Error('Generated bundle source map reference missing');
  }

  const build = object(proof.buildEvidence);
  const log = textFile(verifiedFile(root, build.path, build.sha256));
  const marker = string(build.successfulMarker);
  if (!marker.includes('--dry-run') || !log.includes(marker)) {
    throw new Error('Generated bundle successful build evidence missing');
  }
}

function chooseRuntimes(
  root: string,
  source: Source,
  manifest: ReturnType<typeof readScope>,
): Runtime[] {
  const { path } = source;
  const exclusion = manifest.exclusions.get(path);
  const override = manifest.overrides.get(path);
  const validation = manifest.validations.get(path);

  if ([exclusion, override, validation].filter(Boolean).length > 1) {
    throw new Error('Conflicting scope entries: ' + path);
  }

  const guard = manifest.guards.get(path);
  if (
    guard &&
    (source.language !== 'haskell' ||
      !string(guard.reason) ||
      source.sha256 !== guard.source_sha256)
  ) {
    throw new Error('Constant-guard review source changed: ' + path);
  }

  if (exclusion) {
    const basis = validateScopeEvidence(root, source, exclusion);

    if (exclusion.kind !== 'generated' && exclusion.kind !== 'external') {
      throw new Error('Only generated/external provenance exclusions supported: ' + path);
    }

    if (exclusion.provenance_format !== undefined) {
      if (exclusion.provenance_format !== 'wrangler-bundle-v1') {
        throw new Error('Unknown generated provenance format: ' + path);
      }

      validateGeneratedBundle(root, path, basis);
    }

    source.exclusion = exclusion;
    return [];
  }

  if (override) {
    validateScopeEvidence(root, source, override);
    source.runtime_basis = override;
    return reviewedRuntime(source, override.required);
  }

  if (validation) {
    validateScopeEvidence(root, source, validation);
    const kind = string(validation.kind);
    const approved =
      source.language === 'haskell' ? haskellContracts : ['declaration', 'type-contract'];
    if (
      !approved.includes(kind) ||
      (kind === 'declaration' && !declarations.some((suffix) => path.endsWith(suffix)))
    ) {
      throw new Error('Invalid compile validation kind: ' + path);
    }

    source.validation_basis = validation;

    if (haskellContracts.includes(kind)) {
      source.source_kind =
        kind === 'haskell-test-entry' ? 'test-discovery-entry' : 'compiler-interface';
    }

    return ['compile'];
  }

  return defaultRuntimes(source);
}

function readScope(data: Record<string, unknown>): {
  exclusions: Map<string, Record<string, unknown>>;
  overrides: Map<string, Record<string, unknown>>;
  validations: Map<string, Record<string, unknown>>;
  guards: Map<string, Record<string, unknown>>;
} {
  return {
    exclusions: manifestEntries(data, 'exclusions'),
    overrides: manifestEntries(data, 'runtimes'),
    validations: manifestEntries(data, 'validations'),
    guards: manifestEntries(data, 'constant_guards'),
  };
}

export function applyScope(root: string, sources: Source[], data: Record<string, unknown>): void {
  const manifest = readScope(data);
  const known = new Set(sources.map(({ path }) => path));
  if (
    Object.values(manifest).some((entries) => [...entries.keys()].some((path) => !known.has(path)))
  ) {
    throw new Error('Scope manifest references a missing source');
  }

  for (const source of sources) {
    const required = chooseRuntimes(root, source, manifest);
    source.required_runtimes = required;
    source.evidence = Object.fromEntries(required.map((name) => [name, { status: 'unmeasured' }]));
    source.wasm = required.includes('wasm') ? 'unmeasured' : 'not-applicable';
  }
}

export function moduleCandidates(
  root: string,
  sources: Source[],
  module: string,
  mixPath: string,
): Source[] {
  const bases = new Set([root]);
  const names = module.split('/');
  if (names.length > 1) {
    const owners = sources
      .map((source) => source.package)
      .filter((name) => name && names[0].startsWith(name + '-'));
    const owner = owners.toSorted((a, b) => (b?.length ?? 0) - (a?.length ?? 0))[0];
    if (owner) {
      const roots = new Set(
        sources.filter(({ package: name }) => name === owner).map((source) => source.package_root),
      );
      if (roots.size !== 1) {
        throw new Error('Ambiguous Cabal package root: ' + owner);
      }

      bases.clear();
      bases.add(resolve(root, [...roots][0] ?? '.'));
    }
  } else {
    sources.forEach((source) => {
      if (source.package_root !== null) {
        bases.add(resolve(root, source.package_root));
      }
    });
  }

  const resolved = new Set([...bases].map((base) => absolutePath(resolve(base, mixPath))));
  return sources.filter(
    (source) =>
      source.language === 'haskell' &&
      source.module === names.at(-1) &&
      resolved.has(absolutePath(join(root, source.path))),
  );
}
