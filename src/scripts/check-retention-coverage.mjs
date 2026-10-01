/* global process */

/**
 * check-retention-coverage.mjs — Verify that every high-growth table has a retention decision.
 *
 * Reads the retention policy matrix defined below against the live database.
 * Reports COVERED, UNCOVERED, and KEEP-FOREVER tables. Exits 1 when any
 * high-growth table (>= --threshold-mb) is uncovered. The threshold
 * must be a finite positive number; invalid input fails closed rather than
 * producing an empty, falsely-clean result.
 *
 * TWO WAYS THIS GATE USED TO REPORT GREEN OVER NOTHING, both now closed.
 *
 * 1. `pg_total_relation_size(c.oid) / 1048576` is INTEGER division on a bigint,
 *    so every table under 1 MiB measured as exactly 0 MB. `--threshold-mb=0.1`
 *    therefore selected the identical set as the default `1`, and no argument
 *    could ever reach a sub-megabyte table. Measured on a 946-table schema:
 *    `/1048576 >= 0.1` matched 41 tables and `/1048576.0 >= 0.1` matched 88.
 *    The divisor is now `1048576.0`, which is numeric division. At the default
 *    threshold of exactly 1 the selected set is unchanged (both forms reduce to
 *    `bytes >= 1048576`); what changes is that the threshold argument works.
 *
 * 2. Nothing put a floor under the corpus. Against a migrated-but-empty schema
 *    every table measured below the threshold, `highGrowth` came back empty,
 *    `uncovered` was therefore empty too, and the gate exited 0 having
 *    classified not one table. That green said "no uncovered table" when it
 *    meant "no table". MIN_TABLES_SCANNED and MIN_HIGH_GROWTH_TABLES below are
 *    the same shape as MIN_SEALS / MIN_SEALED_FILES in check-evidence-seal.mjs:
 *    an unmeasured corpus is INCONCLUSIVE (exit 2), never a pass.
 *
 * The floors are deliberately NOT raisable from the command line. The fix for a
 * gate that measures nothing is a database with something in it, not a lower bar.
 *
 * DATABASE_URL is read from the environment only. This script no longer calls
 * `dotenv.config()` itself: that silently substituted the .env connection string
 * whenever DATABASE_URL was unset, so the documented exit-2 path was unreachable
 * and the gate reported on whichever database .env happened to name. It also
 * wrote a banner to STDOUT, which corrupted the JSON report this script exists
 * to emit. The npm script passes `--env-file-if-exists=.env`, so the packaged
 * gate still picks up a local .env — by an explicit flag rather than in secret.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node src/scripts/check-retention-coverage.mjs
 *   node src/scripts/check-retention-coverage.mjs --threshold-mb=5
 *   node src/scripts/check-retention-coverage.mjs --self-test
 *   node src/scripts/check-retention-coverage.mjs --print-query
 *
 * Exit codes:
 *   0 = a real corpus was measured and every high-growth table is covered
 *   1 = at least one high-growth table has no retention decision
 *   2 = INCONCLUSIVE — DATABASE_URL unset, an unusable threshold, a query
 *       failure, or a corpus too small to have measured anything
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const thresholdArg = args.find((a) => a.startsWith("--threshold-mb="))?.slice(15) ?? "1";
export function parseThreshold(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--threshold-mb must be a finite positive number; received ${value}`);
  }
  return parsed;
}

let thresholdMb;
try {
  thresholdMb = parseThreshold(thresholdArg);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

// Canonical owner slugs — mirrors MODULE_SLO_OWNERSHIP in slo-modules.ts via MODULE_OWNERS in route-attribution.mjs.
const RETENTION_OWNERS = new Set([
  "people-team",
  "delivery-team",
  "support-team",
  "finance-team",
  "payments-team",
  "knowledge-team",
  "communications-team",
  "platform-reliability",
]);

const RETENTION_MATRIX = {
  /**
   * Three decided 2026-09-10, from pg_catalog rather than from a guess: the FK
   * counts quoted below were read out of pg_constraint, and the deleted_at
   * claims out of information_schema.
   *
   * ⚠ FIVE MORE ARE UNCOVERED AND ARE DELIBERATELY NOT HERE. Adding a line to
   * this map is what turns the gate green, so it is exactly the wrong place to
   * record a guess — an invented retention period would read as a decision
   * somebody made, and the sweep that eventually enforces it would delete real
   * rows on that authority.
   *
   *   helpdesk_tickets (237 MB), mail_message_metadata (12 MB),
   *   announcements (9 MB)
   *     — each needs a retention PERIOD, which is a product and DPDP question,
   *       not an engineering one. RETAIN-BOUNDED is almost certainly the shape;
   *       the number is not mine to pick, and a worker has to exist before the
   *       decision means anything.
   *
   *   performance_reviews (141 MB), hr_reporting_lines (1 MB)
   *     — HR-owned. Behind the fence, and the retention of appraisal records
   *       carries statutory obligations this lane has no standing to decide.
   *
   * The gate stays red until those five are answered by the people who own
   * them. That is the gate working.
   */
  gl_accounts: {
    decision: "KEEP-FOREVER",
    // db/schema/accounting → MODULE_OWNERS.accounting in route-attribution.mjs.
    owner: "finance-team",
    worker: null,
    notes:
      "Chart of accounts. Referenced by 12 tables including ap_document_lines, ap_payments, ap_withholding, ar_document_lines, ar_receipts and bank_profiles — deleting an account orphans posted financial history, and the row IS the meaning of every amount that points at it. Reference data, not an event stream: 1 MB and it does not grow with volume. Carries deleted_at, so withdrawing an account is a soft delete and the history stays joinable.",
  },
  business_parties: {
    decision: "KEEP-FOREVER",
    // db/schema/party is nobody's module folder: no registry entry owns the
    // `party` namespace, CRM merely administers it (administersNamespaces), and
    // CRM is in route-attribution's SLO_EXCLUDED_MODULES — which is exactly the
    // case that file resolves to platform-reliability. Accounting, CRM and
    // Inventory all read this table, so naming any one of them as owner would
    // be picking a tenant of the record as its landlord.
    owner: "platform-reliability",
    worker: null,
    notes:
      "Customer/vendor master. Referenced by 45 tables, and it is the single copy since the CRM legacy rows stopped being written — the Party IS the record. Retention is by SOFT delete (deleted_at), so a removed party stays joinable from the invoice that names it. The one physical-delete path is DPDP/GDPR erasure, which root CLAUDE.md lists as an explicit exception to soft-delete and which no retention sweep may pre-empt: erasure is a legal instruction, not a schedule.",
  },
  party_roles: {
    decision: "KEEP-FOREVER",
    // Shares business_parties' lifecycle, so it shares its owner.
    owner: "platform-reliability",
    worker: null,
    notes:
      "Child of business_parties and shares its lifecycle; nothing references it, so it is deleted only with its party. Kept for the same reason: a role that vanished would make an old document's counterparty unexplainable.",
  },
  kb_article_chunks: {
    decision: "RETAIN-BOUNDED",
    worker: "CronKbChunkRetentionService",
    owner: "support-team",
    notes: "Prune chunks whose parent article/page is deleted or unpublished. 30k rows, 497 MB.",
  },
  chat_messages: {
    decision: "PARTITION+ARCHIVE",
    worker: "NotificationRetentionService (detach+drop)",
    owner: "communications-team",
    notes: "Partitioned monthly. DETACH PARTITION CONCURRENTLY + DROP. 365-day retention.",
  },
  timesheets: {
    decision: "KEEP-FOREVER",
    worker: null,
    owner: "people-team",
    notes: "Payroll-adjacent compliance obligation. 5k rows, 10.7 MB. No deletion allowed.",
  },
  ai_usage_logs: {
    decision: "RETAIN-BOUNDED",
    worker: "CronAiUsageRetentionService",
    owner: "platform-reliability",
    notes: "730-day default. Dry-run by default. Resumable cursor in Redis. 401 rows now.",
  },
  kb_pages: {
    decision: "RETAIN-BOUNDED",
    worker: "CronKbService (kb-trash-purge)",
    owner: "knowledge-team",
    notes: "Soft delete is the lifecycle; KbPageTreeService.purgeExpired hard-deletes in bounded batches once deleted_at is older than the org's trash_retention_days, recording attachment purge keys first. The worker existed and was DELIBERATELY unscheduled, its stated reason being the absence of this very inventory entry — so the drain was correct and dead, and the table read UNCOVERED against a live database. This entry is what let kb-trash-purge join RETENTION_JOBS. Decided 2026-09-04 (ticket 16, PRD-C134).",
  },
  kb_events: {
    decision: "RETAIN-BOUNDED",
    worker: "CronKbTelemetryRetentionService",
    owner: "knowledge-team",
    notes: "One row per article view and per search — the two hottest KB read paths — and the only source behind the analytics overview, gaps, no-results and content-gaps reports, whose rangeSchema leaves both bounds optional so the default read is unbounded. 365 days, matching chat_messages, the other user-attributable append-only stream. Free text in `query` and an actor membership make it discoverable, so org-wide and HR subject legal holds both stop the sweep. Decided 2026-09-04 (ticket 16, PRD-C134).",
  },
  kb_ingestion_checkpoints: {
    decision: "RETAIN-BOUNDED",
    worker: "CronKbTelemetryRetentionService",
    owner: "support-team",
    notes: "One row per chunk carrying a full vector(1536) plus its source text. clearCheckpoints fires only on ingestion SUCCESS, so a crashed worker, a source stranded in `processing` or a provider outage mid-batch leaves them permanently. Expired on the outbox dead-letter horizon (OUTBOX_RETENTION_DAYS = 30) by sharing that constant: nothing resumes a run whose retry budget expired. Derived data, so only the org-wide legal hold applies. Decided 2026-09-04 (ticket 16, PRD-C134).",
  },
  kb_chat_conversations: {
    decision: "RETAIN-BOUNDED",
    worker: "CronKbChatRetentionService",
    owner: "knowledge-team",
    notes: "Organization-configured chat history retention, defaulting to 90 days, with bounded tenant-scoped deletion.",
  },
  kb_page_versions: {
    decision: "KEEP-FOREVER",
    worker: null,
    owner: "knowledge-team",
    notes: "Wiki revision history is the content audit trail and the only path to restore a page after a bad edit; insert-only, matching kb_article_versions. Growth is bounded by the VERSION_WINDOW_MS snapshot throttle, not by deletion. Decided 2026-09-02 (S10).",
  },
  integration_webhook_deliveries: {
    decision: "RETAIN-BOUNDED",
    worker: "CronBuildRetentionService",
    owner: "delivery-team",
    notes: "Completed delivery attempts are retained for 90 days; pending attempts are never removed by this worker.",
  },
  notifications: {
    decision: "PARTITION+ARCHIVE",
    worker: "NotificationRetentionService (detach+drop)",
    owner: "communications-team",
    notes: "Partitioned monthly. 180-day retention.",
  },
  notification_events: {
    decision: "RETAIN-BOUNDED",
    worker: "CronNotificationRetentionService (body purge + record delete)",
    owner: "communications-team",
    notes: "90-day body purge, 13-month record delete.",
  },
  notification_deliveries: {
    decision: "RETAIN-BOUNDED",
    worker: "CronNotificationRetentionService",
    owner: "communications-team",
    notes: "90-day body purge, 13-month record delete.",
  },
  email_outbox: {
    decision: "RETAIN-BOUNDED",
    worker: "CronNotificationRetentionService",
    owner: "communications-team",
    notes: "90-day body purge, 13-month record delete.",
  },
  documents: {
    decision: "RETAIN-BOUNDED",
    worker: "CronHrRetentionService (via hr_retention_policies, recordType=document)",
    owner: "people-team",
    notes: "Policy-driven deletion or anonymization with legal-hold exclusion and bounded batches.",
  },
  helpdesk_tickets: {
    decision: "RETAIN-BOUNDED",
    worker: "CronHelpdeskRetentionService",
    owner: "people-team",
    notes: "730-day retention after resolved_at; only resolved or closed tickets are eligible. forEachOrg, batch 200, legal-hold exclusion, comments cascade.",
  },
  performance_reviews: {
    decision: "KEEP-FOREVER",
    worker: null,
    owner: "people-team",
    notes: "Employment-record obligation used in succession, compensation and dispute evidence. No deleted_at column; deletion needs an approved per-org statutory rule.",
  },
  mail_message_metadata: {
    decision: "RETAIN-BOUNDED",
    worker: "CronMailRetentionService",
    owner: "communications-team",
    notes: "365-day retention from synced_at. A re-syncable projection of the provider mailbox, not the system of record. forEachOrg, batch 500.",
  },
  announcements: {
    decision: "RETAIN-BOUNDED",
    worker: "CronAnnouncementsRetentionService",
    owner: "people-team",
    notes: "Expired past a 90-day grace and aged past 730 days. forEachOrg, batch 200 per phase; targets and reads cascade.",
  },
  notification_outbox: {
    decision: "RETAIN-BOUNDED",
    worker: "CronNotificationOutboxRetentionService",
    owner: "communications-team",
    notes: "30-day retention for PROCESSED, 180-day for DEAD so dead-letter evidence outlives the 24h alert window. PENDING and IN_FLIGHT rows are never touched. forEachOrg, batch 500, per-org lease.",
  },
  outbox_events: {
    decision: "RETAIN-BOUNDED",
    worker: "CronOutboxRetentionService",
    owner: "platform-reliability",
    notes: "30-day retention for terminal states (DELIVERED, DEAD, SUPPRESSED). PENDING and IN_FLIGHT rows are never touched. Global sweep (owner role, no tenant GUC), batch 1000. inbox_records processed_at < cutoff also swept.",
  },
  gdpr_export_jobs: {
    decision: "RETAIN-BOUNDED",
    worker: "CronGdprExportRetentionService",
    owner: "people-team",
    notes:
      "The export artifact is a complete dump of one subject's personal data. 72h expiry from " +
      "GdprExportService.EXPIRY_MS; the sweep marks the row expired, deletes the object from " +
      "storage and only then clears file_key, and reclaims jobs a dead worker left in 'running'. " +
      "forEachOrg, keyset page 100, hourly.",
  },
  audit_logs: {
    decision: "KEEP-FOREVER",
    worker: null,
    owner: "platform-reliability",
    notes: "Immutable audit obligation. No deleted_at column. DB-level triggers prevent mutation. Cannot be touched by any retention worker.",
  },
  hr_audit_logs: {
    decision: "KEEP-FOREVER",
    worker: null,
    owner: "people-team",
    notes: "HR audit trail. Written only by retention sweep itself as a record of what was purged. Never deleted.",
  },
  payroll_runs: {
    decision: "KEEP-FOREVER",
    worker: null,
    owner: "people-team",
    notes: "Financial record. Immutable after posting. Legal obligation to retain.",
  },
  hr_people: {
    decision: "RETAIN-BOUNDED",
    worker: "CronHrRetentionService (via hr_retention_policies)",
    owner: "people-team",
    notes: "Soft-delete only. Legal-hold exclusion enforced. Policy-driven (hr_retention_policies table).",
  },
  hr_employments: {
    decision: "KEEP-FOREVER",
    worker: null,
    owner: "people-team",
    notes: "Employment records carry payroll and statutory obligations. Not deletable.",
  },
  hr_reporting_lines: {
    decision: "KEEP-FOREVER",
    worker: null,
    owner: "people-team",
    notes: "Effective-dated reporting history supports employment/payroll auditability and is bounded by employment history; no automated deletion is permitted without an approved statutory-retention rule.",
  },
  attendance: {
    decision: "RETAIN-BOUNDED",
    worker: "CronHrRetentionService (via hr_retention_policies, recordType=attendance)",
    owner: "people-team",
    notes: "Physical delete allowed per policy. Legal-hold exclusion enforced.",
  },
  permissions: {
    decision: "KEEP-FOREVER",
    worker: null,
    owner: "platform-reliability",
    notes: "RBAC permission catalog. Grows as features are added, shrinks on removal. Configuration state, not event-sourced. 3 MB is mostly index overhead on 731 rows.",
  },
  role_permission_grants: {
    decision: "KEEP-FOREVER",
    worker: null,
    owner: "platform-reliability",
    notes: "Per-org role grants. Rows are deleted when grants are revoked or roles removed (cascading). Not append-only — size is bounded by org count × role count. No sweep needed.",
  },
};

