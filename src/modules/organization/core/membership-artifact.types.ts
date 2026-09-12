export type ArtifactMechanism =
  | "database-cascade"
  | "database-write"
  | "pending-migration"
  | "session-store"
  | "realtime"
  | "provider"
  | "cache";

export type RemovalAction =
  | "cascade"
  | "set-null"
  | "delete"
  | "revoke"
  | "blocks-removal"
  /**
   * The column holds a membership id and carries no foreign key, so removing a
   * membership does not touch it and nothing else does either. It is recorded
   * rather than omitted because a countable gap is one somebody can close; an
   * absent row reads as "handled".
   */
  | "unreferenced";

export type SuspensionAction = "revoke" | "retain";

export interface MembershipArtifact {
  readonly id: string;
  readonly mechanism: ArtifactMechanism;
  readonly table: string | null;
  readonly keyedBy: string;
  readonly onRemoval: RemovalAction;
  readonly onSuspension: SuspensionAction;
  readonly reason: string;
}

