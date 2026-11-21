import { coverageEntrySchema } from './coverage-schema.mts';
import type { CoverageEntry } from './coverage-schema.mts';
import { z } from 'zod';
import { jsonValue } from './json.mts';
/** One instrumentation pipeline for authored TypeScript in Node and workerd. */
import { createHash } from 'node:crypto';
import { createInstrumenter } from 'istanbul-lib-instrument';
import { transformSync } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../../../package.json', import.meta.url));

export const instrumentationIdentity = createHash('sha256')
  .update(readFileSync(new URL(import.meta.url)))
  .update(
    JSON.stringify([
      z.object({ version: z.string() }).parse(require('esbuild/package.json')).version,
      z.object({ version: z.string() }).parse(require('istanbul-lib-instrument/package.json'))
        .version,
    ]),
  )
  .digest('hex');

export function instrumentTypeScript(
  source: string,
  filename: string,
): {
  code: string;
  manifest: { instrumentation: string; sha256: string; coverage: CoverageEntry };
} {
  const transpiled = transformSync(source, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
    sourcemap: 'external',
    sourcefile: filename,
    sourcesContent: true,
  });
  const instrumenter = createInstrumenter({
    esModules: true,
    produceSourceMap: true,
    coverageVariable: '__workerdCoverage__',
  });
  const code = instrumenter.instrumentSync(
    transpiled.code,
    filename,
    z
      .object({
        version: z.number().transform(String),
        file: z.string().default(''),
        sources: z.array(z.string()),
        names: z.array(z.string()),
        mappings: z.string(),
        sourceRoot: z.string().optional(),
        sourcesContent: z.array(z.string()).optional(),
      })
      .parse(jsonValue(transpiled.map)),
  );
  return {
    code:
      code +
      '\n//# sourceMappingURL=data:application/json;base64,' +
      Buffer.from(JSON.stringify(instrumenter.lastSourceMap())).toString('base64'),
    manifest: {
      instrumentation: instrumentationIdentity,
      sha256: createHash('sha256').update(source).digest('hex'),
      coverage: coverageEntrySchema.parse(instrumenter.lastFileCoverage()),
    },
  };
}
