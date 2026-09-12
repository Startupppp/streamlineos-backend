import type { TriggerCandidate } from "../renewal-triggers";
import type { LoadedCandidate, SweepEntry } from "../lifecycle-triggers.types";

/**
 * The database row, as the pure decider's input.
 *
 * A function rather than a cast, so a column added to the query cannot silently
 * become a field the decider reads: every value it uses is named here.
 */
export function toTriggerCandidate(candidate: LoadedCandidate, asOf: Date): TriggerCandidate {
  return {
    status: candidate.status,
    renewalOn: candidate.renewalOn,
    termStartedOn: candidate.startedOn,
    riskScore: candidate.riskScore,
    healthStatus: candidate.healthStatus,
    lastSignalAt: candidate.lastSignalAt,
    expansionSignalAt: toDate(candidate.expansionSignalAt),
    existing: candidate.triggerId
      ? {
          hasOpportunity: candidate.opportunityDealId !== null,
          attempts: candidate.attempts ?? 0,
          lastAttemptAt: candidate.lastAttemptAt,
          holdPlaced: candidate.autonomyHoldId !== null,
        }
      : null,
    asOf,
  };
}

export function base(
  candidate: LoadedCandidate,
  over: { action: SweepEntry["action"]; reason?: string; triggerId?: string },
): SweepEntry {
  return {
    customerLifecycleId: candidate.customerLifecycleId,
    partyId: candidate.partyId,
    renewalOn: candidate.renewalOn,
    action: over.action,
    outcome: null,
    reason: over.reason ?? null,
    triggerId: over.triggerId ?? candidate.triggerId,
    opportunityDealId: candidate.opportunityDealId,
    autonomyHoldId: null,
  };
}

export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

/**
 * The one place a raw-SQL timestamp becomes a Date.
 *
 * An unparseable value is treated as absent rather than passed on as an Invalid
 * Date, which would compare false against everything and make an expansion
 * signal silently stop working rather than fail.
 */
function toDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
