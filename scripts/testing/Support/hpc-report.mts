import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { absolutePath, capture, files, isFile, textFile, withTemp } from './cli.mts';
import { trackedFiles } from './evidence-io.mts';
import {
  full,
  hits,
  measurement,
  moduleCandidates,
  type Metrics,
  type Source,
} from './coverage-scope.mts';
import { formatTix, mixIndex, parseTix, type Mix, type Tix } from './hpc.mts';
import { list, object, strings } from './validation.mts';
import type { HpcProof } from './proof-inputs.mts';

type Runtime = 'host' | 'wasm';

interface Group {
  records: Tix[];
  paths: Set<string>;
  suite: string | null;
}

interface RuntimeInput {
  tix: string[];
  mix: string[];
  proof?: HpcProof;
}

interface HpcModule {
  module: string;
  hash: string;
  suite: string | null;
  metrics: Metrics;
  bindings: { name: string; hits: number }[];
  line_hits: Record<string, number>;
  line_method: string;
  mix_sources: string[];
  sources: string[];
  raw_metrics?: Metrics;
  constant_guards?: unknown[];
  scope?: string;
  provenance?: unknown[];
}

interface Projection {
  tix: Tix;
  mix: Mix;
  mixText: string;
  source: Source;
  authenticated: boolean;
  cpp: boolean;
}

export function hpcMetrics(xml: string): Map<string, Metrics> {
  const result = new Map<string, Metrics>();
  for (const [, name, body] of xml.matchAll(
    /<module\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/module>/g,
  )) {
    const metrics: Metrics = {};
    for (const tag of ['exprs', 'booleans', 'alts']) {
      const attributes = new RegExp(`<${tag}\\s+([^>]+)>`).exec(body)?.[1];
      if (attributes === undefined) {
        throw new Error('Missing HPC metric: ' + tag);
      }

      const values = new Map(
        [...attributes.matchAll(/([a-z]+)="(\d+)"/g)].map((match) => [match[1], Number(match[2])]),
      );
      const count =
        (values.get('count') ?? Number.NaN) -
        (tag === 'booleans' ? (values.get('true') ?? 0) + (values.get('false') ?? 0) : 0);
      metrics[tag] = measurement(count, values.get('boxes') ?? Number.NaN);
    }

    result.set(name, metrics);
  }

  if (result.size === 0) {
    throw new Error('HPC report has no modules');
  }

  return result;
}

function groups(paths: readonly string[]): Group[] {
  const grouped = new Map<string, Group>();
  for (const path of paths) {
    for (const record of parseTix(textFile(path))) {
      const suite = record.name === 'Main' ? absolutePath(path) : null;
      const key = JSON.stringify([record.name, record.hash, record.ticks.length, suite]);
      const group = grouped.get(key) ?? { records: [], paths: new Set<string>(), suite };
      group.records.push(record);
      group.paths.add(absolutePath(path));
      grouped.set(key, group);
    }
  }

  return [...grouped.values()];
}

function mergedTicks(records: readonly Tix[]): Tix {
  const first = records[0];
  return {
    ...first,
    ticks: first.ticks.map((_, index) =>
      records.reduce((sum, record) => sum + record.ticks[index], 0n),
    ),
  };
}

function readMeasurements(temp: string, tix: Tix, content: string): Metrics {
  const counter = join(temp, 'counter.tix');
  const maps = join(temp, 'map');
  const map = join(maps, tix.name + '.mix');
  mkdirSync(dirname(map), { recursive: true });
  writeFileSync(map, content);
  writeFileSync(counter, formatTix([tix]));
  const xml = capture(
    ['hpc', 'report', '--xml-output', '--per-module', '--hpcdir=' + maps, counter],
    { cwd: temp },
  );
  const metrics = hpcMetrics(xml).get(tix.name);
  if (metrics === undefined) {
    throw new Error('HPC did not report ' + tix.name);
  }

  return metrics;
}

export function hpcLines(mix: Mix, ticks: readonly bigint[]): Record<string, number> {
  if (mix.boxes.length !== ticks.length) {
    throw new Error('HPC mix/counter mismatch');
  }

  const lines: Record<string, number> = {};
  for (const [index, box] of mix.boxes.entries()) {
    if (box.kind !== 'ExpBox') {
      continue;
    }

    const [start, , end] = box.span;
    const count = Number(ticks[index]);
    if (end < start || end - start > 100_000 || !Number.isSafeInteger(count)) {
      throw new Error('Invalid HPC mix span or count');
    }

    for (let line = start; line <= end; line += 1) {
      lines[line] = Math.min(lines[line] ?? count, count);
    }
  }

  return lines;
}

