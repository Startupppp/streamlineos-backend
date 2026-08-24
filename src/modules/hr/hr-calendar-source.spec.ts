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
});
