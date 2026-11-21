const text = (value: string): number[] => [...new TextEncoder().encode(value)];
const name = (value: string): number[] => [text(value).length, ...text(value)];
const section = (identifier: number, contents: readonly number[]): number[] => [
  identifier,
  contents.length,
  ...contents,
];

const writeLine = (descriptor: number): number[] => [
  0x41,
  descriptor,
  0x41,
  0,
  0x41,
  1,
  0x41,
  20,
  0x10,
  0,
  0x1a,
];

// A real WASI reactor: _initialize writes one line to each output descriptor.
export function outputReactor(): Uint8Array<ArrayBuffer> {
  const body = [0, ...writeLine(1), ...writeLine(2), 0x0b];
  const data = [8, 0, 0, 0, 4, 0, 0, 0, ...text('out\n')];
  return Uint8Array.from([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [2, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
    ...section(2, [1, ...name('wasi_snapshot_preview1'), ...name('fd_write'), 0, 0]),
    ...section(3, [1, 1]),
    ...section(5, [1, 0, 1]),
    ...section(7, [2, ...name('memory'), 2, 0, ...name('_initialize'), 0, 1]),
    ...section(10, [1, body.length, ...body]),
    ...section(11, [1, 0, 0x41, 0, 0x0b, data.length, ...data]),
  ]);
}

interface SchedulerOptions {
  loopKind?: 'function' | 'memory';
  start?: boolean;
}

// A real WASM reactor whose initialization schedules its exported RTS loop.
// The loop reports execution through an independent JSFFI callback.
export function schedulingReactor({
  loopKind = 'function',
  start = false,
}: SchedulerOptions = {}): Uint8Array<ArrayBuffer> {
  const exports = [
    ...name('memory'),
    2,
    0,
    ...name('_initialize'),
    0,
    2,
    ...name('rts_schedulerLoop'),
    loopKind === 'function' ? 0 : 2,
    loopKind === 'function' ? 3 : 0,
  ];
  return Uint8Array.from([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(2, [
      2,
      ...name('ghc_wasm_jsffi'),
      ...name('scheduleWork'),
      0,
      0,
      ...name('ghc_wasm_jsffi'),
      ...name('observe'),
      0,
      0,
    ]),
    ...section(3, [2, 0, 0]),
    ...section(5, [1, 0, 1]),
    ...section(7, [3, ...exports]),
    ...(start ? section(8, [2]) : []),
    ...section(10, [2, 4, 0, 0x10, 0, 0x0b, 4, 0, 0x10, 1, 0x0b]),
  ]);
}
