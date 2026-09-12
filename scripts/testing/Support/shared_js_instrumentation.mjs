/** One instrumentation pipeline for authored TypeScript in Node and workerd. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { transformSync } = require("esbuild");
const { createInstrumenter } = require("istanbul-lib-instrument");

export const instrumentationIdentity = createHash("sha256")
  .update(readFileSync(new URL(import.meta.url)))
  .update(JSON.stringify([require("esbuild/package.json").version, require("istanbul-lib-instrument/package.json").version]))
  .digest("hex");

export function instrumentTypeScript(source, filename) {
  const transpiled = transformSync(source, {
    loader: "ts", format: "esm", target: "es2022", sourcemap: "external",
    sourcefile: filename, sourcesContent: true,
  });
  const instrumenter = createInstrumenter({
    esModules: true, produceSourceMap: true, coverageVariable: "__workerdCoverage__",
  });
  const code = instrumenter.instrumentSync(transpiled.code, filename, JSON.parse(transpiled.map));
  return {
    code: code + "\n//# sourceMappingURL=data:application/json;base64," + Buffer.from(JSON.stringify(instrumenter.lastSourceMap())).toString("base64"),
    manifest: { instrumentation: instrumentationIdentity, sha256: createHash("sha256").update(source).digest("hex"), coverage: instrumenter.lastFileCoverage() },
  };
}
