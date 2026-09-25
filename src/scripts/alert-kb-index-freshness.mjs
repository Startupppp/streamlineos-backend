import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env"), quiet: true });

const args = process.argv.slice(2);
const staleThresholdMinutes = Math.max(
  5,
  parseInt(args.find((a) => a.startsWith("--stale-minutes="))?.slice(16) ?? "30", 10),
);
const lookbackHours = Math.max(
  1,
  parseInt(args.find((a) => a.startsWith("--lookback-hours="))?.slice(17) ?? "24", 10),
);
const minUnindexedPages = Math.max(
  1,
  parseInt(args.find((a) => a.startsWith("--min-pages="))?.slice(12) ?? "3", 10),
);

function evaluate(unindexedCount, maxStalenessSeconds, thresholds) {
  const fired = unindexedCount >= thresholds.minUnindexedPages;
  return {
    fired,
    unindexedCount,
    maxStalenessSeconds,
    thresholds,
  };
}

if (args.includes("--self-test")) {
  const thresholds = { staleThresholdMinutes, lookbackHours, minUnindexedPages };

  const case1 = evaluate(0, null, thresholds);
  const case2 = evaluate(1, 3600, thresholds);
  const case3 = evaluate(5, 7200, thresholds);
  const case4 = evaluate(minUnindexedPages, 1800, thresholds);

  const checks = {
    zeroUnindexedClear: !case1.fired,
    belowMinDoesNotFire: !case2.fired,
    atMinFires: case4.fired,
    aboveMinFires: case3.fired,
    defaultStaleThresholdIs30: staleThresholdMinutes === 30,
    defaultLookbackIs24: lookbackHours === 24,
    defaultMinPagesIs3: minUnindexedPages === 3,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({ selfTest: true, pass, checks }) + "\n",
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

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
try {
  const rows = await sql`
    SELECT
      COUNT(*)::int AS unindexed_count,
      MAX(EXTRACT(EPOCH FROM (NOW() - p.updated_at)))::int AS max_staleness_seconds
    FROM kb_pages p
    WHERE p.deleted_at IS NULL
      AND p.updated_at < NOW() - (${staleThresholdMinutes} * INTERVAL '1 minute')
      AND p.updated_at > NOW() - (${lookbackHours} * INTERVAL '1 hour')
      AND NOT EXISTS (
        SELECT 1
        FROM kb_article_chunks c
        WHERE c.page_id = p.id
      )
  `;

  const unindexedCount = Number(rows[0]?.unindexed_count ?? 0);
  const maxStalenessSeconds = rows[0]?.max_staleness_seconds !== null
    ? Number(rows[0]?.max_staleness_seconds)
    : null;

  const thresholds = { staleThresholdMinutes, lookbackHours, minUnindexedPages };
  const result = evaluate(unindexedCount, maxStalenessSeconds, thresholds);

  process.stdout.write(
    JSON.stringify({
      ...result,
      destination:
        "CONFIGURE_ME — wire exit-code 1 to your oncall system (PagerDuty, Slack webhook, etc.)",
      note:
        "A page with no chunks is invisible to vector search but reachable by keyword search and its own route. A count of 0 is healthy; a non-zero count means the ingestion outbox or indexing consumer is behind.",
    }) + "\n",
  );
  process.exit(result.fired ? 1 : 0);
} catch (err) {
  process.stderr.write(`Query failed: ${err.message}\n`);
  process.exit(2);
} finally {
  await sql.end();
}
