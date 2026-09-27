import { KB_ALERT_RUNBOOK, type ServiceLevelObjective } from "./slo-types";

export const KB_ASK_SPAN = "kb.ask.operation";

export const KB_ASK_MAX_FAULT_RATIO = 0.05;

export const KB_ASK_MIN_FAULTS = 2;

export const KB_ASK_WINDOW_HOURS = 1;

export const KB_ASK_FAULT_OUTCOMES = [
  "credits_exhausted",
  "provider_unavailable",
  "error",
] as const;

export const KB_ASK_SLO: ServiceLevelObjective = {
  id: "module:kb:ask",
  kind: "module",
  subject: "kb",
  statement: `No more than ${KB_ASK_MAX_FAULT_RATIO * 100}% of KB Ask operations end in ${KB_ASK_FAULT_OUTCOMES.join(", ")} over a ${KB_ASK_WINDOW_HOURS}h window, measured on at least ${KB_ASK_MIN_FAULTS} faults.`,
  indicator: {
    kind: "outcome-rate",
    spanName: KB_ASK_SPAN,
    outcomeAttribute: "kb.ask.outcome",
    faultOutcomes: KB_ASK_FAULT_OUTCOMES,
    maxFaultRatio: KB_ASK_MAX_FAULT_RATIO,
    minFaults: KB_ASK_MIN_FAULTS,
    windowHours: KB_ASK_WINDOW_HOURS,
  },
  owner: "knowledge-team",
  alertId: "kb-ask",
  runbookFile: KB_ALERT_RUNBOOK,
  runbookAnchor: "#kb-ask",
};

export const KB_ASK_SLOS: readonly ServiceLevelObjective[] = [KB_ASK_SLO];
