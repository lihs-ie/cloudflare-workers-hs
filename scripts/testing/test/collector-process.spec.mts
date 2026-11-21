import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectAudit } from '../dependency-audit.mts';
import { runDockerTests } from '../dev-docker.mts';
import { verdict } from '../mutations.mts';
import { runLogged } from '../Support/async-command.mts';
import {
  digest,
  files,
  jsonFile,
  withTemp,
  writeJson,
  type CommandRunner,
} from '../Support/cli.mts';
import { withSnapshotServer } from '../Support/snapshot-server.mts';
import { acceptSnapshot } from '../workerd-js-coverage.mts';
import {
  archiveObject,
  objectName,
  plan,
  probeStatus,
  recordReceipt,
  scope,
  validateApproval,
  validateManifest,
} from '../Support/remote-r2-manifest.mts';

for (const [testExit, copyExit, expected] of [
  [0, 0, 0],
  [0, 4, 4],
  [17, 4, 17],
]) {
  void test(`Docker exports exit codes ${testExit}/${copyExit} and removes the container`, () => {
    withTemp('test-docker-', (root) => {
      const calls: string[] = [];
      const run: CommandRunner = ([, action, ...args]) => {
        calls.push(action);

        if (action === 'build') {
          writeFileSync(args[1], 'test-image');
        }

        if (action === 'create') {
          assert.deepEqual(args, ['test-image', '--example', 'minimal']);
        }

        if (action === 'cp') {
          assert.equal(args[0], 'test-container:/work/artifacts/testing/.');
        }

        if (action === 'rm') {
          assert.deepEqual(args, ['--force', 'test-container']);
        }

        const outcomes: Record<string, number> = { start: testExit, cp: copyExit };
        return { code: outcomes[action] ?? 0, stdout: 'test-container\n', stderr: '' };
      };

      const actual = runDockerTests(root, ['--example', 'minimal'], run);

      assert.equal(actual, expected);
      assert.deepEqual(calls, ['info', 'build', 'create', 'start', 'cp', 'rm']);
      const [record] = files(join(root, 'artifacts/testing/docker'));
      assert.deepEqual(jsonFile(record), {
        image: 'test-image',
        container: 'test-container',
        command: ['node', 'scripts/testing/docker-suites.mts'],
        exitCode: expected,
        artifactCopyExitCode: copyExit,
      });
    });
  });
}

void test('a package manager launch failure leaves a sanitized unavailable audit', () => {
  const unavailable = collectAudit(() => {
    throw new Error('simulated private terminal output');
  });

  assert.deepEqual(unavailable, {
    status: 'unavailable',
    reason: 'Package manager could not complete the audit',
  });
});

