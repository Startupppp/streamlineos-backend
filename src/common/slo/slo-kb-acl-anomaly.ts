import { KB_ALERT_RUNBOOK, type ServiceLevelObjective } from "./slo-types";

export const KB_ACL_ANOMALY_MAX_DENIAL_RATIO = 0.15;

export const KB_ACL_ANOMALY_MAX_NOT_FOUND_RATIO = 0.4;

export const KB_ACL_ANOMALY_MIN_DENIALS = 10;

export const KB_ACL_ANOMALY_MIN_NOT_FOUND = 10;

export const KB_ACL_ANOMALY_MIN_TOTAL_REQUESTS = 20;

export const KB_ACL_ANOMALY_WINDOW_HOURS = 1;

export const KB_ACL_ANOMALY_SLO: ServiceLevelObjective = {
  id: "module:kb:acl-anomaly",
  kind: "module",
  subject: "kb",
  statement: `Over a ${KB_ACL_ANOMALY_WINDOW_HOURS}h window of at least ${KB_ACL_ANOMALY_MIN_TOTAL_REQUESTS} KB route requests: 403 denial ratio stays at or below ${KB_ACL_ANOMALY_MAX_DENIAL_RATIO * 100}% (on at least ${KB_ACL_ANOMALY_MIN_DENIALS} denials); 404 not-found ratio stays at or below ${KB_ACL_ANOMALY_MAX_NOT_FOUND_RATIO * 100}% (on at least ${KB_ACL_ANOMALY_MIN_NOT_FOUND} not-founds). Measured from structured log SPAN lines on /kb/ routes.`,
  indicator: {
    kind: "outcome-rate",
    spanName: "kb.route",
    outcomeAttribute: "http.status_code",
    faultOutcomes: ["403", "404"],
    maxFaultRatio: KB_ACL_ANOMALY_MAX_DENIAL_RATIO,
    minFaults: KB_ACL_ANOMALY_MIN_DENIALS,
    windowHours: KB_ACL_ANOMALY_WINDOW_HOURS,
  },
  owner: "knowledge-team",
  alertId: "kb-acl-anomaly",
  runbookFile: KB_ALERT_RUNBOOK,
  runbookAnchor: "#kb-acl-anomaly",
};

export const KB_ACL_ANOMALY_SLOS: readonly ServiceLevelObjective[] = [KB_ACL_ANOMALY_SLO];
