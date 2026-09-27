import { MODULE_SLOS } from "./slo-modules";
import { QUEUE_SLOS } from "./slo-queues";
import { KB_SLOS } from "./slo-kb-indexing";
import { KB_ASK_SLOS } from "./slo-kb-ask";
import { KB_SEARCH_SLOS } from "./slo-kb-search";
import { KB_FRESHNESS_SLOS } from "./slo-kb-freshness";
import { KB_READ_WRITE_SLOS } from "./slo-kb-read-write";
import { KB_DB_HEALTH_SLOS } from "./slo-kb-db-health";
import { KB_ACL_ANOMALY_SLOS } from "./slo-kb-acl-anomaly";
import { KB_PURGE_BACKLOG_SLOS } from "./slo-kb-purge-backlog";
import type { ServiceLevelObjective } from "./slo-types";

export { SLO_OWNERS, KB_ALERT_RUNBOOK } from "./slo-types";
export { MODULE_SLOS } from "./slo-modules";
export { QUEUE_SLOS, QUEUE_SUBJECTS } from "./slo-queues";
export {
  KB_SLOS,
  KB_INDEXING_SLO,
  KB_INDEXING_SPAN,
  KB_INDEXING_MIN_FAULTS,
  KB_INDEXING_FAULT_OUTCOMES,
  KB_INDEXING_MAX_FAULT_RATIO,
} from "./slo-kb-indexing";
export {
  KB_ASK_SLO,
  KB_ASK_SLOS,
  KB_ASK_SPAN,
  KB_ASK_MIN_FAULTS,
  KB_ASK_FAULT_OUTCOMES,
  KB_ASK_MAX_FAULT_RATIO,
} from "./slo-kb-ask";
export {
  KB_SEARCH_SLO,
  KB_SEARCH_SLOS,
  KB_SEARCH_SPAN,
  KB_SEARCH_MIN_FAULTS,
  KB_SEARCH_MIN_DENIALS,
  KB_SEARCH_MIN_NOT_FOUND,
  KB_SEARCH_FAULT_OUTCOMES,
  KB_SEARCH_MAX_FAULT_RATIO,
  KB_SEARCH_MAX_DENIED_RATIO,
  KB_SEARCH_MAX_NOT_FOUND_RATIO,
} from "./slo-kb-search";

export {
  KB_FRESHNESS_SLOS,
  KB_INDEX_FRESHNESS_SLO,
  KB_ACCESS_REVOCATION_SLO,
  KB_INDEX_FRESHNESS_STALE_THRESHOLD_MINUTES,
  KB_INDEX_FRESHNESS_MIN_PAGES,
  KB_ACCESS_REVOCATION_LAG_THRESHOLD_SECONDS,
  KB_ACCESS_REVOCATION_MIN_PAGES,
} from "./slo-kb-freshness";

export {
  KB_DB_HEALTH_SLO,
  KB_DB_HEALTH_SLOS,
  KB_DB_MAX_CONNECTIONS,
  KB_DB_MAX_LOCK_WAITS,
  KB_DB_SLOW_QUERY_MS,
  KB_DB_MIN_CACHE_HIT_PCT,
} from "./slo-kb-db-health";

export {
  KB_ACL_ANOMALY_SLO,
  KB_ACL_ANOMALY_SLOS,
  KB_ACL_ANOMALY_MAX_DENIAL_RATIO,
  KB_ACL_ANOMALY_MAX_NOT_FOUND_RATIO,
  KB_ACL_ANOMALY_MIN_DENIALS,
  KB_ACL_ANOMALY_MIN_NOT_FOUND,
  KB_ACL_ANOMALY_MIN_TOTAL_REQUESTS,
} from "./slo-kb-acl-anomaly";

export {
  KB_PURGE_BACKLOG_SLO,
  KB_PURGE_BACKLOG_SLOS,
  KB_PURGE_STALE_MINUTES,
  KB_PURGE_MIN_ROWS,
} from "./slo-kb-purge-backlog";

export const SLO_CATALOGUE: readonly ServiceLevelObjective[] = [
  ...MODULE_SLOS,
  ...QUEUE_SLOS,
  ...KB_SLOS,
  ...KB_ASK_SLOS,
  ...KB_SEARCH_SLOS,
  ...KB_FRESHNESS_SLOS,
  ...KB_READ_WRITE_SLOS,
  ...KB_DB_HEALTH_SLOS,
  ...KB_ACL_ANOMALY_SLOS,
  ...KB_PURGE_BACKLOG_SLOS,
];
