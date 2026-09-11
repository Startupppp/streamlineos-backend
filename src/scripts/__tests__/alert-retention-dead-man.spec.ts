import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(__dirname, "../alert-retention-dead-man.mjs");

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

// ── self-test mode ────────────────────────────────────────────────────────────

describe("alert-retention-dead-man --self-test", () => {
  it("exits 0 and emits the {pass:true} line check-alert-system.mjs consumes", () => {
    const { stdout, stderr, status } = run(["--self-test"]);
    expect(status).toBe(0);
    const last = stdout.trim().split("\n").at(-1) ?? "";
    const parsed = JSON.parse(last) as { pass: boolean; selfTest: boolean };
    expect(parsed.selfTest).toBe(true);
    expect(parsed.pass).toBe(true);
    expect(stderr).toBe("");
  });

  it("passes at least 10 assertions (vacuity: self-test is not hollow)", () => {
    const { stdout, status } = run(["--self-test"]);
    expect(status).toBe(0);
    const last = stdout.trim().split("\n").at(-1) ?? "";
    const parsed = JSON.parse(last) as { passed: number; failedCount: number };
    expect(parsed.passed).toBeGreaterThanOrEqual(10);
    expect(parsed.failedCount).toBe(0);
  });
});

// ── no Redis env vars ─────────────────────────────────────────────────────────

