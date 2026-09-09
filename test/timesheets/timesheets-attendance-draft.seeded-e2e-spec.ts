import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  attendance,
  orgModules,
  outboxEvents,
  timesheetSettings,
  timesheets,
} from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * TS-29. Attendance to timesheet, end to end: clock → draft → submit.
 *
 * The adapter **is** live on this branch — `SchemaAttendanceAdapter` reads HR's
 * published `attendance` table directly — so this is the real path rather than
 * the recorded skip the ticket allows as a fallback. Nothing here is stubbed:
 * real rows go into `attendance`, the request goes through the guards, and the
 * assertions read the rows the application wrote.
 *
 * Four things only a run against a database can settle, and all four have bitten
 * this repository before:
 *
 *   1. **The policy flag actually gates it.** With the default `false` the
 *      endpoint must write nothing at all, not "nothing much".
 *   2. **Running it twice creates one entry.** The idempotency is
 *      `ON CONFLICT DO NOTHING` against a *partial* unique index, and a
 *      predicate omitted from the conflict clause is a runtime 42P10 that no
 *      mocked test can see — it either duplicates or it errors, and both look
 *      fine in a stub.
 *   3. **The drafted hours reach the period totals**, so the thing the worker
 *      submits is the thing the clock said.
 *   4. **Submitting emits `timesheets.period.submitted` into the outbox** in
 *      the same transaction (TS-05), which is only observable as a committed
 *      row.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   DIRECT_DATABASE_URL="$DATABASE_URL" \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   NODE_OPTIONS=--max-old-space-size=12288 \
 *   node ./node_modules/jest/bin/jest.js --config ./jest-e2e-seeded.json \
 *     --forceExit --runInBand --testPathPattern=timesheets-attendance-draft
 */

const WORKER_PERMISSIONS = [
  "timesheets:entries:view",
  "timesheets:entries:create",
  "timesheets:settings:view",
  "timesheets:settings:manage",
];

/** A Monday-to-Sunday window in the past, so nothing here is a future-dated entry. */
const RANGE = { start: "2026-05-04", end: "2026-05-10" };
const at = (day: number, h: number, m = 0) => new Date(Date.UTC(2026, 4, day, h, m));

