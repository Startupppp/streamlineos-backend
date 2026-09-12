import request from "supertest";
import { and, eq } from "drizzle-orm";
import { orgModules, signEnvelopes, signSweepRuns } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { REDIS } from "src/common/cache/cache.service";
import { PROCESS_CELL_ID } from "src/common/cell-resources/cell-id";

/**
 * SIGN-P0-01 and SIGN-P0-02. The sweeps had no scheduler.
 *
 * `runReminderSweep` and `runExpirationSweep` have existed since SignOS
 * shipped — reminder intervals, maximum counts, expiry handling, all of it —
 * reachable only from an admin button somebody had to press. Every envelope's
 * "we will remind them in 3 days" was a promise nothing kept, and nothing
 * anywhere said so.
 *
 * The awkward part is that the sweeps query `sign_envelopes` with no `org_id`
 * filter. From an admin request that is correct: RLS narrows it to the caller's
 * organisation. From a cron endpoint there is no tenant context at all, and
 * `sign_envelopes` uses the raising accessor — so a naive cron route would have
 * failed outright rather than sweeping quietly. This asserts the route works
 * across organisations via `forEachOrg`, and that the run is recorded where an
 * operator can see it.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db CRON_SECRET=... \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=sign-sweep-cron
 */

const CRON_SECRET = process.env.CRON_SECRET ?? "";

describe(`${SEEDED_HARNESS} sign sweeps reach the scheduler`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let adminToken = "";

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("admin", { permissionKeys: ["sign:admin:manage"] })
      .build();
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "sign", enabled: true })
      .onConflictDoNothing();

    adminToken = await signSeededToken(seeded, fixture.members["admin"]!.userId, fixture.orgId);
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb.delete(signSweepRuns).where(eq(signSweepRuns.orgId, fixture.orgId));
      await seeded.seedDb.delete(signEnvelopes).where(eq(signEnvelopes.orgId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 60_000);

  const cron = (sweep: string, secret = CRON_SECRET) =>
    request(seeded.app.getHttpServer())
      .post(`/cron/sign-${sweep}-sweep`)
      .set("Authorization", `Bearer ${secret}`)
      .send({});

  const sweepStatus = () =>
    request(seeded.app.getHttpServer())
      .get("/sign/admin/sweep-status")
      .set("Authorization", `Bearer ${adminToken}`);

  const runUntilNotSkipped = async (sweep: string) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await cron(sweep);
      expect(res.status).toBe(200);
      if (res.body?.skipped !== true) return res;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw new Error(`${sweep} sweep never got the lease`);
  };

  it("reports both sweeps as never run before anything schedules them", async () => {
    const res = await sweepStatus();

    expect(res.status).toBe(200);
    const sweeps = res.body.sweeps as Array<{ sweep: string; neverRun: boolean }>;
    expect(sweeps.map((s) => s.sweep).sort()).toEqual(["expiration", "reminder"]);
    expect(sweeps.every((s) => s.neverRun)).toBe(true);
  }, 60_000);

  it("refuses a caller without the cron secret", async () => {
    const res = await cron("reminder", "not-the-secret");
    expect([401, 403]).toContain(res.status);
  }, 60_000);

  it("runs the reminder sweep across organisations", async () => {
    const res = await runUntilNotSkipped("reminder");

    expect(res.body.success).toBe(true);
    expect(res.body.sweep).toBe("reminder");
    /** It walked organisations rather than failing on the first tenant-less query. */
    expect(res.body.organizations).toBeGreaterThan(0);
    expect(res.body.failed).toBe(0);
  }, 180_000);

  it("records the run where an operator can see it", async () => {
    const [row] = await seeded.seedDb
      .select({ ranAt: signSweepRuns.ranAt, error: signSweepRuns.error })
      .from(signSweepRuns)
      .where(and(eq(signSweepRuns.orgId, fixture.orgId), eq(signSweepRuns.sweep, "reminder")));

    expect(row).toBeDefined();
    expect(row!.error).toBeNull();

    const res = await sweepStatus();
    const reminder = (res.body.sweeps as Array<{ sweep: string; neverRun: boolean; ranAt: string | null }>).find(
      (s) => s.sweep === "reminder",
    );
    expect(reminder).toMatchObject({ neverRun: false });
    expect(reminder!.ranAt).not.toBeNull();
  }, 60_000);

  /**
   * The lease is not decoration: a second copy starting underneath the first
   * would send every reminder twice, and a reminder is an email to a customer.
   *
   * Proved by holding the lease rather than by firing two requests at once.
   * `withLease` releases in a `finally`, so two *sequential* calls both acquire
   * — which is correct, since a 600s lease that outlived its job would block
   * the next scheduled run for ten minutes — and two concurrent calls race
   * against a sweep that finishes in milliseconds on a small database. Taking
   * the key first is the only version of this test that is deterministic and
   * still about the real lease.
   */
  it("skips the run while another holder has the lease", async () => {
    const redis = seeded.app.get(REDIS, { strict: false });
    if (!redis) {
      throw new Error(
        "no Redis bound: the lease cannot be proved in this environment, and without it " +
          "every scheduled sweep runs unguarded. Configure UPSTASH_REDIS_REST_URL/TOKEN.",
      );
    }

    const leaseKey = `cron:lease:${PROCESS_CELL_ID}:sign-reminder-sweep`;
    const taken = await redis.set(leaseKey, "held-by-the-test", { ex: 30, nx: true });
    expect(taken).toBe("OK");

    try {
      const res = await cron("reminder");
      expect(res.status).toBe(200);
      expect(res.body.skipped).toBe(true);
    } finally {
      await redis.del(leaseKey);
    }
  }, 60_000);

  it("runs the expiration sweep on its own lease", async () => {
    const res = await runUntilNotSkipped("expiration");

    expect(res.body.sweep).toBe("expiration");
    expect(res.body.failed).toBe(0);

    const status = await sweepStatus();
    const expiration = (status.body.sweeps as Array<{ sweep: string; neverRun: boolean }>).find(
      (s) => s.sweep === "expiration",
    );
    expect(expiration).toMatchObject({ neverRun: false });
  }, 180_000);

  /** The admin button must keep working; the cron route is an addition, not a replacement. */
  it("leaves the manual admin sweep working", async () => {
    const res = await request(seeded.app.getHttpServer())
      .post("/sign/admin/run-reminder-sweep")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("remindedCount");
  }, 60_000);
});
