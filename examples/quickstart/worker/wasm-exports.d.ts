/** Exact JavaScript FFI exports declared by app/Main.hs. */
export interface WasmExports {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  management(
    request: Request,
    env: ManagementEnv,
    ctx: ExecutionContext,
  ): Promise<Response>;
  exportApi(
    request: Request,
    env: ExportEnv,
    ctx: ExecutionContext,
  ): Promise<Response>;
  recovery(
    request: Request,
    env: RecoveryEnv,
    ctx: ExecutionContext,
  ): Promise<Response>;
  aggregation(
    batch: MessageBatch<unknown>,
    env: AggregationEnv,
    ctx: ExecutionContext,
  ): Promise<void>;
  quickstartGeneration(
    batch: MessageBatch<unknown>,
    env: GenerationEnv,
    ctx: ExecutionContext,
  ): Promise<void>;
  recoveryIngest(
    batch: MessageBatch<unknown>,
    env: RecoveryIngestEnv,
    ctx: ExecutionContext,
  ): Promise<void>;
  maintenance(
    event: ScheduledController,
    env: MaintenanceEnv,
    ctx: ExecutionContext,
  ): Promise<void>;
  coordinator(
    request: Request,
    env: { STORAGE: DurableObjectStorage },
    ctx: DurableObjectState,
  ): Promise<Response>;
  coordinatorAlarm(storage: DurableObjectStorage): Promise<void>;
}
