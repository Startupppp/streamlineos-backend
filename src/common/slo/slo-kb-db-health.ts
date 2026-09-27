import { KB_ALERT_RUNBOOK, type ServiceLevelObjective } from "./slo-types";

export const KB_DB_MAX_CONNECTIONS = 80;

export const KB_DB_MAX_LOCK_WAITS = 5;

export const KB_DB_SLOW_QUERY_MS = 100;

export const KB_DB_MIN_CACHE_HIT_PCT = 90;

export const KB_DB_HEALTH_WINDOW_HOURS = 1;

export const KB_DB_HEALTH_SLO: ServiceLevelObjective = {
  id: "module:kb:db-health",
  kind: "module",
  subject: "kb",
  statement: `KB DB health within a ${KB_DB_HEALTH_WINDOW_HOURS}h window: active+idle-in-transaction connections at or below ${KB_DB_MAX_CONNECTIONS}; lock-waiting sessions at or below ${KB_DB_MAX_LOCK_WAITS}; no KB table query with mean execution time above ${KB_DB_SLOW_QUERY_MS}ms; buffer cache hit rate at or above ${KB_DB_MIN_CACHE_HIT_PCT}% per KB table. Replica lag is not measured — this deployment has no read-replica endpoint.`,
  indicator: {
    kind: "db-threshold",
    description:
      "Composite of four catalog queries: (1) pg_stat_activity active+idle-in-transaction count vs max 80; (2) pg_stat_activity lock-wait count vs max 5; (3) pg_stat_statements mean_exec_time above 100ms for KB-table queries when the extension is installed; (4) pg_statio_user_tables hit rate below 90% for kb_% tables with at least one block read. Replica lag is blocked/no-replica-endpoint — not a measurable signal in this deployment.",
    maxThreshold: KB_DB_MAX_CONNECTIONS,
    windowHours: KB_DB_HEALTH_WINDOW_HOURS,
  },
  owner: "knowledge-team",
  alertId: "kb-db-health",
  runbookFile: KB_ALERT_RUNBOOK,
  runbookAnchor: "#kb-db-health",
};

export const KB_DB_HEALTH_SLOS: readonly ServiceLevelObjective[] = [KB_DB_HEALTH_SLO];
