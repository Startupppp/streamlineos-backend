/**
 * KB purge backlog monitor.
 *
 * SOURCE: direct query against `kb_page_purge_ledger`. Each page deletion
 * opens five ledger rows (visits, favorites, source_links, page_rows, blobs).
 * Rows advance from `pending` → `completed` as each store is drained. Rows
 * stuck in `pending` beyond the threshold mean the drainer is stalled.
 *
 * PRODUCER DEPENDENCY (lane M3): `emptyTrash` and `purgeExpired` in
 * `kb-page-trash.service.ts` must call `markStoreComplete` for every store
 * on every page. If that fix has not landed, every emptied or auto-purged
 * page leaves permanent `pending` rows and this alert fires continuously.
 * The current code in the repository does make those calls; verify M3 is
 * merged before treating a permanent-fire state as an alert defect.
 *
 * EXIT CODES (operator contract, tested in alert-delivery.spec.ts):
 *   0 = no stale backlog or too few pages to be meaningful
 *   1 = stale pending rows detected (alert fires)
 *   2 = configuration error (DATABASE_URL not set)
 *
 * Usage:
 *   node alert-kb-purge-backlog.mjs
 *   node alert-kb-purge-backlog.mjs --stale-minutes=60 --min-rows=5
 *   node alert-kb-purge-backlog.mjs --self-test
 *
 * Requires: DATABASE_URL (owner/migration role — BYPASSRLS, no tenant GUC).
 */
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env"), quiet: true });

const args = process.argv.slice(2);
const staleMinutes = Math.max(
  5,
  parseInt(args.find((a) => a.startsWith("--stale-minutes="))?.slice(16) ?? "60", 10),
);
const minRows = Math.max(
  1,
  parseInt(args.find((a) => a.startsWith("--min-rows="))?.slice(11) ?? "5", 10),
);

function evaluateBacklog(rows, thresholdMinutes, minRowsThreshold) {
  const pendingCount = Number(rows[0]?.pending_count ?? 0);
  const oldestAgeMinutes = rows[0]?.oldest_age_minutes != null
    ? Number(rows[0].oldest_age_minutes)
    : null;

  return {
    pendingCount,
    oldestAgeMinutes,
    thresholdMinutes,
    minRows: minRowsThreshold,
    fired: pendingCount >= minRowsThreshold && oldestAgeMinutes !== null && oldestAgeMinutes > thresholdMinutes,
  };
}

if (args.includes("--self-test")) {
  const noBacklog = evaluateBacklog(
    [{ pending_count: "0", oldest_age_minutes: null }],
    staleMinutes,
    minRows,
  );
  const freshBacklog = evaluateBacklog(
    [{ pending_count: "10", oldest_age_minutes: "5" }],
    staleMinutes,
    minRows,
  );
  const staleBacklog = evaluateBacklog(
    [{ pending_count: "25", oldest_age_minutes: "120" }],
    staleMinutes,
    minRows,
  );
  const tinyBacklog = evaluateBacklog(
    [{ pending_count: "2", oldest_age_minutes: "120" }],
    staleMinutes,
    minRows,
  );

  const checks = {
    noBacklogClear: noBacklog.fired === false,
    freshBacklogClear: freshBacklog.fired === false,
    staleBacklogFires: staleBacklog.fired === true,
    tinyBacklogClear: tinyBacklog.fired === false,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({
      selfTest: true,
      pass,
      checks,
      producerDependency: "lane-M3 (kb-page-trash.service.ts markStoreComplete)",
      note: "If M3 fix is absent, this alert fires permanently on every trash operation.",
    }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write(
    "DATABASE_URL is required (owner/migration role — BYPASSRLS, no tenant GUC needed)\n",
  );
  process.exit(2);
}

const sql = postgres(url, { max: 1 });
try {
  const rows = await sql`
    SELECT
      COUNT(*) AS pending_count,
      EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 60 AS oldest_age_minutes
    FROM kb_page_purge_ledger
    WHERE status = 'pending'
  `;

  const result = evaluateBacklog(rows, staleMinutes, minRows);
  process.stdout.write(
    JSON.stringify({
      fired: result.fired,
      staleMinutes,
      minRows,
      ...result,
    }) + "\n",
  );
  process.exit(result.fired ? 1 : 0);
} finally {
  await sql.end();
}
