/**
 * Progressive discipline ladder helpers (Phase 9.2).
 * Soft policy guidance — not a substitute for legal employment advice.
 */

export type DisciplinaryActionType =
  | "verbal_warning"
  | "written_warning"
  | "final_warning"
  | "suspension"
  | "termination_recommended";

export const DISCIPLINE_LADDER: DisciplinaryActionType[] = [
  "verbal_warning",
  "written_warning",
  "final_warning",
  "suspension",
  "termination_recommended",
];

export function disciplineLevel(type: DisciplinaryActionType): number {
  return DISCIPLINE_LADDER.indexOf(type);
}

export interface ProgressiveCheckResult {
  ok: boolean;
  /** Suggested prior step missing from history */
  missingPrior: DisciplinaryActionType | null;
  warning: string | null;
  honestyNote: string;
}

/**
 * Check whether issuing `next` skips a progressive step given prior types.
 * verbal_warning always ok; higher steps prefer prior history unless forceEscalate.
 */
export function checkProgressiveDiscipline(
  next: DisciplinaryActionType,
  priorTypes: DisciplinaryActionType[],
  forceEscalate = false,
): ProgressiveCheckResult {
  const honestyNote =
    "Progressive discipline guidance is product policy only — not legal advice. Escalation can be forced with an audit reason when business needs require it.";

  const nextLevel = disciplineLevel(next);
  if (nextLevel <= 0) {
    return { ok: true, missingPrior: null, warning: null, honestyNote };
  }

  const maxPrior = priorTypes.reduce(
    (m, t) => Math.max(m, disciplineLevel(t)),
    -1,
  );

  // Prefer having at least the immediately prior step (or higher) already on file
  const expectedPrior = DISCIPLINE_LADDER[nextLevel - 1];
  if (maxPrior >= nextLevel - 1) {
    return { ok: true, missingPrior: null, warning: null, honestyNote };
  }

  if (forceEscalate) {
    return {
      ok: true,
      missingPrior: expectedPrior,
      warning: `Forced escalate to ${next} without prior ${expectedPrior} on file`,
      honestyNote,
    };
  }

  return {
    ok: false,
    missingPrior: expectedPrior,
    warning: `Issuing ${next} typically follows ${expectedPrior}. Pass forceEscalate=true with a note to override.`,
    honestyNote,
  };
}
