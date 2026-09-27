import { KB_ALERT_RUNBOOK, type ServiceLevelObjective } from "./slo-types";

export const KB_SEARCH_SPAN = "kb.search.operation";

export const KB_SEARCH_MAX_FAULT_RATIO = 0.05;

export const KB_SEARCH_MIN_FAULTS = 2;

export const KB_SEARCH_WINDOW_HOURS = 1;

export const KB_SEARCH_FAULT_OUTCOMES = ["error"] as const;

export const KB_SEARCH_MAX_DENIED_RATIO = 0.25;

export const KB_SEARCH_MIN_DENIALS = 5;

export const KB_SEARCH_MAX_NOT_FOUND_RATIO = 0.6;

export const KB_SEARCH_MIN_NOT_FOUND = 10;

export const KB_SEARCH_SLO: ServiceLevelObjective = {
  id: "module:kb:search",
  kind: "module",
  subject: "kb",
  statement: `No more than ${KB_SEARCH_MAX_FAULT_RATIO * 100}% of KB search operations end in ${KB_SEARCH_FAULT_OUTCOMES.join(", ")} over a ${KB_SEARCH_WINDOW_HOURS}h window, measured on at least ${KB_SEARCH_MIN_FAULTS} faults; and neither access denials (over ${KB_SEARCH_MAX_DENIED_RATIO * 100}% of operations on at least ${KB_SEARCH_MIN_DENIALS} denials) nor empty results (over ${KB_SEARCH_MAX_NOT_FOUND_RATIO * 100}% on at least ${KB_SEARCH_MIN_NOT_FOUND}) exceed their anomaly thresholds.`,
  indicator: {
    kind: "outcome-rate",
    spanName: KB_SEARCH_SPAN,
    outcomeAttribute: "kb.search.outcome",
    faultOutcomes: KB_SEARCH_FAULT_OUTCOMES,
    maxFaultRatio: KB_SEARCH_MAX_FAULT_RATIO,
    minFaults: KB_SEARCH_MIN_FAULTS,
    windowHours: KB_SEARCH_WINDOW_HOURS,
  },
  owner: "knowledge-team",
  alertId: "kb-search",
  runbookFile: KB_ALERT_RUNBOOK,
  runbookAnchor: "#kb-search",
};

export const KB_SEARCH_SLOS: readonly ServiceLevelObjective[] = [KB_SEARCH_SLO];
