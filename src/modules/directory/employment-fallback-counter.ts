import { reportError } from "../../common/observability";
import type { EmploymentFactName } from "./employment-facts.types";

export const EMPLOYMENT_FALLBACK_EVENT = "EMPLOYMENT_LEGACY_FALLBACK";
export const EMPLOYMENT_DRIFT_EVENT = "EMPLOYMENT_DRIFT";

export type EmploymentFallbackSnapshot = {
  total: number;
  byField: Record<string, number>;
};

const counters = new Map<EmploymentFactName, number>();

export function snapshotEmploymentFallbacks(): EmploymentFallbackSnapshot {
  const byField: Record<string, number> = {};
  let total = 0;
  for (const [field, count] of counters) {
    byField[field] = count;
    total += count;
  }
  return { total, byField };
}

export function resetEmploymentFallbacks(): void {
  counters.clear();
}

export function recordEmploymentFallback(
  orgId: string,
  userId: string,
  field: EmploymentFactName,
): void {
  counters.set(field, (counters.get(field) ?? 0) + 1);
  reportError(new Error(EMPLOYMENT_FALLBACK_EVENT), {
    event: EMPLOYMENT_FALLBACK_EVENT,
    orgId,
    userId,
    field,
  });
}

const SENSITIVE_FIELDS = new Set<EmploymentFactName>(["bankDetails", "taxId", "salaryAmountCents"]);

function forAlert(field: EmploymentFactName, value: unknown): string {
  if (SENSITIVE_FIELDS.has(field)) return value === null || value === undefined ? "∅" : "<redacted>";
  return value === null || value === undefined ? "∅" : String(value);
}

export function reportEmploymentDrift(
  orgId: string,
  userId: string,
  field: EmploymentFactName,
  canonicalValue: unknown,
  legacyValue: unknown,
): void {
  reportError(new Error(`${EMPLOYMENT_DRIFT_EVENT}: ${field}`), {
    event: EMPLOYMENT_DRIFT_EVENT,
    orgId,
    userId,
    field,
    canonicalValue: forAlert(field, canonicalValue),
    legacyValue: forAlert(field, legacyValue),
  });
}
