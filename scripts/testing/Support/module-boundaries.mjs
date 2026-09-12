import { registerHooks } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const registryKey = Symbol.for("cloudflare-workers-hs.test-module-boundaries");
const registry = globalThis[registryKey] ??= new Map();
let serial = 0;

/** Replace an imported dependency without rewriting the importing module's bytes. */
export function moduleBoundary(specifier, { namedExports = {}, defaultExport } = {}) {
  const provided = String(specifier);
  const target = provided.startsWith("file:") ? pathToFileURL(realpathSync(fileURLToPath(provided))).href : provided;
  const identifier = `${process.pid}-${serial++}`;
  const url = `test-boundary:${identifier}`;
  const exports = { ...namedExports };
  if (defaultExport !== undefined) {
    exports.default = defaultExport;
  }
  registry.set(identifier, exports);
  const declarations = Object.keys(exports).map((name, index) => {
    const binding = `value${index}`;
    return `const ${binding} = values[${JSON.stringify(name)}]; export { ${binding} as ${name} };`;
  }).join("\n");
  const source = `const values = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(registryKey))})].get(${JSON.stringify(identifier)});\n${declarations}\n`;
  const hooks = registerHooks({
    resolve(request, context, next) {
      if (request === target) {
        return { url, shortCircuit: true };
      }
      const resolved = next(request, context);
      if (resolved.url === target) {
        return { url, shortCircuit: true };
      }
      return resolved;
    },
    load(request, context, next) {
      if (request === url) {
        return { format: "module", source, shortCircuit: true };
      }
      return next(request, context);
    },
  });
  return { restore() { hooks.deregister(); registry.delete(identifier); } };
}
