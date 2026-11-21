import type * as Module from 'node:module';
import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

declare global {
  var testModuleBoundaryRegistry: Map<string, Record<string, unknown>> | undefined;
}
const registry = (globalThis.testModuleBoundaryRegistry ??= new Map<
  string,
  Record<string, unknown>
>());
let serial = 0;

/** Replace an imported dependency without rewriting the importing module's bytes. */
export function moduleBoundary(
  specifier: string | URL,
  {
    namedExports = {},
    defaultExport,
  }: { namedExports?: Record<string, unknown>; defaultExport?: unknown } = {},
): { restore(): void } {
  const provided = String(specifier);
  const target = provided.startsWith('file:')
    ? pathToFileURL(realpathSync(fileURLToPath(provided))).href
    : provided;
  const identifier = `${process.pid}-${serial++}`;
  const url = `test-boundary:${identifier}`;
  const exports: Record<string, unknown> = { ...namedExports };

  if (defaultExport !== undefined) {
    exports.default = defaultExport;
  }

  registry.set(identifier, exports);
  const declarations = Object.keys(exports)
    .map((name, index) => {
      const binding = `value${index}`;
      return `const ${binding} = values[${JSON.stringify(name)}]; export { ${binding} as ${name} };`;
    })
    .join('\n');
  const source = `const values = globalThis.testModuleBoundaryRegistry.get(${JSON.stringify(identifier)});\n${declarations}\n`;
  const hooks = registerHooks({
    resolve(
      request: string,
      context: Module.ResolveHookContext,
      next: (
        specifier: string,
        context?: Partial<Module.ResolveHookContext>,
      ) => Module.ResolveFnOutput,
    ): import('module').ResolveFnOutput {
      if (request === target) {
        return { url, shortCircuit: true };
      }

      const resolved = next(request, context);

      if (resolved.url === target) {
        return { url, shortCircuit: true };
      }

      return resolved;
    },
    load(
      request: string,
      context: Module.LoadHookContext,
      next: (url: string, context?: Partial<Module.LoadHookContext>) => Module.LoadFnOutput,
    ): import('module').LoadFnOutput {
      if (request === url) {
        return { format: 'module', source, shortCircuit: true };
      }

      return next(request, context);
    },
  });
  return {
    restore(): void {
      hooks.deregister();
      registry.delete(identifier);
    },
  };
}
