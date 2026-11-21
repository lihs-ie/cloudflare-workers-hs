import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { checkSource } from '../scripts/check-docs.ts';
import { valid, invalid } from './Support/docs-fixtures.ts';

test('documented public API passes while internal and private members are ignored', () => {
  assert.deepEqual(checkSource(valid), []);
});
for (const [name, source, expected] of invalid) {
  test(`rejects ${name}`, () => {
    assert.ok(
      checkSource(source).some((issue) => issue.message.includes(expected)),
      JSON.stringify(checkSource(source)),
    );
  });
}
test('CLI reports a path and line and fails for a negative fixture', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-docs-'));
  try {
    const filename = join(directory, 'bad.ts');
    writeFileSync(filename, 'export function missing() {}');
    const result = spawnSync(process.execPath, ['scripts/check-docs.ts', filename], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${filename}:1:`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI accepts the default public source and an explicitly selected valid file', () => {
  for (const args of [[], ['src/index.ts']]) {
    const result = spawnSync(process.execPath, ['scripts/check-docs.ts', ...args], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Public API TSDoc checks passed/);
  }
});

test('re-exported declarations are checked once and external re-exports need no local docs', () => {
  const issues = checkSource(`interface Shape { value: string }
export { Shape }; export { Shape as Alias };
export { External } from "external";`);
  assert.equal(issues.filter((issue) => issue.message === 'Shape: missing TSDoc').length, 1);
  assert.equal(issues.filter((issue) => issue.message === 'Shape.value: missing TSDoc').length, 1);
});

test('documents default classes, literal members, callable shapes, and exported values', () => {
  assert.deepEqual(
    checkSource(`
/** Exposes an implementation. */
export default class {
  private hidden() {}
  protected inherited() {}
  #secret() {}
  static {}
  /** The public literal field. */
  "literal-field": string = "";
  /** Returns a record. */
  run(options: { /** An option. */ enabled: boolean }): { /** The result. */ result: boolean } { return { result: true }; }
}
/** The callable contract. */
export interface Callable {
  /** Invokes the callable. */
  (): void;
  /** Creates a result. */
  new (): Callable;
  /** Looks up a member. */
  [key: string]: unknown;
}
/** The configured value. */
export const enabled = true;
/** A declared function. */
export declare function declared(): void;
`),
    [],
  );
});

test('a parser diagnostic without a source label is reported on the first line', () => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', 'test/Support/parser-diagnostic.ts'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
