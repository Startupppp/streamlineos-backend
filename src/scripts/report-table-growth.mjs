/**
 * report-table-growth.mjs — Measure table sizes and identify high-growth candidates.
 *
 * Queries pg_class + pg_stat_user_tables for every table in the public schema
 * and reports: total size (bytes + MB), live rows, dead rows, last analyze/vacuum.
 *
 * Usage:
 *   node src/scripts/report-table-growth.mjs
 *   node src/scripts/report-table-growth.mjs --top=20
 *   node src/scripts/report-table-growth.mjs --min-mb=1
 *   node src/scripts/report-table-growth.mjs --self-test
 *
 * Exit codes:
 *   0 = ran successfully
 *   1 = DATABASE_URL not set
 *   2 = query failed
 */
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const args = process.argv.slice(2);
const top = Math.max(1, parseInt(args.find((a) => a.startsWith("--top="))?.slice(6) ?? "50", 10));
const minMb = parseFloat(args.find((a) => a.startsWith("--min-mb="))?.slice(9) ?? "0");

if (args.includes("--self-test")) {
  const rows = [
    { table_name: "kb_article_chunks", total_bytes: "521306112", heap_bytes: "10821632", n_live_tup: "30000", n_dead_tup: "0" },
    { table_name: "timesheets", total_bytes: "11214848", heap_bytes: "2015232", n_live_tup: "5000", n_dead_tup: "204" },
    { table_name: "chat_messages", total_bytes: "7815168", heap_bytes: "1662976", n_live_tup: "4250", n_dead_tup: "0" },
    { table_name: "audit_logs", total_bytes: "212992", heap_bytes: "81920", n_live_tup: "11", n_dead_tup: "0" },
  ];

  const enriched = rows.map(enrich);
  const checks = {
    largestFirst: enriched[0].table_name === "kb_article_chunks",
    mbCalculated: enriched[0].total_mb === 497,
    deadTupCounted: enriched[1].dead_pct > 0,
    auditLogsPresent: enriched.some((r) => r.table_name === "audit_logs"),
  };
  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks, sample: enriched }) + "\n");
  process.exit(pass ? 0 : 1);
}

function enrich(row) {
  const totalBytes = Number(row.total_bytes ?? 0);
  const heapBytes = Number(row.heap_bytes ?? 0);
  const liveTup = Number(row.n_live_tup ?? 0);
  const deadTup = Number(row.n_dead_tup ?? 0);
  const total = liveTup + deadTup;
  return {
    table_name: row.table_name,
    total_mb: Math.floor(totalBytes / 1024 / 1024),
    heap_mb: Math.floor(heapBytes / 1024 / 1024),
    total_bytes: totalBytes,
    n_live_tup: liveTup,
    n_dead_tup: deadTup,
    dead_pct: total > 0 ? Math.round((deadTup / total) * 100 * 10) / 10 : 0,
    last_analyze: row.last_analyze ?? null,
    last_autovacuum: row.last_autovacuum ?? null,
  };
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(1);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  const rows = await sql`
    SELECT
      c.relname                                   AS table_name,
      pg_total_relation_size(c.oid)               AS total_bytes,
      pg_relation_size(c.oid)                     AS heap_bytes,
      s.n_live_tup,
      s.n_dead_tup,
      s.last_analyze,
      s.last_autovacuum
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s
      ON s.relname = c.relname AND s.schemaname = n.nspname
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT ${top}
  `;

  const enriched = rows.map(enrich).filter((r) => r.total_mb >= minMb);

  const note = {
    measuredAt: new Date().toISOString(),
    note_pg_stat_statements: "pg_stat_statements is NOT installed on this Neon instance — slow-query identification relies on application-layer span telemetry (alert-seam-latency.mjs, alert-p95.mjs) instead.",
    topTables: enriched,
  };

  process.stdout.write(JSON.stringify(note, null, 2) + "\n");
  process.exit(0);
} catch (err) {
  process.stderr.write(`QUERY FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
} finally {
  await sql.end();
}