function bindingHits(mix: Mix, ticks: readonly bigint[]): { name: string; hits: number }[] {
  return mix.boxes.flatMap((box, index) => {
    if (box.kind !== 'TopLevelBox') {
      return [];
    }

    const names = strings(JSON.parse(box.label));
    const hits = Number(ticks[index]);
    if (!Number.isSafeInteger(hits)) {
      throw new Error('Invalid HPC binding count');
    }

    return names.length === 1 ? [{ name: names[0], hits }] : [];
  });
}

function expandTabs(text: string): string {
  let result = '';
  for (const char of text) {
    result += char === '\t' ? ' '.repeat(8 - (result.length % 8)) : char;
  }

  return result;
}

export function reviewedGuards(
  root: string,
  source: Source | undefined,
  mix: Mix,
  ticks: readonly bigint[],
  scope: ReadonlyMap<string, Record<string, unknown>>,
  raw: Metrics,
): { metrics: Metrics; guards: unknown[] } {
  const review = source === undefined ? undefined : scope.get(source.path);
  if (review === undefined || source === undefined) {
    return { metrics: raw, guards: [] };
  }

  const lines = textFile(join(root, source.path)).split(/\r?\n/);
  const spans = new Map(
    list(review.guards)
      .map(object)
      .map((guard) => [JSON.stringify(guard.span), guard]),
  );
  const observed = new Map<string, { span: number[]; outcomes: Map<string, bigint> }>();
  for (const [index, box] of mix.boxes.entries()) {
    const key = JSON.stringify(box.span);
    const entry = spans.get(key);
    const outcome = /^GuardBinBox (True|False)$/.exec(box.label)?.[1];
    if (entry === undefined || box.kind !== 'BinBox' || outcome === undefined) {
      continue;
    }

    const [start, column, end, last] = box.span;

    if (
      start !== end ||
      entry.token !== 'otherwise' ||
      expandTabs(lines[start - 1] ?? '').slice(column - 1, last) !== entry.token
    ) {
      throw new Error('Reviewed constant guard no longer matches its source');
    }

    if (outcome === 'False' && ticks[index] !== 0n) {
      throw new Error('Reviewed constant guard produced an impossible outcome');
    }

    const pair = observed.get(key) ?? { span: box.span, outcomes: new Map() };
    pair.outcomes.set(outcome, ticks[index]);
    observed.set(key, pair);
  }

  const guards = [...observed.values()].map(({ span, outcomes }) => {
    if (!outcomes.has('True') || !outcomes.has('False')) {
      throw new Error('Incomplete constant-guard counter pair');
    }

    return {
      span,
      token: 'otherwise',
      unreachable: false,
      true_hits: Number(outcomes.get('True')),
      basis: 'Reviewed Prelude.otherwise; source fingerprint and exact labelled guard map',
    };
  });
  const { covered, total } = raw.booleans;
  return { metrics: { ...raw, booleans: measurement(covered, total - guards.length) }, guards };
}

function generatedProvenance(root: string, name: string, mix: Mix, cabal: string[]): unknown[] {
  if (
    !isAbsolute(mix.path) ||
    !isFile(mix.path) ||
    !textFile(mix.path).includes('WARNING: This module was generated by Cabal.')
  ) {
    return [];
  }

  const module = name.split('/').at(-1) ?? '';
  const field = new RegExp(`autogen-modules:[^\\n]*\\b${RegExp.escape(module)}\\b`);
  return cabal
    .filter((path) => field.test(textFile(join(root, path))))
    .map((evidence) => ({
      path: mix.path,
      kind: 'generated',
      evidence,
      reason: 'Explicit Cabal autogen-modules declaration and Cabal-generated source warning',
    }));
}

