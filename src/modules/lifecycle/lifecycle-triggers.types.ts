import type { LifecycleTriggerKind } from "../../db/schema/crm/lifecycle";

/**
 * The shapes the renewal-trigger sweep reads and reports. Declared apart from
 * `lifecycle-triggers.service.ts` so the steps in `lib/` can name them without
 * importing the service; the service re-exports `SweepEntry` and `SweepReport`.
 */

export interface LoadedCandidate {
  readonly customerLifecycleId: string;
  readonly partyId: string;
  readonly status: string;
  readonly startedOn: string;
  readonly renewalOn: string;
  readonly riskScore: number;
  readonly lastSignalAt: Date | null;
  /** An ISO timestamp as the driver returned it; see the projection. */
  readonly expansionSignalAt: string | null;
  readonly contractValueMinor: number;
  readonly healthScore: number | null;
  readonly healthStatus: string | null;
  readonly partyName: string | null;
  readonly companyName: string | null;
  readonly ownerUserId: string | null;
  readonly triggerId: string | null;
  readonly triggerKind: LifecycleTriggerKind | null;
  readonly dueOn: string | null;
  readonly opportunityDealId: number | null;
  readonly attempts: number | null;
  readonly lastAttemptAt: Date | null;
  readonly autonomyHoldId: string | null;
}

export interface SweepEntry {
  readonly customerLifecycleId: string;
  readonly partyId: string;
  readonly renewalOn: string;
  readonly action: "opened" | "reoffered" | "stood-down";
  /** Set when the loop was actually asked. */
  readonly outcome: "held" | "skipped" | null;
  /** The stand-down reason, or the loop's own refusal sentence. */
  readonly reason: string | null;
  readonly triggerId: string | null;
  readonly opportunityDealId: number | null;
  readonly autonomyHoldId: string | null;
}

export interface SweepReport {
  readonly asOf: Date;
  readonly considered: number;
  readonly opened: number;
  readonly reoffered: number;
  readonly held: number;
  readonly entries: readonly SweepEntry[];
}
