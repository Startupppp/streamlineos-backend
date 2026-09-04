/**
 * The shape of one captured EXPLAIN pair in `plan-evidence.json`, and the guard
 * that decides whether a parsed entry really is one.
 *
 * PRD-C047 — the reader used to check `id` alone and then write
 * `entry as PlanEvidence`, which asserted `probe`, `withCandidate` and
 * `withoutCandidate` that nothing had looked at. An entry missing any of them
 * became a `PlanEvidence` whose fields were `undefined` at runtime and `string`
 * to the compiler, and a plan that proves nothing is exactly the evidence this
 * gate exists to refuse to invent. The guard is here rather than beside the
 * reader so the self-test can drive it without importing the entrypoint back.
 */
export interface PlanEvidence {
  readonly id: string;
  readonly probe: string;
  readonly withCandidate: string;
  readonly withoutCandidate: string;
}

export function isPlanEvidence(value: unknown): value is PlanEvidence {
  if (value === null || typeof value !== "object") return false;
  const record: Record<string, unknown> = { ...value };
  return (
    typeof record.id === "string" &&
    typeof record.probe === "string" &&
    typeof record.withCandidate === "string" &&
    typeof record.withoutCandidate === "string"
  );
}
