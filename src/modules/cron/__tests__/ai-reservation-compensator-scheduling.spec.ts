import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CronRetentionSchedulerService } from "../cron-retention-scheduler.service";
import type { CronLeaseService } from "../cron-lease.service";
import { RETENTION_JOBS } from "../retention-schedule";
import { CronBillingService } from "../cron-billing.service";

/*
 * The compensator that had never run.
 *
 * `AiCreditsReservationService.reserve` debits the wallet by the catalogue ceiling before
 * the provider call and writes a RESERVED row expiring in 15 minutes; `settle` refunds the
 * over-estimate. A lost or failed settle therefore leaves the organisation charged the
 * ceiling with **no `ai_credit_transactions` row to explain it**, and
 * `sweepExpiredReservations` is the only thing that gives the money back.
 *
 * It was reachable only as `GET|POST /cron/ai-reservations-sweep` behind `CRON_SECRET`.
 * There is no `@Cron` decorator anywhere in `src` — measured, not assumed — the README's
 * external-scheduler contract named five jobs and not this one, and the in-process
 * scheduler registered thirteen retention drains and not this one. So no over-charge had
 * ever been refunded.
 *
 * These tests assert the three halves of "scheduled": declared on a cadence, wired to a
 * runner that reaches the real sweep, and watched by the dead-man alert.
 */

const JOB_KEY = "ai-reservations-sweep";

function schedulerWith(billing: CronBillingService, lease: CronLeaseService) {
  const run = jest.fn().mockResolvedValue({});
  const noop = {
    sweep: run,
    purgeExpiredConversations: run,
    pruneStaleChunks: run,
    pruneWebhookDeliveries: run,
    purgeExpiredTrash: run,
  };
  const fill = Array.from({ length: 17 }, () => noop);
  return new CronRetentionSchedulerService(
    null,
    lease,
    fill[0] as never,
    fill[1] as never,
    fill[2] as never,
    fill[3] as never,
    fill[4] as never,
    fill[5] as never,
    fill[6] as never,
    fill[7] as never,
    fill[8] as never,
    fill[9] as never,
    fill[10] as never,
    fill[11] as never,
    fill[12] as never,
    fill[13] as never,
    fill[14] as never,
    fill[15] as never,
    fill[16] as never,
    billing,
  );
}

describe("AI credit reservation compensator — it is scheduled", () => {
  it("(anti-vacuous) no @Cron decorator exists anywhere in src, so a declaration is the only mechanism", () => {
    const scheduler = readFileSync(
      resolve(__dirname, "..", "cron-retention-scheduler.service.ts"),
      "utf8",
    );
    expect(scheduler).toContain("CronLeaseService");
    expect(scheduler).not.toContain("@Cron(");
  });

  it("declares a cadence shorter than a day, because the reservation window is 15 minutes", () => {
    const job = RETENTION_JOBS.find((entry) => entry.jobKey === JOB_KEY);
    expect(job).toBeDefined();
    expect(job?.intervalMs).toBe(15 * 60_000);
    // A daily sweep would leave a wallet short of its own ceiling for most of a day.
    expect(job?.intervalMs).toBeLessThan(24 * 3_600_000);
    expect(job?.maxAgeMs).toBeGreaterThan(job?.intervalMs ?? 0);
    // The same lease the HTTP route takes, so an external POST and this scheduler compose.
    expect(job?.leaseSeconds).toBe(120);
  });

  it("runs the compensator on a tick, under its own lease", async () => {
    const sweepAiReservations = jest.fn().mockResolvedValue({ released: 4 });
    const withLease = jest.fn(
      async (_key: string, _seconds: number, fn: () => Promise<unknown>) => ({
        ran: true as const,
        result: await fn(),
      }),
    );
    const scheduler = schedulerWith(
      {
        sweepAiReservations,
        processMonthlyPlanGrants: jest.fn().mockResolvedValue({ granted: 0, skipped: 0 }),
        processTrialExpiry: jest.fn().mockResolvedValue({ expired: 0, reminded: 0 }),
        processPeriodExpiry: jest.fn().mockResolvedValue({ expired: 0, notified: 0 }),
      } as unknown as CronBillingService,
      { withLease } as unknown as CronLeaseService,
    );

    const outcome = await scheduler.tick();

    expect(outcome.ran).toContain(JOB_KEY);
    expect(outcome.failed).toEqual([]);
    expect(sweepAiReservations).toHaveBeenCalledTimes(1);
    expect(withLease.mock.calls.map((call) => [call[0], call[1]])).toContainEqual([
      JOB_KEY,
      120,
    ]);
  });

  it("surfaces a failing compensator instead of reporting a clean tick", async () => {
    const sweepAiReservations = jest.fn().mockRejectedValue(new Error("42501 no tenant context"));
    const withLease = jest.fn(
      async (_key: string, _seconds: number, fn: () => Promise<unknown>) => ({
        ran: true as const,
        result: await fn(),
      }),
    );
    const scheduler = schedulerWith(
      {
        sweepAiReservations,
        processMonthlyPlanGrants: jest.fn().mockResolvedValue({ granted: 0, skipped: 0 }),
        processTrialExpiry: jest.fn().mockResolvedValue({ expired: 0, reminded: 0 }),
        processPeriodExpiry: jest.fn().mockResolvedValue({ expired: 0, notified: 0 }),
      } as unknown as CronBillingService,
      { withLease } as unknown as CronLeaseService,
    );

    const outcome = await scheduler.tick();

    expect(outcome.failed).toContain(JOB_KEY);
    expect(outcome.ran).not.toContain(JOB_KEY);
  });

  it("is watched by the dead-man alert on an hourly window, not a daily one", () => {
    // The alert is an .mjs script jest cannot import, so it is read the way
    // retention-schedule-parity.spec.ts reads it.
    const alert = readFileSync(
      resolve(__dirname, "..", "..", "..", "scripts", "alert-retention-dead-man.mjs"),
      "utf8",
    );
    const entry = alert.slice(alert.indexOf(`jobKey: "${JOB_KEY}"`));
    expect(entry.length).toBeGreaterThan(0);
    expect(entry.slice(0, 300)).toContain("maxAgeMs: 3_600_000");
  });
});

describe("CronBillingService.sweepAiReservations — one pass over the tenants, not one per tenant", () => {
  it("delegates straight to the sweep, which iterates organisations itself", async () => {
    const sweepExpiredReservations = jest.fn().mockResolvedValue(7);
    const forEachOrg = jest.fn();
    const service = Object.create(CronBillingService.prototype) as CronBillingService;
    Object.assign(service, {
      db: {},
      aiCredits: { sweepExpiredReservations },
    });

    await expect(service.sweepAiReservations()).resolves.toEqual({ released: 7 });
    expect(sweepExpiredReservations).toHaveBeenCalledTimes(1);
    expect(forEachOrg).not.toHaveBeenCalled();
  });

  it("no longer wraps the cross-tenant sweep in a second per-tenant loop", () => {
    const source = readFileSync(resolve(__dirname, "..", "cron-billing.service.ts"), "utf8");
    const body = source.slice(
      source.indexOf("async sweepAiReservations"),
      source.indexOf("redriveStuckProviderEvents"),
    );
    expect(body).toContain("sweepExpiredReservations");
    // The wrapper ran the whole eight-tenant sweep once per tenant: 64 tenant blocks
    // for 8 tenants' worth of work, and it reset app.organization_id inside the outer
    // transaction on every inner iteration.
    expect(body).not.toContain("forEachOrg");
  });
});
