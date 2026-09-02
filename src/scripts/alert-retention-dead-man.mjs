#!/usr/bin/env node
// Dead-man alert for retention sweeps.
// Reads cron:heartbeat:<jobKey> from Upstash Redis and exits non-zero when any
// monitored sweep has not recorded a run within its expected window.
//
// Usage:
//   node src/scripts/alert-retention-dead-man.mjs
//   node src/scripts/alert-retention-dead-man.mjs --self-test
//
// Exit codes:
//   0 = all sweeps healthy
//   1 = one or more sweeps stale (missing heartbeat or too old)
//   2 = cannot reach Redis, env not configured, or vacuity guard fired

import { resolve } from "node:path";
import * as dotenv from "dotenv";

export const HEARTBEAT_KEY_PREFIX = "cron:heartbeat:";
export const LAST_ERROR_KEY_PREFIX = "cron:last-error:";

// maxAgeMs: 26h allows for daily scheduling jitter without false positives.
// Mirrors src/modules/cron/retention-schedule.ts. `retention-schedule-parity.spec.ts`
// fails if the two drift — a monitored list shorter than the scheduled list is a sweep
// that can die unobserved, which is the exact failure this alert exists to catch.
// maxAgeMs: 26h allows for daily scheduling jitter without false positives.
export const MONITORED_SWEEPS = [
  {
    jobKey: "hr-policy-retention-sweep",
    label: "HR policy retention (documents, employees, cases, attendance)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "helpdesk-retention-sweep",
    label: "Helpdesk ticket retention (resolved tickets older than 2 years)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "mail-metadata-retention-sweep",
    label: "Mail metadata retention (synced metadata older than 1 year)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "announcements-retention-sweep",
    label: "Announcements retention (expired after grace, aged beyond 2 years)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "ai-usage-retention-sweep",
    label: "AI usage log retention (730-day window, explicit non-dry-run)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "notifications-retention-sweep",
    label: "Notification body + record purge (email_outbox, notification_deliveries)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "notification-outbox-retention-sweep",
    label: "Notification outbox retention (30-day terminal state purge)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "outbox-events-retention-sweep",
    label: "Outbox events retention (outbox_events + inbox_records, 30-day terminal purge)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "kb-chat-history-purge",
    label: "KB chat history purge (per-org chat_history_retention_days)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "kb-chunk-retention-sweep",
    label: "KB chunk retention (orphaned chunks whose parent is gone)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "build-retention-prune",
    label: "Build webhook delivery retention (completed attempts older than 90 days)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "notifications-retention-detach",
    label: "Notification partition maintenance (DETACH CONCURRENTLY + DROP)",
    maxAgeMs: 26 * 3_600_000,
  },
];

/**
 * Returns true when the ISO timestamp is absent, unparseable, or older than maxAgeMs.
 * A null/undefined input is treated as "never ran" and is always stale.
 */
export function isStale(ts, maxAgeMs, now = Date.now()) {
  if (ts === undefined || ts === null) return true;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t > maxAgeMs;
}

/**
 * Partitions sweeps into stale and healthy using the provided heartbeat map.
 * heartbeats: Map<jobKey, string|null>  (null = key absent in Redis)
 */
export function classifySweeps(sweeps, heartbeats, now = Date.now()) {
  const stale = [];
  const healthy = [];
  for (const sweep of sweeps) {
    const ts = heartbeats.get(sweep.jobKey) ?? null;
    if (isStale(ts, sweep.maxAgeMs, now))
      stale.push({ ...sweep, lastRun: ts ?? "(never)" });
    else
      healthy.push({ ...sweep, lastRun: ts });
  }
  return { stale, healthy };
}

/**
 * Returns true when every heartbeat in the map is absent (null/undefined).
 * An all-absent result is unproven — not healthy. Could mean Redis is down,
 * the sweeps never ran, or the deployment is mis-configured.
 */
export function isVacuous(heartbeats) {
  return [...heartbeats.values()].every((v) => v === null || v === undefined);
}

/**
 * Partial failure is a different fault from staleness and must be signalled separately.
 *
 * `forEachOrg` isolates a failing tenant so the rest of the sweep still drains, and
 * `CronSweepFailureSinkService` writes that outcome to `cron:last-error:<jobKey>`. The
 * heartbeat is still written — the sweep did run — so a run that failed for a subset of
 * tenants is invisible to a staleness check alone.
 *
 * records: Map<jobKey, string|null>  (the raw JSON written by the sink or the lease)
 */
