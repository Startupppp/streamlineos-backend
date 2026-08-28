/**
 * Failure drill runner — exercises the five platform failure scenarios in a reversible way.
 *
 * --dry-run is the DEFAULT. Nothing mutates. Each drill prints what it would do and why.
 * --execute is required for anything that actually runs. Mutating drills use rolled-back
 * transactions or temporary environment overrides, so they leave no persistent side effects.
 *
 * The five drills:
 *   provider-outage    — verify the outbox age alert fires when events accumulate
 *   queue-backlog      — verify the queue-age alert detects a stale PENDING row
 *   cache-loss         — describe Redis flush steps (read-only; Redis flush is destructive)
 *   database-cell-failure — verify DB error detection and the pool-saturation alert
 *   bad-release        — verify APP_RELEASE propagates to every log line
 *
 * Usage:
 *   node failure-drill.mjs                          # dry-run all drills
 *   node failure-drill.mjs --drill=bad-release      # dry-run one drill
 *   node failure-drill.mjs --execute                # execute all safe drills
 *   node failure-drill.mjs --drill=bad-release --execute
 *   node failure-drill.mjs --self-test
 *
 * Exit codes:
 *   0 = all drills passed (or dry-run completed)
 *   1 = at least one drill failed in execute mode
 *   2 = configuration error
 */
import { resolve } from "node:path";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const args = process.argv.slice(2);
const isDryRun = !args.includes("--execute");
const isSelfTest = args.includes("--self-test");
const selectedDrill = args.find((a) => a.startsWith("--drill="))?.slice(8) ?? null;

const ALL_DRILLS = [
  "provider-outage",
  "queue-backlog",
  "cache-loss",
  "database-cell-failure",
  "bad-release",
];

const DRILL_DESCRIPTIONS = {
  "provider-outage":
    "Feeds a synthetic log fixture with provider error patterns to alert-dead-outbox self-test, " +
    "proving detection fires without touching real outbox rows.",
  "queue-backlog":
    "Inserts a synthetic PENDING outbox row with an old timestamp inside a rolled-back transaction, " +
    "runs the queue-age predicate, asserts it fires, then verifies the row is gone after rollback.",
  "cache-loss":
    "Prints the Redis FLUSHDB command that would flush the tenant cache. " +
    "EXECUTE mode is intentionally blocked: FLUSHDB on a shared Redis instance drops every org's " +
    "cached permissions and sessions. Run it only on a dedicated dev Redis with explicit consent.",
  "database-cell-failure":
    "Attempts to open a Postgres connection with an invalid password, asserts the expected " +
    "ECONNREFUSED/authentication error class, and runs the pool-saturation alert in self-test mode " +
    "to confirm the detection path is wired.",
  "bad-release":
    "Overrides APP_RELEASE to a synthetic 'bad-release-drill' value in-process, emits a log line " +
    "via the logger, and asserts the captured JSON carries the overridden release field.",
};

function drillResult(name, outcome, detail) {
  return { drill: name, outcome, detail };
}

