import { JobsState as ApplicationJobsState } from "../../worker/jobs-state.js";

/** Real DO failure injection to verify that Queue retries a failed RPC delivery. */
export class JobsState extends ApplicationJobsState {
  override async commit(encoded: string): Promise<string> {
    const value: unknown = JSON.parse(encoded);
    if (
      typeof value === "object" &&
      value !== null &&
      "identifier" in value &&
      value.identifier === "retry-once"
    ) {
      const injected = await this.ctx.storage.get<boolean>(
        "fixture:retry-injected",
      );
      if (injected !== true) {
        await this.ctx.storage.put("fixture:retry-injected", true);
        throw new Error("Injected transient storage failure");
      }
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "identifier" in value &&
      value.identifier === "commit-response-lost"
    ) {
      const stored: unknown = await this.ctx.storage.get(
        "fixture:response-loss-attempts",
      );
      if (
        stored !== undefined &&
        (typeof stored !== "number" ||
          !Number.isSafeInteger(stored) ||
          stored < 0)
      ) {
        throw new Error("Invalid response-loss attempt counter");
      }
      const attempts = (stored ?? 0) + 1;
      await this.ctx.storage.put("fixture:response-loss-attempts", attempts);
      const result = await super.commit(encoded);
      if (attempts === 1) {
        // The SQL commit succeeded; only its RPC acknowledgement is lost.
        throw new Error("Injected RPC response loss after commit");
      }
      return result;
    }
    return super.commit(encoded);
  }

  override async status(identifier: string): Promise<string> {
    const result = await super.status(identifier);
    if (identifier !== "commit-response-lost") {
      return result;
    }
    const value: unknown = JSON.parse(result);
    if (value === null) {
      return result;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid persisted job status");
    }
    const attempts: unknown = await this.ctx.storage.get(
      "fixture:response-loss-attempts",
    );
    if (
      typeof attempts !== "number" ||
      !Number.isSafeInteger(attempts) ||
      attempts < 1
    ) {
      throw new Error("Invalid response-loss attempt counter");
    }
    return JSON.stringify({ ...value, attempts });
  }
}