export function classifyFailures(sweeps, records, now = Date.now()) {
  const failing = [];
  for (const sweep of sweeps) {
    const raw = records.get(sweep.jobKey) ?? null;
    if (typeof raw !== "string") continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      failing.push({ ...sweep, error: "unparseable failure record", ts: "(unknown)" });
      continue;
    }
    const ts = typeof parsed?.ts === "string" ? parsed.ts : null;
    const at = ts === null ? NaN : new Date(ts).getTime();
    // Older than the staleness window means the sweep has succeeded since; the record
    // is kept for 7 days purely for post-mortem and must not fire for ever.
    if (Number.isFinite(at) && now - at > sweep.maxAgeMs) continue;
    failing.push({
      ...sweep,
      error: typeof parsed?.error === "string" ? parsed.error : "unknown failure",
      ts: ts ?? "(unknown)",
      partial: parsed?.partial === true,
      failedOrgIds: Array.isArray(parsed?.failedOrgIds) ? parsed.failedOrgIds : [],
    });
  }
  return failing;
}

// Detect direct execution vs. import (works on both ESM and CommonJS/ts-jest).
const isMain =
  process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/alert-retention-dead-man.mjs") ?? false;

if (isMain) {
  if (process.argv.includes("--self-test")) {
    runSelfTests();
  } else {
    dotenv.config({ path: resolve(process.cwd(), ".env") });
    runMain().catch((err) => {
      process.stderr.write(
        `alert-retention-dead-man: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    });
  }
}

function runSelfTests() {
  let passed = 0;
  let failed = 0;
  const checks = {};

  function assert(label, condition) {
    checks[label] = condition === true;
    if (condition) {
      passed++;
    } else {
      process.stderr.write(`  FAIL: ${label}\n`);
      failed++;
    }
  }

  const NOW = Date.now();
  const MAX_AGE = 26 * 3_600_000;
  const RECENT = new Date(NOW - 3_600_000).toISOString();
  const OLD = new Date(NOW - 48 * 3_600_000).toISOString();

  assert("recentHeartbeatHealthy", !isStale(RECENT, MAX_AGE, NOW));
  assert(
    "boundaryHeartbeatNotStale",
    !isStale(new Date(NOW - MAX_AGE).toISOString(), MAX_AGE, NOW),
  );
  assert("oldHeartbeatStale", isStale(OLD, MAX_AGE, NOW));
  assert("nullHeartbeatStale", isStale(null, MAX_AGE, NOW));
  assert("undefinedHeartbeatStale", isStale(undefined, MAX_AGE, NOW));
  assert("unparseableHeartbeatStale", isStale("not-a-date", MAX_AGE, NOW));

  assert("monitorsAtLeastTwelveSweeps", MONITORED_SWEEPS.length >= 12);
  assert(
    "everyMonitoredSweepHasAKeyAndWindow",
    MONITORED_SWEEPS.every(
      (s) => typeof s.jobKey === "string" && s.jobKey.length > 0 && s.maxAgeMs > 0,
    ),
  );
  assert(
    "monitoredJobKeysAreUnique",
    new Set(MONITORED_SWEEPS.map((s) => s.jobKey)).size === MONITORED_SWEEPS.length,
  );

  {
    const beats = new Map(MONITORED_SWEEPS.map((s) => [s.jobKey, RECENT]));
    const { stale, healthy } = classifySweeps(MONITORED_SWEEPS, beats, NOW);
    assert(
      "allRecentHeartbeatsHealthy",
      stale.length === 0 && healthy.length === MONITORED_SWEEPS.length,
    );
  }

  {
    // One stale, one absent, the rest recent — the mixed case a real fleet produces.
    const [first, second, ...rest] = MONITORED_SWEEPS;
    const beats = new Map([
      [first.jobKey, OLD],
      [second.jobKey, null],
      ...rest.map((s) => [s.jobKey, RECENT]),
    ]);
    const { stale, healthy } = classifySweeps(MONITORED_SWEEPS, beats, NOW);
    assert("mixedFleetStaleCountIsTwo", stale.length === 2);
    assert("mixedFleetHealthyCountIsTheRest", healthy.length === MONITORED_SWEEPS.length - 2);
    assert("staleListNamesTheOldOne", stale.some((s) => s.jobKey === first.jobKey));
    assert(
      "absentHeartbeatReportsNever",
      stale.some((s) => s.jobKey === second.jobKey && s.lastRun === "(never)"),
    );
  }

  {
    const allNull = new Map(MONITORED_SWEEPS.map((s) => [s.jobKey, null]));
    assert("allNullTriggersVacuityGuard", isVacuous(allNull));
    const onePresent = new Map(allNull);
    onePresent.set(MONITORED_SWEEPS[0].jobKey, RECENT);
    assert("onePresentDoesNotTriggerVacuityGuard", !isVacuous(onePresent));
  }

  {
    const records = new Map();
    assert("noFailureRecordsMeansNoAlert", classifyFailures(MONITORED_SWEEPS, records, NOW).length === 0);

    const partial = JSON.stringify({
      error: "3 of 250 organisation(s) failed during mail-metadata-retention",
      ts: RECENT,
      partial: true,
      failedOrgIds: ["org-0007", "org-0113", "org-0250"],
    });
    records.set("mail-metadata-retention-sweep", partial);
    const firing = classifyFailures(MONITORED_SWEEPS, records, NOW);
    assert("recentPartialFailureFires", firing.length === 1);
    assert("partialFailureIsFlaggedPartial", firing[0]?.partial === true);
    assert("partialFailureNamesTheTenants", firing[0]?.failedOrgIds.length === 3);

    const stale = new Map([
      ["mail-metadata-retention-sweep", JSON.stringify({ error: "old", ts: OLD })],
    ]);
    assert(
      "failureRecordOlderThanTheWindowDoesNotFireForever",
      classifyFailures(MONITORED_SWEEPS, stale, NOW).length === 0,
    );

    const junk = new Map([["mail-metadata-retention-sweep", "{not json"]]);
    assert(
      "unparseableFailureRecordFires",
      classifyFailures(MONITORED_SWEEPS, junk, NOW).length === 1,
    );
  }

  {
    const healthyBeats = new Map(MONITORED_SWEEPS.map((s) => [s.jobKey, RECENT]));
    const staleBeats = new Map(MONITORED_SWEEPS.map((s) => [s.jobKey, OLD]));
    assert(
      "healthyAndStaleFixturesDiffer",
      classifySweeps(MONITORED_SWEEPS, healthyBeats, NOW).stale.length === 0 &&
        classifySweeps(MONITORED_SWEEPS, staleBeats, NOW).stale.length ===
          MONITORED_SWEEPS.length,
    );
  }

  const pass = failed === 0;
  process.stdout.write(
    JSON.stringify({
      selfTest: true,
      pass,
      checks,
      monitoredSweeps: MONITORED_SWEEPS.length,
      passed,
      failedCount: failed,
    }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

async function redisGet(redisUrl, redisToken, key) {
  const response = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  });
  if (!response.ok) throw new Error(`Redis responded ${response.status} for key ${key}`);
  const body = await response.json();
  return body.result ?? null;
}

async function runMain() {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    process.stderr.write(
      "alert-retention-dead-man: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required\n",
    );
    process.exit(2);
  }

  const heartbeats = new Map();
  const failureRecords = new Map();
  const fetchErrors = [];

  for (const sweep of MONITORED_SWEEPS) {
    try {
      heartbeats.set(
        sweep.jobKey,
        await redisGet(redisUrl, redisToken, `${HEARTBEAT_KEY_PREFIX}${sweep.jobKey}`),
      );
    } catch (err) {
      fetchErrors.push(
        `  ${sweep.jobKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      heartbeats.set(sweep.jobKey, null);
    }
    try {
      failureRecords.set(
        sweep.jobKey,
        await redisGet(redisUrl, redisToken, `${LAST_ERROR_KEY_PREFIX}${sweep.jobKey}`),
      );
    } catch {
      failureRecords.set(sweep.jobKey, null);
    }
  }

  if (fetchErrors.length > 0) {
    process.stderr.write(
      `alert-retention-dead-man: failed to fetch ${fetchErrors.length} heartbeat key(s):\n` +
        fetchErrors.join("\n") +
        "\n",
    );
  }

  if (isVacuous(heartbeats)) {
    process.stderr.write(
      "alert-retention-dead-man: VACUITY GUARD — zero heartbeat keys found in Redis.\n" +
        "Redis unreachable, sweeps never ran, or deployment is mis-configured.\n" +
        "An empty result set is NOT a healthy state — investigate before concluding clean.\n",
    );
    process.exit(2);
  }

  const { stale, healthy } = classifySweeps(MONITORED_SWEEPS, heartbeats);
  const failing = classifyFailures(MONITORED_SWEEPS, failureRecords);

  process.stdout.write(
    `alert-retention-dead-man: ${MONITORED_SWEEPS.length} sweeps checked — ` +
      `${healthy.length} healthy, ${stale.length} stale, ${failing.length} with a recent failure\n`,
  );
  for (const s of healthy)
    process.stdout.write(`  OK     ${s.jobKey}  last=${s.lastRun}\n`);

  if (stale.length > 0) {
    process.stderr.write("Stale sweeps (not run within expected window):\n");
    for (const s of stale) {
      process.stderr.write(
        `  STALE  ${s.jobKey}  last=${s.lastRun}  maxAge=${s.maxAgeMs / 3_600_000}h\n` +
          `         ${s.label}\n`,
      );
    }
  }

  if (failing.length > 0) {
    process.stderr.write("Sweeps with a recent failure record (total or per-tenant):\n");
    for (const f of failing) {
      process.stderr.write(
        `  FAILED ${f.jobKey}  at=${f.ts}  partial=${String(f.partial === true)}\n` +
          `         ${f.error}\n` +
          (f.failedOrgIds && f.failedOrgIds.length > 0
            ? `         tenants: ${f.failedOrgIds.join(", ")}\n`
            : ""),
      );
    }
  }

  process.exit(stale.length > 0 || failing.length > 0 ? 1 : 0);
}
