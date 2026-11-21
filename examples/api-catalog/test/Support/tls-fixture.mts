import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

interface ServerCertificate {
  certificate: Buffer;
  key: Buffer;
  authority: string;
}

export interface TLSFixture {
  trusted: ServerCertificate;
  untrusted: ServerCertificate;
  close(): Promise<void>;
}

async function issue(directory: string, label: string): Promise<ServerCertificate> {
  const authority = path.join(directory, `${label}-ca.pem`);
  const authorityKey = path.join(directory, `${label}-ca-key.pem`);
  const config = path.join(directory, `${label}.cnf`);
  const key = path.join(directory, `${label}-key.pem`);
  const request = path.join(directory, `${label}.csr`);
  const certificate = path.join(directory, `${label}.pem`);
  await writeFile(
    config,
    `
[req]
distinguished_name = subject
[subject]
[authority]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
`,
  );
  await execute(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-days',
      '3650',
      '-keyout',
      authorityKey,
      '-out',
      authority,
      '-subj',
      `/CN=Workers ${label} test CA`,
      '-config',
      config,
      '-extensions',
      'authority',
    ],
    { timeout: 10000 },
  );
  await execute(
    'openssl',
    [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      request,
      '-subj',
      '/CN=localhost',
      '-config',
      config,
    ],
    { timeout: 10000 },
  );
  await execute(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      request,
      '-CA',
      authority,
      '-CAkey',
      authorityKey,
      '-CAcreateserial',
      '-out',
      certificate,
      '-days',
      '365',
      '-sha256',
      '-extfile',
      config,
      '-extensions',
      'server',
    ],
    { timeout: 10000 },
  );

  return { certificate: await readFile(certificate), key: await readFile(key), authority };
}

export async function createTLSFixture(): Promise<TLSFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'workers-tls-'));
  const close = (): Promise<void> => rm(directory, { recursive: true, force: true });
  try {
    const trusted = await issue(directory, 'trusted');
    const untrusted = await issue(directory, 'untrusted');
    return { trusted, untrusted, close };
  } catch (error) {
    await close();
    throw error;
  }
}
