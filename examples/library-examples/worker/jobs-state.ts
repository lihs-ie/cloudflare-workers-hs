import { DurableObject } from "cloudflare:workers";
import { reactor } from "./runtime.js";

/** The Haskell handlers own storage, SQL, and domain decisions. */
export class JobsState extends DurableObject<Env> {
  constructor(context: DurableObjectState, env: Env) {
    super(context, env);
    void context.blockConcurrencyWhile(() =>
      reactor.jobsInitialize(context.storage),
    );
  }

  commit(encoded: string): Promise<string> {
    return reactor.jobsCommit(this.ctx.storage, encoded);
  }

  status(identifier: string): Promise<string> {
    return reactor.jobsStatus(this.ctx.storage, identifier);
  }

  saveSettings(encoded: string): Promise<string> {
    // Hold the input gate across the Haskell read/transaction/prune sequence.
    return this.ctx.blockConcurrencyWhile(() =>
      reactor.jobsSaveSettings(this.ctx.storage, encoded),
    );
  }

  history(): Promise<string> {
    return reactor.jobsSettingsHistory(this.ctx.storage);
  }
}
