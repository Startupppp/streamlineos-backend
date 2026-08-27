import type { DecisionKind } from "../../db/schema/crm/autonomous-decisions";
import type { CorrectionType } from "../../db/schema/crm/autonomy-corrections";

/**
 * Turning what a person corrected into a case the evaluator scores against.
 *
 * Phase 4, ticket 13, criterion 4 — "human corrections captured from the review
 * feed are promotable into the datasets, so accuracy compounds". The table has
 * carried `consented` and `promotedAt` since it was created, and a partial index
 * on exactly the promotable slice; nothing ever read them. So every correction a
 * customer made taught the system nothing, and the same mistake stayed available
 * to be made again.
 *
 * Promotion is deliberately not automatic. It is a decision somebody makes, over
 * rows somebody consented to, which is why `promotedAt` is nullable and set
 * explicitly rather than being a boolean defaulting to true.
 */
export interface CorrectionRow {
  readonly autonomyCorrectionId: string;
  readonly organizationId: string;
  readonly kind: DecisionKind;
  readonly correctionType: CorrectionType;
  readonly field: string;
  readonly systemValue: string | null;
  readonly humanValue: string | null;
  readonly reason: string | null;
  readonly consented: boolean;
  readonly promotedAt: Date | null;
}

export interface PromotedCase {
  /** Where it came from, so a case in a dataset can be traced to its correction. */
  readonly sourceCorrectionId: string;
  readonly kind: DecisionKind;
  readonly field: string;
  /** What the system said, which is the case's input. */
  readonly systemValue: string | null;
  /** What a person said instead, which is what a correct run must produce. */
  readonly expected: string;
  readonly note: string | null;
}

/** Why a correction cannot become a case. Returned, never thrown — this is a filter. */
export type PromotionRefusal =
  | "not-consented"
  | "already-promoted"
  | "no-human-value"
  | "unchanged";

export interface PromotionVerdict {
  readonly correctionId: string;
  readonly promotable: boolean;
  readonly refusal: PromotionRefusal | null;
}

/**
 * Whether one correction may enter a dataset, and why not when it may not.
 *
 * The order matters and is the order of the argument. Consent is checked first
 * because it is the only one of these that is not ours to weigh: a row nobody
 * consented to is out regardless of how instructive it would have been.
 */
export function assessPromotion(row: CorrectionRow): PromotionVerdict {
  const base = { correctionId: row.autonomyCorrectionId };

  if (!row.consented) return { ...base, promotable: false, refusal: "not-consented" };
  if (row.promotedAt !== null) return { ...base, promotable: false, refusal: "already-promoted" };

  // A reversal with nothing put in its place says the system was wrong without
  // saying what right looks like. It is a real signal for the correction rate
  // and a useless one for a dataset, which needs an expected output.
  if (row.humanValue === null || row.humanValue.trim() === "")
    return { ...base, promotable: false, refusal: "no-human-value" };

  // Somebody opened the editor and saved the same value. Nothing was corrected.
  if (row.humanValue === row.systemValue)
    return { ...base, promotable: false, refusal: "unchanged" };

  return { ...base, promotable: true, refusal: null };
}

export function toPromotedCase(row: CorrectionRow): PromotedCase | null {
  if (!assessPromotion(row).promotable) return null;
  return {
    sourceCorrectionId: row.autonomyCorrectionId,
    kind: row.kind,
    field: row.field,
    systemValue: row.systemValue,
    expected: row.humanValue!,
    note: row.reason,
  };
}

/**
 * Every case a batch of corrections yields, and an account of the rest.
 *
 * The refusals are returned rather than dropped so a promotion run can say "412
 * corrections, 38 promoted, 374 not consented" — a number that tells somebody
 * whether asking for consent differently would be worth it, which a silent
 * filter never would.
 */
export function promoteCorrections(rows: readonly CorrectionRow[]): {
  readonly cases: readonly PromotedCase[];
  readonly refused: Readonly<Record<PromotionRefusal, number>>;
} {
  const cases: PromotedCase[] = [];
  const refused: Record<PromotionRefusal, number> = {
    "not-consented": 0,
    "already-promoted": 0,
    "no-human-value": 0,
    unchanged: 0,
  };

  for (const row of rows) {
    const verdict = assessPromotion(row);
    if (verdict.promotable) {
      cases.push(toPromotedCase(row)!);
      continue;
    }
    if (verdict.refusal) refused[verdict.refusal] += 1;
  }

  return { cases, refused };
}
