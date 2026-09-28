import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env"), quiet: true });

const args = process.argv.slice(2);
const maxConnections = Math.max(
  1,
  parseInt(args.find((a) => a.startsWith("--max-connections="))?.slice(18) ?? "80", 10),
);
const maxLockWaits = Math.max(
  0,
  parseInt(args.find((a) => a.startsWith("--max-lock-waits="))?.slice(17) ?? "5", 10),
);
const slowQueryMs = Math.max(
  1,
  parseFloat(args.find((a) => a.startsWith("--slow-query-ms="))?.slice(16) ?? "100"),
);
const minCacheHitPct = Math.min(
  100,
  Math.max(0, parseFloat(args.find((a) => a.startsWith("--min-cache-hit-pct="))?.slice(20) ?? "90")),
);

function evaluate(connStats, lockWaits, slowQueryProbe, cacheStats, thresholds) {
  const totalSaturated =
    (connStats.active ?? 0) + (connStats.idleInTransaction ?? 0);
  const connectionsFired = totalSaturated > thresholds.maxConnections;

  const lockWaitsFired = (lockWaits ?? 0) > thresholds.maxLockWaits;

  const slowQueriesObservable = slowQueryProbe.installed === true;
  const slowQueryRows = slowQueriesObservable ? slowQueryProbe.rows : [];
  const slowQueriesFired = slowQueryRows.length > 0;

  const lowHitTables = cacheStats.filter(
    (t) =>
      t.totalBlocks > 0 &&
      t.hitRatePct !== null &&
      t.hitRatePct < thresholds.minCacheHitPct,
  );
  const cacheHitFired = lowHitTables.length > 0;

  const fired = connectionsFired || lockWaitsFired || slowQueriesFired || cacheHitFired;

  return {
    fired,
    connectionsFired,
    lockWaitsFired,
    slowQueriesFired,
    slowQueriesObservable,
    cacheHitFired,
    connections: {
      active: connStats.active ?? 0,
      idle: connStats.idle ?? 0,
      idleInTransaction: connStats.idleInTransaction ?? 0,
      other: connStats.other ?? 0,
      saturated: totalSaturated,
      threshold: thresholds.maxConnections,
    },
    lockWaits: {
      count: lockWaits ?? 0,
      threshold: thresholds.maxLockWaits,
    },
    slowQueries: slowQueriesObservable
      ? {
          status: "measured",
          thresholdMs: thresholds.slowQueryMs,
          rows: slowQueryRows,
        }
      : {
          status: "blocked",
          reason: "pg-stat-statements-not-installed",
          message:
            "pg_stat_statements is not installed on this database, so no statement can be seen at all. This dimension is unmeasured, not clear. Install the extension to enable it.",
        },
    cacheHit: {
      lowHitTables,
      threshold: thresholds.minCacheHitPct,
    },
    replicaLag: {
      status: "blocked",
      reason: "no-replica-endpoint",
      message:
        "This deployment has no read replica endpoint. Replica lag cannot be measured. Configure DB_REPLICA_URL to enable this check.",
    },
    droppedInvalidations: {
      status: "delegated",
      alert: "alert-cache-invalidation-dropped.mjs",
      message:
        "Cache invalidation drops are measured by alert-cache-invalidation-dropped.mjs reading the CacheService.DROPPED_MARKER from the log stream. That alert is the authoritative source for this dimension.",
    },
  };
}

