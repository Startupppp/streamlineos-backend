import { KB_ALERT_RUNBOOK, type ServiceLevelObjective } from "./slo-types";

export const KB_INDEXING_SPAN = "kb.indexing.operation";

export const KB_INDEXING_MAX_FAULT_RATIO = 0.05;

export const KB_INDEXING_MIN_FAULTS = 2;

export const KB_INDEXING_WINDOW_HOURS = 1;

export const KB_INDEXING_FAULT_OUTCOMES = [
  "embedding_unavailable",
  "credits_exhausted",
  "error",
] as const;

export const KB_INDEXING_SLO: ServiceLevelObjective = {
  id: "module:kb:indexing",
  kind: "module",
  subject: "kb",
  statement: `No more than ${KB_INDEXING_MAX_FAULT_RATIO * 100}% of KB page indexing operations end in ${KB_INDEXING_FAULT_OUTCOMES.join(", ")} over a ${KB_INDEXING_WINDOW_HOURS}h window, measured on at least ${KB_INDEXING_MIN_FAULTS} faults.`,
  indicator: {
    kind: "outcome-rate",
    spanName: KB_INDEXING_SPAN,
    outcomeAttribute: "kb.outcome",
    faultOutcomes: KB_INDEXING_FAULT_OUTCOMES,
    maxFaultRatio: KB_INDEXING_MAX_FAULT_RATIO,
    minFaults: KB_INDEXING_MIN_FAULTS,
    windowHours: KB_INDEXING_WINDOW_HOURS,
  },
  owner: "knowledge-team",
  alertId: "kb-indexing",
  runbookFile: KB_ALERT_RUNBOOK,
  runbookAnchor: "#kb-indexing",
};

export const KB_SLOS: readonly ServiceLevelObjective[] = [KB_INDEXING_SLO];