void test('a missing executable and timeout leave distinct failed command evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'test-process-'));
  try {
    const failed = await runLogged(root, 'launch.log', [join(root, 'missing')], { cwd: root });
    const timed = await runLogged(
      root,
      'timeout.log',
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      {
        cwd: root,
        timeout: 100,
      },
    );

    assert.equal(failed.exitCode, 127);
    assert.equal(timed.exitCode, 124);
    assert.equal(timed.timed_out, true);
    assert.equal(failed.logSha256, digest(join(root, 'launch.log')));
    assert.equal(timed.logSha256, digest(join(root, 'timeout.log')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('mutations require a complete suite summary and corresponding exit status', () => {
  const passing = { output: '  Passed: 5\n  Failed: 0\n', exitCode: 0, timed_out: false };
  const killed = { output: '  Passed: 4, Failed: 1\n', exitCode: 1, timed_out: false };

  assert.equal(verdict(passing, true), 'passed');
  assert.equal(verdict(passing), 'survived');
  assert.equal(verdict(killed), 'killed');
  assert.equal(verdict(killed, true), 'baseline-failed');
  assert.equal(verdict({ ...passing, timed_out: true }), 'error');
  assert.equal(verdict({ ...killed, exitCode: 127 }), 'error');
  assert.equal(verdict({ ...killed, output: 'Failed to compile' }), 'error');
  assert.equal(verdict({ ...killed, output: killed.output.repeat(2) }), 'error');
});

void test('workerd HTTP uploads reject conflicting or regressing cumulative counters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'test-upload-'));
  const bundle = 'a'.repeat(16);
  const isolate = '123e4567-e89b-12d3-a456-426614174000';
  const path = 'src/check.ts';
  const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } };
  const entry = {
    path,
    statementMap: { '0': location },
    fnMap: {},
    branchMap: {},
    s: { '0': 0 },
    f: {},
    b: {},
  };
  writeJson(join(root, 'bundles', bundle, 'manifest.json'), {
    [path]: { sha256: 'test', instrumentation: 'test', coverage: entry },
  });
  const received = new Map();
  const errors: string[] = [];
  try {
    await withSnapshotServer(
      (body) => acceptSnapshot(root, received, body),
      errors,
      async (url) => {
        async function post(sequence: number, hits: number): Promise<number> {
          const response = await fetch(url, {
            method: 'POST',
            body: JSON.stringify({
              bundle,
              isolate,
              sequence,
              coverage: { [path]: { ...entry, s: { '0': hits } } },
            }),
          });
          await response.arrayBuffer();
          return response.status;
        }

        assert.equal(await post(1, 3), 204);
        assert.equal(await post(1, 3), 204);
        assert.equal(await post(1, 5), 400);
        assert.equal(await post(2, 2), 400);
        assert.equal(await post(2, 4), 204);
      },
    );

    assert.deepEqual(errors, ['Conflicting duplicate snapshot', 'Cumulative counter regressed']);
    assert.equal(received.size, 1);
    assert.deepEqual(jsonFile(join(root, 'snapshots', bundle + '-' + isolate + '.json')), {
      bundle,
      isolate,
      sequence: 2,
      coverage: { [path]: { ...entry, s: { '0': 4 } } },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const account = 'a'.repeat(32);

void test('R2 plans reserve unique owned resources and reject expanded cleanup scope', () => {
  const first = plan(account);
  const second = plan(account);
  const legacy = { ...first, schema: 1, objects: [objectName] };

  assert.notEqual(first.resource.identifier, second.resource.identifier);
  assert.deepEqual(validateManifest(first).objects, [objectName, archiveObject]);
  assert.deepEqual(validateManifest(legacy).objects, [objectName]);
  assert.throws(
    () => validateManifest({ ...first, objects: [...first.objects, 'unrelated'] }),
    /scope/,
  );
  assert.throws(
    () =>
      validateManifest({
        ...first,
        resource: { ...first.resource, identifier: 'existing-production' },
      }),
    /does not belong/,
  );
});

void test('R2 persists multipart creation intent before accepting a scoped upload receipt', () => {
  withTemp('test-r2-', (root) => {
    const manifest = plan(account);
    const path = join(root, 'run.json');
    const upload = { key: archiveObject, identifier: 'test-upload' };
    const created = { phase: 'created', ...upload };

    assert.throws(() => recordReceipt(manifest, path, created), /no creation intent/);
    recordReceipt(manifest, path, { phase: 'intent', key: archiveObject });
    assert.deepEqual(jsonFile(path), { ...manifest, multipartIntent: true });
    recordReceipt(manifest, path, created);
    assert.deepEqual(jsonFile(path), { ...manifest, multipart: [upload], multipartIntent: false });
    assert.throws(() => recordReceipt(manifest, path, created), /no creation intent/);
    assert.throws(
      () => recordReceipt(manifest, path, { phase: 'closed', ...upload, identifier: 'different' }),
      /Unknown closed upload/,
    );
    recordReceipt(manifest, path, { phase: 'closed', ...upload });
    assert.deepEqual(jsonFile(path), { ...manifest, multipartClosed: true });
  });
});

void test('R2 approval requires an acknowledged budget for the exact probe scope', () => {
  const approved = {
    account,
    scope,
    approvedBy: 'operator',
    approvedAt: '2026-09-08T00:00:00Z',
    approvedBudgetUsd: 5,
    acknowledgeNotHardCap: true,
  };

  assert.doesNotThrow(() => validateApproval(approved, account));
  assert.throws(() => validateApproval({ ...approved, scope: 'remote-r2-ssec' }, account), /scope/);
  assert.throws(
    () => validateApproval({ ...approved, acknowledgeNotHardCap: false }, account),
    /acknowledgement/,
  );
  for (const invalid of [true, 0, Infinity, NaN]) {
    assert.throws(
      () => validateApproval({ ...approved, approvedBudgetUsd: invalid }, account),
      /budget/,
    );
  }
  assert.equal(
    probeStatus({ positiveChecksPassed: true, negativeProof: 'unverified' }),
    'incomplete',
  );
});