if (args.includes("--self-test")) {
  const thresholds = { maxConnections, maxLockWaits, slowQueryMs, minCacheHitPct };

  const healthyConn = { active: 5, idle: 3, idleInTransaction: 0, other: 0 };
  const highConn = { active: 60, idle: 5, idleInTransaction: 30, other: 0 };
  const healthyLocks = 0;
  const highLocks = 10;
  const noSlowQueries = { installed: true, rows: [] };
  const slowQueriesPresent = {
    installed: true,
    rows: [{ query: "SELECT ...", meanExecMs: 250, maxExecMs: 800, calls: 5 }],
  };
  const slowQueriesUnobservable = { installed: false, rows: [] };
  const goodCache = [{ table: "kb_pages", hitRatePct: 98.5, totalBlocks: 1000 }];
  const badCache = [{ table: "kb_article_chunks", hitRatePct: 75.0, totalBlocks: 2000 }];
  const emptyCache = [{ table: "kb_pages", hitRatePct: null, totalBlocks: 0 }];

  const case1 = evaluate(healthyConn, healthyLocks, noSlowQueries, goodCache, thresholds);
  const case2 = evaluate(highConn, healthyLocks, noSlowQueries, goodCache, thresholds);
  const case3 = evaluate(healthyConn, highLocks, noSlowQueries, goodCache, thresholds);
  const case4 = evaluate(healthyConn, healthyLocks, slowQueriesPresent, goodCache, thresholds);
  const case5 = evaluate(healthyConn, healthyLocks, noSlowQueries, badCache, thresholds);
  const case6 = evaluate(healthyConn, healthyLocks, noSlowQueries, emptyCache, thresholds);
  const case7 = evaluate(
    healthyConn,
    healthyLocks,
    slowQueriesUnobservable,
    goodCache,
    thresholds,
  );

  const checks = {
    healthyClear: !case1.fired,
    highConnectionsFire: case2.fired && case2.connectionsFired,
    highLockWaitsFire: case3.fired && case3.lockWaitsFired,
    slowQueriesFire: case4.fired && case4.slowQueriesFired,
    lowCacheHitFires: case5.fired && case5.cacheHitFired,
    zeroBlocksDoesNotFireOnCache: !case6.cacheHitFired,
    measuredSlowQueriesReportMeasured: case1.slowQueries.status === "measured",
    absentExtensionIsNotReportedAsClear:
      case7.slowQueries.status === "blocked" &&
      case7.slowQueriesObservable === false &&
      !Object.prototype.hasOwnProperty.call(case7.slowQueries, "rows"),
    absentExtensionDoesNotPageOncall: !case7.fired,
    replicaLagAlwaysBlocked: case1.replicaLag.status === "blocked",
    droppedInvalidationsDelegated: case1.droppedInvalidations.status === "delegated",
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
  const connRows = await sql`
    SELECT
      state,
      COUNT(*) AS cnt
    FROM pg_stat_activity
    WHERE datname = current_database()
    GROUP BY state
  `;
  const connStats = {};
  for (const row of connRows) {
    const state = row.state ?? "other";
    const cnt = Number(row.cnt ?? 0);
    if (state === "active") connStats.active = cnt;
    else if (state === "idle") connStats.idle = cnt;
    else if (state === "idle in transaction") connStats.idleInTransaction = cnt;
    else connStats.other = (connStats.other ?? 0) + cnt;
  }

  const lockWaitRows = await sql`
    SELECT COUNT(*) AS cnt
    FROM pg_stat_activity
    WHERE wait_event_type = 'Lock'
      AND datname = current_database()
  `;
  const lockWaits = Number(lockWaitRows[0]?.cnt ?? 0);

  const extensionRows = await sql`
    SELECT COUNT(*) AS cnt FROM pg_extension WHERE extname = 'pg_stat_statements'
  `;
  const pgStatStatementsInstalled = Number(extensionRows[0]?.cnt ?? 0) > 0;

  let slowQueryRows = [];
  if (pgStatStatementsInstalled) {
    const slowRows = await sql`
      SELECT
        LEFT(query, 200) AS query,
        ROUND(mean_exec_time::numeric, 1) AS mean_exec_ms,
        ROUND(max_exec_time::numeric, 1) AS max_exec_ms,
        calls
      FROM pg_stat_statements
      WHERE mean_exec_time > ${slowQueryMs}
        AND (
          query ILIKE '%kb_pages%'
          OR query ILIKE '%kb_article_chunks%'
          OR query ILIKE '%kb_spaces%'
          OR query ILIKE '%kb_articles%'
        )
      ORDER BY mean_exec_time DESC
      LIMIT 10
    `;
    slowQueryRows = slowRows.map((r) => ({
      query: r.query,
      meanExecMs: Number(r.mean_exec_ms),
      maxExecMs: Number(r.max_exec_ms),
      calls: Number(r.calls),
    }));
  }

  const cacheRows = await sql`
    SELECT
      relname AS table_name,
      heap_blks_read,
      heap_blks_hit,
      heap_blks_read + heap_blks_hit AS total_blocks,
      CASE
        WHEN heap_blks_read + heap_blks_hit = 0 THEN NULL
        ELSE ROUND(100.0 * heap_blks_hit / (heap_blks_read + heap_blks_hit), 1)
      END AS hit_rate_pct
    FROM pg_statio_user_tables
    WHERE relname LIKE 'kb_%'
    ORDER BY heap_blks_read + heap_blks_hit DESC
    LIMIT 20
  `;
  const cacheStats = cacheRows.map((r) => ({
    table: r.table_name,
    hitRatePct: r.hit_rate_pct !== null ? Number(r.hit_rate_pct) : null,
    totalBlocks: Number(r.total_blocks ?? 0),
  }));

  const thresholds = { maxConnections, maxLockWaits, slowQueryMs, minCacheHitPct };
  const result = evaluate(
    connStats,
    lockWaits,
    { installed: pgStatStatementsInstalled, rows: slowQueryRows },
    cacheStats,
    thresholds,
  );

  process.stdout.write(
    JSON.stringify({
      ...result,
      pgStatStatementsInstalled,
      thresholds,
      destination:
        "CONFIGURE_ME — wire exit-code 1 to your oncall system (PagerDuty, Slack webhook, etc.)",
    }) + "\n",
  );
  process.exit(result.fired ? 1 : 0);
} catch (err) {
  process.stderr.write(`Query failed: ${err.message}\n`);
  process.exit(2);
} finally {
  await sql.end();
}
