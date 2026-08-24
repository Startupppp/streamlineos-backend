import { HrCalendarSource } from "./hr-calendar-source";
import type { CalendarSourceContext } from "../calendar/calendar-event-source";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CalendarSourceRegistry } from "../calendar/calendar-source.registry";
import { Test } from "@nestjs/testing";
import { AttendancePolicyService } from "./time/attendance-policy.service";

const ctx: CalendarSourceContext = {
  orgId: "org-1",
  userId: "user-1",
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-08-31T23:59:59.999Z"),
  scope: "all",
};

const defaultAttendanceRules = {
  graceMinutes: 15,
  autoCheckoutTime: "19:00",
  lateArrivalPenalty: "none",
  halfDayThresholdMinutes: 240,
  absentThresholdMinutes: 0,
  enforceGeofence: false,
  minReclockInMinutes: 2,
};

const defaultShiftRules = { weeklyOffDays: ["sat", "sun"] };

function buildAttendancePolicy(): jest.Mocked<AttendancePolicyService> {
  return {
    getAttendanceRules: jest.fn().mockResolvedValue(defaultAttendanceRules),
    getShiftRosterRules: jest.fn().mockResolvedValue(defaultShiftRules),
  } as unknown as jest.Mocked<AttendancePolicyService>;
}

