import {
  runObject,
  defineWorker,
} from "@cloudflare-workers-hs/runtime";
import { wasmExports } from "./runtime.js";
import { DurableObject } from "cloudflare:workers";

export class ExportCoordinator extends DurableObject<CoordinatorEnv> {
  fetch(request: Request): Promise<Response> {
    return runObject(
      this.ctx,
      () =>
        wasmExports.coordinator(
          request,
          { STORAGE: this.ctx.storage },
          this.ctx,
        ),
      true,
    );
  }

  alarm(): Promise<void> {
    return runObject(
      this.ctx,
      () => wasmExports.coordinatorAlarm(this.ctx.storage),
      true,
    );
  }
}

export default defineWorker({});
