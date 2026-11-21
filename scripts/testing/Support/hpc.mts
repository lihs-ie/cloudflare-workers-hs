import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { digest, textFile } from './cli.mts';

const tixPattern = /TixModule\s+("(?:[^"\\]|\\.)*")\s+(\d+)\s+(\d+)\s+\[([\d,\s]*)\]/g;
const mixPattern = /^Mix\s+("(?:[^"\\]|\\.)*").*? UTC\s+(\d+)\s+(\d+)\s+\[/;
const boxPattern = /\((\d+):(\d+)-(\d+):(\d+),(ExpBox|BinBox|TopLevelBox|LocalBox)\b([^)]*)\)/g;

export interface Tix {
  name: string;
  hash: string;
  ticks: bigint[];
}

export interface Box {
  span: [number, number, number, number];
  kind: string;
  label: string;
}

export interface Mix {
  path: string;
  hash: string;
  width: number;
  boxes: Box[];
  layout: string;
}

function readName(encoded: string): string {
  const name: unknown = JSON.parse(encoded);
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Invalid HPC name');
  }

  return name;
}

export function parseTix(text: string): Tix[] {
  const residue = text.replace(tixPattern, 'MODULE');
  if (!/^\s*Tix\s*\[\s*MODULE(?:\s*,\s*MODULE)*\s*\]\s*$/.test(residue)) {
    throw new Error('Malformed counter separators or empty Tix');
  }

  const names = new Set<string>();
  return [...text.matchAll(tixPattern)].map(([, encoded, hash, count, values]) => {
    if (!/^\s*(?:\d+(?:\s*,\s*\d+)*)?\s*$/.test(values)) {
      throw new Error('Malformed counter values');
    }

    const name = readName(encoded);
    if (isAbsolute(name) || name.split(sep).includes('..') || names.has(name)) {
      throw new Error('Unsafe or duplicate module name: ' + name);
    }

    const ticks = values.trim() ? values.split(',').map((value) => BigInt(value)) : [];
    if (ticks.length !== Number(count)) {
      throw new Error('Counter count mismatch: ' + name);
    }

    names.add(name);
    return { name, hash, ticks };
  });
}

export function formatTix(records: readonly Tix[]): string {
  return (
    'Tix [' +
    records
      .map(
        ({ name, hash, ticks }) =>
          `TixModule ${JSON.stringify(name)} ${hash} ${ticks.length} [${ticks.join(',')}]`,
      )
      .join(',') +
    ']'
  );
}

export function parseMix(text: string): Mix {
  const match = mixPattern.exec(text);
  if (match === null) {
    throw new Error('Invalid HPC mix header');
  }

  const [, encoded, hash, width] = match;
  const layout = text.slice(match[0].length).trimEnd();
  const boxes: Box[] = [...layout.matchAll(boxPattern)].map(
    ([, start, column, end, last, kind, label]) => ({
      span: [Number(start), Number(column), Number(end), Number(last)],
      kind,
      label: label.trim(),
    }),
  );

  if (!/^(?:BOX(?:,\s*BOX)*)?\]$/.test(layout.replace(boxPattern, 'BOX'))) {
    throw new Error('Unsupported HPC mix box layout');
  }

  return { path: readName(encoded), hash, width: Number(width), boxes, layout };
}

interface MixCandidate {
  path: string;
  content: string;
  mix: Mix;
}

export function mixIndex(paths: readonly string[]): Map<string, MixCandidate[]> {
  const result = new Map<string, MixCandidate[]>();
  for (const path of paths) {
    const content = textFile(path);
    const mix = parseMix(content);
    const key = basename(path, '.mix') + ':' + mix.hash;
    const entries = result.get(key) ?? [];
    entries.push({ path, content, mix });
    result.set(key, entries);
  }

  return result;
}

export function copyMix(
  records: readonly Tix[],
  candidates: ReadonlyMap<string, readonly MixCandidate[]>,
  output: string,
): Record<string, string> {
  const copied: Record<string, string> = {};
  for (const { name, hash, ticks } of records) {
    const matches = candidates.get(name.split('/').at(-1) + ':' + hash) ?? [];
    const contents = new Set(matches.map(({ content }) => content));
    if (contents.size !== 1) {
      throw new Error('Missing or ambiguous mix: ' + name);
    }

    const candidate = matches[0];
    if (candidate.mix.boxes.length !== ticks.length) {
      throw new Error('Mix counter count mismatch: ' + name);
    }

    const relative = join('mix', hash, name + '.mix');
    const file = join(output, relative);
    if (existsSync(file) && textFile(file) !== candidate.content) {
      throw new Error('Conflicting copied mix: ' + name);
    }

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, candidate.content);
    copied[relative] = digest(file);
  }

  return copied;
}

export function successfulSummaries(log: string, count: number): boolean {
  const passed = [...log.matchAll(/^\s*Passed:\s+(\d+)\s*$/gm)];
  const failed = [...log.matchAll(/^\s*Failed:\s+(\d+)\s*$/gm)];
  return (
    passed.length === count &&
    passed.every((match) => Number(match[1]) > 0) &&
    failed.length === count &&
    failed.every((match) => Number(match[1]) === 0)
  );
}