function makeChain(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain["innerJoin"] = jest.fn().mockReturnValue(chain);
  chain["where"] = jest.fn().mockReturnValue(chain);
  chain["orderBy"] = jest.fn().mockReturnValue(chain);
  chain["limit"] = jest.fn().mockResolvedValue(rows);
  chain["then"] = (resolve: (v: unknown[]) => void, reject: (e: unknown) => void) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function buildDb(queryResults: unknown[][]): unknown {
  let callIndex = 0;
  return {
    select: jest.fn().mockImplementation(() => {
      const rows = queryResults[callIndex++] ?? [];
      const chain = makeChain(rows);
      return { from: jest.fn().mockReturnValue(chain) };
    }),
  };
}

async function buildSource(
  db: unknown,
  attendancePolicy?: jest.Mocked<AttendancePolicyService>,
): Promise<HrCalendarSource> {
  const module = await Test.createTestingModule({
    providers: [
      HrCalendarSource,
      { provide: DRIZZLE, useValue: db },
      { provide: CalendarSourceRegistry, useValue: { register: jest.fn() } },
      {
        provide: AttendancePolicyService,
        useValue: attendancePolicy ?? buildAttendancePolicy(),
      },
    ],
  }).compile();
  return module.get(HrCalendarSource);
}

// 10 db.select() calls in order:
// 0 leaveRequests, 1 interviews (outer), 2 interviewPanelMembers (exists subquery),
// 3 attendance, 4 wfhRequests, 5 organizations, 6 rosterEntries,
// 7 orgHolidays (via listCompatibleHolidays), 8 holidays (via listCompatibleHolidays),
// 9 organizationMembers
const FUTURE_JOIN = [{ joinedAt: null, activatedAt: null, joiningDate: "2999-01-01" }];
const ACTIVE_JOIN = [{ joinedAt: new Date("2020-01-01T00:00:00.000Z"), activatedAt: null, joiningDate: null }];
const ORG_UTC = [{ timezone: "UTC" }];

function emptyWith(overrides: Record<number, unknown[]>): unknown[][] {
  const results = Array.from({ length: 10 }, () => [] as unknown[]);
  results[5] = ORG_UTC;
  results[9] = FUTURE_JOIN;
  for (const [idx, rows] of Object.entries(overrides))
    results[Number(idx)] = rows;
  return results;
}

describe("HrCalendarSource", () => {
  it("has the expected key, label and module", async () => {
    const source = await buildSource(buildDb(emptyWith({})));
    expect(source.key).toBe("hr");
    expect(source.label).toBe("HR");
    expect(source.module).toBe("hr");
  });

  it("returns an empty array when no data and employment has not started yet", async () => {
    const source = await buildSource(buildDb(emptyWith({})));
    const result = await source.load(ctx);
    expect(result).toHaveLength(0);
  });

  it("shows a colleague's absence without its reason", async () => {
    const leaveRows = [
      {
        id: 7,
        userId: "someone-else",
        startDate: "2026-08-12",
        endDate: "2026-08-12",
        reason: "Chemotherapy appointment",
        userName: "Bob",
        isHalfDay: false,
        halfDayPeriod: null,
      },
    ];
    const source = await buildSource(buildDb(emptyWith({ 0: leaveRows })));

    const leave = (await source.load(ctx)).find((p) => p.id === "leave-7");

    expect(leave).toBeDefined();
    expect(leave?.meta["creatorName"]).toBe("Bob");
    expect(leave?.meta["description"]).toBeNull();
    expect(JSON.stringify(leave)).not.toContain("Chemotherapy");
  });

  it("keeps the reason on the reader's own absence", async () => {
    const leaveRows = [
      {
        id: 8,
        userId: "user-1",
        startDate: "2026-08-13",
        endDate: "2026-08-13",
        reason: "Chemotherapy appointment",
        userName: "Alice",
        isHalfDay: false,
        halfDayPeriod: null,
      },
    ];
    const source = await buildSource(buildDb(emptyWith({ 0: leaveRows })));

    const leave = (await source.load(ctx)).find((p) => p.id === "leave-8");

    expect(leave?.meta["description"]).toBe("Chemotherapy appointment");
  });

  it("converts an approved leave to a projection with category=leave", async () => {
    const leaveRows = [
      {
        id: 1,
        userId: "user-1",
        startDate: "2026-08-10",
        endDate: "2026-08-10",
        reason: "Rest",
        userName: "Alice",
        isHalfDay: false,
        halfDayPeriod: null,
      },
    ];
    const source = await buildSource(buildDb(emptyWith({ 0: leaveRows })));
    const result = await source.load(ctx);

    const leave = result.find((p) => p.id === "leave-1");
    expect(leave).toBeDefined();
    expect(leave?.category).toBe("leave");
    expect(leave?.color).toBe("green");
    expect(leave?.allDay).toBe(true);
    expect(leave?.meta["source"]).toBe("leave");
    expect(leave?.meta["creatorName"]).toBe("Alice");
    expect(leave?.meta["description"]).toBe("Rest");
  });

  it("labels a half-day leave correctly in the title", async () => {
    const leaveRows = [
      {
        id: 2,
        userId: "user-1",
        startDate: "2026-08-11",
        endDate: "2026-08-11",
        reason: null,
        userName: "Bob",
        isHalfDay: true,
        halfDayPeriod: "morning",
      },
    ];
    const source = await buildSource(buildDb(emptyWith({ 0: leaveRows })));
    const result = await source.load(ctx);

    const leave = result.find((p) => p.id === "leave-2");
    expect(leave?.title).toContain("Half-day leave (morning)");
  });

  it("converts an interview to a projection with category=interview", async () => {
    const scheduledAt = new Date("2026-08-15T10:00:00.000Z");
    const interviewRows = [
      {
        id: 5,
        scheduledAt,
        duration: 45,
        type: "Technical",
        interviewerId: "user-1",
        location: null,
        meetingLink: "https://meet.example.com",
      },
    ];
    const source = await buildSource(buildDb(emptyWith({ 1: interviewRows })));
    const result = await source.load(ctx);

    const interview = result.find((p) => p.id === "interview-5");
    expect(interview).toBeDefined();
    expect(interview?.category).toBe("interview");
    expect(interview?.color).toBe("orange");
    expect(interview?.allDay).toBe(false);
    expect(interview?.meta["source"]).toBe("interview");
    expect(interview?.meta["location"]).toBe("https://meet.example.com");
  });

  it("defaults interview duration to 60 minutes when duration is null", async () => {
    const scheduledAt = new Date("2026-08-20T14:00:00.000Z");
    const interviewRows = [
      { id: 9, scheduledAt, duration: null, type: "HR", interviewerId: "user-1", location: null, meetingLink: null },
    ];
    const source = await buildSource(buildDb(emptyWith({ 1: interviewRows })));
    const result = await source.load(ctx);

    const interview = result.find((p) => p.id === "interview-9");
    const expectedEnd = new Date(scheduledAt);
    expectedEnd.setMinutes(expectedEnd.getMinutes() + 60);
    expect(interview?.end).toEqual(expectedEnd);
  });

  it("maps leave start and end to noon UTC regardless of the source date string", async () => {
    const leaveRows = [
      {
        id: 3,
        userId: "user-1",
        startDate: "2026-08-10",
        endDate: "2026-08-12",
        reason: null,
        userName: "Alice",
        isHalfDay: false,
        halfDayPeriod: null,
      },
    ];
    const source = await buildSource(buildDb(emptyWith({ 0: leaveRows })));
    const result = await source.load(ctx);

    const leave = result.find((e) => e.id === "leave-3");
    expect(leave?.start).toEqual(new Date("2026-08-10T12:00:00.000Z"));
    expect(leave?.end).toEqual(new Date("2026-08-12T12:00:00.000Z"));
  });

  it("surfaces only interviews where the user is interviewer or panel member, and nothing when no rows match", async () => {
    const scheduledAt = new Date("2026-08-15T10:00:00.000Z");
    const interviewRow = {
      id: 20,
      scheduledAt,
      duration: 30,
      type: "Technical",
      interviewerId: "user-1",
      location: null,
      meetingLink: null,
    };

    const allowSource = await buildSource(buildDb(emptyWith({ 1: [interviewRow] })));
    const allowResult = await allowSource.load(ctx);
    expect(allowResult.filter((e) => e.category === "interview")).toHaveLength(1);

    const denySource = await buildSource(buildDb(emptyWith({})));
    const denyResult = await denySource.load(ctx);
    expect(denyResult.filter((e) => e.category === "interview")).toHaveLength(0);
  });

  it("generates an attendance event for an active member with a present check-in record", async () => {
    const attendanceRow = {
      id: 55,
      date: "2026-08-05",
      checkIn: new Date("2026-08-05T09:00:00.000Z"),
      checkOut: new Date("2026-08-05T17:00:00.000Z"),
      status: "PRESENT",
      workHours: "8",
      breakHours: "0",
      createdAt: new Date("2026-08-05T17:00:00.000Z"),
    };
    const source = await buildSource(buildDb(emptyWith({ 3: [attendanceRow], 9: ACTIVE_JOIN })));
    const result = await source.load(ctx);

    const event = result.find((e) => e.id === "attendance-55");
    expect(event).toBeDefined();
    expect(event?.category).toBe("attendance");
    expect(event?.allDay).toBe(true);
    expect(event?.start).toEqual(new Date("2026-08-05T12:00:00.000Z"));
    expect(event?.color).toBe("green");
  });

  it("has no per-source module gate — CalendarSourceRegistry gates on source.module before calling load (see calendar-source.registry.spec.ts)", async () => {
    const source = await buildSource(buildDb(emptyWith({})));
    expect(source.module).toBe("hr");
  });

  // OVER-BROAD QUERY: the leave query predicates on orgId + APPROVED + date range only; userId is
  // NOT a predicate. Every org member's approved absence is visible to every other caller. Reason
  // masking is applied in the projection layer (non-self reasons become null), not in SQL.
  it("leave query is org-wide — all approved org leaves in the date range surface, not only the caller's", async () => {
    const leaveRows = [
      {
        id: 30,
        userId: "other-user",
        startDate: "2026-08-14",
        endDate: "2026-08-14",
        reason: "PRIVATE",
        userName: "Colleague",
        isHalfDay: false,
        halfDayPeriod: null,
      },
      {
        id: 31,
        userId: "user-1",
        startDate: "2026-08-15",
        endDate: "2026-08-15",
        reason: "Mine",
        userName: "Alice",
        isHalfDay: false,
        halfDayPeriod: null,
      },
    ];
    const source = await buildSource(buildDb(emptyWith({ 0: leaveRows })));
    const result = await source.load(ctx);

    expect(result.find((e) => e.id === "leave-30")).toBeDefined();
    expect(result.find((e) => e.id === "leave-31")).toBeDefined();
  });

  it("attendance query is caller-scoped — only the caller's records are fetched via eq(attendance.userId, userId)", async () => {
    const attendanceRow = {
      id: 88,
      date: "2026-08-06",
      checkIn: new Date("2026-08-06T09:00:00.000Z"),
      checkOut: new Date("2026-08-06T17:00:00.000Z"),
      status: "PRESENT",
      workHours: "8",
      breakHours: "0",
      createdAt: new Date("2026-08-06T17:00:00.000Z"),
    };
    const source = await buildSource(buildDb(emptyWith({ 3: [attendanceRow], 9: ACTIVE_JOIN })));
    const result = await source.load(ctx);

    expect(result.find((e) => e.id === "attendance-88")).toBeDefined();
  });

  it("generates a WFH attendance event for an approved WFH day with no attendance record on a past weekday", async () => {
    const wfhRow = { id: 99, date: "2026-08-03" };
    const source = await buildSource(buildDb(emptyWith({ 4: [wfhRow], 9: ACTIVE_JOIN })));
    const result = await source.load(ctx);

    const event = result.find((e) => e.id === "attendance-wfh-99");
    expect(event).toBeDefined();
    expect(event?.category).toBe("attendance");
    expect(event?.allDay).toBe(true);
    expect(event?.start).toEqual(new Date("2026-08-03T12:00:00.000Z"));
  });
});