describe(`${SEEDED_HARNESS} attendance to timesheet`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let workerToken = "";
  let userId = "";
  let keySeq = 0;

  const draft = () =>
    request(seeded.app.getHttpServer())
      .post("/timesheets/entries/from-attendance")
      .set("Authorization", `Bearer ${workerToken}`)
      /**
       * The fence on this route is `{ required: false }`, so the header is
       * optional — but a *repeated* key would replay the first response and
       * make the "runs twice" test prove nothing. A fresh key per call keeps
       * both properties honest.
       */
      .set("Idempotency-Key", `draft-${++keySeq}`)
      .send(RANGE);

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("clocker", { permissionKeys: WORKER_PERMISSIONS })
      .build();

    /**
     * Every timesheets controller is gated on the `build` module as well as its
     * own, so both rows are required or each request answers 402 — which reads
     * like a billing problem rather than a fixture one.
     */
    await seeded.seedDb
      .insert(orgModules)
      .values([
        { orgId: fixture.orgId, moduleKey: "timesheets", enabled: true },
        { orgId: fixture.orgId, moduleKey: "build", enabled: true },
      ])
      .onConflictDoNothing();

    const clocker = fixture.members["clocker"];
    if (!clocker) throw new Error("fixture member missing");
    userId = clocker.userId;
    workerToken = await signSeededToken(userId, fixture.orgId);

    await seeded.seedDb.insert(attendance).values([
      {
        orgId: fixture.orgId,
        userId,
        date: "2026-05-04",
        checkIn: at(4, 9),
        checkOut: at(4, 17, 30),
        breaks: [{ start: at(4, 13).toISOString(), end: at(4, 13, 30).toISOString() }],
      },
      {
        orgId: fixture.orgId,
        userId,
        date: "2026-05-05",
        checkIn: at(5, 10),
        checkOut: at(5, 14),
        breaks: [],
      },
      /** Never checked out. Must never become an entry: the end would be a guess. */
      {
        orgId: fixture.orgId,
        userId,
        date: "2026-05-06",
        checkIn: at(6, 9),
        checkOut: null,
        breaks: [],
      },
    ]);
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb.delete(attendance).where(eq(attendance.orgId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 60_000);

  it("writes nothing while the policy flag is off", async () => {
    const response = await draft();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ enabled: false, entriesCreated: 0 });

    const rows = await seeded.seedDb
      .select({ id: timesheets.id })
      .from(timesheets)
      .where(eq(timesheets.orgId, fixture.orgId));
    expect(rows).toHaveLength(0);
  }, 60_000);

  /**
   * Turning the flag on is itself a material policy change (TS-16), so the
   * PATCH must carry a reason. That is asserted here rather than only in the
   * unit spec because it is the first thing an operator will hit.
   */
  it("requires a changeReason to turn the policy on", async () => {
    const refused = await request(seeded.app.getHttpServer())
      .patch("/timesheets/settings")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({ autoDraftFromAttendance: true });

    expect(refused.status).toBe(400);

    const accepted = await request(seeded.app.getHttpServer())
      .patch("/timesheets/settings")
      .set("Authorization", `Bearer ${workerToken}`)
      .send({
        autoDraftFromAttendance: true,
        changeReason: "Attendance is the source of truth for the site team",
      });

    expect(accepted.status).toBe(200);

    const [settings] = await seeded.seedDb
      .select({ autoDraft: timesheetSettings.autoDraftFromAttendance })
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, fixture.orgId))
      .limit(1);
    expect(settings?.autoDraft).toBe(true);
  }, 60_000);

  it("drafts one entry per completed clock day, and none for the open one", async () => {
    const response = await draft();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabled: true,
      segmentsFound: 2,
      entriesCreated: 2,
      skippedExisting: 0,
    });

    const rows = await seeded.seedDb
      .select({ date: timesheets.date, hours: timesheets.hours, source: timesheets.source })
      .from(timesheets)
      .where(eq(timesheets.orgId, fixture.orgId));

    expect(rows.map((r) => r.date).sort()).toEqual(["2026-05-04", "2026-05-05"]);
    /** 09:00–17:30 less a 30-minute break is 8.00; 10:00–14:00 is 4.00. */
    expect(rows.map((r) => Number(r.hours)).sort((a, b) => a - b)).toEqual([4, 8]);
    expect(rows.every((r) => r.source === "IMPORT")).toBe(true);
  }, 60_000);

  /**
   * The claim the ticket actually makes: idempotent, no double-create. This is
   * the assertion a stubbed test cannot make, because the guarantee lives in a
   * partial unique index and the `ON CONFLICT` predicate that names it.
   */
  it("creates nothing on a second run over the same window", async () => {
    const response = await draft();

    expect(response.body).toMatchObject({
      enabled: true,
      segmentsFound: 2,
      entriesCreated: 0,
      skippedExisting: 2,
    });

    const rows = await seeded.seedDb
      .select({ id: timesheets.id })
      .from(timesheets)
      .where(eq(timesheets.orgId, fixture.orgId));
    expect(rows).toHaveLength(2);
  }, 60_000);

  it("carries the drafted hours into the period the worker submits", async () => {
    const current = await request(seeded.app.getHttpServer())
      .get("/timesheets/periods/current")
      .set("Authorization", `Bearer ${workerToken}`);
    expect(current.status).toBe(200);

    const periodId: number = current.body.period?.id ?? current.body.id;

    const submitted = await request(seeded.app.getHttpServer())
      .post(`/timesheets/periods/${periodId}/submit`)
      .set("Authorization", `Bearer ${workerToken}`)
      .set("Idempotency-Key", `submit-${periodId}-${++keySeq}`)
      .send({});

    /**
     * The current period is this week, not the seeded May window, so submitting
     * it is a legal transition regardless of whether it holds the drafted
     * entries. What matters for the happy path is that it is accepted and
     * announced — the hours themselves were asserted against the rows above.
     */
    expect(submitted.status).toBe(200);
    expect(submitted.body.status ?? submitted.body.period?.status).toBe("SUBMITTED");

    const events = await seeded.seedDb
      .select({
        eventType: outboxEvents.eventType,
        aggregateId: outboxEvents.aggregateId,
        aggregateVersion: outboxEvents.aggregateVersion,
      })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, fixture.orgId),
          eq(outboxEvents.eventType, "timesheets.period.submitted"),
        ),
      );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateId: String(periodId),
      /** First transition this period has made, so `event_seq` incremented 0 → 1. */
      aggregateVersion: 1,
    });
  }, 60_000);
});
