import request from "supertest";
import {
  holidays,
  orgModules,
  timesheetSettings,
  timesheets as timesheetEntries,
} from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * TS-12. Holidays reach the grid, and stop being hours anyone owes.
 *
 * The timesheets module did not read the `holidays` table at all — only the
 * payroll export did. So the week grid had no way to mark a closed day, and
 * `expectedHoursForRange` was `completeWeeks * weeklyHours` flat: a week
 * containing a public holiday still expected forty hours and the compliance
 * report marked the whole company short for it.
 *
 * Two halves are proved here. The calendar route must be reachable by the
 * people who fill in timesheets — it carries `timesheets:entries:view`, not
 * `reports:view`, and the fixture member deliberately holds only the former
 * for that test. And the compliance report's expectation must drop by exactly
 * one day per weekday holiday.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=timesheets-holidays
 */

/** June 2026 begins on a Monday, so 06-01..06-28 is exactly four whole weeks. */
const START = "2026-06-01";
const END = "2026-06-28";

describe(`${SEEDED_HARNESS} timesheet holidays`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let workerToken = "";
  let analystToken = "";

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      /** Only entries:view — the grid user, who must be able to read the calendar. */
      .addMember("worker", { permissionKeys: ["timesheets:entries:view", "timesheets:entries:create"] })
      .addMember("analyst", { permissionKeys: ["timesheets:reports:view", "timesheets:entries:view"] })
      .build();

    await seeded.seedDb
      .insert(orgModules)
      .values([
        { orgId: fixture.orgId, moduleKey: "timesheets", enabled: true },
        { orgId: fixture.orgId, moduleKey: "build", enabled: true },
      ])
      .onConflictDoNothing();

    workerToken = await signSeededToken(seeded, fixture.members["worker"]!.userId, fixture.orgId);
    analystToken = await signSeededToken(seeded, fixture.members["analyst"]!.userId, fixture.orgId);

    await seeded.seedDb.insert(timesheetSettings).values({
      orgId: fixture.orgId,
      expectedWeeklyHours: "40.00",
    });

    /**
     * The compliance report has one row per user who logged something, so
     * without an entry there is nobody to have an expectation.
     */
    await seeded.seedDb.insert(timesheetEntries).values({
      orgId: fixture.orgId,
      userMembershipId: fixture.members["worker"]!.membershipId,
      date: "2026-06-02",
      hours: "8.00",
      description: "a day in the range",
      status: "APPROVED" as const,
      isBillable: true,
    });

    await seeded.seedDb.insert(holidays).values([
      /** A Wednesday: a working day, so it costs expected hours. */
      { orgId: fixture.orgId, name: "Founders Day", date: "2026-06-10", isPublic: true },
      /** A Saturday: nobody owed hours on it, so it must change nothing. */
      { orgId: fixture.orgId, name: "Company Picnic", date: "2026-06-13", isPublic: true },
      /** Outside the range entirely. */
      { orgId: fixture.orgId, name: "Later Holiday", date: "2026-07-06", isPublic: true },
    ]);
  }, 240_000);

  afterAll(async () => {
    await fixture?.teardown();
    await seeded?.close();
  }, 60_000);

  it("serves the calendar to someone holding only entries:view", async () => {
    const res = await request(seeded.app.getHttpServer())
      .get(`/timesheets/calendar/holidays?startDate=${START}&endDate=${END}`)
      .set("Authorization", `Bearer ${workerToken}`);

    expect(res.status).toBe(200);
    const dates = (res.body.holidays as Array<{ date: string; name: string }>).map((h) => h.date);
    expect(dates).toEqual(["2026-06-10", "2026-06-13"]);
    expect(res.body.holidays[0]).toMatchObject({ name: "Founders Day" });
  }, 60_000);

  it("does not leak holidays from outside the requested range", async () => {
    const res = await request(seeded.app.getHttpServer())
      .get(`/timesheets/calendar/holidays?startDate=${START}&endDate=${END}`)
      .set("Authorization", `Bearer ${workerToken}`);

    expect(JSON.stringify(res.body)).not.toContain("Later Holiday");
  }, 60_000);

  it("requires both ends of the range rather than scanning a whole calendar", async () => {
    const res = await request(seeded.app.getHttpServer())
      .get(`/timesheets/calendar/holidays?startDate=${START}`)
      .set("Authorization", `Bearer ${workerToken}`);

    expect(res.status).toBe(400);
  }, 60_000);

  /**
   * Four whole weeks at forty hours is 160. One weekday holiday costs 40/5,
   * so the answer must be 152 — not 160, and not 144, which is what counting
   * the Saturday too would give.
   */
  it("deducts exactly one working day from the compliance expectation", async () => {
    const res = await request(seeded.app.getHttpServer())
      .get(`/timesheets/reports/compliance?startDate=${START}&endDate=${END}`)
      .set("Authorization", `Bearer ${analystToken}`);

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].expectedHours).toBe(152);
  }, 60_000);
});
