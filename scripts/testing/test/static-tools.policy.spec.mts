import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { auditOutcome, changesDependencies } from '../dependency-audit.mts';
import { consumerErrors, exposedModules, manifestErrors } from '../internal-module-boundaries.mts';
import { maskMultilineJavaScriptFfi } from '../hlint-multiline-javascript-ffi.mts';
import { registration } from '../registration.mts';
import { violations } from '../test-boundaries.mts';
import { textFile, withTemp, type CommandRunner } from '../Support/cli.mts';

function fixture(root: string, file: string, source: string): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

const layer = 'pkg/test/unit';
const entry = layer + '/HTTPSpec.hs';
const child = layer + '/HTTP/RequestCases.hs';
const header = 'module HTTPSpec where\nimport HTTP.RequestCases qualified as Request\n';

for (const scenario of [
  { name: 'direct use', body: 'spec = Request.spec\n', expected: undefined },
  {
    name: 'comment-only use',
    body: '-- Request.spec\nspec = pure ()\n',
    expected: /registered 0 times/,
  },
  { name: 'string-only use', body: 'spec = pure "Request.spec"\n', expected: /registered 0 times/ },
  {
    name: 'duplicate call',
    body: 'spec = Request.spec >> Request.spec\n',
    expected: /registered 2 times/,
  },
]) {
  void test(`Haskell registration identifies the child and handles ${scenario.name}`, () => {
    withTemp('registration-', (root) => {
      fixture(root, entry, header + scenario.body);
      fixture(root, child, 'module HTTP.RequestCases where\nspec = pure ()\n');

      const result = registration(root, [layer]);

      assert.deepEqual(result.inventory[0].children, [child]);

      if (scenario.expected === undefined) {
        assert.deepEqual(result.errors, []);
      } else {
        assert.match(result.errors.join('\n'), scenario.expected);
      }
    });
  });
}

for (const extension of ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']) {
  void test(`registration records exactly one owner for ${extension} cases`, () => {
    withTemp('registration-', (root) => {
      const source = `import { registerRuntime } from './a.cases${extension}';\nregisterRuntime();\n`;
      fixture(root, `${layer}/a.cases${extension}`, 'export function registerRuntime() {}');
      fixture(root, `${layer}/a.spec${extension}`, source);
      fixture(root, `pkg/test/Support/a.spec${extension}`, '');

      const result = registration(root, [layer]);

      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.inventory[0].children, [`${layer}/a.cases${extension}`]);

      fixture(root, `${layer}/b.spec${extension}`, source);

      assert.match(registration(root, [layer]).errors.join('\n'), /2 owners/);
    });
  });
}

void test('registration rejects unowned, unresolved and undeclared modules', () => {
  withTemp('registration-', (root) => {
    fixture(root, entry, header + 'spec = Request.spec\n');
    fixture(root, layer + '/OtherCases.hs', 'module OtherCases where\nspec = pure ()');
    fixture(root, 'pkg/pkg.cabal', 'other-modules: HTTPSpec\n');

    const { errors } = registration(root, [layer, 'absent', layer]);

    for (const diagnostic of [
      /unresolved test module/,
      /0 owners/,
      /module absent/,
      /missing required/,
      /duplicate test layer/,
    ]) {
      assert.match(errors.join('\n'), diagnostic);
    }
  });
});

for (const [file, content, diagnostic] of [
  [
    'cloudflare-workers/test/contract.ts',
    "import x from '../../examples/minimal/src/no.ts';",
    /imports an example/,
  ],
  [
    'scripts/testing/Support/contract.mts',
    "import('./../../../examples/minimal/test/fixture.ts');",
    /imports an example/,
  ],
  [
    'examples/minimal/worker/index.ts',
    "import x from '../test/fixture.ts';",
    /production imports test support/,
  ],
  ['tests/runtime/harness.ts', "import x from '../../../outside.ts';", /import escapes/],
  [
    'tests/runtime/runtime-contracts.cabal',
    'hs-source-dirs: ../../examples/minimal/src',
    /depends on example/,
  ],
  [
    'cloudflare-workers/test/Probe.hs',
    'import ApiCatalog.API qualified as API\n',
    /imports an example module/,
  ],
  ['examples/minimal/test/fixture.mjs', 'export {};', /handwritten JavaScript/],
] as const) {
  void test(`ownership rejects ${file} when it crosses its boundary`, () => {
    withTemp('ownership-', (root) => {
      fixture(root, file, content);

      const result = violations(root);

      assert.equal(result.length, 1);
      assert.match(result[0], diagnostic);
    });
  });
}

