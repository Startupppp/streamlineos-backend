/**
 * RBAC verification matrix — core types.
 *
 * The matrix models authorization as a five-dimensional space:
 *   actor standing × resource × action × tenant × state → expected outcome
 *
 * Actor standings correspond to BE-102's six structural positions plus two
 * cross-boundary stances: outsider (authenticated but not a member of the org
 * under test) and cross-tenant (a member of a different tenant accessing an id
 * belonging to a foreign tenant — the existence-oracle case).
 *
 * Each cell must pair a negative assertion with a positive one (BE-141): a
 * denial that is never paired with a passing control is vacuous.
 */

/** BE-102: org owner/admin/member + module owner/admin/member, plus boundary stances. */
export type ActorStanding =
  | "org:owner"
  | "org:admin"
  | "org:member"
  | "module:admin"
  | "module:member"
  | "outsider"
  | "cross-tenant";

/** Status semantics per BE-22 plus "allow" for the positive control. */
export type ExpectedOutcome =
  | "allow"
  | "403"
  | "404"
  | "402";

export type AdapterKind = "http" | "realtime" | "job" | "file";

/**
 * One cell in the matrix.  A cell is the minimal unit the ledger tracks;
 * it maps directly to one paired test (deny + allow control).
 */
export interface ScenarioCell {
  readonly id: string;
  readonly actor: ActorStanding;
  readonly resource: string;
  readonly action: string;
  readonly tenant: "same" | "other";
  readonly state: "normal" | "module-disabled" | "permission-revoked" | "cross-resource";
  readonly expected: ExpectedOutcome;
  readonly adapter: AdapterKind;
}

/** The three statuses the ledger reports per cell. */
export type CellRunStatus = "proven" | "failed" | "unrun";

export interface CellRunResult {
  readonly cellId: string;
  readonly status: CellRunStatus;
  readonly detail?: string;
}

export interface MatrixLedger {
  readonly cells: readonly ScenarioCell[];
  readonly results: readonly CellRunResult[];
  readonly proven: number;
  readonly failed: number;
  readonly unrun: number;
}
