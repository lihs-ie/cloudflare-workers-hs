/** Test-only workerd instrumentation. Normal Wrangler configs are untouched. */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { instrumentTypeScript } from "./shared_js_instrumentation.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(root, "package.json"));

export async function instrumentConfig(configPath, mainOverride) {
  if (!process.env.WORKERD_JS_COVERAGE_ENDPOINT) {
    return { config: configPath, close: async () => {} };
  }
  const { build } = require("esbuild");
  const { parse } = createRequire(path.join(root, "examples/quickstart/package.json"))("jsonc-parser");
  const original = path.resolve(configPath);
  const configuration = parse(await readFile(original, "utf8"));
  const entry = path.resolve(path.dirname(original), mainOverride ?? configuration.main);
  const example = entry.match(/examples\/([^/]+)\//)?.[1];
  if (!example) { throw new Error("Coverage entry must belong to an example"); }
  const output = path.resolve(process.env.WORKERD_JS_COVERAGE_DIRECTORY);
  if (!output.startsWith(path.join(root, "artifacts/testing/"))) { throw new Error("Coverage output must be in artifacts/testing"); }
  const identifier = createHash("sha256").update(original).digest("hex").slice(0, 16);
  const directory = path.join(output, "bundles", identifier);
  await mkdir(directory, { recursive: true });
  const manifest = {};
  const result = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, metafile: true,
    external: ["cloudflare:*", "node:*"], sourcemap: "inline", outfile: path.join(directory, "instrumented.mjs"),
    plugins: [{ name: "authored-worker-coverage", setup(builder) {
      builder.onResolve({ filter: /\.wasm$/ }, args => ({ path: path.resolve(args.resolveDir, args.path), external: true }));
      builder.onLoad({ filter: /\.ts$/ }, async args => {
        const relative = path.relative(root, args.path);
        if (!relative.startsWith(`examples/${example}/`) || relative.endsWith(".d.ts")) { return; }
        const source = await readFile(args.path, "utf8");
        const instrumented = instrumentTypeScript(source, args.path);
        manifest[args.path] = instrumented.manifest;
        return { contents: instrumented.code, loader: "js", resolveDir: path.dirname(args.path) };
      });
    } }],
  });
  await writeFile(path.join(directory, "instrumented.mjs"), result.outputFiles[0].contents);
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  const names = Object.values(result.metafile.outputs).flatMap(value => value.exports).filter(name => name !== "default");
  if (names.some(name => !/^[A-Za-z_$][\w$]*$/.test(name))) { throw new Error("Unsupported export name"); }
  const runtime = await readFile(path.join(root, "scripts/testing/Support/workerd_js_runtime.mjs"), "utf8");
  const wrapper = `import * as original from './instrumented.mjs';\nconst endpoint=${JSON.stringify(process.env.WORKERD_JS_COVERAGE_ENDPOINT)};\nconst bundle=${JSON.stringify(identifier)};\n${runtime}\n` + names.map(name => `export const ${name}=wrapClass(original.${name});`).join("\n") + "\nexport default wrapHandler(original.default);\n";
  await writeFile(path.join(directory, "entry.mjs"), wrapper);
  configuration.main = path.join(directory, "entry.mjs");
  delete configuration.build;
  configuration.rules = [...(configuration.rules ?? []), { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true }];
  const temporary = path.join(path.dirname(original), `.dev-test-js-coverage-${process.pid}-${identifier}.json`);
  await writeFile(temporary, JSON.stringify(configuration));
  return { config: temporary, close: () => rm(temporary, { force: true }) };
}
