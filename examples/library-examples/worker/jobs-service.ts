import { WorkerEntrypoint } from "cloudflare:workers";

/** Remote batch validation before the producer performs any Queue writes. */
export class JobsValidator extends WorkerEntrypoint {
  validate(encoded: string): string {
    let jobs: unknown;
    try {
      jobs = JSON.parse(encoded);
    } catch {
      return "invalid";
    }
    if (!Array.isArray(jobs) || jobs.length === 0 || jobs.length > 100) {
      return "invalid";
    }
    const identifiers = new Set<string>();
    for (const job of jobs) {
      const identifier = validatedIdentifier(job);
      if (identifier === undefined || identifiers.has(identifier)) {
        return "invalid";
      }
      identifiers.add(identifier);
    }
    return "accepted";
  }
}

export default {
  fetch(): Response {
    return new Response("RPC service", { status: 404 });
  },
};

function validatedIdentifier(job: unknown): string | undefined {
  if (
    typeof job !== "object" ||
    job === null ||
    !("identifier" in job) ||
    typeof job.identifier !== "string" ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(job.identifier) ||
    !("payload" in job) ||
    typeof job.payload !== "string" ||
    job.payload.length === 0 ||
    new TextEncoder().encode(job.payload).byteLength > 4096
  ) {
    return undefined;
  }
  return job.identifier;
}