function classify(tableName) {
  const entry = RETENTION_MATRIX[tableName];
  if (!entry) return { status: "UNCOVERED", decision: null, worker: null };
  return {
    status:
      entry.decision === "KEEP-FOREVER"
        ? "KEEP-FOREVER"
        : entry.decision === "PENDING-DECISION"
          ? "UNCOVERED"
          : "COVERED",
    decision: entry.decision,
    worker: entry.worker,
    notes: entry.notes,
  };
}

export function policyTableName(tableName, parentTableName = null) {
  return parentTableName || tableName;
}

/**
 * A gate that classified nothing must not answer "clean". Both floors below are
 * INCONCLUSIVE conditions, not failures: they say the corpus could not support a
 * verdict, which is a different claim from "every table is covered".
 *
 * MIN_TABLES_SCANNED — the schema this ran against must actually be a migrated
 * StreamlineOS schema. Head carries 946 base/partitioned tables in `public`; 200
 * is a floor no partial or wrong database clears while staying comfortably under
 * any real one.
 *
 * MIN_HIGH_GROWTH_TABLES — at least one table must clear the threshold, or the
 * classifier never ran and `uncovered.length === 0` is arithmetic rather than
 * evidence. This is the exact shape that reported green over a fully migrated but
 * empty 943-table database.
 */
