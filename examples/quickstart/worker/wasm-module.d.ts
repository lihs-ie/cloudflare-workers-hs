// Wrangler resolves WASM imports to compiled modules.
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
