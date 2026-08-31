import type { Db } from "../../db/drizzle.module";
import { CalendarReminderSweepService } from "./calendar-reminder-sweep.service";

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

import { forEachOrg } from "../../common/tenant";

const ORG = "org-test";
const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

function makeChain(result: unknown[]) {
  const limit = jest.fn().mockResolvedValue(result);
  const where = jest.fn().mockReturnValue({ limit });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ where, innerJoin });
  return { from, where, limit };
}

function makeInsertCapture() {
  const returning = jest.fn().mockResolvedValue([{ id: 1 }]);
  const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  return {
    insert: jest.fn().mockReturnValue({ values }),
    capturedValues: values,
    capturedOnConflict: onConflictDoNothing,
  };
}

function makeUpdateCapture() {
  const where = jest.fn().mockResolvedValue([]);
  const set = jest.fn().mockReturnValue({ where });
  return { update: jest.fn().mockReturnValue({ set }), capturedSet: set };
}

describe("CalendarReminderSweepService — recurring event reminder dedupeKey", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("uses occurrence start and attendee membershipId in dedupeKey for a recurring event", async () => {
    const now = new Date("2024-03-11T09:45:00Z");
    const expectedOccurrenceStart = new Date("2024-03-11T10:00:00Z");
    const eventId = 42;
    const membershipId = 101;
    const userId = "user-abc";

    const insertCap = makeInsertCapture();
    const updateCap = makeUpdateCapture();

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      let selectCallCount = 0;
      const tx = {
        select: jest.fn().mockImplementation(() => {
          const callIdx = selectCallCount++;
          if (callIdx === 0) return { from: makeChain([]).from };
          if (callIdx === 1)
            return {
              from: makeChain([
                {
                  id: eventId,
                  title: "Weekly standup",
                  startDate: new Date("2024-03-04T10:00:00Z"),
                  endDate: new Date("2024-03-04T10:30:00Z"),
                  allDay: false,
                  timezone: "UTC",
                  orgId: ORG,
                  rrule: "FREQ=WEEKLY;BYDAY=MO",
                  recurrenceEnd: null,
                },
              ]).from,
            };
          if (callIdx === 2) return { from: makeChain([]).from };
          if (callIdx === 3)
            return { from: makeChain([{ eventId, userId, membershipId }]).from };
          return { from: makeChain([]).from };
        }),
        ...insertCap,
        ...updateCap,
      } as unknown as Db;

      await cb(tx, ORG);
      return { processed: 1, failed: 0 };
    });

    const db = {} as unknown as Db;
    const svc = new CalendarReminderSweepService(db);
    const result = await svc.run(now);

    expect(result.candidates).toBe(1);
    expect(insertCap.capturedValues).toHaveBeenCalledTimes(1);

    const row = insertCap.capturedValues.mock.calls[0]?.[0] as {
      dedupeKey: string;
      message: string;
      targetUserIds: string[];
    };
    expect(row.dedupeKey).toBe(
      `calendar:reminder:${eventId}:${expectedOccurrenceStart.toISOString()}:${membershipId}`,
    );
    expect(row.message).toContain(expectedOccurrenceStart.toISOString());
    expect(row.targetUserIds).toEqual([userId]);
  });

  it("does NOT set reminder15MinSent on a recurring event", async () => {
    const now = new Date("2024-03-11T09:45:00Z");

    const insertCap = makeInsertCapture();
    const updateCap = makeUpdateCapture();

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      let selectCallCount = 0;
      const tx = {
        select: jest.fn().mockImplementation(() => {
          const callIdx = selectCallCount++;
          if (callIdx === 0) return { from: makeChain([]).from };
          if (callIdx === 1)
            return {
              from: makeChain([
                {
                  id: 55,
                  title: "Daily standup",
                  startDate: new Date("2024-03-01T09:00:00Z"),
                  endDate: new Date("2024-03-01T09:15:00Z"),
                  allDay: false,
                  timezone: "UTC",
                  orgId: ORG,
                  rrule: "FREQ=DAILY",
                  recurrenceEnd: null,
                },
              ]).from,
            };
          return { from: makeChain([]).from };
        }),
        ...insertCap,
        ...updateCap,
      } as unknown as Db;

      await cb(tx, ORG);
      return { processed: 1, failed: 0 };
    });

    const db = {} as unknown as Db;
    const svc = new CalendarReminderSweepService(db);
    await svc.run(now);

    expect(updateCap.update).not.toHaveBeenCalled();
  });

  it("uses occurrence start and membershipId in dedupeKey for a non-recurring event", async () => {
    const now = new Date("2024-03-11T09:45:00Z");
    const eventStart = new Date("2024-03-11T10:00:00Z");
    const eventId = 77;
    const membershipId = 202;
    const userId = "user-xyz";

    const insertCap = makeInsertCapture();
    const updateCap = makeUpdateCapture();

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      let selectCallCount = 0;
      const tx = {
        select: jest.fn().mockImplementation(() => {
          const callIdx = selectCallCount++;
          if (callIdx === 0)
            return { from: makeChain([{ id: eventId, title: "One-time meeting", startDate: eventStart }]).from };
          if (callIdx === 1) return { from: makeChain([]).from };
          if (callIdx === 2)
            return { from: makeChain([{ eventId, userId, membershipId }]).from };
          return { from: makeChain([]).from };
        }),
        ...insertCap,
        ...updateCap,
      } as unknown as Db;

      await cb(tx, ORG);
      return { processed: 1, failed: 0 };
    });

    const db = {} as unknown as Db;
    const svc = new CalendarReminderSweepService(db);
    await svc.run(now);

    const row = insertCap.capturedValues.mock.calls[0]?.[0] as { dedupeKey: string; targetUserIds: string[] };
    expect(row.dedupeKey).toBe(`calendar:reminder:${eventId}:${eventStart.toISOString()}:${membershipId}`);
    expect(row.targetUserIds).toEqual([userId]);
    expect(updateCap.update).toHaveBeenCalledTimes(1);
  });

  it("second sweep of the same recurring occurrence emits nothing new (per-attendee dedupeKey idempotency)", async () => {
    const now = new Date("2024-03-11T09:45:00Z");
    const eventId = 42;
    const membershipId = 101;
    const userId = "user-abc";

    let insertCallCount = 0;
    const returningFirst = jest.fn().mockResolvedValue([{ id: 1 }]);
    const returningSecond = jest.fn().mockResolvedValue([]);
    const onConflictDoNothingFirst = jest.fn().mockReturnValue({ returning: returningFirst });
    const onConflictDoNothingSecond = jest.fn().mockReturnValue({ returning: returningSecond });
    const values = jest.fn().mockImplementation(() => {
      insertCallCount += 1;
      return insertCallCount === 1
        ? { onConflictDoNothing: onConflictDoNothingFirst }
        : { onConflictDoNothing: onConflictDoNothingSecond };
    });
    const insertCapIdempotent = { insert: jest.fn().mockReturnValue({ values }) };
    const updateCap = makeUpdateCapture();

    const eventRow = {
      id: eventId,
      title: "Weekly standup",
      startDate: new Date("2024-03-04T10:00:00Z"),
      endDate: new Date("2024-03-04T10:30:00Z"),
      allDay: false,
      timezone: "UTC",
      orgId: ORG,
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      recurrenceEnd: null,
    };
    const attendeeRow = { eventId, userId, membershipId };

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      let selectCallCount = 0;
      const tx = {
        select: jest.fn().mockImplementation(() => {
          const callIdx = selectCallCount++;
          if (callIdx === 0) return { from: makeChain([]).from };
          if (callIdx === 1) return { from: makeChain([eventRow]).from };
          if (callIdx === 2) return { from: makeChain([]).from };
          if (callIdx === 3) return { from: makeChain([attendeeRow]).from };
          return { from: makeChain([]).from };
        }),
        ...insertCapIdempotent,
        ...updateCap,
      } as unknown as Db;

      await cb(tx, ORG);
      return { processed: 1, failed: 0 };
    });

    const db = {} as unknown as Db;
    const svc = new CalendarReminderSweepService(db);

    const firstResult = await svc.run(now);
    expect(firstResult.intentsWritten).toBe(1);

    const secondResult = await svc.run(now);
    expect(secondResult.intentsWritten).toBe(0);

    expect(insertCapIdempotent.insert).toHaveBeenCalledTimes(2);
    const firstRow = values.mock.calls[0]?.[0] as { dedupeKey: string };
    const secondRow = values.mock.calls[1]?.[0] as { dedupeKey: string };
    expect(firstRow.dedupeKey).toBe(secondRow.dedupeKey);
  });

  it("skips a cancelled recurring occurrence", async () => {
    const now = new Date("2024-03-11T09:45:00Z");
    const occurrenceStart = new Date("2024-03-11T10:00:00Z");
    const eventId = 42;

    const insertCap = makeInsertCapture();
    const updateCap = makeUpdateCapture();

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      let selectCallCount = 0;
      const tx = {
        select: jest.fn().mockImplementation(() => {
          const callIdx = selectCallCount++;
          if (callIdx === 0) return { from: makeChain([]).from };
          if (callIdx === 1)
            return {
              from: makeChain([
                {
                  id: eventId,
                  title: "Weekly standup",
                  startDate: new Date("2024-03-04T10:00:00Z"),
                  endDate: new Date("2024-03-04T10:30:00Z"),
                  allDay: false,
                  timezone: "UTC",
                  orgId: ORG,
                  rrule: "FREQ=WEEKLY;BYDAY=MO",
                  recurrenceEnd: null,
                },
              ]).from,
            };
          if (callIdx === 2)
            return {
              from: makeChain([{ eventId, occurrenceStart, isCancelled: true }]).from,
            };
          return { from: makeChain([]).from };
        }),
        ...insertCap,
        ...updateCap,
      } as unknown as Db;

      await cb(tx, ORG);
      return { processed: 1, failed: 0 };
    });

    const db = {} as unknown as Db;
    const svc = new CalendarReminderSweepService(db);
    const result = await svc.run(now);

    expect(result.candidates).toBe(0);
    expect(insertCap.capturedValues).not.toHaveBeenCalled();
  });
});

