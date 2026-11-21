import { dirname, extname, join, relative } from 'node:path';
import { capture, jsonFile, textFile } from './cli.mts';
import {
  childPath,
  equals,
  sourceSnapshot,
  successfulProof,
  verifiedFile,
  type Sources,
} from './evidence-io.mts';
import { full, hits, type Evidence } from './coverage-scope.mts';
import { list, nonnegative, object, string } from './validation.mts';

type EvidenceMap = Record<string, Evidence>;

interface Istanbul {
  statementMap: Record<string, unknown>;
  fnMap: Record<string, unknown>;
  branchMap: Record<string, unknown>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

function counters<T>(
  map: Record<string, unknown>,
  value: unknown,
  read: (item: unknown) => T,
): Record<string, T> {
  const entries = Object.entries(object(value));
  if (!equals(entries.map(([key]) => key).sort(), Object.keys(map).sort())) {
    throw new Error('Incomplete Istanbul map/count pairs');
  }

  return Object.fromEntries(entries.map(([key, item]) => [key, read(item)]));
}

function readIstanbul(entry: Record<string, unknown>): Istanbul {
  const statementMap = object(entry.statementMap);
  const fnMap = object(entry.fnMap);
  const branchMap = object(entry.branchMap);
  const b = counters(branchMap, entry.b, (item) => list(item).map(nonnegative));
  for (const [key, values] of Object.entries(b)) {
    if (values.length !== list(object(branchMap[key]).locations).length) {
      throw new Error('Invalid Istanbul branch arity');
    }
  }

  return {
    statementMap,
    fnMap,
    branchMap,
    s: counters(statementMap, entry.s, nonnegative),
    f: counters(fnMap, entry.f, nonnegative),
    b,
  };
}

function mergeCounts(name: string, previous: Istanbul, next: Istanbul): void {
  if (
    !(['statementMap', 'fnMap', 'branchMap'] as const).every((key) =>
      equals(previous[key], next[key]),
    )
  ) {
    throw new Error('Cannot merge different Istanbul instrumentation: ' + name);
  }

  for (const lane of ['s', 'f'] as const) {
    for (const [key, count] of Object.entries(next[lane])) {
      previous[lane][key] = nonnegative(previous[lane][key] + count);
    }
  }

  for (const [key, values] of Object.entries(next.b)) {
    previous.b[key] = values.map((count, index) => nonnegative(previous.b[key][index] + count));
  }
}

function jsMetrics(entry: Istanbul): Evidence {
  const lines = new Map<number, number>();
  for (const [key, location] of Object.entries(entry.statementMap)) {
    const line = nonnegative(object(object(location).start).line);
    lines.set(line, Math.max(lines.get(line) ?? 0, entry.s[key]));
  }

  const metrics = {
    statements: hits(Object.values(entry.s)),
    functions: hits(Object.values(entry.f)),
    branches: hits(Object.values(entry.b).flat()),
    lines: hits([...lines.values()]),
  };
  return { status: 'measured', metrics, complete: full(metrics) };
}

export function javascriptEvidence(root: string, paths: readonly string[]): EvidenceMap {
  const merged = new Map<string, Istanbul>();
  for (const path of paths) {
    const entries = Object.entries(object(jsonFile(path)));
    if (entries.length === 0) {
      throw new Error('Empty Istanbul report: ' + path);
    }

    for (const [reference, value] of entries) {
      const entry = object(value);
      const name = relative(root, childPath(root, string(entry.path ?? reference)));
      const current = readIstanbul(entry);
      const previous = merged.get(name);
      if (previous === undefined) {
        merged.set(name, current);
      } else {
        mergeCounts(name, previous, current);
      }
    }
  }

  return Object.fromEntries([...merged].map(([name, entry]) => [name, jsMetrics(entry)]));
}

export function shellEvidence(root: string, path?: string): EvidenceMap {
  if (path === undefined) {
    return {};
  }

  const report = object(jsonFile(path));
  const collector = object(report.collector);
  const entries = Object.entries(object(report.files));
  if (
    report.schema !== 1 ||
    collector.name !== 'kcov' ||
    !string(collector.version) ||
    entries.length === 0
  ) {
    throw new Error('Invalid kcov shell evidence');
  }

  return Object.fromEntries(
    entries.map(([name, value]) => {
      const entry = object(value);
      const source = verifiedFile(root, name, entry.sha256);
      const count = textFile(source).trimEnd().split('\n').length;
      const lines = Object.entries(object(entry.lines));
      if (extname(source) !== '.sh' || lines.length === 0 || entry.branch_coverage !== false) {
        throw new Error('Shell evidence must declare unavailable branch measurement');
      }

      const covered = lines.map(([line, countValue]) => {
        if (!/^[1-9][0-9]*$/.test(line) || Number(line) > count) {
          throw new Error('Invalid shell line/count');
        }

        return nonnegative(countValue);
      });
      return [
        relative(root, source),
        {
          status: 'measured',
          metrics: { lines: hits(covered) },
          complete: false,
          branches: {
            status: 'unmeasured',
            reason: 'kcov supplies line hits, not branch outcomes',
          },
          collector,
          contracts: report.contracts ?? {},
        },
      ];
    }),
  );
}

export function verifiedSharedJavascript(
  root: string,
  path: string,
  sources: Sources = sourceSnapshot(root),
): {
  combined: string;
  workerdOnly: string;
  proof: string;
} {
  const proofPath = childPath(root, path);
  const proof = object(jsonFile(proofPath));
  successfulProof(proof, sources);
  const args = [
    process.execPath,
    join(root, 'scripts/testing/Support/shared_js_report.mts'),
    '--verify',
    proofPath,
  ];
  const result: unknown = JSON.parse(capture(args, { cwd: root, timeout: 60_000 }));
  const verification = object(result);
  if (
    !['sources', 'sha256', 'workerdOnlySha256', 'inputs'].every((key) =>
      equals(verification[key], proof[key]),
    )
  ) {
    throw new Error('Shared JavaScript verifier response differs');
  }

  return {
    combined: verifiedFile(dirname(proofPath), 'coverage-final.json', proof.sha256),
    workerdOnly: verifiedFile(dirname(proofPath), 'workerd-only.json', proof.workerdOnlySha256),
    proof: proofPath,
  };
}
