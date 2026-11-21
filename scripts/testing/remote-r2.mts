import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { command, digest, jsonFile, repositoryRoot, runCli, writeJson } from './Support/cli.mts';
import {
  plan,
  probeStatus,
  recordReceipt,
  saveManifest,
  validateApproval,
  validateManifest,
  type Manifest,
} from './Support/remote-r2-manifest.mts';
import { withSnapshotServer } from './Support/snapshot-server.mts';
import { startWorkerProcess } from './Support/worker-process.mts';
import { object, string } from './Support/validation.mts';

const root = repositoryRoot;
const wrangler = join(root, 'node_modules/.bin/wrangler');
const example = join(root, 'examples/api-catalog');

function environment(account: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: account,
    WRANGLER_SEND_METRICS: 'false',
    CI: 'true',
  };
}

async function api(
  account: string,
  method: 'GET' | 'POST' | 'DELETE',
  bucket?: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; result?: unknown }> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error('CLOUDFLARE_API_TOKEN is required for execution or cleanup');
  }

  const suffix = bucket === undefined ? '' : '/' + encodeURIComponent(bucket);
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets${suffix}`;
  const response = await fetch(url, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    body: body && JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  if (!response.ok || response.status === 204) {
    return { status: response.status };
  }

  const data = object(await response.json());
  if (data.success !== true) {
    throw new Error('Cloudflare operation rejected');
  }

  return { status: response.status, result: data.result };
}

function safeStartupDetails(manifest: Manifest, error: unknown): void {
  const text = error instanceof Error ? error.message : '';
  manifest.startupErrorKinds =
    text.match(
      /Could not resolve|Cannot find module|No such file|Unsupported|not exported|No matching export/g,
    ) ?? [];
  manifest.startupDiagnostics = {
    exitCode: Number(/^Wrangler exited (\d+)/.exec(text)?.[1]) || null,
    cloudflareCodes: [...text.matchAll(/\[code: (\d+)\]/g)].map((match) => match[1]),
    flags: [
      'Authentication',
      'permission',
      'resolve',
      'compatibility',
      'CLOUDFLARE_API_TOKEN',
      'login',
      'SyntaxError',
      'workers.dev',
    ].filter((flag) => text.includes(flag)),
  };
}

async function runWorker(
  manifest: Manifest,
  entry: 'cleanup-probe.ts' | 'ssec-probe.ts',
  variables: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const directory = mkdtempSync(join(tmpdir(), 'hs-remote-r2-'));
  const account = string(manifest.account);
  const bucket = manifest.resource.identifier;
  const config = join(directory, 'wrangler.json');
  try {
    const settings = object(jsonFile(join(example, 'wrangler.jsonc')));
    writeJson(config, {
      name: bucket,
      account_id: account,
      main: join(example, 'test/Support/Remote', entry),
      compatibility_date: string(settings.compatibility_date),
      compatibility_flags: ['nodejs_compat'],
      rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'] }],
      vars: {
        EXAMPLE_MODE: 'remote-test',
        EXAMPLE_SECRET: 'non-sensitive-test-marker',
        ...variables,
      },
      r2_buckets: [{ binding: 'EXAMPLE_BUCKET', bucket_name: bucket, remote: true }],
    });
    const worker = await startWorkerProcess({
      directory,
      artifactDirectory: directory,
      startupTimeout: 120_000,
      shutdownTimeout: 10_000,
      environment: environment(account),
      command(port: number, state: string): { executable: string; arguments: string[] } {
        return {
          executable: wrangler,
          arguments: [
            'dev',
            '--config',
            config,
            '--ip',
            '127.0.0.1',
            '--port',
            String(port),
            '--persist-to',
            state,
          ],
        };
      },
    }).catch((error: unknown) => {
      safeStartupDetails(manifest, error);
      throw new Error('Wrangler stopped before probe readiness; logs omitted');
    });
    try {
      const result = await fetch(worker.base + '/run', {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!result.ok && result.status !== 500) {
        throw new Error('Unexpected probe HTTP status');
      }

      return object(await result.json());
    } finally {
      await worker.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function cleanup(manifest: Manifest, path: string): Promise<void> {
  const { resource } = manifest;

  if (resource.state === 'deleted') {
    return;
  }

  if (resource.state !== 'created' && resource.state !== 'cleanup-pending') {
    throw new Error('Creation is unconfirmed; refuse automatic deletion');
  }

  const account = string(manifest.account);
  resource.state = 'cleanup-pending';
  saveManifest(path, manifest);

  if (manifest.multipartIntent) {
    throw new Error('Multipart creation is unconfirmed; reconcile before cleanup');
  }

  if (manifest.multipart.length > 0 && !manifest.multipartClosed) {
    const result = await runWorker(
      manifest,
      'cleanup-probe.ts',
      {},
      { uploads: manifest.multipart },
    );
    if (result.passed !== true) {
      throw new Error('Multipart abort failed; receipts retained');
    }

    manifest.multipartClosed = true;
    saveManifest(path, manifest);
  }

  for (const key of manifest.objects) {
    const result = command(
      [wrangler, 'r2', 'object', 'delete', resource.identifier + '/' + key, '--remote'],
      { cwd: root, env: environment(account), timeout: 60_000, stdio: 'ignore' },
    );
    if (result.code !== 0 && (await api(account, 'GET', resource.identifier)).status !== 404) {
      throw new Error('Object cleanup failed; manifest retained');
    }
  }

  const deleted = await api(account, 'DELETE', resource.identifier);
  if (![200, 204, 404].includes(deleted.status)) {
    throw new Error('Bucket cleanup failed; manifest retained');
  }

  resource.state = 'deleted';
  saveManifest(path, manifest);
}

function verifyBuild(): { manifestSha256: string } {
  const result = command(
    [
      'node',
      '--input-type=module',
      '-e',
      'import { verifyBuild } from "./examples/api-catalog/test/Support/build-manifest.mts"; verifyBuild();',
    ],
    { cwd: root, timeout: 30_000, stdio: 'ignore' },
  );
  if (result.code !== 0) {
    throw new Error('Production WASM build verification failed; rebuild api-catalog');
  }

  return { manifestSha256: digest(join(example, 'worker/build.json')) };
}

async function execute(manifest: Manifest, path: string): Promise<number> {
  const account = string(manifest.account);
  const { resource } = manifest;

  if ((await api(account, 'GET', resource.identifier)).status !== 404) {
    throw new Error('Expected absent dedicated bucket');
  }

  resource.state = 'create-pending';
  saveManifest(path, manifest);
  const created = await api(account, 'POST', undefined, {
    name: resource.identifier,
    storageClass: 'Standard',
  });
  if (![200, 201].includes(created.status) || object(created.result).name !== resource.identifier) {
    throw new Error('Creation unconfirmed; manifest retained for reconciliation');
  }

  resource.state = 'created';
  saveManifest(path, manifest);
  try {
    const receiptErrors: string[] = [];
    manifest.result = await withSnapshotServer(
      (body) => recordReceipt(manifest, path, JSON.parse(body)),
      receiptErrors,
      async (callback) => await runWorker(manifest, 'ssec-probe.ts', { RECEIPT_URL: callback }, {}),
      4096,
    );
    manifest.status = receiptErrors.length === 0 ? probeStatus(manifest.result) : 'failed';
  } catch (error) {
    manifest.status = 'failed';
    const reason = error instanceof Error ? error.message : '';
    const safe = [
      'Wrangler stopped before probe readiness; logs omitted',
      'Unexpected probe HTTP status',
    ];
    manifest.result = {
      passed: false,
      reason: safe.includes(reason) ? reason : 'probe-failed-details-omitted',
    };
  } finally {
    saveManifest(path, manifest);
    await cleanup(manifest, path);
  }

  return manifest.status === 'passed' ? 0 : 1;
}

runCli(
  import.meta.url,
  '[plan|execute|cleanup] [--account ACCOUNT] [--approval FILE] [--manifest FILE]',
  async () => {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        account: { type: 'string' },
        approval: { type: 'string' },
        manifest: { type: 'string' },
      },
    });
    const [mode = 'plan'] = positionals;

    if (positionals.length > 1 || !['plan', 'execute', 'cleanup'].includes(mode)) {
      throw new Error('Expected plan, execute or cleanup');
    }

    if (mode === 'plan') {
      console.log(JSON.stringify(plan(values.account), null, 2));
      return 0;
    }

    if (!values.manifest || !values.account) {
      throw new Error('Execution and cleanup require --manifest and --account');
    }

    const path = resolve(values.manifest);
    try {
      if (mode === 'cleanup') {
        const manifest = validateManifest(jsonFile(path));
        if (values.account !== manifest.account) {
          throw new Error('Cleanup requires the matching account');
        }

        await cleanup(manifest, path);
        return 0;
      }

      if (!values.approval || existsSync(path)) {
        throw new Error('Execution requires --approval and a new manifest path');
      }

      const manifest = validateManifest(plan(values.account));
      const approval = jsonFile(values.approval);
      validateApproval(approval, values.account);
      manifest.buildEvidence = verifyBuild();
      manifest.approval = approval;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      return await execute(manifest, path);
    } catch {
      console.error('Remote validation failed; inspect the manifest. Secret diagnostics omitted.');
      return 1;
    }
  },
);
