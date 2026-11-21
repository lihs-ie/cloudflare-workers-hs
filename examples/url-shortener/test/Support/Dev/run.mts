import {
  jsonObject,
  jsonArray,
  jsonNumber,
  jsonString,
} from '../../../../../scripts/testing/Support/json.mts';
import { required } from '../../../../../scripts/testing/Support/required.mts';
import { fetchReadiness } from '../../../../../scripts/testing/Support/readiness.mts';
/** Real wrangler dev process tests; the gateway only selects production Workers. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { verifyBuild } from '../Runtime/build-manifest.mts';
import { createAccessFixture, accessTeam, accessAudience } from '../Production/auth.ts';
import { exerciseManagement, exerciseExport } from '../Production/http-contract.ts';
import type { Send } from '../Production/http-contract.ts';

const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.resolve(example, '../..');
const artifact = path.join(
  root,
  'artifacts/testing',
  `dev-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`,
);
await mkdir(artifact, { recursive: true });
const configurations = [
  ...['redirect', 'management', 'export', 'recovery'].map((app) => `apps/${app}/wrangler.jsonc`),
  ...[
    'aggregation',
    'export-generation',
    'recovery-ingest',
    'maintenance',
    'export-coordinator',
  ].map((worker) => `workers/${worker}/wrangler.jsonc`),
];
const state = await mkdtemp(path.join(tmpdir(), 'workers-dev-'));
const results: unknown[] = [];
const processes: ReturnType<typeof spawn>[] = [];
const temporaryFiles: string[] = [];
let failed = false;
let log = '';
let jwksServer: ReturnType<typeof createHTTPServer> | undefined;
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a listening TCP port');
  }

  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return;
  }

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  const kill = setTimeout(() => {
    try {
      process.kill(-required(child.pid, 'child.pid'), 'SIGKILL');
    } catch {}
  }, 3000);
  await exited;
  clearTimeout(kill);
}
function launch(
  args: string[],
): import('child_process').ChildProcessByStdio<
  null,
  import('stream').Readable,
  import('stream').Readable
> {
  const child = spawn('pnpm', ['exec', 'wrangler', ...args], {
    cwd: example,
    detached: true,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.push(child);
  child.on('error', (error) => {
    log += error.stack;
  });
  required(child.stdout, 'child.stdout').on('data', (data) => {
    log += data;
  });
  required(child.stderr, 'child.stderr').on('data', (data) => {
    log += data;
  });
  return child;
}
async function execute(args: string[]): Promise<void> {
  const child = launch(args);
  const timeout = setTimeout(() => {
    void stop(child);
  }, 60000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  }).finally(() => clearTimeout(timeout));

  if (code !== 0) {
    throw new Error(`Wrangler command failed (${code}): ${args.join(' ')}\n${log}`);
  }
}
async function cleanup(): Promise<void> {
  await Promise.all(processes.map(stop));

  if (jwksServer?.listening) {
    await new Promise<void>((resolve) => required(jwksServer, 'jwksServer').close(() => resolve()));
  }

  await Promise.all(temporaryFiles.map((filename) => rm(filename, { force: true })));
  await rm(state, { recursive: true, force: true });
}
process.once('SIGTERM', () => {
  void cleanup().finally(() => process.exit(143));
});
process.once('SIGINT', () => {
  void cleanup().finally(() => process.exit(130));
});
function check(condition: boolean, description: string): void {
  results.push({ case: description, status: condition ? 'passed' : 'failed' });

  if (!condition) {
    throw new Error(description);
  }

  console.log(`PASS ${description}`);
}
try {
  verifyBuild('url-shortener');
  const fixture = await createAccessFixture();
  let jwksDocument = fixture.jwks;
  let jwksStatus = 200;
  let jwksRequests = 0;
  jwksServer = createHTTPServer((_request, response) => {
    jwksRequests += 1;
    response.writeHead(jwksStatus, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(jwksDocument));
  });
  await new Promise<void>((resolve, reject) => {
    required(jwksServer, 'jwksServer').once('error', reject);
    required(jwksServer, 'jwksServer').listen(0, '127.0.0.1', resolve);
  });
  const jwksAddress = jwksServer.address();
  if (!jwksAddress || typeof jwksAddress === 'string') {
    throw new Error('Expected a listening JWKS port');
  }

  const jwksPort = jwksAddress.port;
  const services: { binding: string; service: string }[] = [];
  const configs: string[] = [];
  for (const [index, name] of configurations.entries()) {
    const original = path.resolve(example, name);
    const content = await readFile(original, 'utf8');
    const errors: ParseError[] = [];
    const config = jsonObject(parse(content, errors, { allowTrailingComma: true }));

    if (errors.length) {
      throw new Error(`Invalid config ${original}: ${JSON.stringify(errors)}`);
    }

    delete config.build;

    if (process.env.WASM_COVERAGE_ENDPOINT) {
      config.define = {
        ...jsonObject(config.define ?? {}),
        WASM_COVERAGE_ENDPOINT: JSON.stringify(process.env.WASM_COVERAGE_ENDPOINT),
      };
    }

    config.vars = {
      ...jsonObject(config.vars ?? {}),
      ACCESS_TEAM: accessTeam,
      ACCESS_AUDIENCE: accessAudience,
      ACCESS_JWKS_URL: `http://127.0.0.1:${jwksPort}/certs`,
    };
    const temporary = path.join(path.dirname(original), `.dev-test-${process.pid}-${index}.json`);
    temporaryFiles.push(temporary);
    await writeFile(temporary, JSON.stringify(config));
    configs.push(temporary);

    if (name.startsWith('apps/')) {
      services.push({ binding: name.split('/')[1], service: jsonString(config.name) });
    }

    results.push({
      configuration: name,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  await execute([
    'd1',
    'migrations',
    'apply',
    'DB',
    '--config',
    configs[1],
    '--local',
    '--persist-to',
    state,
  ]);
  const gateway = path.join(example, `test/Support/Dev/.dev-test-${process.pid}.json`);
  temporaryFiles.push(gateway);
  await writeFile(
    gateway,
    JSON.stringify({
      name: `dev-test-gateway-${process.pid}`,
      main: 'gateway.ts',
      compatibility_date: '2026-07-21',
      services,
    }),
  );
  const port = await freePort();
  const command = [
    'dev',
    ...[gateway, ...configs].flatMap((config) => ['--config', config]),
    '--local',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--inspector-port',
    String(await freePort()),
    '--persist-to',
    state,
    '--show-interactive-dev-session=false',
  ];
  const child = launch(command);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
      throw new Error(`Wrangler exited before ready: ${log}`);
    }

    try {
      const response = await fetchReadiness(
        `${origin}/redirect/__dev_test_unknown_route__`,
        deadline,
        { redirect: 'manual' },
      );
      check(
        response.status === 404,
        `Production reactor unknown route returns404 (received ${response.status})`,
      );
      ready = true;
      break;
    } catch (error) {
      const connectionRefused =
        error instanceof Error &&
        error.cause instanceof Error &&
        'code' in error.cause &&
        error.cause.code === 'ECONNREFUSED';

      if (!connectionRefused) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (!ready) {
    throw new Error(`Wrangler readiness timed out: ${log}`);
  }

  const send: Send = (application, pathname, init) =>
    fetch(`${origin}/${application}${pathname}`, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
  const token = await fixture.token();
  // Exercise actual HTTP retrieval, crypto and the persistent WASM cache.
  const verifyIdentity = async (assertion: string): Promise<number> => {
    const response = await send('management', '/unknown-access-cache-probe', {
      headers: { 'Cf-Access-Jwt-Assertion': assertion },
    });
    await response.body?.cancel();
    return response.status;
  };
  check(
    (await verifyIdentity(token)) === 404,
    'Access accepts a signed identity through real HTTP JWKS retrieval',
  );
  const initialJWKSRequests = jwksRequests;
  check(
    (await verifyIdentity(token)) === 404 && jwksRequests === initialJWKSRequests,
    'Fresh JWKS cache avoids another HTTP request',
  );
  const rotatedFixture = await createAccessFixture('rotated-test-key');
  const rotatedToken = await rotatedFixture.token();
  jwksDocument = { keys: [...fixture.jwks.keys, ...rotatedFixture.jwks.keys] };
  check(
    (await verifyIdentity(rotatedToken)) === 404 && jwksRequests === initialJWKSRequests + 1,
    'Unknown kid refreshes real HTTP JWKS and accepts a rotated key',
  );
  const recoveryFixture = await createAccessFixture('recovery-test-key');
  const recoveryToken = await recoveryFixture.token();
  jwksStatus = 503;
  const beforeFailure = jwksRequests;
  check(
    (await verifyIdentity(recoveryToken)) === 401 && jwksRequests === beforeFailure + 1,
    'JWKS HTTP failure rejects an uncached identity',
  );
  check(
    (await verifyIdentity(token)) === 404 && jwksRequests === beforeFailure + 1,
    'Failed JWKS refresh preserves a previously verified cached key',
  );
  jwksStatus = 200;
  jwksDocument = { keys: [...jwksDocument.keys, ...recoveryFixture.jwks.keys] };
  check(
    (await verifyIdentity(recoveryToken)) === 404 && jwksRequests === beforeFailure + 2,
    'JWKS HTTP recovery retries immediately without poisoning kid-miss throttle',
  );

  const startDay = new Date().toISOString().slice(0, 10);
  const created = await exerciseManagement(send, token, check);
  const endDay = new Date().toISOString().slice(0, 10);
  const aggregationDeadline = Date.now() + 30000;
  let count = 0;
  while (Date.now() < aggregationDeadline) {
    const stats = await send('management', `/stats?start=${startDay}&end=${endDay}`, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });

    if (stats.status !== 200) {
      throw new Error(`Stats HTTP ${stats.status}: ${await stats.text()}`);
    }

    const body = jsonObject(await stats.json());
    count = jsonArray(body.items)
      .map(jsonObject)
      .filter((item) => item.url === created.identifier)
      .reduce((sum, item) => sum + jsonNumber(item.count), 0);

    if (count >= 2) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check(
    count === 2,
    `Queue aggregates both successful redirects after URL deletion (received ${count})`,
  );
  const exported = await exerciseExport(send, token, check, { startDay, endDay });
  check(exported.csv.includes(created.identifier), 'CSV includes retained clicks for deleted URL');
  const events = await send('recovery', '/events', {
    headers: { 'Cf-Access-Jwt-Assertion': token },
  });
  check(
    events.status === 200 && Array.isArray(await events.json()),
    'Recovery lists failed events through authenticated API',
  );
  const missingReplay = await send('recovery', '/events/nonexistent/replay', {
    method: 'POST',
    headers: { 'Cf-Access-Jwt-Assertion': token },
  });
  check(missingReplay.status === 404, 'Recovery rejects replay of nonexistent event');

  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error('Wrangler exited during HTTP tests');
  }

  verifyBuild('url-shortener');
} catch (error) {
  failed = true;
  results.push({ status: 'failed', error: String(error) });
  console.error(error);
} finally {
  await cleanup();
  await writeFile(path.join(artifact, 'wrangler.log'), log);
  await writeFile(
    path.join(artifact, 'results.json'),
    JSON.stringify({ complete: !failed, results }, null, 2),
  );
  console.log(`Evidence: ${artifact}`);
}
process.exitCode = failed ? 1 : 0;
