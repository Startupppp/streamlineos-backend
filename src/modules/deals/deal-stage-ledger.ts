/**
 * What moved a deal, and what a deal is worth.
 *
 * Both are pure here so the rules are testable without a database, a tenant or a
 * running pipeline — which matters because ticket 12 will make the system itself
 * the actor, and the thing that records that has to be provably right before it
 * starts writing rows nobody typed.
 */

/**
 * Who moved a deal between stages.
 *
 * A discriminated union rather than a nullable user id, so "system" is a real
 * case the compiler makes every caller handle instead of a null that reads as
 * missing data. The database enforces the same shape with a CHECK.
 */
export type StageActor =
  | { readonly kind: "human"; readonly userId: string }
  | { readonly kind: "system"; readonly label: string };

export interface StageTransitionInput {
  readonly organizationId: string;
  readonly dealId: number;
  readonly pipelineId: string | null;
  /** Null on the first transition, where the deal had no prior stage. */
  readonly fromStage: string | null;
  readonly toStage: string;
  readonly actor: StageActor;
  readonly reason?: string | null;
}

export interface StageTransitionRow {
  organizationId: string;
  dealId: number;
  pipelineId: string | null;
  fromStage: string | null;
  toStage: string;
  actorKind: string;
  actorUserId: string | null;
  actorLabel: string | null;
  reason: string | null;
}

/**
 * Flattens an actor onto the columns, keeping the two halves mutually exclusive.
 *
 * A human transition never carries a label and a system one never carries a user
 * id — the same invariant the CHECK constraint holds, expressed once here so a
 * caller cannot construct the row that would violate it.
 */
export function toTransitionRow(input: StageTransitionInput): StageTransitionRow {
  const { actor } = input;

  return {
    organizationId: input.organizationId,
    dealId: input.dealId,
    pipelineId: input.pipelineId,
    fromStage: input.fromStage,
    toStage: input.toStage,
    actorKind: actor.kind,
    actorUserId: actor.kind === "human" ? actor.userId : null,
    actorLabel: actor.kind === "system" ? actor.label : null,
    reason: input.reason?.trim() ? input.reason.trim() : null,
  };
}

/** What a reviewer reads in the feed. Never an identifier. */
export function describeActor(row: {
  actorKind: string;
  actorLabel: string | null;
  actorName?: string | null;
}): string {
  if (row.actorKind === "system") return row.actorLabel ?? "The system";
  return row.actorName ?? "A team member";
}

/** True when a move is worth writing a row for. */
export function isStageChange(from: string | null | undefined, to: string | null | undefined): boolean {
  if (!to) return false;
  return (from ?? null) !== to;
}

// ── Money ───────────────────────────────────────────────────────────────────

/**
 * Minor units from whatever the boundary handed us.
 *
 * Deal values arrive as a number from JSON and as a string from the decimal
 * column and from CSV import. Multiplying a float by 100 is where the missing
 * cent comes from — 1234.56 * 100 is 123455.99999999999 — so the scaling is done
 * on the decimal text, and only then converted.
 */
export function toMinorUnits(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;

  const text = typeof value === "number" ? value.toFixed(2) : value.trim();
  if (!/^-?\d*\.?\d*$/.test(text) || text === "" || text === "-") return 0;

  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace("-", "").split(".");
  const cents = `${fraction}00`.slice(0, 2);

  const minor = Number(whole) * 100 + Number(cents);
  if (!Number.isFinite(minor)) return 0;

  return negative ? -minor : minor;
}

/** The decimal string the API and the legacy generated column both show. */
export function fromMinorUnits(minor: number): string {
  const negative = minor < 0;
  const absolute = Math.abs(Math.trunc(minor));
  const whole = Math.trunc(absolute / 100);
  const cents = String(absolute % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${cents}`;
}