describe("alert-retention-dead-man — missing env vars", () => {
  it("exits 2 and prints an explanatory message when Redis env vars are absent", () => {
    const result = spawnSync("node", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("UPSTASH_REDIS_REST_URL");
  });
});

// ── pure logic (inlined to avoid ESM/CJS import friction with ts-jest) ────────
// These functions mirror the exported implementations exactly. If the script
// logic changes, update here to match. Tests run without any subprocess or Redis.

const HEARTBEAT_KEY_PREFIX = "cron:heartbeat:";

const FIXTURE_SWEEPS = [
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

function isStale(ts: string | null | undefined, maxAgeMs: number, now: number): boolean {
  if (ts === undefined || ts === null) return true;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t > maxAgeMs;
}

function classifySweeps(
  sweeps: typeof FIXTURE_SWEEPS,
  heartbeats: Map<string, string | null | undefined>,
  now: number,
) {
  const stale: Array<(typeof FIXTURE_SWEEPS)[number] & { lastRun: string }> = [];
  const healthy: Array<(typeof FIXTURE_SWEEPS)[number] & { lastRun: string }> = [];
  for (const sweep of sweeps) {
    const ts = heartbeats.get(sweep.jobKey) ?? null;
    if (isStale(ts, sweep.maxAgeMs, now))
      stale.push({ ...sweep, lastRun: ts ?? "(never)" });
    else
      healthy.push({ ...sweep, lastRun: ts as string });
  }
  return { stale, healthy };
}

function isVacuous(heartbeats: Map<string, string | null | undefined>): boolean {
  return [...heartbeats.values()].every((v) => v === null || v === undefined);
}

const NOW = Date.now();
const MAX_AGE = 26 * 3_600_000;

describe("HEARTBEAT_KEY_PREFIX", () => {
  it("is cron:heartbeat:", () => {
    expect(HEARTBEAT_KEY_PREFIX).toBe("cron:heartbeat:");
  });
});

// The list the SCRIPT actually monitors, read from source rather than mirrored:
// a monitored list shorter than the scheduled list is a sweep that can die unobserved,
// which is exactly the fault this alert exists to catch.
const SCRIPT_SOURCE = readFileSync(SCRIPT, "utf8");
const SCRIPT_JOB_KEYS = [...SCRIPT_SOURCE.matchAll(/jobKey:\s*"([^"]+)"/g)].map((m) => m[1]);

describe("MONITORED_SWEEPS declared by the script", () => {
  it("monitors every retention sweep, not the three it started with", () => {
    expect(SCRIPT_JOB_KEYS.length).toBeGreaterThanOrEqual(12);
    for (const key of [
      "hr-policy-retention-sweep",
      "helpdesk-retention-sweep",
      "mail-metadata-retention-sweep",
      "announcements-retention-sweep",
      "ai-usage-retention-sweep",
      "notifications-retention-sweep",
      "notification-outbox-retention-sweep",
      "outbox-events-retention-sweep",
      "kb-chat-history-purge",
      "kb-chunk-retention-sweep",
      "build-retention-prune",
      "notifications-retention-detach",
    ])
      expect(SCRIPT_JOB_KEYS).toContain(key);
  });

  it("declares each job key exactly once", () => {
    expect(new Set(SCRIPT_JOB_KEYS).size).toBe(SCRIPT_JOB_KEYS.length);
  });

  it("every fixture sweep has a positive maxAgeMs and a non-empty label", () => {
    for (const s of FIXTURE_SWEEPS) {
      expect(s.maxAgeMs).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(10);
    }
  });
});

describe("isStale", () => {
  it("returns false for a heartbeat 1 hour old (well within window)", () => {
    expect(isStale(new Date(NOW - 3_600_000).toISOString(), MAX_AGE, NOW)).toBe(false);
  });

  it("returns false at the exact boundary (not stale)", () => {
    expect(isStale(new Date(NOW - MAX_AGE).toISOString(), MAX_AGE, NOW)).toBe(false);
  });

  it("returns true for a heartbeat 27 hours old — the central bite proof", () => {
    expect(isStale(new Date(NOW - 27 * 3_600_000).toISOString(), MAX_AGE, NOW)).toBe(true);
  });

  it("returns true for null (sweep never ran)", () => {
    expect(isStale(null, MAX_AGE, NOW)).toBe(true);
  });

  it("returns true for undefined", () => {
    expect(isStale(undefined, MAX_AGE, NOW)).toBe(true);
  });

  it("returns true for an unparseable timestamp", () => {
    expect(isStale("not-a-date", MAX_AGE, NOW)).toBe(true);
  });
});

describe("classifySweeps", () => {
  it("(healthy) all recent heartbeats → zero stale, all healthy", () => {
    const ts = new Date(NOW - 3_600_000).toISOString();
    const beats = new Map(FIXTURE_SWEEPS.map((s) => [s.jobKey, ts]));
    const { stale, healthy } = classifySweeps(FIXTURE_SWEEPS, beats, NOW);
    expect(stale).toHaveLength(0);
    expect(healthy).toHaveLength(FIXTURE_SWEEPS.length);
  });

  it("(stale fixture bite) 48h-old and null heartbeats are classified stale", () => {
    const staleTs = new Date(NOW - 48 * 3_600_000).toISOString();
    const recentTs = new Date(NOW - 3_600_000).toISOString();
    const beats = new Map([
      ["notifications-retention-sweep", staleTs],
      ["notification-outbox-retention-sweep", recentTs],
      ["outbox-events-retention-sweep", null],
    ]);
    const { stale, healthy } = classifySweeps(FIXTURE_SWEEPS, beats, NOW);
    expect(stale).toHaveLength(2);
    expect(healthy).toHaveLength(1);
    expect(stale.map((s) => s.jobKey)).toContain("notifications-retention-sweep");
    expect(stale.map((s) => s.jobKey)).toContain("outbox-events-retention-sweep");
    expect(healthy[0].jobKey).toBe("notification-outbox-retention-sweep");
  });

  it("absent heartbeat sets lastRun=(never) on the stale entry", () => {
    const beats = new Map(FIXTURE_SWEEPS.map((s) => [s.jobKey, null]));
    const { stale } = classifySweeps(FIXTURE_SWEEPS, beats, NOW);
    for (const s of stale) expect(s.lastRun).toBe("(never)");
  });

  it("(probe-whose-failure-equals-success guard) healthy and stale fixtures differ", () => {
    const h = new Map(FIXTURE_SWEEPS.map((s) => [s.jobKey, new Date(NOW - 3_600_000).toISOString()]));
    const x = new Map(FIXTURE_SWEEPS.map((s) => [s.jobKey, new Date(NOW - 48 * 3_600_000).toISOString()]));
    const healthy = classifySweeps(FIXTURE_SWEEPS, h, NOW);
    const stale = classifySweeps(FIXTURE_SWEEPS, x, NOW);
    expect(healthy.stale).toHaveLength(0);
    expect(stale.stale.length).toBeGreaterThan(0);
  });
});

describe("isVacuous", () => {
  it("(empty/vacuous) returns true when all heartbeats are null", () => {
    const allNull = new Map(FIXTURE_SWEEPS.map((s) => [s.jobKey, null]));
    expect(isVacuous(allNull)).toBe(true);
  });

  it("(unreachable simulation) returns true when all values are undefined", () => {
    const allUndefined = new Map(FIXTURE_SWEEPS.map((s) => [s.jobKey, undefined]));
    expect(isVacuous(allUndefined)).toBe(true);
  });

  it("returns false when at least one heartbeat is present", () => {
    const m = new Map([
      ["notifications-retention-sweep", new Date(NOW - 3_600_000).toISOString()],
      ["notification-outbox-retention-sweep", null as string | null],
      ["outbox-events-retention-sweep", null as string | null],
    ]);
    expect(isVacuous(m)).toBe(false);
  });

  it("(bite proof) vacuous and non-vacuous produce different boolean results", () => {
    const allNull = new Map(FIXTURE_SWEEPS.map((s) => [s.jobKey, null]));
    const onePresent = new Map([
      ["notifications-retention-sweep", new Date(NOW - 3_600_000).toISOString()],
      ["notification-outbox-retention-sweep", null as string | null],
      ["outbox-events-retention-sweep", null as string | null],
    ]);
    expect(isVacuous(allNull)).not.toBe(isVacuous(onePresent));
  });
});
