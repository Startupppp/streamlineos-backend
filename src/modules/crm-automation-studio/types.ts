export interface StudioEventPayload {
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
  actorId?: string;
  depth?: number;
}

export interface RunStepLog {
  nodeId: string;
  type: string;
  status: "ok" | "skipped" | "error";
  message?: string;
  branchTaken?: string;
  at: string;
}
