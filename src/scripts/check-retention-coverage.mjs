/**
 * check-retention-coverage.mjs — Verify that every high-growth table has a retention decision.
 *
 * Reads the retention policy matrix defined below against the live database.
 * Reports COVERED, UNCOVERED, and KEEP-FOREVER tables. Exits 1 when any
 * high-growth table (>= COVERAGE_THRESHOLD_MB) is uncovered.
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
const thresholdMb = parseFloat(
  args.find((a) => a.startsWith("--threshold-mb="))?.slice(15) ?? "1",
);

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
    worker: null,
    notes:
      "Chart of accounts. Referenced by 12 tables including ap_document_lines, ap_payments, ap_withholding, ar_document_lines, ar_receipts and bank_profiles — deleting an account orphans posted financial history, and the row IS the meaning of every amount that points at it. Reference data, not an event stream: 1 MB and it does not grow with volume. Carries deleted_at, so withdrawing an account is a soft delete and the history stays joinable.",
  },
  business_parties: {
    decision: "KEEP-FOREVER",
    worker: null,
    notes:
      "Customer/vendor master. Referenced by 45 tables, and it is the single copy since the CRM legacy rows stopped being written — the Party IS the record. Retention is by SOFT delete (deleted_at), so a removed party stays joinable from the invoice that names it. The one physical-delete path is DPDP/GDPR erasure, which root CLAUDE.md lists as an explicit exception to soft-delete and which no retention sweep may pre-empt: erasure is a legal instruction, not a schedule.",
  },
  party_roles: {
    decision: "KEEP-FOREVER",
    worker: null,
    notes:
      "Child of business_parties and shares its lifecycle; nothing references it, so it is deleted only with its party. Kept for the same reason: a role that vanished would make an old document's counterparty unexplainable.",
  },
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
  outbox_events: {
    decision: "PARTITION+ARCHIVE",
    worker: "NotificationRetentionService (detach+drop via notification_outbox partition key)",
    notes: "90-day retention. 18 rows now — small but write path is every mutation.",
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

function classify(tableName, totalMb) {
  const entry = RETENTION_MATRIX[tableName];
  if (!entry) return { status: "UNCOVERED", decision: null, worker: null };
  return {
    status: entry.decision === "KEEP-FOREVER" ? "KEEP-FOREVER" : "COVERED",
    decision: entry.decision,
    worker: entry.worker,
    notes: entry.notes,
  };
}

if (args.includes("--self-test")) {
  const checks = {
    auditLogsIsKeepForever: RETENTION_MATRIX["audit_logs"].decision === "KEEP-FOREVER",
    payrollRunsIsKeepForever: RETENTION_MATRIX["payroll_runs"].decision === "KEEP-FOREVER",
    aiUsageLogsHasWorker: RETENTION_MATRIX["ai_usage_logs"].worker !== null,
    chatMessagesHasWorker: RETENTION_MATRIX["chat_messages"].worker !== null,
    kbChunksHasWorker: RETENTION_MATRIX["kb_article_chunks"].worker !== null,
    auditLogsHasNoWorker: RETENTION_MATRIX["audit_logs"].worker === null,
    classifyUnknownIsUncovered: classify("unknown_table_xyz", 100).status === "UNCOVERED",
    classifyAuditLogsIsKeepForever: classify("audit_logs", 0).status === "KEEP-FOREVER",
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
      pg_total_relation_size(c.oid) / 1048576 AS total_mb,
      COALESCE(s.n_live_tup, 0)               AS n_live_tup
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s
      ON s.relname = c.relname AND s.schemaname = n.nspname
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
  `;

  const results = rows.map((row) => {
    const totalMb = Number(row.total_mb ?? 0);
    const classification = classify(String(row.table_name), totalMb);
    return {
      table_name: row.table_name,
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