export const MIN_TABLES_SCANNED = 200;
export const MIN_HIGH_GROWTH_TABLES = 1;

/**
 * The size expression, exported so the self-test asserts on the string the query
 * actually interpolates rather than on a regex over this file.
 *
 * The divisor MUST carry a decimal point. `pg_total_relation_size()` returns
 * bigint, and `bigint / bigint` is integer division in Postgres: with `1048576`
 * every table under one mebibyte evaluates to exactly 0, so `--threshold-mb`
 * could never select one and the flag was inert below 1. `1048576.0` is numeric,
 * so the quotient keeps its fraction.
 */
export const TOTAL_MB_EXPRESSION = "pg_total_relation_size(c.oid) / 1048576.0";

/** No bound parameters — the threshold is applied in JS so both forms stay comparable. */
export const CATALOGUE_QUERY = `
    SELECT
      c.relname                           AS table_name,
      COALESCE(parent.relname, c.relname) AS policy_table,
      ${TOTAL_MB_EXPRESSION}              AS total_mb,
      COALESCE(s.n_live_tup, 0)           AS n_live_tup
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
    LEFT JOIN pg_class parent ON parent.oid = i.inhparent
    LEFT JOIN pg_stat_user_tables s
      ON s.relname = c.relname AND s.schemaname = n.nspname
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
    ORDER BY pg_total_relation_size(c.oid) DESC
  `;

