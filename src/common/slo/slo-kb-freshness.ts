import { KB_ALERT_RUNBOOK, type ServiceLevelObjective } from "./slo-types";

export const KB_INDEX_FRESHNESS_STALE_THRESHOLD_MINUTES = 30;

export const KB_INDEX_FRESHNESS_MIN_PAGES = 3;

export const KB_INDEX_FRESHNESS_WINDOW_HOURS = 24;

export const KB_INDEX_FRESHNESS_SLO: ServiceLevelObjective = {
  id: "module:kb:index-freshness",
  kind: "module",
  subject: "kb",
  statement: `No KB page modified in the last ${KB_INDEX_FRESHNESS_WINDOW_HOURS}h and older than ${KB_INDEX_FRESHNESS_STALE_THRESHOLD_MINUTES} minutes should lack indexed chunks, measured on at least ${KB_INDEX_FRESHNESS_MIN_PAGES} such pages.`,
  indicator: {
    kind: "db-threshold",
    description:
      "Count of kb_pages rows where updated_at is within the lookback window, older than the stale threshold, and no kb_article_chunks row exists for that page.",
    maxThreshold: KB_INDEX_FRESHNESS_MIN_PAGES - 1,
    windowHours: KB_INDEX_FRESHNESS_WINDOW_HOURS,
  },
  owner: "knowledge-team",
  alertId: "kb-index-freshness",
  runbookFile: KB_ALERT_RUNBOOK,
  runbookAnchor: "#kb-index-freshness",
};

export const KB_ACCESS_REVOCATION_LAG_THRESHOLD_SECONDS = 300;

export const KB_ACCESS_REVOCATION_MIN_PAGES = 3;

export const KB_ACCESS_REVOCATION_SLO: ServiceLevelObjective = {
  id: "module:kb:access-revocation",
  kind: "module",
  subject: "kb",
  statement: `No KB page ACL change should remain unsynced in the chunk index for more than ${KB_ACCESS_REVOCATION_LAG_THRESHOLD_SECONDS} seconds, measured on at least ${KB_ACCESS_REVOCATION_MIN_PAGES} lagging pages.`,
  indicator: {
    kind: "db-threshold",
    description:
      "Count of kb_pages where acl_revision_changed_at exceeds lag threshold and no kb_article_chunks row has acl_synced_at >= acl_revision_changed_at. Guarded by column-existence check; reports 0 when columns are absent.",
    maxThreshold: KB_ACCESS_REVOCATION_MIN_PAGES - 1,
    windowHours: 1,
  },
  owner: "knowledge-team",
  alertId: "kb-revocation-lag",
  runbookFile: KB_ALERT_RUNBOOK,
  runbookAnchor: "#kb-revocation-lag",
};

export const KB_FRESHNESS_SLOS: readonly ServiceLevelObjective[] = [
  KB_INDEX_FRESHNESS_SLO,
  KB_ACCESS_REVOCATION_SLO,
];