function project(
  root: string,
  runtime: Runtime,
  variants: Projection[],
  input: RuntimeInput,
  temp: string,
  guardScope: ReadonlyMap<string, Record<string, unknown>>,
): void {
  const first = variants[0];
  if (
    variants.length < 2 ||
    variants.some(
      (entry) =>
        !entry.authenticated ||
        entry.cpp ||
        entry.mix.width !== first.mix.width ||
        entry.mix.layout !== first.mix.layout,
    ) ||
    first.source.evidence[runtime] === undefined
  ) {
    return;
  }

  const combined = mergedTicks(variants.map(({ tix }) => tix));
  const counts = hpcLines(first.mix, combined.ticks);
  const raw = {
    ...readMeasurements(temp, combined, first.mixText),
    lines: hits(Object.values(counts)),
  };
  const { metrics, guards } = reviewedGuards(
    root,
    first.source,
    first.mix,
    combined.ticks,
    guardScope,
    raw,
  );
  const evidence = first.source.evidence[runtime];
  evidence.complete = full(metrics);
  evidence.projection = {
    method: 'authenticated identical source/compiler/runtime/full labelled tick map',
    source_sha256: first.source.sha256,
    compiler_sha256: input.proof?.compiler?.sha256,
    compiler_version: input.proof?.compiler?.version,
    raw_metrics: raw,
    constant_guards: guards,
    metrics,
    line_hits: counts,
    map_sha256: createHash('sha256')
      .update(`${first.mix.width} [${first.mix.layout}`)
      .digest('hex'),
    variants: variants.map(({ tix }) => ({ module: tix.name, hash: tix.hash })),
  };
}

export function collectHpc(
  root: string,
  runtime: Runtime,
  input: RuntimeInput,
  sources: Source[],
  guardScope: ReadonlyMap<string, Record<string, unknown>>,
  errors: string[],
): HpcModule[] {
  const maps = mixIndex([
    ...new Set(input.mix.flatMap((path) => files(path)).filter((path) => path.endsWith('.mix'))),
  ]);
  const cabal = trackedFiles(root).filter((name) => name.endsWith('.cabal'));
  const variants = new Map<string, Projection[]>();
  const modules: HpcModule[] = [];
  withTemp('workers-hpc-', (temp) => {
    for (const group of groups(input.tix)) {
      const tix = mergedTicks(group.records);
      const matching = maps.get(tix.name.split('/').at(-1) + ':' + tix.hash) ?? [];
      const unique = new Set(matching.map(({ content }) => content));
      if (unique.size !== 1) {
        const issue = unique.size === 0 ? 'No matching mix' : 'Conflicting mix files';
        throw new Error(`${issue} for ${tix.name} hash ${tix.hash}`);
      }

      const { mix, content } = matching[0];
      const counts = hpcLines(mix, tix.ticks);
      const raw = { ...readMeasurements(temp, tix, content), lines: hits(Object.values(counts)) };
      const candidates = moduleCandidates(root, sources, tix.name, mix.path);
      const source = candidates.length === 1 ? candidates[0] : undefined;
      const { metrics, guards } = reviewedGuards(root, source, mix, tix.ticks, guardScope, raw);
      const item: HpcModule = {
        module: tix.name,
        hash: tix.hash,
        suite: group.suite,
        metrics,
        bindings: bindingHits(mix, tix.ticks),
        line_hits: counts,
        line_method: 'all spanning HPC expression ticks executed',
        mix_sources: [mix.path],
        sources: candidates.map(({ path }) => path),
      };

      if (guards.length > 0) {
        item.raw_metrics = raw;
        item.constant_guards = guards;
      }

      modules.push(item);

      if (source === undefined) {
        const provenance =
          candidates.length === 0 ? generatedProvenance(root, tix.name, mix, cabal) : [];
        if (provenance.length > 0) {
          item.scope = 'generated-excluded';
          item.provenance = provenance;
        } else {
          errors.push('Ambiguous or missing source mapping: ' + tix.name);
        }
        continue;
      }

      source[runtime] = 'measured';
      const previous = source.evidence[runtime];
      if (previous !== undefined) {
        source.evidence[runtime] = {
          status: 'measured',
          complete: full(metrics) && (previous.complete ?? true),
          modules: [...(previous.modules ?? []), item],
        };
      }

      const proof = input.proof;
      const authenticated =
        proof !== undefined &&
        [...group.paths].every((path) => proof.artifacts.has(path)) &&
        matching.some(({ path }) => proof.artifacts.has(absolutePath(path))) &&
        proof.sources[source.path] === source.sha256;
      const entry = {
        tix,
        mix,
        mixText: content,
        source,
        authenticated,
        cpp: /^\s*#|\bCPP\b/m.test(textFile(join(root, source.path))),
      };
      const collection = variants.get(source.path) ?? [];
      collection.push(entry);
      variants.set(source.path, collection);
    }

    for (const entries of variants.values()) {
      project(root, runtime, entries, input, temp, guardScope);
    }
  });
  return modules;
}
