export const valid = `
/** The public result. */
export type Result = { /** Whether it succeeded. */ ok: true; /** Returned value. */ value: string } | { /** Whether it succeeded. */ ok: false; /** Failure message. */ message: string };
/** Provides a factory. */
export function factory(options: { /** Enables serialization. */ serialize?: boolean }) {
  class Internal { hidden() {} }
  class Public {
    /** Creates an instance. */
    constructor() {}
    /** The context. */
    readonly context = {};
    private implementation() {}
    /** Runs the handler. */
    run() {}
  }
  return Public as typeof Public;
}
function internal() {}
`;
export const invalid: readonly [name: string, source: string, expected: string][] = [
  ['declaration', 'export function missing() {}', 'missing TSDoc'],
  [
    'field',
    '/** Public shape. */ export interface Shape { value: string }',
    'Shape.value: missing TSDoc',
  ],
  [
    'union',
    '/** Public result. */ export type Result = { value: string } | null;',
    'Result.value: missing TSDoc',
  ],
  [
    'parameter field',
    '/** Runs work. */ export function run(options: { enabled: boolean }) {}',
    'run.enabled: missing TSDoc',
  ],
  [
    'tag syntax',
    '/** Runs work.\n * @param value description\n */ export function run(value: string) {}',
    'tsdoc-param-tag-missing-hyphen',
  ],
  [
    'unknown tag',
    '/** Runs work.\n * @notATag text\n */ export function run() {}',
    'tsdoc-undefined-tag',
  ],
  ['empty description', '/** @public */ export type Empty = string;', 'missing English summary'],
  ['Japanese description', '/** 公開APIです。 */ export type Empty = string;', 'English'],
  ['ordinary comment', '/* Public shape. */ export interface Shape {}', 'missing TSDoc'],
  [
    'returned member',
    '/** Creates instances. */ export function make() { class Public { run() {} } return Public; }',
    'make.run: missing TSDoc',
  ],
  ['export alias', 'interface Shape {} export { Shape };', 'missing TSDoc'],
  ['syntax', 'export interface {', 'TypeScript syntax'],
];
