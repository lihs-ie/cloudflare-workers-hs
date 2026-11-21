import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { equals } from './evidence-io.mts';
import { list, nonnegative, object, string } from './validation.mts';

export const scope = 'remote-r2-ssec-multipart';
const bucketPrefix = 'hs-remote-ssec-';
export const objectName = 'attachments/encrypted/remote-probe.bin';
export const archiveObject = 'archives/encrypted/remote-archive.bin';
const accountPattern = /^[a-f0-9]{32}$/;

export interface Upload {
  key: string;
  identifier: string;
}

export interface Manifest {
  schema: 1 | 2;
  scope?: string;
  identifier: string;
  account: string | null;
  resource: { kind: 'r2-bucket'; identifier: string; state: string };
  objects: string[];
  multipart: Upload[];
  multipartIntent?: boolean;
  multipartClosed?: boolean;
  status: string;
  createdAt?: string;
  estimate?: Record<string, unknown>;
  validationLimitations?: string[];
  buildEvidence?: { manifestSha256: string };
  approval?: unknown;
  result?: Record<string, unknown>;
  startupErrorKinds?: string[];
  startupDiagnostics?: Record<string, unknown>;
}

export function saveManifest(path: string, value: Manifest): void {
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

export function plan(account: string | null = null): Manifest {
  const identifier = randomUUID().replaceAll('-', '');
  return {
    schema: 2,
    scope,
    identifier,
    account,
    validationLimitations: [
      'SSE-C-specific error classification is unavailable: full passed remains false; positive-only success is incomplete and exits nonzero.',
    ],
    createdAt: new Date().toISOString(),
    resource: { kind: 'r2-bucket', identifier: bucketPrefix + identifier, state: 'planned' },
    objects: [objectName, archiveObject],
    multipart: [],
    multipartIntent: false,
    multipartClosed: false,
    status: 'planned',
    estimate: {
      currency: 'USD',
      reviewedAt: '2026-09-08',
      classAPlanningAllowance: 32,
      classBPlanningAllowance: 32,
      objectBytes: 4096 + 5 * 1024 * 1024 + 3,
      timeoutSeconds: 180,
      roundedR2IncrementEstimate: 4.875,
      absoluteSpendingCap: false,
    },
  };
}

function upload(value: unknown): Upload {
  const record = object(value);
  if (!equals(Object.keys(record).sort(), ['identifier', 'key']) || record.key !== archiveObject) {
    throw new Error('Unexpected multipart cleanup scope');
  }

  const identifier = string(record.identifier);
  if (identifier.length === 0 || identifier.length > 2048 || /[\u0000-\u001f]/.test(identifier)) {
    throw new Error('Invalid multipart identifier');
  }

  return { key: archiveObject, identifier };
}

export function validateManifest(value: unknown): Manifest {
  const record = object(value);
  const identifier = string(record.identifier);
  const schema = record.schema;
  if ((schema !== 1 && schema !== 2) || !accountPattern.test(identifier)) {
    throw new Error('Invalid run manifest');
  }

  const resource = object(record.resource);
  if (resource.kind !== 'r2-bucket' || resource.identifier !== bucketPrefix + identifier) {
    throw new Error('Resource does not belong to this run');
  }

  const multipart = list(record.multipart ?? []).map(upload);
  if (
    multipart.length > 1 ||
    (schema === 1 && (multipart.length > 0 || record.multipartIntent || record.multipartClosed))
  ) {
    throw new Error('Unexpected multipart receipt count or legacy multipart operation');
  }

  if (schema === 2 && record.scope !== scope) {
    throw new Error('Unexpected validation scope');
  }

  const objects = schema === 1 ? [objectName] : [objectName, archiveObject];
  if (!equals(record.objects, objects)) {
    throw new Error('Unexpected object deletion scope');
  }

  const account = string(record.account);
  if (!accountPattern.test(account)) {
    throw new Error('Explicit Cloudflare account is required');
  }

  return {
    ...record,
    schema,
    identifier,
    account,
    objects,
    multipart,
    resource: { kind: 'r2-bucket', identifier: resource.identifier, state: string(resource.state) },
    status: typeof record.status === 'string' ? record.status : 'planned',
    multipartIntent: Boolean(record.multipartIntent),
    multipartClosed: record.multipartClosed === true,
  };
}

export function recordReceipt(manifest: Manifest, path: string, value: unknown): void {
  const receipt = object(value);
  const { phase, ...item } = receipt;

  if (phase === 'intent' && equals(item, { key: archiveObject })) {
    if (manifest.multipartIntent || manifest.multipart.length > 0) {
      throw new Error('Duplicate multipart creation');
    }

    manifest.multipartIntent = true;
  } else if (phase === 'created') {
    const validated = upload(item);

    if (manifest.multipartIntent !== true || manifest.multipart.length > 0) {
      throw new Error('Multipart receipt has no creation intent');
    }

    manifest.multipart = [validated];
    manifest.multipartIntent = false;
  } else if (phase === 'closed') {
    if (!equals(manifest.multipart, [upload(item)])) {
      throw new Error('Unknown closed upload');
    }

    manifest.multipartClosed = true;
  } else {
    throw new Error('Invalid receipt');
  }

  saveManifest(path, manifest);
}

export function validateApproval(value: unknown, account: string, now: number = Date.now()): void {
  const approval = object(value);
  if (
    approval.account !== account ||
    approval.scope !== scope ||
    !approval.approvedBy ||
    !approval.approvedAt
  ) {
    throw new Error('Approval account, scope or identity is invalid');
  }

  if (approval.costPolicy === 'free-tier') {
    const evidence = object(approval.usageEvidence);
    const time = Date.parse(string(evidence.checkedAt));
    const age = now - time;
    if (!Number.isFinite(age) || age < 0 || age > 3_600_000 || evidence.account !== account) {
      throw new Error('Fresh account-specific usage evidence is required');
    }

    const limits = { classA: 900_000, classB: 9_000_000, storagePeakBytes: 9_000_000_000 };
    if (
      Object.entries(limits).some(([field, ceiling]) => nonnegative(evidence[field]) >= ceiling)
    ) {
      throw new Error('Insufficient free-tier headroom');
    }

    if (!/^[a-f0-9]{64}$/.test(string(evidence.sourceSha256))) {
      throw new Error('Usage source digest is required');
    }

    return;
  }

  const budget = approval.approvedBudgetUsd;
  if (
    typeof budget !== 'number' ||
    !Number.isFinite(budget) ||
    budget < 4.875 ||
    budget >= 1000 ||
    approval.acknowledgeNotHardCap !== true
  ) {
    throw new Error('Approved finite budget and non-cap acknowledgement are required');
  }
}

export function probeStatus(result: Record<string, unknown>): 'passed' | 'incomplete' | 'failed' {
  if (result.passed === true) {
    return 'passed';
  }

  return result.positiveChecksPassed === true && result.negativeProof === 'unverified'
    ? 'incomplete'
    : 'failed';
}
