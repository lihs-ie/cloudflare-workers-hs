import { ConsoleStdout, File, OpenFile, WASI } from '@bjorn3/browser_wasi_shim';

/** Reactor output destinations. */
export interface ReactorOptions {
  /** Receives complete stdout lines; defaults to console.log. */
  stdout?: (line: string) => void;
  /** Receives complete stderr lines; defaults to console.error. */
  stderr?: (line: string) => void;
}

/**
 * Initializes a WASI reactor and constructs a validated application adapter.
 * @typeParam T - Adapter inferred from the binding callback.
 * @param module - Compiled reactor module.
 * @param makeImports - Generated JSFFI factory receiving a shared export table.
 * @param bind - Constructs application methods using checked exports and decoders.
 * @param options - Output destinations.
 * @returns The application adapter after WASI initialization.
 * @throws TypeError when required WASI or scheduler exports are invalid.
 */
export async function createReactor<T>(
  module: WebAssembly.Module,
  makeImports: (exports: Record<string, unknown>) => WebAssembly.ModuleImports,
  bind: (exports: Record<string, unknown>) => T,
  options: ReactorOptions = {},
): Promise<T> {
  const exports: Record<string, unknown> = {};
  const wasi = new WASI(
    [],
    [],
    [
      new OpenFile(new File([])),
      ConsoleStdout.lineBuffered(options.stdout ?? console.log),
      ConsoleStdout.lineBuffered(options.stderr ?? console.error),
    ],
    { debug: false },
  );
  const imports = makeImports(exports);
  const hasScheduler =
    Object.hasOwn(imports, 'scheduleWork') && typeof imports.scheduleWork === 'function';
  let schedulerLoop: (() => void) | undefined;
  let jsffi = imports;

  if (hasScheduler) {
    const bridge = {
      scheduleWork: () => {
        const callback = schedulerLoop;
        if (callback === undefined) {
          throw new TypeError('Reactor scheduler is not initialized');
        }

        setTimeout(() => callback(), 0);
      },
    };
    Object.setPrototypeOf(bridge, imports);
    jsffi = bridge;
  }

  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
    ghc_wasm_jsffi: jsffi,
  });
  Object.assign(exports, instance.exports);
  const memory = exports.memory;
  const initialize = exports._initialize;

  if (!(memory instanceof WebAssembly.Memory)) {
    throw new TypeError('Reactor must export memory');
  }

  if (typeof initialize !== 'function') {
    throw new TypeError('Reactor must export function _initialize');
  }

  if (hasScheduler) {
    const loop = exports.rts_schedulerLoop;
    if (typeof loop !== 'function') {
      throw new TypeError('Reactor must export function rts_schedulerLoop');
    }

    schedulerLoop = () => {
      loop();
    };
  }

  wasi.initialize({ exports: { memory, _initialize: () => initialize() } });
  return bind(exports);
}
