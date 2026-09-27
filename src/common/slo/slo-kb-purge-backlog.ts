import { KB_ALERT_RUNBOOK, type ServiceLevelObjective } from "./slo-types";

export const KB_PURGE_STALE_MINUTES = 60;

export const KB_PURGE_MIN_ROWS = 5;

export const KB_PURGE_BACKLOG_WINDOW_HOURS = 1;

export const KB_PURGE_BACKLOG_SLO: ServiceLevelObjective = {
  id: "module:kb:purge-backlog",
  kind: "module",
  subject: "kb",
  statement: `No ${KB_PURGE_MIN_ROWS} or more kb_page_purge_ledger rows should remain in PENDING state with the oldest row older than ${KB_PURGE_STALE_MINUTES} minutes. Both conditions must hold simultaneously — a fresh backlog of any size is not an incident.`,
  indicator: {
    kind: "db-threshold",
    description:
      "Count of kb_page_purge_ledger rows in PENDING status where the oldest row's created_at is more than 60 minutes ago. The alert fires only when count >= 5 AND oldest age > 60 minutes; a large but fresh backlog does not trigger. Five pending rows older than the threshold indicates the multi-store drainer (visits, favorites, source_links, page_rows, blobs) has stalled on at least one store.",
    maxThreshold: KB_PURGE_MIN_ROWS - 1,
    windowHours: KB_PURGE_BACKLOG_WINDOW_HOURS,
  },
  owner: "knowledge-team",
  alertId: "kb-purge-backlog",
  runbookFile: KB_ALERT_RUNBOOK,
  runbookAnchor: "#kb-purge-backlog",
};

export const KB_PURGE_BACKLOG_SLOS: readonly ServiceLevelObjective[] = [KB_PURGE_BACKLOG_SLO];
