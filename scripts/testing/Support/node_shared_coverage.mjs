/** Node preload for coverage comparable to workerd; never claims platform execution. */
import { registerHooks } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";
import { instrumentTypeScript } from "./shared_js_instrumentation.mjs";

const directory = process.env.SHARED_JS_COVERAGE_DIRECTORY;
if (directory) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  // Prime Babel lazy dependencies before consumer hooks can rewrite their imports.
  instrumentTypeScript(
    "export const coverageWarmup = true;",
    path.join(root, "coverage-warmup.ts"),
  );
  const inputs = process.env.SHARED_JS_COVERAGE_INPUTS
    ? new Set(
        JSON.parse(readFileSync(process.env.SHARED_JS_COVERAGE_INPUTS, "utf8")),
      )
    : null;
  const manifest = {};
  const identifier = `${process.pid}-${threadId}-${randomUUID()}`;
  mkdirSync(directory, { recursive: true });
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.startsWith("file:")) {
        return loaded;
      }
      const filename = fileURLToPath(url);
      const relative = path.relative(root, filename);
      if (
        !relative.startsWith(`examples${path.sep}`) ||
        !/\.(?:ts|mts|mjs|js)$/.test(filename) ||
        /\.d\.(?:ts|mts)$/.test(filename) ||
        filename.endsWith("-jsffi.mjs") ||
        relative
          .split(path.sep)
          .some((part) =>
            ["node_modules", ".wrangler", "test-artifacts"].includes(part),
          ) ||
        (inputs && !inputs.has(relative))
      ) {
        return loaded;
      }
      const source = readFileSync(filename, "utf8");
      // Substituted modules are test doubles, not execution of the authored file.
      const loadedSource =
        typeof loaded.source === "string"
          ? loaded.source
          : loaded.source == null
            ? null
            : Buffer.from(loaded.source).toString("utf8");
      if (loadedSource !== source) {
        return loaded;
      }
      const instrumented = instrumentTypeScript(source, filename);
      manifest[filename] = instrumented.manifest;
      return { ...loaded, format: "module", source: instrumented.code };
    },
  });
  process.once("exit", () => {
    if (Object.keys(manifest).length === 0) {
      return;
    }
    const bundle = path.join(directory, "bundles", identifier);
    const snapshots = path.join(directory, "snapshots");
    mkdirSync(bundle, { recursive: true });
    mkdirSync(snapshots, { recursive: true });
    writeFileSync(
      path.join(bundle, "manifest.json"),
      JSON.stringify(manifest),
      { flag: "wx" },
    );
    writeFileSync(
      path.join(snapshots, `${identifier}.json`),
      JSON.stringify({ coverage: globalThis.__workerdCoverage__ ?? {} }),
      { flag: "wx" },
    );
  });
}