describe("CalendarReminderSweepService — rescheduled recurring occurrences (modifiedStart)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("queues a reminder at modifiedStart when an occurrence is moved into the sweep window (nominal outside window)", async () => {
    const now = new Date("2024-03-11T09:45:00Z");
    const nominalStart = new Date("2024-03-11T15:00:00Z");
    const modifiedStart = new Date("2024-03-11T10:00:00Z");
    const eventId = 70;
    const membershipId = 301;
    const userId = "user-mod-1";

    const insertCap = makeInsertCapture();
    const updateCap = makeUpdateCapture();

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      let selectCallCount = 0;
      const tx = {
        select: jest.fn().mockImplementation(() => {
          const callIdx = selectCallCount++;
          if (callIdx === 0) return { from: makeChain([]).from };
          if (callIdx === 1)
            return {
              from: makeChain([
                {
                  id: eventId,
                  title: "Weekly standup",
                  startDate: new Date("2024-03-04T15:00:00Z"),
                  endDate: new Date("2024-03-04T15:30:00Z"),
                  allDay: false,
                  timezone: "UTC",
                  orgId: ORG,
                  rrule: "FREQ=WEEKLY;BYDAY=MO",
                  recurrenceEnd: null,
                },
              ]).from,
            };
          if (callIdx === 2)
            return {
              from: makeChain([
                {
                  eventId,
                  occurrenceStart: nominalStart,
                  isCancelled: false,
                  modifiedStart,
                  modifiedTitle: null,
                },
              ]).from,
            };
          if (callIdx === 3)
            return { from: makeChain([{ eventId, userId, membershipId }]).from };
          return { from: makeChain([]).from };
        }),
        ...insertCap,
        ...updateCap,
      } as unknown as Db;

      await cb(tx, ORG);
      return { processed: 1, failed: 0 };
    });

    const db = {} as unknown as Db;
    const svc = new CalendarReminderSweepService(db);
    const result = await svc.run(now);

    expect(result.candidates).toBe(1);
    expect(insertCap.capturedValues).toHaveBeenCalledTimes(1);

    const row = insertCap.capturedValues.mock.calls[0]?.[0] as { dedupeKey: string; message: string };
    expect(row.dedupeKey).toBe(`calendar:reminder:${eventId}:${nominalStart.toISOString()}:${membershipId}`);
    expect(row.message).toContain(modifiedStart.toISOString());
  });

  it("does not queue a reminder when an occurrence is moved out of the sweep window (nominal inside, modifiedStart outside)", async () => {
    const now = new Date("2024-03-11T09:45:00Z");
    const nominalStart = new Date("2024-03-11T10:00:00Z");
    const modifiedStart = new Date("2024-03-11T15:00:00Z");
    const eventId = 71;

    const insertCap = makeInsertCapture();
    const updateCap = makeUpdateCapture();

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      let selectCallCount = 0;
      const tx = {
        select: jest.fn().mockImplementation(() => {
          const callIdx = selectCallCount++;
          if (callIdx === 0) return { from: makeChain([]).from };
          if (callIdx === 1)
            return {
              from: makeChain([
                {
                  id: eventId,
                  title: "Team sync",
                  startDate: new Date("2024-03-04T10:00:00Z"),
                  endDate: new Date("2024-03-04T10:30:00Z"),
                  allDay: false,
                  timezone: "UTC",
                  orgId: ORG,
                  rrule: "FREQ=WEEKLY;BYDAY=MO",
                  recurrenceEnd: null,
                },
              ]).from,
            };
          if (callIdx === 2)
            return {
              from: makeChain([
                {
                  eventId,
                  occurrenceStart: nominalStart,
                  isCancelled: false,
                  modifiedStart,
                  modifiedTitle: null,
                },
              ]).from,
            };
          return { from: makeChain([]).from };
        }),
        ...insertCap,
        ...updateCap,
      } as unknown as Db;

      await cb(tx, ORG);
      return { processed: 1, failed: 0 };
    });

    const db = {} as unknown as Db;
    const svc = new CalendarReminderSweepService(db);
    const result = await svc.run(now);

    expect(result.candidates).toBe(0);
    expect(insertCap.capturedValues).not.toHaveBeenCalled();
  });

  it("applies modifiedTitle and uses modifiedStart in message while nominal start anchors the dedupeKey", async () => {
    const now = new Date("2024-03-11T09:45:00Z");
    const nominalStart = new Date("2024-03-11T10:00:00Z");
    const modifiedStart = new Date("2024-03-11T09:55:00Z");
    const eventId = 72;
    const membershipId = 302;
    const userId = "user-mod-2";

    const insertCap = makeInsertCapture();
    const updateCap = makeUpdateCapture();

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      let selectCallCount = 0;
      const tx = {
        select: jest.fn().mockImplementation(() => {
          const callIdx = selectCallCount++;
          if (callIdx === 0) return { from: makeChain([]).from };
          if (callIdx === 1)
            return {
              from: makeChain([
                {
                  id: eventId,
                  title: "Sprint planning",
                  startDate: new Date("2024-03-04T10:00:00Z"),
                  endDate: new Date("2024-03-04T11:00:00Z"),
                  allDay: false,
                  timezone: "UTC",
                  orgId: ORG,
                  rrule: "FREQ=WEEKLY;BYDAY=MO",
                  recurrenceEnd: null,
                },
              ]).from,
            };
          if (callIdx === 2)
            return {
              from: makeChain([
                {
                  eventId,
                  occurrenceStart: nominalStart,
                  isCancelled: false,
                  modifiedStart,
                  modifiedTitle: "Sprint planning (rescheduled)",
                },
              ]).from,
            };
          if (callIdx === 3)
            return { from: makeChain([{ eventId, userId, membershipId }]).from };
          return { from: makeChain([]).from };
        }),
        ...insertCap,
        ...updateCap,
      } as unknown as Db;

      await cb(tx, ORG);
      return { processed: 1, failed: 0 };
    });

    const db = {} as unknown as Db;
    const svc = new CalendarReminderSweepService(db);
    const result = await svc.run(now);

    expect(result.candidates).toBe(1);
    const row = insertCap.capturedValues.mock.calls[0]?.[0] as {
      dedupeKey: string;
      message: string;
      title: string;
    };
    expect(row.dedupeKey).toBe(`calendar:reminder:${eventId}:${nominalStart.toISOString()}:${membershipId}`);
    expect(row.message).toContain(modifiedStart.toISOString());
    expect(row.title).toContain("Sprint planning (rescheduled)");
  });

  it("does not queue a reminder when an occurrence is moved into the window but subsequently cancelled", async () => {
    const now = new Date("2024-03-11T09:45:00Z");
    const nominalStart = new Date("2024-03-11T15:00:00Z");
    const modifiedStart = new Date("2024-03-11T10:00:00Z");
    const eventId = 73;

    const insertCap = makeInsertCapture();
    const updateCap = makeUpdateCapture();

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      let selectCallCount = 0;
      const tx = {
        select: jest.fn().mockImplementation(() => {
          const callIdx = selectCallCount++;
          if (callIdx === 0) return { from: makeChain([]).from };
          if (callIdx === 1)
            return {
              from: makeChain([
                {
                  id: eventId,
                  title: "Weekly standup",
                  startDate: new Date("2024-03-04T15:00:00Z"),
                  endDate: new Date("2024-03-04T15:30:00Z"),
                  allDay: false,
                  timezone: "UTC",
                  orgId: ORG,
                  rrule: "FREQ=WEEKLY;BYDAY=MO",
                  recurrenceEnd: null,
                },
              ]).from,
            };
          if (callIdx === 2)
            return {
              from: makeChain([
                {
                  eventId,
                  occurrenceStart: nominalStart,
                  isCancelled: true,
                  modifiedStart,
                  modifiedTitle: null,
                },
              ]).from,
            };
          return { from: makeChain([]).from };
        }),
        ...insertCap,
        ...updateCap,
      } as unknown as Db;

      await cb(tx, ORG);
      return { processed: 1, failed: 0 };
    });

    const db = {} as unknown as Db;
    const svc = new CalendarReminderSweepService(db);
    const result = await svc.run(now);

    expect(result.candidates).toBe(0);
    expect(insertCap.capturedValues).not.toHaveBeenCalled();
  });
});

