import { z } from 'zod';

const position = z.object({ line: z.number(), column: z.number() });
const location = z.object({ start: position, end: position });
const functionLocation = z.object({
  name: z.string(),
  decl: location,
  loc: location,
  line: z.number().optional(),
});
const branchLocation = z.object({
  type: z.string(),
  loc: location,
  locations: z.array(z.object({ start: position.partial(), end: position.partial() })),
  line: z.number().optional(),
});

export const coverageEntrySchema = z
  .object({
    path: z.string(),
    statementMap: z.record(z.string(), location),
    fnMap: z.record(z.string(), functionLocation),
    branchMap: z.record(z.string(), branchLocation),
    s: z.record(z.string(), z.number()),
    f: z.record(z.string(), z.number()),
    b: z.record(z.string(), z.array(z.number())),
    inputSourceMap: z.unknown().optional(),
  })
  .passthrough();

export type CoverageEntry = z.infer<typeof coverageEntrySchema>;
export const manifestSchema = z.record(
  z.string(),
  z.object({
    sha256: z.string(),
    instrumentation: z.string(),
    coverage: coverageEntrySchema,
  }),
);
export type InstrumentationManifest = z.infer<typeof manifestSchema>;
export const snapshotSchema = z
  .object({ coverage: z.record(z.string(), coverageEntrySchema) })
  .passthrough();
export const proofSchema = z.object({
  sources: z.record(z.string(), z.string()),
  exit_code: z.number(),
  errors: z.array(z.unknown()),
  commands: z.array(
    z.object({
      command: z.array(z.string()),
      exitCode: z.number(),
      log: z.string(),
      logSha256: z.string(),
    }),
  ),
  sha256: z.string(),
  manifests: z.record(z.string(), z.string()),
  snapshots: z.record(z.string(), z.string()),
});
export const mergedProofSchema = z.object({
  sources: z.record(z.string(), z.string()),
  exit_code: z.number(),
  errors: z.array(z.unknown()),
  inputs: z.array(
    z.object({ kind: z.string(), proof: z.string(), sha256: z.string(), reportSha256: z.string() }),
  ),
  sha256: z.string(),
  workerdOnlySha256: z.string(),
});

export { jsonValue } from './json.mts';

export function coverageData(
  entry: CoverageEntry,
): import('istanbul-lib-coverage').FileCoverageData {
  return {
    ...entry,
    fnMap: Object.fromEntries(
      Object.entries(entry.fnMap).map(([name, mapping]) => [
        name,
        { ...mapping, line: mapping.line ?? mapping.loc.start.line },
      ]),
    ),
    branchMap: Object.fromEntries(
      Object.entries(entry.branchMap).map(([name, mapping]) => [
        name,
        {
          ...mapping,
          line: mapping.line ?? mapping.loc.start.line,
          locations: mapping.locations.map((loc) => ({
            start: {
              line: loc.start.line ?? mapping.loc.start.line,
              column: loc.start.column ?? mapping.loc.start.column,
            },
            end: {
              line: loc.end.line ?? mapping.loc.end.line,
              column: loc.end.column ?? mapping.loc.end.column,
            },
          })),
        },
      ]),
    ),
  };
}
