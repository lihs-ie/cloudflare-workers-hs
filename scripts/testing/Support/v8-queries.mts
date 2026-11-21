import { mkdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absolutePath, digest, files, jsonFile, within, writeJson } from './cli.mts';
import { equals, verifiedFile, type Sources } from './evidence-io.mts';
import { list, object, string } from './validation.mts';

interface Rewrite {
  original: string;
  canonical: string;
  source: string;
  sourceSha256: string;
}

export function canonicalV8(
  root: string,
  evidence: unknown,
  sources: Sources,
  eligible: ReadonlySet<string>,
): { report: Record<string, unknown>; rewrites: Rewrite[] } {
  const report = object(structuredClone(evidence));
  const rewrites: Rewrite[] = [];
  const cache = object(report['source-map-cache'] ?? {});
  for (const script of list(report.result).map(object)) {
    const original = string(script.url);
    // Internal module URLs and unpacked native code have no repository file URL.
    if (!original.startsWith('file:')) {
      continue;
    }

    const url = new URL(original);
    const keys = new Set(url.searchParams.keys());
    if (keys.size !== 1 || !keys.has('contract')) {
      continue;
    }

    const path = absolutePath(fileURLToPath(url));
    const source = relative(root, path);
    if (!within(root, path) || !eligible.has(source)) {
      continue;
    }

    const sourceSha256 = digest(path);
    if (sources[source] !== sourceSha256) {
      throw new Error('Queried V8 module differs from the recorded source');
    }

    url.search = '';
    url.hash = '';
    const canonical = url.href;

    if (Object.hasOwn(cache, original)) {
      if (Object.hasOwn(cache, canonical) && !equals(cache[canonical], cache[original])) {
        throw new Error('Queried V8 source maps disagree');
      }

      cache[canonical] = cache[original];
      delete cache[original];
    }

    script.url = canonical;
    rewrites.push({ original, canonical, source, sourceSha256 });
  }

  return { report, rewrites };
}

export function canonicalV8Files(
  root: string,
  raw: string,
  canonical: string,
  sources: Sources,
  eligible: ReadonlySet<string>,
): Record<string, unknown>[] {
  mkdirSync(canonical);
  const directory = dirname(canonical);
  return files(raw)
    .filter((path) => path.endsWith('.json'))
    .map((path) => {
      const { report, rewrites } = canonicalV8(root, jsonFile(path), sources, eligible);
      const target = join(canonical, basename(path));
      writeJson(target, report);
      return {
        raw: relative(directory, path),
        rawSha256: digest(path),
        canonical: relative(directory, target),
        canonicalSha256: digest(target),
        rewrites,
      };
    });
}

export function validateV8Files(
  root: string,
  directory: string,
  sources: Sources,
  eligible: ReadonlySet<string>,
  proof: unknown,
): void {
  for (const record of list(proof).map(object)) {
    const raw = verifiedFile(directory, record.raw, record.rawSha256);
    const target = verifiedFile(directory, record.canonical, record.canonicalSha256);
    const { report, rewrites } = canonicalV8(root, jsonFile(raw), sources, eligible);

    if (!equals(report, jsonFile(target)) || !equals(rewrites, record.rewrites)) {
      throw new Error('Canonical V8 input differs from its raw proof');
    }
  }
}
