import { KB_ALERT_RUNBOOK, type ServiceLevelObjective } from "./slo-types";

export const KB_READ_SPAN = "kb.read.operation";

export const KB_READ_MAX_FAULT_RATIO = 0.05;

export const KB_READ_MIN_FAULTS = 2;

export const KB_READ_WINDOW_HOURS = 1;

export const KB_READ_FAULT_OUTCOMES = ["denied", "error"] as const;

export const KB_READ_SLO: ServiceLevelObjective = {
  id: "module:kb:read",
  kind: "module",
  subject: "kb",
  statement: `No more than ${KB_READ_MAX_FAULT_RATIO * 100}% of KB read operations end in ${KB_READ_FAULT_OUTCOMES.join(", ")} over a ${KB_READ_WINDOW_HOURS}h window, measured on at least ${KB_READ_MIN_FAULTS} faults.`,
  indicator: {
    kind: "outcome-rate",
    spanName: KB_READ_SPAN,
    outcomeAttribute: "kb.read.outcome",
    faultOutcomes: KB_READ_FAULT_OUTCOMES,
    maxFaultRatio: KB_READ_MAX_FAULT_RATIO,
    minFaults: KB_READ_MIN_FAULTS,
    windowHours: KB_READ_WINDOW_HOURS,
  },
  owner: "knowledge-team",
  alertId: "kb-read",
  runbookFile: KB_ALERT_RUNBOOK,
  runbookAnchor: "#kb-read",
};

export const KB_WRITE_SPAN = "kb.write.operation";

export const KB_WRITE_MAX_FAULT_RATIO = 0.05;

export const KB_WRITE_MIN_FAULTS = 2;

export const KB_WRITE_WINDOW_HOURS = 1;

export const KB_WRITE_FAULT_OUTCOMES = ["denied", "error"] as const;

export const KB_WRITE_SLO: ServiceLevelObjective = {
  id: "module:kb:write",
  kind: "module",
  subject: "kb",
  statement: `No more than ${KB_WRITE_MAX_FAULT_RATIO * 100}% of KB write operations end in ${KB_WRITE_FAULT_OUTCOMES.join(", ")} over a ${KB_WRITE_WINDOW_HOURS}h window, measured on at least ${KB_WRITE_MIN_FAULTS} faults.`,
  indicator: {
    kind: "outcome-rate",
    spanName: KB_WRITE_SPAN,
    outcomeAttribute: "kb.write.outcome",
    faultOutcomes: KB_WRITE_FAULT_OUTCOMES,
    maxFaultRatio: KB_WRITE_MAX_FAULT_RATIO,
    minFaults: KB_WRITE_MIN_FAULTS,
    windowHours: KB_WRITE_WINDOW_HOURS,
  },
  owner: "knowledge-team",
  alertId: "kb-write",
  runbookFile: KB_ALERT_RUNBOOK,
  runbookAnchor: "#kb-write",
};

export const KB_READ_WRITE_SLOS: readonly ServiceLevelObjective[] = [KB_READ_SLO, KB_WRITE_SLO];
