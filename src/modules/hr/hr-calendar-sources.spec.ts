import type { CalendarEventProjection, CalendarSourceContext } from "../calendar/calendar-event-source";
import { HrCalendarSource } from "./hr-calendar-source";
import {
  HrAttendanceCalendarSource,
  HrInterviewCalendarSource,
  HrLeaveCalendarSource,
} from "./hr-calendar-sources";

const ctx: CalendarSourceContext = {
  orgId: "org-1",
  userId: "user-1",
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-08-31T23:59:59.999Z"),
  scope: "all",
};

function projection(source: string): CalendarEventProjection {
  return {
    id: source,
    title: source,
    start: ctx.start,
    end: ctx.end,
    allDay: true,
    category: source,
    meta: { source },
  };
}

function buildLegacy() {
  return {
    load: jest.fn().mockResolvedValue([
      projection("leave"),
      projection("interview"),
      projection("attendance"),
    ]),
  } as unknown as HrCalendarSource;
}

function registry() {
  return { register: jest.fn() } as never;
}

describe("granular HR calendar sources", () => {
  it("exposes separate source keys and labels", () => {
    const legacy = buildLegacy();
    const leaves = new HrLeaveCalendarSource(legacy, registry());
    const interviews = new HrInterviewCalendarSource(legacy, registry());
    const attendance = new HrAttendanceCalendarSource(legacy, registry());

    expect([leaves.key, interviews.key, attendance.key]).toEqual([
      "hr-leaves",
      "hr-interviews",
      "hr-attendance",
    ]);
    expect([leaves.label, interviews.label, attendance.label]).toEqual([
      "Leaves",
      "Interviews",
      "Attendance",
    ]);
  });

  it("filters the owning category after the source-owner access logic runs", async () => {
    const legacy = buildLegacy();
    const leaves = new HrLeaveCalendarSource(legacy, registry());
    const interviews = new HrInterviewCalendarSource(legacy, registry());
    const attendance = new HrAttendanceCalendarSource(legacy, registry());

    await expect(leaves.load(ctx)).resolves.toEqual([projection("leave")]);
    await expect(interviews.load(ctx)).resolves.toEqual([projection("interview")]);
    await expect(attendance.load(ctx)).resolves.toEqual([projection("attendance")]);
    expect(legacy.load).toHaveBeenCalledTimes(3);
    expect(legacy.load).toHaveBeenCalledWith(ctx);
  });

  it("registers each source independently so registry preferences can disable one", () => {
    const register = jest.fn();
    const legacy = buildLegacy();
    new HrLeaveCalendarSource(legacy, { register } as never).onModuleInit();
    new HrInterviewCalendarSource(legacy, { register } as never).onModuleInit();
    new HrAttendanceCalendarSource(legacy, { register } as never).onModuleInit();

    expect(register.mock.calls.map(([source]) => (source as { key: string }).key)).toEqual([
      "hr-leaves",
      "hr-interviews",
      "hr-attendance",
    ]);
  });
});
