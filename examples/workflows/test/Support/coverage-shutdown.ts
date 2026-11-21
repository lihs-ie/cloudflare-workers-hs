declare global {
  var workflowCoverageSnapshots: string[] | undefined;
}

export function takeWorkflowCoverageSnapshots(): string[] {
  const snapshots = globalThis.workflowCoverageSnapshots ?? [];
  globalThis.workflowCoverageSnapshots = [];
  return snapshots;
}