/*
 * `--print-query` exposes the shipped SQL and the corpus floors without opening a
 * connection, so retention-coverage-gate.db.spec.ts can measure THIS file rather
 * than an importable copy of it. Importing the module is not an option: it calls
 * process.exit() at top level, which would take the jest worker with it.
 */
if (args.includes("--print-query")) {
  process.stdout.write(
    JSON.stringify(
      {
        totalMbExpression: TOTAL_MB_EXPRESSION,
        catalogueQuery: CATALOGUE_QUERY,
        minTablesScanned: MIN_TABLES_SCANNED,
        minHighGrowthTables: MIN_HIGH_GROWTH_TABLES,
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

if (args.includes("--self-test")) {
  const checks = {
    auditLogsIsKeepForever: RETENTION_MATRIX["audit_logs"].decision === "KEEP-FOREVER",
    payrollRunsIsKeepForever: RETENTION_MATRIX["payroll_runs"].decision === "KEEP-FOREVER",
    aiUsageLogsHasWorker: RETENTION_MATRIX["ai_usage_logs"].worker !== null,
    chatMessagesHasWorker: RETENTION_MATRIX["chat_messages"].worker !== null,
    kbChunksHasWorker: RETENTION_MATRIX["kb_article_chunks"].worker !== null,
    kbChatConversationsHasWorker: RETENTION_MATRIX["kb_chat_conversations"].worker === "CronKbChatRetentionService",
    /*
     * Both of these were invisible to this gate rather than covered by it. It reports on
     * tables at or above --threshold-mb in the live database, so an uncovered table that
     * is still small is never classified at all — and "not in the report" reads exactly
     * like "fine". Naming them in the matrix is what lets `classify` answer for them the
     * moment they cross the threshold, instead of the gate discovering them by growing.
     */
    kbPagesHasWorker:
      RETENTION_MATRIX["kb_pages"].worker !== null &&
      classify("kb_pages").status === "COVERED",
    kbEventsHasWorker:
      RETENTION_MATRIX["kb_events"].worker === "CronKbTelemetryRetentionService" &&
      classify("kb_events").status === "COVERED",
    kbIngestionCheckpointsHasWorker:
      RETENTION_MATRIX["kb_ingestion_checkpoints"].worker === "CronKbTelemetryRetentionService" &&
      classify("kb_ingestion_checkpoints").status === "COVERED",
    webhookDeliveriesHaveWorker: RETENTION_MATRIX["integration_webhook_deliveries"].worker === "CronBuildRetentionService",
    auditLogsHasNoWorker: RETENTION_MATRIX["audit_logs"].worker === null,
    classifyUnknownIsUncovered: classify("unknown_table_xyz", 100).status === "UNCOVERED",
    classifyAuditLogsIsKeepForever: classify("audit_logs", 0).status === "KEEP-FOREVER",
    partitionUsesParentDecision:
      classify(policyTableName("notifications_y2026_m08", "notifications")).status === "COVERED" &&
      classify(policyTableName("chat_messages_y2026_m08", "chat_messages")).status === "COVERED",
    reportingLinesHaveDecision: RETENTION_MATRIX["hr_reporting_lines"].decision === "KEEP-FOREVER",
    documentsHaveExistingWorker: RETENTION_MATRIX["documents"].worker === "CronHrRetentionService (via hr_retention_policies, recordType=document)",
    outboxTablesAreNowCovered: ["notification_outbox", "outbox_events"].every(
      (table) =>
        RETENTION_MATRIX[table].decision === "RETAIN-BOUNDED" &&
        typeof RETENTION_MATRIX[table].worker === "string" &&
        classify(table).status === "COVERED",
    ),
    decidedTablesAreNoLongerPending: [
      ["helpdesk_tickets", "CronHelpdeskRetentionService"],
      ["mail_message_metadata", "CronMailRetentionService"],
      ["announcements", "CronAnnouncementsRetentionService"],
      ["notification_outbox", "CronNotificationOutboxRetentionService"],
      ["outbox_events", "CronOutboxRetentionService"],
    ].every(
      ([table, worker]) =>
        RETENTION_MATRIX[table].decision === "RETAIN-BOUNDED" &&
        RETENTION_MATRIX[table].worker === worker &&
        classify(table).status === "COVERED",
    ),
    performanceReviewsIsKeepForever:
      RETENTION_MATRIX["performance_reviews"].decision === "KEEP-FOREVER" &&
      classify("performance_reviews").status === "KEEP-FOREVER",
    /*
     * The regression this gate shipped for two releases: an integer divisor made
     * every sub-megabyte table measure 0 MB, so `--threshold-mb=0.1` selected the
     * identical set as the default and no argument could reach below 1 MB. A
     * database is needed to prove the arithmetic (retention-coverage-gate.db.spec.ts
     * does that); what this check pins is that the divisor never loses its decimal
     * point again, since that single character is the whole defect.
     */
    sizeDivisorIsNumericNotInteger:
      /\/\s*1048576\.\d/.test(TOTAL_MB_EXPRESSION) && !/\/\s*1048576\s*(?![.\d])/.test(TOTAL_MB_EXPRESSION),
    catalogueQueryUsesTheExportedSizeExpression: CATALOGUE_QUERY.includes(TOTAL_MB_EXPRESSION),
    /* A corpus floor that can be satisfied by an empty database is not a floor. */
    corpusFloorsAreAboveZero: MIN_TABLES_SCANNED > 0 && MIN_HIGH_GROWTH_TABLES > 0,
    corpusFloorIsNotCommandLineRaisable: !args.some((a) => a.startsWith("--min-tables")),
    invalidThresholdsFailClosed: ["", "0", "-1", "NaN", "Infinity"].every((value) => {
      try {
        parseThreshold(value);
        return false;
      } catch {
        return true;
      }
    }),
    decimalThresholdIsAccepted: parseThreshold("1.5") === 1.5,
    everyMatrixEntryHasDecision: Object.values(RETENTION_MATRIX).every((entry) =>
      ["RETAIN-BOUNDED", "PARTITION+ARCHIVE", "KEEP-FOREVER", "PENDING-DECISION"].includes(entry.decision),
    ),
    everyMatrixEntryHasNotes: Object.values(RETENTION_MATRIX).every(
      (entry) => typeof entry.notes === "string" && entry.notes.trim().length > 0,
    ),
    everyMatrixEntryHasOwner: Object.values(RETENTION_MATRIX).every(
      (entry) => typeof entry.owner === "string" && entry.owner.trim().length > 0,
    ),
    everyMatrixOwnerIsCanonical: Object.values(RETENTION_MATRIX).every(
      (entry) => RETENTION_OWNERS.has(entry.owner),
    ),
    keepForeverEntriesHaveNoWorker: Object.values(RETENTION_MATRIX)
      .filter((entry) => entry.decision === "KEEP-FOREVER")
      .every((entry) => entry.worker === null),
    boundedEntriesHaveWorker: Object.values(RETENTION_MATRIX)
      .filter((entry) => ["RETAIN-BOUNDED", "PARTITION+ARCHIVE"].includes(entry.decision))
      .every((entry) => typeof entry.worker === "string" && entry.worker.length > 0),
  };
  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }) + "\n");
  process.exit(pass ? 0 : 1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write(
    "INCONCLUSIVE — DATABASE_URL is not set, so no table was measured. " +
      "This is exit 2, not a pass.\n",
  );
  process.exit(2);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  const rows = await sql.unsafe(CATALOGUE_QUERY);

  const results = rows.map((row) => {
    const totalMb = Number(row.total_mb ?? 0);
    const classification = classify(policyTableName(String(row.table_name), row.policy_table), totalMb);
    return {
      table_name: row.table_name,
      policy_table: row.policy_table,
      total_mb: totalMb,
      n_live_tup: Number(row.n_live_tup ?? 0),
      ...classification,
    };
  });

  if (results.length < MIN_TABLES_SCANNED) {
    process.stderr.write(
      `INCONCLUSIVE — the catalogue query returned ${results.length} table(s) in schema "public" ` +
        `(expected >= ${MIN_TABLES_SCANNED}). This is not a migrated StreamlineOS schema, so ` +
        `"no uncovered table" would mean "no table". Point DATABASE_URL at a migrated database.\n`,
    );
    await sql.end();
    process.exit(2);
  }

  const highGrowth = results.filter((r) => r.total_mb >= thresholdMb);
  const uncovered = highGrowth.filter((r) => r.status === "UNCOVERED");
  const covered = highGrowth.filter((r) => r.status === "COVERED");
  const keepForever = highGrowth.filter((r) => r.status === "KEEP-FOREVER");

  process.stdout.write(
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        thresholdMb,
        summary: {
          highGrowthTables: highGrowth.length,
          covered: covered.length,
          keepForever: keepForever.length,
          uncovered: uncovered.length,
        },
        uncovered,
        covered,
        keepForever,
        allHighGrowth: highGrowth,
      },
      null,
      2,
    ) + "\n",
  );

  if (uncovered.length > 0) {
    process.stderr.write(
      `WARN: ${uncovered.length} table(s) >= ${thresholdMb} MB have no retention decision:\n` +
        uncovered.map((t) => `  - ${t.table_name} (${t.total_mb} MB, ${t.n_live_tup} rows)`).join("\n") +
        "\n",
    );
    process.exit(1);
  }

  if (highGrowth.length < MIN_HIGH_GROWTH_TABLES) {
    process.stderr.write(
      `INCONCLUSIVE — ${results.length} table(s) were scanned and ${highGrowth.length} cleared ` +
        `${thresholdMb} MB, so the retention matrix was never consulted. Exiting 0 here would ` +
        `report "every high-growth table is covered" over an empty set. Run this against a ` +
        `database carrying real data, or lower --threshold-mb — do not read this as a pass.\n`,
    );
    await sql.end();
    process.exit(2);
  }

  process.exit(0);
} catch (err) {
  process.stderr.write(`QUERY FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
} finally {
  await sql.end();
}
