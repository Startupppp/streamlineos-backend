import { AttendanceDraftService } from "../attendance-draft.service";
import type { TimesheetAttendancePort } from "../attendance.port";
import type { ClockSegment } from "../lib/clock-segments";
import type { Db } from "../../../../../db/drizzle.module";
import type { EntriesPeriodService } from "../../entries-period.service";
import type { TimesheetsAuditService } from "../../timesheets-audit.service";
import type { CurrentUserContext } from "../../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../../common/auth/principal";

const USER = { orgId: "org-1", userId: "usr-1", principal: humanSessionPrincipal(1, false) } as unknown as CurrentUserContext;
const RANGE = { start: "2026-05-01", end: "2026-05-07" };

const SEGMENT: ClockSegment = {
  date: "2026-05-04",
  startedAt: "2026-05-04T09:00:00.000Z",
  endedAt: "2026-05-04T17:00:00.000Z",
  breakMinutes: 30,
  netMinutes: 450,
  autoCheckedOut: false,
};

interface Inserted {
  values: Record<string, unknown>;
  conflictTarget: unknown;
}

function stubDb(settingsRow: unknown, insertResults: unknown[][]) {
  const inserts: Inserted[] = [];
  const results = [...insertResults];
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (settingsRow ? [settingsRow] : []) }) }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: (conflictTarget: unknown) => ({
          returning: async () => {
            inserts.push({ values, conflictTarget });
            return results.shift() ?? [];
          },
        }),
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  } as unknown as Db;
  return { db, inserts };
}

function stubPort(segments: ClockSegment[]) {
  let calls = 0;
  const port: TimesheetAttendancePort = {
    getClockSegments: async () => {
      calls++;
      return segments;
    },
  };
  return { port, reads: () => calls };
}

const periods = {
  getOrCreatePeriod: async () => 77,
  recomputePeriodTotals: async () => undefined,
} as unknown as EntriesPeriodService;

const audit = { record: async () => undefined } as unknown as TimesheetsAuditService;

describe("AttendanceDraftService", () => {
  it("reads no attendance at all when the policy flag is off", async () => {
    const { db, inserts } = stubDb({ autoDraft: false, workWeekStart: 1 }, []);
    const port = stubPort([SEGMENT]);
    const service = new AttendanceDraftService(db, port.port, periods, audit);

    const result = await service.draftForUser(USER, RANGE);

    expect(result.enabled).toBe(false);
    expect(port.reads()).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it("treats a missing settings row as not opted in", async () => {
    const { db } = stubDb(null, []);
    const port = stubPort([SEGMENT]);
    const service = new AttendanceDraftService(db, port.port, periods, audit);

    expect((await service.draftForUser(USER, RANGE)).enabled).toBe(false);
    expect(port.reads()).toBe(0);
  });

  it("creates one draft entry per completed clock day", async () => {
    const { db, inserts } = stubDb({ autoDraft: true, workWeekStart: 1 }, [[{ id: 5 }]]);
    const service = new AttendanceDraftService(db, stubPort([SEGMENT]).port, periods, audit);

    const result = await service.draftForUser(USER, RANGE);

    expect(result).toMatchObject({
      enabled: true,
      segmentsFound: 1,
      entriesCreated: 1,
      skippedExisting: 0,
    });
    expect(inserts[0]!.values).toMatchObject({
      orgId: "org-1",
      userMembershipId: 1,
      date: "2026-05-04",
      hours: "7.50",
      isBillable: false,
      billingType: "NON_BILLABLE",
      source: "IMPORT",
      timesheetPeriodId: 77,
    });
  });

  it("counts a day the unique index already holds as skipped, not created", async () => {
    const { db } = stubDb({ autoDraft: true, workWeekStart: 1 }, [[]]);
    const service = new AttendanceDraftService(db, stubPort([SEGMENT]).port, periods, audit);

    const result = await service.draftForUser(USER, RANGE);

    expect(result).toMatchObject({ segmentsFound: 1, entriesCreated: 0, skippedExisting: 1 });
  });

  it("names the partial index's predicate on the conflict clause", async () => {
    const { db, inserts } = stubDb({ autoDraft: true, workWeekStart: 1 }, [[{ id: 5 }]]);
    const service = new AttendanceDraftService(db, stubPort([SEGMENT]).port, periods, audit);

    await service.draftForUser(USER, RANGE);

    const target = inserts[0]!.conflictTarget as { target: unknown[]; where?: unknown };
    expect(target.target).toHaveLength(3);
    expect(target.where).toBeDefined();
  });

  it("says in the entry where the number came from, and flags an auto checkout", async () => {
    const { db, inserts } = stubDb({ autoDraft: true, workWeekStart: 1 }, [[{ id: 5 }]]);
    const service = new AttendanceDraftService(
      db,
      stubPort([{ ...SEGMENT, autoCheckedOut: true }]).port,
      periods,
      audit,
    );

    await service.draftForUser(USER, RANGE);

    expect(inserts[0]!.values.description).toBe(
      "Drafted from attendance 09:00–17:00, 30m break (auto checked out)",
    );
  });

  it("skips a segment whose net time rounds to nothing", async () => {
    const { db, inserts } = stubDb({ autoDraft: true, workWeekStart: 1 }, []);
    const service = new AttendanceDraftService(
      db,
      stubPort([{ ...SEGMENT, netMinutes: 0 }]).port,
      periods,
      audit,
    );

    const result = await service.draftForUser(USER, RANGE);

    expect(result).toMatchObject({ segmentsFound: 1, entriesCreated: 0, skippedEmpty: 1 });
    expect(inserts).toHaveLength(0);
  });

  it("refuses a window longer than the cap rather than truncating it", async () => {
    const { db } = stubDb({ autoDraft: true, workWeekStart: 1 }, []);
    const service = new AttendanceDraftService(db, stubPort([]).port, periods, audit);

    await expect(
      service.draftForUser(USER, { start: "2026-01-01", end: "2026-12-31" }),
    ).rejects.toThrow(/at most 62 days/);
  });
});
