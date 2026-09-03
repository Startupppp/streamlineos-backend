import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RETENTION_JOBS, UNSCHEDULED_BILLING_JOBS } from "../retention-schedule";
import { CronBillingService } from "../cron-billing.service";

/*
 * The two billing jobs that had never run, and the two that still must not.
 *
 * `CronBillingController` exposes six leased routes. Nothing in either repository sends
 * any of them: `@nestjs/schedule` is not installed, no `@Cron` exists, the README's
 * external-scheduler contract named five unrelated jobs, `vercel.json` declares no
 * `crons`, and no GitHub workflow POSTs a `/cron/` route. So `monthly-plan-grants` had
 * never granted an organisation its monthly allocation and `trial-expiry` had never
 * ended a trial — money owed to customers, and revenue never collected.
 *
 * Scheduling them is only safe because each is idempotent in the DATABASE. The lease is
 * not the guard: `CronLeaseService.withLease` runs without dedup when Redis is absent or
 * erroring, and `isDue()` returns true with no Redis. These tests pin the guards that do
 * the work, so removing one fails here rather than in a customer's ledger.
 */

const SCHEMA_ROOT = resolve(__dirname, "..", "..", "..", "db", "schema");

function schema(relative: string): string {
  return readFileSync(resolve(SCHEMA_ROOT, relative), "utf8");
}

describe("the two billing jobs are scheduled, daily, and watched", () => {
  it.each([
    ["monthly-plan-grants", "billing-monthly-grants"],
    ["trial-expiry", "billing-trial-expiry"],
  ])("declares %s on a daily cadence with the route's own lease", (jobKey, sweepName) => {
    const job = RETENTION_JOBS.find((entry) => entry.jobKey === jobKey);
    expect(job).toBeDefined();
    expect(job?.intervalMs).toBe(24 * 3_600_000);
    expect(job?.maxAgeMs).toBeGreaterThan(job?.intervalMs ?? 0);
    // Matches withLease("<jobKey>", 300, ...) in cron-billing.controller.ts, so an
    // external POST and the in-process scheduler take the same lock.
    expect(job?.leaseSeconds).toBe(300);
    expect(job?.sweepName).toBe(sweepName);
  });

  it.each(["monthly-plan-grants", "trial-expiry"])(
    "registers a runner for %s that calls the real service method",
    (jobKey) => {
      const scheduler = readFileSync(
        resolve(__dirname, "..", "cron-retention-scheduler.service.ts"),
        "utf8",
      );
      expect(scheduler).toContain(`["${jobKey}",`);
    },
  );

  it("wires each runner to a method that exists on CronBillingService", () => {
    const proto: unknown = CronBillingService.prototype;
    expect(typeof Reflect.get(Object(proto), "processMonthlyPlanGrants")).toBe("function");
    expect(typeof Reflect.get(Object(proto), "processTrialExpiry")).toBe("function");
  });

  it.each(["monthly-plan-grants", "trial-expiry"])("is watched by the dead-man alert: %s", (jobKey) => {
    const alert = readFileSync(
      resolve(__dirname, "..", "..", "..", "scripts", "alert-retention-dead-man.mjs"),
      "utf8",
    );
    expect(alert).toContain(`jobKey: "${jobKey}"`);
  });

  it.each(["monthly-plan-grants", "trial-expiry"])("is documented for an operator: %s", (jobKey) => {
    const readme = readFileSync(
      resolve(__dirname, "..", "..", "..", "..", "README.md"),
      "utf8",
    );
    expect(readme).toContain(`/cron/${jobKey}`);
  });
});

describe("what makes scheduling them safe — the database guards, not the lease", () => {
  it("monthly-plan-grants: a partial unique index refuses a second grant for the same month", () => {
    const billing = schema("billing/billing.ts");
    expect(billing).toContain("uq_ai_credit_txns_plan_grant_ref");
    // (org_id, reference_id) WHERE type = 'PLAN_GRANT' — the reference is
    // `${plan}-monthly-YYYY-MM`, so a second run in the same month raises 23505 and
    // grantPlanCredits' isUniqueViolation branch returns without crediting.
    expect(billing).toMatch(
      /uniqueIndex\("uq_ai_credit_txns_plan_grant_ref"\)[\s\S]{0,200}type = 'PLAN_GRANT'/,
    );
  });

  it("monthly-plan-grants: the service checks the reference inside its own transaction too", () => {
    const service = readFileSync(
      resolve(__dirname, "..", "..", "billing", "core", "ai-credits.service.ts"),
      "utf8",
    );
    const grant = service.slice(
      service.indexOf("async grantPlanCredits"),
      service.indexOf("async purchaseCreditsDirectly"),
    );
    expect(grant).toContain("db.transaction");
    expect(grant).toContain('eq(aiCreditTransactions.type, "PLAN_GRANT")');
    expect(grant).toContain("isUniqueViolation");
  });

  it("trial-expiry: the expiry is one conditional UPDATE, so a second run matches no rows", () => {
    const cron = readFileSync(resolve(__dirname, "..", "cron-billing.service.ts"), "utf8");
    const body = cron.slice(
      cron.indexOf("async processTrialExpiry"),
      cron.indexOf("async processMonthlyPlanGrants"),
    );
    // The status predicate is what makes it idempotent: read-then-write would race.
    expect(body).toContain('eq(subscriptions.status, "TRIAL")');
    expect(body).toContain("lt(subscriptions.trialEndsAt, now)");
    expect(body).toContain(".returning(");
    // The churn event is emitted per RETURNING row, so a no-op run emits nothing.
    expect(body).toMatch(/for \(const row of expiredRows\)[\s\S]{0,200}this\.revenue\.emit/);
  });

  it("trial-expiry: the reminders are deduped by a unique index, not by a cache TTL", () => {
    const cron = readFileSync(resolve(__dirname, "..", "cron-billing.service.ts"), "utf8");
    expect(cron).toContain("dedupeKey: `trial-expiry:");
    expect(schema("common/notifications-delivery.ts")).toContain(
      'uniqueIndex("uniq_notification_outbox_dedupe").on(table.orgId, table.dedupeKey)',
    );
  });
});

describe("the billing jobs that are NOT scheduled, and why", () => {
  it("(anti-vacuous) the exclusion list is populated", () => {
    expect(UNSCHEDULED_BILLING_JOBS.length).toBeGreaterThan(0);
  });

  it("gives every excluded job a reason and keeps it off the schedule", () => {
    const scheduled = new Set(RETENTION_JOBS.map((job) => job.jobKey));
    for (const job of UNSCHEDULED_BILLING_JOBS) {
      expect(job.reason.length).toBeGreaterThan(40);
      expect(scheduled.has(job.jobKey)).toBe(false);
    }
  });

  it("accounts for every leased route on CronBillingController", () => {
    const controller = readFileSync(
      resolve(__dirname, "..", "cron-billing.controller.ts"),
      "utf8",
    );
    const leased = [...controller.matchAll(/withLease\("([^"]+)"/g)].map((m) => m[1]);
    expect(leased.length).toBe(6);

    const accounted = new Set([
      ...RETENTION_JOBS.map((job) => job.jobKey),
      ...UNSCHEDULED_BILLING_JOBS.map((job) => job.jobKey),
    ]);
    // A new billing cron route must be scheduled or explicitly excluded with a reason.
    // Neither is the state that shipped: six correct jobs that nothing ever called.
    expect(leased.filter((key) => !accounted.has(key))).toEqual([]);
  });
});
