/* global process */

/**
 * check-retention-coverage.mjs — Verify that every high-growth table has a retention decision.
 *
 * Reads the retention policy matrix defined below against the live database.
 * Reports COVERED, UNCOVERED, and KEEP-FOREVER tables. Exits 1 when any
 * high-growth table (>= COVERAGE_THRESHOLD_MB) is uncovered. The threshold
 * must be a finite positive number; invalid input fails closed rather than
 * producing an empty, falsely-clean result.
 *
 * Usage:
 *   node src/scripts/check-retention-coverage.mjs
 *   node src/scripts/check-retention-coverage.mjs --threshold-mb=5
 *   node src/scripts/check-retention-coverage.mjs --self-test
 *
 * Exit codes:
 *   0 = all high-growth tables are covered
 *   1 = at least one high-growth table has no retention decision
 *   2 = DATABASE_URL not set
 */
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

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

const RETENTION_MATRIX = {
  kb_article_chunks: {
    decision: "RETAIN-BOUNDED",
    worker: "CronKbChunkRetentionService",
    notes: "Prune chunks whose parent article/page is deleted or unpublished. 30k rows, 497 MB.",
  },
  chat_messages: {
    decision: "PARTITION+ARCHIVE",
    worker: "NotificationRetentionService (detach+drop)",
    notes: "Partitioned monthly. DETACH PARTITION CONCURRENTLY + DROP. 365-day retention.",
  },
  timesheets: {
    decision: "KEEP-FOREVER",
    worker: null,
    notes: "Payroll-adjacent compliance obligation. 5k rows, 10.7 MB. No deletion allowed.",
  },
  ai_usage_logs: {
    decision: "RETAIN-BOUNDED",
    worker: "CronAiUsageRetentionService",
    notes: "730-day default. Dry-run by default. Resumable cursor in Redis. 401 rows now.",
  },
  kb_chat_conversations: {
    decision: "RETAIN-BOUNDED",
    worker: "CronKbChatRetentionService",
    notes: "Organization-configured chat history retention, defaulting to 90 days, with bounded tenant-scoped deletion.",
  },
  webhook_deliveries: {
    decision: "RETAIN-BOUNDED",
    worker: "CronBuildRetentionService",
    notes: "Completed delivery attempts are retained for 90 days; pending attempts are never removed by this worker.",
  },
  notifications: {
    decision: "PARTITION+ARCHIVE",
    worker: "NotificationRetentionService (detach+drop)",
    notes: "Partitioned monthly. 180-day retention.",
  },
  notification_events: {
    decision: "RETAIN-BOUNDED",
    worker: "CronNotificationRetentionService (body purge + record delete)",
    notes: "90-day body purge, 13-month record delete.",
  },
  notification_deliveries: {
    decision: "RETAIN-BOUNDED",
    worker: "CronNotificationRetentionService",
    notes: "90-day body purge, 13-month record delete.",
  },
  email_outbox: {
    decision: "RETAIN-BOUNDED",
    worker: "CronNotificationRetentionService",
    notes: "90-day body purge, 13-month record delete.",
  },
  documents: {
    decision: "RETAIN-BOUNDED",
    worker: "CronHrRetentionService (via hr_retention_policies, recordType=document)",
    notes: "Policy-driven deletion or anonymization with legal-hold exclusion and bounded batches.",
  },
  helpdesk_tickets: {
    decision: "PENDING-DECISION",
    worker: null,
    notes: "No safe automated retention worker exists; ticket and comment retention requires an approved policy and dependency review.",
  },
  performance_reviews: {
    decision: "PENDING-DECISION",
    worker: null,
    notes: "No safe automated retention worker exists; review and cycle dependencies require an approved policy before deletion.",
  },
  mail_message_metadata: {
    decision: "PENDING-DECISION",
    worker: null,
    notes: "Synced mailbox metadata has no approved retention worker; account, thread, and provider synchronization dependencies require review.",
  },
  announcements: {
    decision: "PENDING-DECISION",
    worker: null,
    notes: "Expiry metadata exists but no retention worker is wired; announcement targets and reads require an approved lifecycle policy.",
  },
  notification_outbox: {
    decision: "PENDING-DECISION",
    worker: null,
    notes: "No safe worker exists; pending and in-flight notification intents must not be deleted without an approved processed/dead-state policy.",
  },
  outbox_events: {
    decision: "PENDING-DECISION",
    worker: null,
    notes: "No safe worker exists; pending, in-flight, delivered, and dead domain events require an approved lifecycle and replay policy.",
  },
  audit_logs: {
    decision: "KEEP-FOREVER",
    worker: null,
    notes: "Immutable audit obligation. No deleted_at column. DB-level triggers prevent mutation. Cannot be touched by any retention worker.",
  },
  hr_audit_logs: {
    decision: "KEEP-FOREVER",
    worker: null,
    notes: "HR audit trail. Written only by retention sweep itself as a record of what was purged. Never deleted.",
  },
  payroll_runs: {
    decision: "KEEP-FOREVER",
    worker: null,
    notes: "Financial record. Immutable after posting. Legal obligation to retain.",
  },
  hr_people: {
    decision: "RETAIN-BOUNDED",
    worker: "CronHrRetentionService (via hr_retention_policies)",
    notes: "Soft-delete only. Legal-hold exclusion enforced. Policy-driven (hr_retention_policies table).",
  },
  hr_employments: {
    decision: "KEEP-FOREVER",
    worker: null,
    notes: "Employment records carry payroll and statutory obligations. Not deletable.",
  },
  hr_reporting_lines: {
    decision: "KEEP-FOREVER",
    worker: null,
    notes: "Effective-dated reporting history supports employment/payroll auditability and is bounded by employment history; no automated deletion is permitted without an approved statutory-retention rule.",
  },
  attendance: {
    decision: "RETAIN-BOUNDED",
    worker: "CronHrRetentionService (via hr_retention_policies, recordType=attendance)",
    notes: "Physical delete allowed per policy. Legal-hold exclusion enforced.",
  },
  permissions: {
    decision: "KEEP-FOREVER",
    worker: null,
    notes: "RBAC permission catalog. Grows as features are added, shrinks on removal. Configuration state, not event-sourced. 3 MB is mostly index overhead on 731 rows.",
  },
  role_permission_grants: {
    decision: "KEEP-FOREVER",
    worker: null,
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

if (args.includes("--self-test")) {
  const checks = {
    auditLogsIsKeepForever: RETENTION_MATRIX["audit_logs"].decision === "KEEP-FOREVER",
    payrollRunsIsKeepForever: RETENTION_MATRIX["payroll_runs"].decision === "KEEP-FOREVER",
    aiUsageLogsHasWorker: RETENTION_MATRIX["ai_usage_logs"].worker !== null,
    chatMessagesHasWorker: RETENTION_MATRIX["chat_messages"].worker !== null,
    kbChunksHasWorker: RETENTION_MATRIX["kb_article_chunks"].worker !== null,
    kbChatConversationsHasWorker: RETENTION_MATRIX["kb_chat_conversations"].worker === "CronKbChatRetentionService",
    webhookDeliveriesHaveWorker: RETENTION_MATRIX["webhook_deliveries"].worker === "CronBuildRetentionService",
    auditLogsHasNoWorker: RETENTION_MATRIX["audit_logs"].worker === null,
    classifyUnknownIsUncovered: classify("unknown_table_xyz", 100).status === "UNCOVERED",
    classifyAuditLogsIsKeepForever: classify("audit_logs", 0).status === "KEEP-FOREVER",
    partitionUsesParentDecision:
      classify(policyTableName("notifications_y2026_m08", "notifications")).status === "COVERED" &&
      classify(policyTableName("chat_messages_y2026_m08", "chat_messages")).status === "COVERED",
    reportingLinesHaveDecision: RETENTION_MATRIX["hr_reporting_lines"].decision === "KEEP-FOREVER",
    documentsHaveExistingWorker: RETENTION_MATRIX["documents"].worker === "CronHrRetentionService (via hr_retention_policies, recordType=document)",
    unsupportedTablesRemainPending: [
      "helpdesk_tickets",
      "performance_reviews",
      "mail_message_metadata",
      "announcements",
      "notification_outbox",
      "outbox_events",
    ].every((table) => RETENTION_MATRIX[table].decision === "PENDING-DECISION" && classify(table).status === "UNCOVERED"),
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
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(2);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  const rows = await sql`
    SELECT
      c.relname                                AS table_name,
      COALESCE(parent.relname, c.relname)      AS policy_table,
      pg_total_relation_size(c.oid) / 1048576 AS total_mb,
      COALESCE(s.n_live_tup, 0)               AS n_live_tup
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

  process.exit(0);
} catch (err) {
  process.stderr.write(`QUERY FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
} finally {
  await sql.end();
}
