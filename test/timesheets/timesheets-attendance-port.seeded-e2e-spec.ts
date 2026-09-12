import { eq } from "drizzle-orm";
import { attendance, orgModules } from "src/db/schema";
import { SEEDED_HARNESS, createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import {
  TIMESHEET_ATTENDANCE_PORT,
  type TimesheetAttendancePort,
} from "src/modules/timesheets/core/attendance/attendance.port";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";

/**
 * The attendance port, resolved from the running application and pointed at
 * real rows.
 *
 * The arithmetic has its own spec with no database in it. Two things only this
 * can answer:
 *
 *   - **Is the port actually bound?** It is fetched from the Nest container by
 *     its token, so a module that declares the interface and forgets to
 *     provide it fails here rather than at the first call site somebody writes.
 *   - **Do the column types survive the trip?** `breaks` is jsonb,
 *     `check_in`/`check_out` come back as `Date` objects rather than the ISO
 *     strings a hand-written fixture uses, and `date` is a `date` column. A
 *     derivation correct on strings and wrong on Dates would pass every unit
 *     test in this repository.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=timesheets-attendance-port
 */

describe(`${SEEDED_HARNESS} timesheet attendance port`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let port: TimesheetAttendancePort;
  let userId = "";

  const at = (day: number, h: number, m = 0) => new Date(Date.UTC(2026, 4, day, h, m));
  const range = { start: "2026-05-01", end: "2026-05-31" };

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb).addMember("clocker").build();
    await seeded.seedDb
      .insert(orgModules)
      .values([
        { orgId: fixture.orgId, moduleKey: "timesheets", enabled: true },
        { orgId: fixture.orgId, moduleKey: "build", enabled: true },
      ])
      .onConflictDoNothing();

    userId = fixture.members["clocker"]!.userId;
    port = seeded.app.get<TimesheetAttendancePort>(TIMESHEET_ATTENDANCE_PORT);

    await seeded.seedDb.insert(attendance).values([
      {
        orgId: fixture.orgId,
        userId,
        date: "2026-05-11",
        checkIn: at(11, 9),
        checkOut: at(11, 17),
        breaks: [{ start: at(11, 13).toISOString(), end: at(11, 13, 30).toISOString() }],
      },
      /** Still open. Must yield no segment: the day is not over. */
      {
        orgId: fixture.orgId,
        userId,
        date: "2026-05-12",
        checkIn: at(12, 9),
        checkOut: null,
        breaks: [],
      },
      {
        orgId: fixture.orgId,
        userId,
        date: "2026-05-13",
        checkIn: at(13, 10),
        checkOut: at(13, 14),
        breaks: [],
        autoCheckedOut: true,
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

  it("is bound in the application container", () => {
    expect(port).toBeDefined();
    expect(typeof port.getClockSegments).toBe("function");
  });

  it("derives net minutes from timestamp columns and jsonb breaks", async () => {
    const segments = await port.getClockSegments(fixture.orgId, userId, range);
    const first = segments.find((s) => s.date === "2026-05-11");

    expect(first).toMatchObject({ breakMinutes: 30, netMinutes: 450 });
  }, 60_000);

  it("omits the day that was never checked out", async () => {
    const segments = await port.getClockSegments(fixture.orgId, userId, range);

    expect(segments.map((s) => s.date)).toEqual(["2026-05-11", "2026-05-13"]);
  }, 60_000);

  it("carries the auto-checkout flag through", async () => {
    const segments = await port.getClockSegments(fixture.orgId, userId, {
      start: "2026-05-13",
      end: "2026-05-13",
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ netMinutes: 240, autoCheckedOut: true });
  }, 60_000);

  it("honours the range rather than returning the whole history", async () => {
    const segments = await port.getClockSegments(fixture.orgId, userId, {
      start: "2026-05-01",
      end: "2026-05-12",
    });

    expect(segments.map((s) => s.date)).toEqual(["2026-05-11"]);
  }, 60_000);

  /** An empty answer is legitimate under the contract, and must not be an error. */
  it("returns nothing, quietly, for someone with no attendance", async () => {
    const segments = await port.getClockSegments(fixture.orgId, "nobody-at-all", range);

    expect(segments).toEqual([]);
  }, 60_000);

  /**
   * The property that makes the `orgId` argument mean something.
   *
   * Asking for organisation A's attendance from inside organisation B's
   * transaction is a bug, and the dangerous version of that bug is the quiet
   * one: RLS would filter every row and the caller would read "no attendance
   * recorded" for somebody who clocks in daily. The adapter refuses instead.
   */
  it("refuses to read one organisation's attendance from inside another's transaction", async () => {
    const other = await seedOrg(seeded.seedDb).addMember("stranger").build();
    const db = seeded.app.get<Db>(DRIZZLE);

    try {
      await expect(
        runInNewTenantTransaction(db, other.orgId, () =>
          port.getClockSegments(fixture.orgId, userId, range),
        ),
      ).rejects.toThrow(/refusing to open a transaction for org/);
    } finally {
      await other.teardown();
    }
  }, 120_000);
});
