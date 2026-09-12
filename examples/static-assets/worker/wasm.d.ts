declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "*-jsffi.mjs" {
  export default function makeImports(
    exports: Record<string, unknown>,
  ): WebAssembly.ModuleImports;
}

// The runtime uses a sibling package path so Wrangler can share dependencies.
// Resolve its published declarations, rather than treating that JS path as any.
declare module "*browser_wasi_shim/dist/index.js" {
  export const WASI: typeof import("../../quickstart/node_modules/@bjorn3/browser_wasi_shim/typings/index.js").WASI;
  export const ConsoleStdout: typeof import("../../quickstart/node_modules/@bjorn3/browser_wasi_shim/typings/index.js").ConsoleStdout;
  export const File: typeof import("../../quickstart/node_modules/@bjorn3/browser_wasi_shim/typings/index.js").File;
  export const OpenFile: typeof import("../../quickstart/node_modules/@bjorn3/browser_wasi_shim/typings/index.js").OpenFile;
}