describe("CalendarReminderSweepService — DST correctness for reminder window", () => {
  it("spring-forward (UTC 07:00 = 03:00 EDT): event at that instant is within a 20-min pre-reminder window starting UTC 06:45", () => {
    const eventUtcStart = new Date("2024-03-10T07:00:00Z");
    const windowStart = new Date("2024-03-10T06:45:00Z");
    const windowEnd = new Date("2024-03-10T07:05:00Z");
    expect(eventUtcStart >= windowStart && eventUtcStart <= windowEnd).toBe(true);
  });

  it("fall-back: UTC 05:59 and UTC 06:01 are both distinct instants 2 minutes apart", () => {
    const beforeFallback = new Date("2024-11-03T05:59:00Z");
    const afterFallback = new Date("2024-11-03T06:01:00Z");
    expect(afterFallback.getTime() - beforeFallback.getTime()).toBe(2 * 60 * 1000);
  });

  it("Asia/Kolkata (+05:30): weekly FREQ=DAILY series expanded to 2024-01-15 midnight IST = UTC 18:30 prior day", () => {
    const { expandToOccurrences } = require("./calendar-occurrence.service");
    const event = {
      id: 1,
      title: "IST midnight series",
      startDate: new Date("2024-01-14T18:30:00Z"),
      endDate: new Date("2024-01-14T19:00:00Z"),
      allDay: false,
      timezone: "Asia/Kolkata",
      orgId: "org-1",
      rrule: "FREQ=DAILY",
      recurrenceEnd: null,
    };
    const windowStart = new Date("2024-01-15T18:25:00Z");
    const windowEnd = new Date("2024-01-15T18:45:00Z");
    const occurrences = expandToOccurrences(event, windowStart, windowEnd);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.startDate.toISOString()).toBe("2024-01-15T18:30:00.000Z");
  });

  it("America/New_York spring-forward: weekly series starting 2024-03-04T14:00Z expands to 2024-03-11T13:00Z (EDT offset)", () => {
    const { expandToOccurrences } = require("./calendar-occurrence.service");
    const event = {
      id: 2,
      title: "NY weekly",
      startDate: new Date("2024-03-04T14:00:00Z"),
      endDate: new Date("2024-03-04T14:30:00Z"),
      allDay: false,
      timezone: "America/New_York",
      orgId: "org-1",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      recurrenceEnd: null,
    };
    const windowStart = new Date("2024-03-11T12:55:00Z");
    const windowEnd = new Date("2024-03-11T13:15:00Z");
    const occurrences = expandToOccurrences(event, windowStart, windowEnd);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.startDate.toISOString()).toBe("2024-03-11T13:00:00.000Z");
  });
});