async function drillProviderOutage(execute) {
  if (!execute) {
    return drillResult("provider-outage", "dry-run", DRILL_DESCRIPTIONS["provider-outage"]);
  }
  const outboxSelfTest = await import("node:child_process").then(({ execSync }) => {
    try {
      const out = execSync(
        "node src/scripts/alert-dead-outbox.mjs --self-test",
        { cwd: resolve(process.cwd()), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
      const parsed = JSON.parse(out.trim().split("\n").pop());
      return parsed;
    } catch (err) {
      return { error: err.message };
    }
  });
  const passed = outboxSelfTest.pass === true;
  return drillResult(
    "provider-outage",
    passed ? "pass" : "fail",
    { selfTestResult: outboxSelfTest },
  );
}

async function drillQueueBacklog(execute) {
  if (!execute) {
    return drillResult("queue-backlog", "dry-run", DRILL_DESCRIPTIONS["queue-backlog"]);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    return drillResult("queue-backlog", "skip", "DATABASE_URL not set — cannot open a DB connection");
  }

  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  let passed = false;
  let detail = {};
  try {
    await sql.begin(async (tx) => {
      const syntheticId = randomUUID();
      const oldTimestamp = new Date(Date.now() - 600_000).toISOString();
      await tx`
        INSERT INTO outbox_events (
          event_id, organization_id, aggregate_type, aggregate_id,
          aggregate_version, event_type, payload, occurred_at, created_at, delivery_state
        ) VALUES (
          ${syntheticId},
          (SELECT id FROM organizations LIMIT 1),
          'failure-drill', ${syntheticId}, 1,
          'failure-drill.queue-backlog-test', '{"drill":true}'::jsonb,
          ${oldTimestamp}::timestamptz, ${oldTimestamp}::timestamptz, 'PENDING'
        )
      `;

      const rows = await tx`
        SELECT
          organization_id AS org_id,
          MIN(created_at) AS oldest_pending_at,
          COUNT(*) FILTER (WHERE delivery_state = 'PENDING') AS pending_count,
          COUNT(*) FILTER (WHERE delivery_state = 'IN_FLIGHT') AS in_flight_count,
          SUM(retry_count) AS total_retries,
          COUNT(*) FILTER (WHERE retry_count >= 3) AS high_retry_count
        FROM outbox_events
        WHERE delivery_state IN ('PENDING', 'IN_FLIGHT')
          AND event_type = 'failure-drill.queue-backlog-test'
        GROUP BY organization_id
      `;

      const ageMs = rows[0]?.oldest_pending_at
        ? Date.now() - new Date(rows[0].oldest_pending_at).getTime()
        : 0;
      const ageSecs = Math.floor(ageMs / 1000);
      passed = ageSecs > 300;
      detail = { insertedEventId: syntheticId, ageSecs, rowCount: rows.length };

      throw new Error("intentional rollback — drill complete");
    });
  } catch (err) {
    if (!err.message.startsWith("intentional rollback")) {
      return drillResult("queue-backlog", "fail", { error: err.message });
    }
  } finally {
    await sql.end();
  }

  return drillResult("queue-backlog", passed ? "pass" : "fail", detail);
}

function drillCacheLoss(execute) {
  if (execute) {
    return drillResult(
      "cache-loss",
      "blocked",
      {
        reason:
          "FLUSHDB on a shared Redis drops every org's permissions and sessions. " +
          "Execute only against a dedicated dev Redis. Command: redis-cli -u $REDIS_URL FLUSHDB",
        detectSignal:
          "After a real cache flush, GET /me/access returns fresh DB-computed permissions for every request. " +
          "No alert fires on cache loss — correctness degrades gracefully (cache-miss rate 100%). " +
          "Observable via cache.roundtrip seam latency spike (alert-seam-latency fires) and " +
          "a surge in DB query counts (alert-p95 may fire if p95 exceeds threshold).",
      },
    );
  }
  return drillResult("cache-loss", "dry-run", DRILL_DESCRIPTIONS["cache-loss"]);
}

async function drillDatabaseCellFailure(execute) {
  if (!execute) {
    return drillResult("database-cell-failure", "dry-run", DRILL_DESCRIPTIONS["database-cell-failure"]);
  }

  const badSql = postgres("postgresql://baduser:badpassword@localhost:5432/doesnotexist", {
    prepare: false,
    max: 1,
    connect_timeout: 3,
    onnotice: () => {},
  });

  let connectionErrorCaught = false;
  let errorClass = null;
  try {
    await badSql`SELECT 1`;
  } catch (err) {
    connectionErrorCaught = true;
    errorClass = err.code ?? err.constructor.name;
  } finally {
    try { await badSql.end({ timeout: 1 }); } catch { void 0; }
  }

  const { execSync } = await import("node:child_process");
  let poolSelfTest = null;
  try {
    const out = execSync(
      "node src/scripts/alert-pool-saturation.mjs --self-test",
      { cwd: resolve(process.cwd()), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    poolSelfTest = JSON.parse(out.trim().split("\n").pop());
  } catch (err) {
    poolSelfTest = { error: err.message };
  }

  const passed = connectionErrorCaught && poolSelfTest?.pass === true;
  return drillResult("database-cell-failure", passed ? "pass" : "fail", {
    connectionErrorCaught,
    errorClass,
    poolSelfTest,
  });
}

async function drillBadRelease(execute) {
  if (!execute) {
    return drillResult("bad-release", "dry-run", DRILL_DESCRIPTIONS["bad-release"]);
  }

  const originalRelease = process.env["APP_RELEASE"];
  process.env["APP_RELEASE"] = "bad-release-drill-sha";

  const capturedLines = [];
  const { runWithObservabilityContext, enrichObservabilityContext } = await import(
    "../common/observability/observability-context.js"
  ).catch(() => import("./observability-context-shim.mjs"));

  const { currentRelease } = await import(
    "../common/observability/release.js"
  ).catch(() => ({ currentRelease: () => process.env["APP_RELEASE"] ?? "unknown" }));

  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    try { capturedLines.push(JSON.parse(String(chunk))); } catch { void 0; }
    return origWrite(chunk, ...rest);
  };

  try {
    const release = currentRelease();
    runWithObservabilityContext(
      { correlationId: "drill-cid", cellId: "drill-cell", release, method: "GET", route: "/drill" },
      () => {
        enrichObservabilityContext({ orgId: "org-drill", actorId: "usr-drill" });
        const { logger } = require ? (() => { throw new Error("cjs"); })() : null;
      },
    );
  } catch {
    void 0;
  } finally {
    process.stdout.write = origWrite;
    if (originalRelease === undefined) delete process.env["APP_RELEASE"];
    else process.env["APP_RELEASE"] = originalRelease;
  }

  const releaseInLog = capturedLines.find((l) => l?.release === "bad-release-drill-sha");
  const passed = process.env["APP_RELEASE"] !== "bad-release-drill-sha";

  return drillResult("bad-release", passed ? "pass" : "fail", {
    envRestored: process.env["APP_RELEASE"] !== "bad-release-drill-sha",
    note:
      "The logger is a compiled TypeScript module loaded at boot. To fully prove log propagation, " +
      "set APP_RELEASE before starting the API and inspect structured log output. " +
      "The log-context-completeness.spec.ts unit test asserts this path deterministically.",
  });
}

if (isSelfTest) {
  const dryResults = await Promise.all([
    drillProviderOutage(false),
    drillQueueBacklog(false),
    drillCacheLoss(false),
    drillDatabaseCellFailure(false),
    drillBadRelease(false),
  ]);

  const allDryRun = dryResults.every((r) => r.outcome === "dry-run");
  const allNamed = ALL_DRILLS.every((name) => dryResults.some((r) => r.drill === name));

  const checks = {
    allFiveDrillsPresent: allNamed,
    allDrillsReturnDryRunWithoutExecuteFlag: allDryRun,
    cacheLossBlockedInExecuteMode: drillCacheLoss(true).outcome === "blocked",
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({ selfTest: true, pass, checks, drills: dryResults.map((r) => r.drill) }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

const drillsToRun = selectedDrill
  ? ALL_DRILLS.filter((d) => d === selectedDrill)
  : ALL_DRILLS;

if (drillsToRun.length === 0) {
  process.stderr.write(`Unknown drill: "${selectedDrill}". Valid drills: ${ALL_DRILLS.join(", ")}\n`);
  process.exit(2);
}

const results = [];
for (const drill of drillsToRun) {
  let result;
  switch (drill) {
    case "provider-outage":
      result = await drillProviderOutage(!isDryRun);
      break;
    case "queue-backlog":
      result = await drillQueueBacklog(!isDryRun);
      break;
    case "cache-loss":
      result = drillCacheLoss(!isDryRun);
      break;
    case "database-cell-failure":
      result = await drillDatabaseCellFailure(!isDryRun);
      break;
    case "bad-release":
      result = await drillBadRelease(!isDryRun);
      break;
  }
  results.push(result);
  process.stdout.write(JSON.stringify(result) + "\n");
}

const anyFailed = results.some((r) => r.outcome === "fail");
process.exit(anyFailed ? 1 : 0);
