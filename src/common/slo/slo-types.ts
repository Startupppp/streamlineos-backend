import type { SeamKey } from "../observability/seam-budgets";

export const SLO_OWNERS = [
  "platform-reliability",
  "notifications-team",
  "payments-team",
  "people-team",
  "delivery-team",
  "finance-team",
  "knowledge-team",
  "communications-team",
  "support-team",
] as const;

export type SloOwner = (typeof SLO_OWNERS)[number];

export type SloSubjectKind = "module" | "queue";

export type SloIndicator =
  | {
      readonly kind: "seam";
      readonly seam: SeamKey;
      readonly percentile: "p95";
    }
  | {
      readonly kind: "queue-age";
      readonly maxPendingAgeSeconds: number;
      readonly maxRetryPressure: number;
    }
  | {
      readonly kind: "dead-letter";
      readonly maxDeadRowsInWindow: number;
      readonly windowHours: number;
    }
  | {
      readonly kind: "outcome-rate";
      readonly spanName: string;
      readonly outcomeAttribute: string;
      readonly faultOutcomes: readonly string[];
      readonly maxFaultRatio: number;
      readonly minFaults: number;
      readonly windowHours: number;
    };

export interface ServiceLevelObjective {
  readonly id: string;
  readonly kind: SloSubjectKind;
  readonly subject: string;
  readonly statement: string;
  readonly indicator: SloIndicator;
  readonly owner: SloOwner;
  readonly alertId: string;
  readonly runbookFile: string;
  readonly runbookAnchor: string;
}

export const ALERT_RUNBOOK =
  "architecture-refactor/final-refactor/evidence/40-observability/FAILURE-RUNBOOKS.md";

export const FAILURE_RUNBOOK =
  "architecture-refactor/final-refactor/evidence/40-observability/FAILURE-RUNBOOKS.md";
