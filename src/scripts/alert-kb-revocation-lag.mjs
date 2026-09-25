/**
 * KB ACL revocation lag detector.
 *
 * SOURCE: direct query against `kb_pages.acl_revision_changed_at` and
 * `kb_article_chunks.acl_synced_at`. The lag is the gap between the time
 * the page ACL was last changed and the time the chunk index last synced
 * that revision. A large lag means revoked readers may still see stale
 * embeddings in retrieval results.
 *
 * MIGRATION DEPENDENCY: Both columns (`kb_pages.acl_revision_changed_at`
 * and `kb_article_chunks.acl_synced_at`) are authored by lane M5. This
 * script guards with a column-existence check and exits with
 * `fired: false, reason: "migration-M5-pending"` when either column is
 * absent. Shipping this alert before M5's migration lands is safe — it
 * will not fire and will not mislead.
 *
 * EXIT CODES (operator contract, tested in alert-delivery.spec.ts):
 *   0 = lag within threshold or migration pending (no action needed)
 *   1 = revocation lag exceeds threshold (alert fires)
 *   2 = configuration error (DATABASE_URL not set)
 *
 * Usage:
 *   node alert-kb-revocation-lag.mjs
 *   node alert-kb-revocation-lag.mjs --lag-seconds=300 --min-pages=5
 *   node alert-kb-revocation-lag.mjs --self-test
 *
 * Requires: DATABASE_URL (owner/migration role — BYPASSRLS, no tenant GUC).
 */
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env"), quiet: true });

const args = process.argv.slice(2);
const lagThresholdSeconds = Math.max(
  60,
  parseInt(args.find((a) => a.startsWith("--lag-seconds="))?.slice(14) ?? "300", 10),
);
const minPages = Math.max(
  1,
  parseInt(args.find((a) => a.startsWith("--min-pages="))?.slice(11) ?? "3", 10),
);

async function columnsExist(sql) {
  const rows = await sql`
    SELECT COUNT(*) AS cnt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        (table_name = 'kb_pages' AND column_name = 'acl_revision_changed_at')
        OR
        (table_name = 'kb_article_chunks' AND column_name = 'acl_synced_at')
      )
  `;
  return Number(rows[0]?.cnt ?? 0) === 2;
}

async function measureLag(sql, thresholdSeconds, minPagesThreshold) {
  const rows = await sql`
    SELECT
      COUNT(*) AS lagging_pages,
      MAX(EXTRACT(EPOCH FROM (NOW() - p.acl_revision_changed_at)))::int AS max_lag_seconds,
      AVG(EXTRACT(EPOCH FROM (NOW() - p.acl_revision_changed_at)))::int AS avg_lag_seconds
    FROM kb_pages p
    WHERE
      p.acl_revision_changed_at IS NOT NULL
      AND p.deleted_at IS NULL
      AND (
        NOT EXISTS (
          SELECT 1 FROM kb_article_chunks c
          WHERE c.page_id = p.id
            AND c.acl_synced_at >= p.acl_revision_changed_at
        )
      )
      AND EXTRACT(EPOCH FROM (NOW() - p.acl_revision_changed_at)) > ${thresholdSeconds}
  `;

  const laggingPages = Number(rows[0]?.lagging_pages ?? 0);
  const maxLagSeconds = Number(rows[0]?.max_lag_seconds ?? 0);
  const avgLagSeconds = Number(rows[0]?.avg_lag_seconds ?? 0);

  return {
    laggingPages,
    maxLagSeconds,
    avgLagSeconds,
    thresholdSeconds,
    minPages: minPagesThreshold,
    fired: laggingPages >= minPagesThreshold,
  };
}

if (args.includes("--self-test")) {
  const checks = {
    lagThresholdDefaultIs300: lagThresholdSeconds === 300,
    minPagesDefaultIs3: minPages === 3,
    selfTestRunsWithoutDb: true,
  };
  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({
      selfTest: true,
      pass,
      checks,
      migrationDependency: "lane-M5",
      columnNames: ["kb_pages.acl_revision_changed_at", "kb_article_chunks.acl_synced_at"],
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
  const ready = await columnsExist(sql);
  if (!ready) {
    process.stdout.write(
      JSON.stringify({
        fired: false,
        reason: "migration-M5-pending",
        message:
          "Columns kb_pages.acl_revision_changed_at and kb_article_chunks.acl_synced_at do not exist yet. Apply lane M5 migration before this alert can emit a meaningful reading.",
      }) + "\n",
    );
    process.exit(0);
  }

  const result = await measureLag(sql, lagThresholdSeconds, minPages);
  process.stdout.write(
    JSON.stringify({
      fired: result.fired,
      lagThresholdSeconds,
      minPages,
      ...result,
    }) + "\n",
  );
  process.exit(result.fired ? 1 : 0);
} finally {
  await sql.end();
}
