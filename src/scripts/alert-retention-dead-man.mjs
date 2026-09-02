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

// maxAgeMs: 26h allows for daily scheduling jitter without false positives.
export const MONITORED_SWEEPS = [
  {
    jobKey: "notifications-retention-sweep",
    label: "Notification body + record purge (email_outbox, notification_deliveries)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "notification-outbox-retention-sweep",
    label: "Notification outbox retention (notification_outbox — 30-day terminal state purge)",
    maxAgeMs: 26 * 3_600_000,
  },
  {
    jobKey: "outbox-events-retention-sweep",
    label: "Outbox events retention (outbox_events + inbox_records — 30-day terminal state purge)",
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

  function assert(label, condition) {
    if (condition) {
      passed++;
    } else {
      process.stderr.write(`  FAIL: ${label}\n`);
      failed++;
    }
  }

  const NOW = Date.now();
  const MAX_AGE = 26 * 3_600_000;

  assert(
    "a heartbeat 1 hour old is healthy",
    !isStale(new Date(NOW - 3_600_000).toISOString(), MAX_AGE, NOW),
  );
  assert(
    "a heartbeat exactly at the boundary is not stale",
    !isStale(new Date(NOW - MAX_AGE).toISOString(), MAX_AGE, NOW),
  );
  assert(
    "a heartbeat 27 hours old is stale — the central bite proof",
    isStale(new Date(NOW - 27 * 3_600_000).toISOString(), MAX_AGE, NOW),
  );
  assert("a null heartbeat (sweep never ran) is stale", isStale(null, MAX_AGE, NOW));
  assert("an undefined heartbeat is stale", isStale(undefined, MAX_AGE, NOW));
  assert("an unparseable timestamp is stale", isStale("not-a-date", MAX_AGE, NOW));

  {
    const ts = new Date(NOW - 3_600_000).toISOString();
    const beats = new Map(MONITORED_SWEEPS.map((s) => [s.jobKey, ts]));
    const { stale, healthy } = classifySweeps(MONITORED_SWEEPS, beats, NOW);
    assert(
      "all recent heartbeats → healthy list, none stale",
      stale.length === 0 && healthy.length === MONITORED_SWEEPS.length,
    );
  }

  {
    const staleTs = new Date(NOW - 48 * 3_600_000).toISOString();
    const recentTs = new Date(NOW - 3_600_000).toISOString();
    const beats = new Map([
      ["notifications-retention-sweep", staleTs],
      ["notification-outbox-retention-sweep", recentTs],
      ["outbox-events-retention-sweep", null],
    ]);
    const { stale, healthy } = classifySweeps(MONITORED_SWEEPS, beats, NOW);
    assert("48h-old heartbeat is stale — stale list has 2 entries", stale.length === 2);
    assert(
      "stale list names notifications-retention-sweep",
      stale.some((s) => s.jobKey === "notifications-retention-sweep"),
    );
    assert(
      "null heartbeat (never ran) is stale — outbox-events-retention-sweep",
      stale.some((s) => s.jobKey === "outbox-events-retention-sweep"),
    );
    assert(
      "recent heartbeat is healthy — notification-outbox-retention-sweep",
      healthy.length === 1 && healthy[0].jobKey === "notification-outbox-retention-sweep",
    );
    assert(
      "stale entry carries lastRun=(never) when the key was absent",
      stale.some((s) => s.jobKey === "outbox-events-retention-sweep" && s.lastRun === "(never)"),
    );
  }

  {
    const allNull = new Map(MONITORED_SWEEPS.map((s) => [s.jobKey, null]));
    assert("all-null heartbeats trigger vacuity guard", isVacuous(allNull));

    const onePresent = new Map([
      ["notifications-retention-sweep", new Date(NOW - 3_600_000).toISOString()],
      ["notification-outbox-retention-sweep", null],
      ["outbox-events-retention-sweep", null],
    ]);
    assert("one present heartbeat does not trigger vacuity guard", !isVacuous(onePresent));
  }

  {
    const healthyBeats = new Map(
      MONITORED_SWEEPS.map((s) => [s.jobKey, new Date(NOW - 3_600_000).toISOString()]),
    );
    const staleBeats = new Map(
      MONITORED_SWEEPS.map((s) => [s.jobKey, new Date(NOW - 48 * 3_600_000).toISOString()]),
    );
    const healthyResult = classifySweeps(MONITORED_SWEEPS, healthyBeats, NOW);
    const staleResult = classifySweeps(MONITORED_SWEEPS, staleBeats, NOW);
    assert(
      "healthy and stale fixtures produce different outcomes — a probe whose failure equals its success proves nothing",
      healthyResult.stale.length === 0 && staleResult.stale.length > 0,
    );
  }

  if (failed > 0) {
    process.stderr.write(
      `alert-retention-dead-man self-tests: ${failed} failed, ${passed} passed\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`alert-retention-dead-man self-tests: ${passed} passed\n`);
  process.exit(0);
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
  const fetchErrors = [];

  for (const sweep of MONITORED_SWEEPS) {
    const heartbeatKey = `${HEARTBEAT_KEY_PREFIX}${sweep.jobKey}`;
    try {
      heartbeats.set(sweep.jobKey, await redisGet(redisUrl, redisToken, heartbeatKey));
    } catch (err) {
      fetchErrors.push(
        `  ${sweep.jobKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      heartbeats.set(sweep.jobKey, null);
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

  process.stdout.write(
    `alert-retention-dead-man: ${MONITORED_SWEEPS.length} sweeps checked — ` +
      `${healthy.length} healthy, ${stale.length} stale\n`,
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
    process.exit(1);
  }

  process.exit(0);
}
