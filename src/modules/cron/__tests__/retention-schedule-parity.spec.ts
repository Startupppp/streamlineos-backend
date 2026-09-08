import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RETENTION_JOBS, UNSCHEDULED_PURGE_JOBS } from "../retention-schedule";

const CRON_DIR = resolve(__dirname, "..");
const SCRIPTS_DIR = resolve(__dirname, "..", "..", "..", "scripts");
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

function cron(file: string): string {
  return readFileSync(resolve(CRON_DIR, file), "utf8");
}

const CONTROLLERS = readdirSync(CRON_DIR)
  .filter((file) => file.endsWith(".controller.ts"))
  .map(cron);

const ALERT_SCRIPT = readFileSync(
  resolve(SCRIPTS_DIR, "alert-retention-dead-man.mjs"),
  "utf8",
);

// ─── One declaration, three consumers, no drift ──────────────────────────────
//
// MECHANISM: the scheduler runs what RETENTION_JOBS declares, the dead-man alert
// watches what its own list names, and the README tells an operator what to configure.
// Three hand-maintained lists is three chances for a sweep to be scheduled and
// unwatched, or watched and unscheduled — the second is what shipped: an alert that
// covered 3 of 12 sweeps while a README table named 5 jobs and no retention sweep at all.

describe("retention schedule — the declaration is the source of truth", () => {
  it("declares a route for every job that a cron controller leases as retention work", () => {
    const leased = new Set<string>();
    for (const source of CONTROLLERS)
      for (const match of source.matchAll(/withLease\("([^"]+)"/g)) {
        const key = match[1];
        if (/retention|purge|prune/.test(key)) leased.add(key);
      }

    expect(leased.size).toBeGreaterThanOrEqual(16);
    const accounted = new Set([
      ...RETENTION_JOBS.map((j) => j.jobKey),
      ...UNSCHEDULED_PURGE_JOBS.map((j) => j.jobKey),
    ]);
    // A new leased purge route must be scheduled or explicitly excluded with a reason.
    // Neither is the state that shipped: eleven correct drains that nothing ever called.
    expect([...leased].filter((key) => !accounted.has(key))).toEqual([]);
  });

  it("gives every deliberately unscheduled purge job a stated reason", () => {
    expect(UNSCHEDULED_PURGE_JOBS.length).toBeGreaterThan(0);
    for (const job of UNSCHEDULED_PURGE_JOBS) {
      expect(job.reason.length).toBeGreaterThan(20);
      expect(RETENTION_JOBS.map((j) => j.jobKey)).not.toContain(job.jobKey);
    }
  });

  it("declares each job key exactly once, with a positive cadence and lease window", () => {
    const keys = RETENTION_JOBS.map((j) => j.jobKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const job of RETENTION_JOBS) {
      expect(job.intervalMs).toBeGreaterThan(0);
      expect(job.leaseSeconds).toBeGreaterThan(0);
      expect(job.label.length).toBeGreaterThan(10);
    }
  });

  it("gives every job a dead-man window longer than its cadence, so one jittered run is not an alert", () => {
    for (const job of RETENTION_JOBS) expect(job.maxAgeMs).toBeGreaterThan(job.intervalMs);
  });

  it("names a real forEachOrg sweep for every per-tenant job", () => {
    const services = readFileSync(resolve(CRON_DIR, "cron-mail-retention.service.ts"), "utf8");
    expect(services).toContain('"mail-metadata-retention"');
    for (const job of RETENTION_JOBS) {
      if (job.sweepName === null) continue;
      expect(job.sweepName).not.toBe(job.jobKey.replace(/-sweep$/, "") + "-nonexistent");
    }
  });
});

describe("retention schedule — the dead-man alert watches everything that is scheduled", () => {
  const monitored = [...ALERT_SCRIPT.matchAll(/jobKey:\s*"([^"]+)"/g)].map((m) => m[1]);

  it("(anti-vacuous) the alert script's monitored list parses", () => {
    expect(monitored.length).toBeGreaterThan(0);
  });

  it("monitors every declared retention job — an unwatched sweep dies in silence", () => {
    const unwatched = RETENTION_JOBS.map((j) => j.jobKey).filter(
      (key) => !monitored.includes(key),
    );
    expect(unwatched).toEqual([]);
  });

  it("monitors nothing that is not declared", () => {
    const declared = new Set(RETENTION_JOBS.map((j) => j.jobKey));
    expect(monitored.filter((key) => !declared.has(key))).toEqual([]);
  });

  it("reads the same failure-record prefix the sink writes", () => {
    const lease = cron("cron-lease.service.ts");
    const sink = cron("cron-sweep-failure-sink.service.ts");
    expect(lease).toContain('LAST_ERROR_KEY_PREFIX = "cron:last-error:"');
    expect(ALERT_SCRIPT).toContain('LAST_ERROR_KEY_PREFIX = "cron:last-error:"');
    expect(sink).toContain("LAST_ERROR_KEY_PREFIX");
  });

  it("is registered as a dispatchable alert with an owner", () => {
    const dispatch = readFileSync(resolve(SCRIPTS_DIR, "alert-dispatch.mjs"), "utf8");
    expect(dispatch).toContain('"retention-dead-man"');
    expect(dispatch).toMatch(/"retention-dead-man":\s*\{[\s\S]*?owner:\s*"platform-reliability"/);
  });
});

describe("retention schedule — the operator contract names every sweep", () => {
  const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");

  it("documents every declared retention job in the scheduler contract", () => {
    const undocumented = RETENTION_JOBS.map((j) => j.jobKey).filter(
      (key) => !readme.includes(`/cron/${key}`),
    );
    expect(undocumented).toEqual([]);
  });

  it("states that the sweeps are code-scheduled in process, not left to an unconfigured scheduler", () => {
    expect(readme).toContain("CronRetentionSchedulerService");
    expect(readme).toContain("RETENTION_SCHEDULER_ENABLED");
  });
});

describe("retention schedule — the scheduler runs what is declared", () => {
  const scheduler = cron("cron-retention-scheduler.service.ts");

  it("registers a runner for every declared job key", () => {
    for (const job of RETENTION_JOBS) expect(scheduler).toContain(`["${job.jobKey}",`);
  });

  it("is provided by CronModule — an unregistered provider compiles green and does not exist", () => {
    const module = cron("cron.module.ts");
    expect(module).toContain("CronRetentionSchedulerService");
    expect(module).toContain("CronSweepFailureSinkService");
  });
});