void test('ownership permits generated fixtures and library-owned fixtures in the runtime harness', () => {
  withTemp('ownership-', (root) => {
    fixture(root, 'examples/minimal/worker/minimal-jsffi.mjs', 'export {};');
    fixture(root, 'examples/minimal/node_modules/example/index.mjs', 'export {};');
    fixture(
      root,
      'tests/runtime/harness.ts',
      "import x from '../../cloudflare-workers/test/Support/fixture.ts';",
    );

    assert.deepEqual(violations(root), []);
  });
});

void test('manifest reading handles continued fields, comments and multiple components', () => {
  const manifest = `library
  exposed-modules: Public.First, Public.Second -- ignored.Comment
    Public.Third
  other-modules: Public.Internal.Hidden
library helper
  exposed-modules:
    Helper.Public
`;

  const modules = exposedModules(manifest);

  assert.deepEqual(modules, ['Public.First', 'Public.Second', 'Public.Third', 'Helper.Public']);
});

void test('missing manifests and exposed Internal modules fail the manifest gate', () => {
  withTemp('compiler-boundary-', (root) => {
    fixture(
      root,
      'cloudflare-workers/cloudflare-workers.cabal',
      'library\n  exposed-modules: Public.Internal.Hidden\n',
    );

    const result = manifestErrors(root);

    assert.equal(result.length, 4);
    assert.match(result[0], /must be in other-modules/);
    assert.match(result[1], /missing Cabal file/);
  });
});

for (const [mode, expected] of [
  ['hidden', 0],
  ['public-broken', 1],
  ['build-broken', 1],
  ['exposed', 4],
  ['unrelated', 4],
] as const) {
  void test(`consumer probes distinguish ${mode} diagnostics`, () => {
    let calls = 0;
    const run: CommandRunner = (argv) => {
      calls += 1;

      if (calls <= 2) {
        return {
          code: Number(mode === 'build-broken' || (calls === 2 && mode === 'public-broken')),
          stdout: '',
          stderr: 'compiler',
        };
      }

      const file = argv.at(-1);
      assert.ok(file);
      const name = /^import qualified (.+)$/m.exec(textFile(file))?.[1];
      return {
        code: mode === 'exposed' ? 0 : 1,
        stdout: '',
        stderr: mode === 'hidden' ? `hidden module ${name}` : 'parse error',
      };
    };

    const errors = consumerErrors('.', run);

    assert.equal(errors.length, expected);
    const stoppedAfterBuild = mode === 'build-broken';
    const consumerCalls = mode === 'public-broken' ? 2 : 6;
    assert.equal(calls, stoppedAfterBuild ? 1 : consumerCalls);
  });
}

void test('HLint masks JS FFI strings while preserving line and column positions', () => {
  const source = [
    'module Probe where',
    'foreign import javascript unsafe',
    '  """',
    '  const value = $1;',
    '  """ fn :: IO ()',
    'ordinary = id',
    '',
  ].join('\r\n');

  const masked = maskMultilineJavaScriptFfi(source);

  assert.equal(masked.length, source.length);
  assert.equal(masked.split('\r\n').length, source.split('\r\n').length);
  assert.deepEqual(masked.split('\r\n').slice(2, 6), [
    '  "" ',
    ' '.repeat(19),
    '      fn :: IO ()',
    'ordinary = id',
  ]);
});

for (const [paths, expected] of [
  [['README.md', 'cloudflare-workers/src/File.hs'], false],
  [['examples/url-shortener/package.json'], true],
  [['.github/workflows/test.yml'], true],
  [['docker/dev-tests.Dockerfile'], true],
  [['nix/js-toolchain.nix'], true],
  [['pnpm-lock.yaml'], true],
] as const) {
  void test(`dependency audit policy classifies ${paths.join(', ')}`, () => {
    assert.equal(changesDependencies(paths), expected);
  });
}

for (const [advisories, code, status] of [
  [{ high: 0, critical: 0 }, 0, 'passed'],
  [{ high: 1, critical: 0 }, 1, 'vulnerabilities'],
  [{ high: 0, critical: 1 }, 0, 'vulnerabilities'],
  [{ high: 0, critical: 0 }, 1, 'unavailable'],
  [{ high: true, critical: 0 }, 0, 'unavailable'],
] as const) {
  void test(`dependency audit classifies ${JSON.stringify(advisories)} and exit ${code}`, () => {
    const response = JSON.stringify({ metadata: { vulnerabilities: advisories } });

    const outcome = auditOutcome({ code, stdout: response, stderr: '' });

    assert.equal(outcome.status, status);
  });
}

void test('audit registry errors do not look like a passing result', () => {
  const result = auditOutcome({ code: 1, stdout: '<registry 503>', stderr: '' });

  assert.equal(result.status, 'unavailable');
});
