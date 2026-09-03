import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  expandToOccurrences,
  type CalendarEventLike,
  type CalendarEventException,
} from "./calendar-occurrence.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();
function renderCond(cond: unknown) {
  return dialect.sqlToQuery(cond as SQL);
}

const ORG = "org-exception-scope";
const USER = "user-owner";
const MEMBER_ID = 7;
const EVENT_ID = 50;
const OCCURRENCE_ISO = "2024-06-03T10:00:00.000Z";

function makeWeeklyEvent(overrides: Partial<CalendarEventLike> = {}): CalendarEventLike {
  return {
    id: EVENT_ID,
    title: "Weekly standup",
    startDate: new Date("2024-05-27T10:00:00Z"),
    endDate: new Date("2024-05-27T10:30:00Z"),
    allDay: false,
    timezone: "UTC",
    orgId: ORG,
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    recurrenceEnd: null,
    ...overrides,
  };
}

function makeOwnerDb(memberRow: { id: number } | null, eventRow: unknown) {
  const limit = jest.fn().mockResolvedValue(eventRow ? [eventRow] : []);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  return {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(memberRow),
      },
    },
    select: jest.fn().mockReturnValue({ from }),
  };
}

describe("expandToOccurrences — cancelled exception filters out the occurrence", () => {
  const windowStart = new Date("2024-06-02T00:00:00Z");
  const windowEnd = new Date("2024-06-10T00:00:00Z");
  const occurrenceStart = new Date(OCCURRENCE_ISO);

  const cancelledEx: CalendarEventException = {
    occurrenceStart,
    isCancelled: true,
  };

  it("WITH cancelled exception: the occurrence is absent from the expansion", () => {
    const event = makeWeeklyEvent();
    const results = expandToOccurrences(event, windowStart, windowEnd, [cancelledEx]);
    const starts = results.map((o) => o.startDate.toISOString());
    expect(starts).not.toContain(occurrenceStart.toISOString());
  });

  it("BITE PROOF: WITHOUT the cancelled exception the occurrence IS present (the filter is the gate)", () => {
    const event = makeWeeklyEvent();
    const results = expandToOccurrences(event, windowStart, windowEnd, []);
    const starts = results.map((o) => o.startDate.toISOString());
    expect(starts).toContain(occurrenceStart.toISOString());
  });

  it("a non-cancelled (isCancelled: false) exception for the same occurrence still includes it", () => {
    const event = makeWeeklyEvent();
    const modifiedEx: CalendarEventException = {
      occurrenceStart,
      isCancelled: false,
      modifiedTitle: "Rescheduled standup",
    };
    const results = expandToOccurrences(event, windowStart, windowEnd, [modifiedEx]);
    const titles = results.map((o) => o.title);
    expect(titles).toContain("Rescheduled standup");
  });
});

describe("expandToOccurrences — modified exception replaces occurrence fields", () => {
  const windowStart = new Date("2024-06-02T00:00:00Z");
  const windowEnd = new Date("2024-06-10T00:00:00Z");
  const occurrenceStart = new Date(OCCURRENCE_ISO);

  it("modifiedTitle replaces the event title for only that occurrence", () => {
    const event = makeWeeklyEvent();
    const ex: CalendarEventException = {
      occurrenceStart,
      isCancelled: false,
      modifiedTitle: "Emergency sync",
    };
    const results = expandToOccurrences(event, windowStart, windowEnd, [ex]);
    const occ = results.find((o) => o.startDate.getTime() === occurrenceStart.getTime());
    expect(occ).toBeDefined();
    expect(occ!.title).toBe("Emergency sync");
    const otherOccs = results.filter((o) => o.startDate.getTime() !== occurrenceStart.getTime());
    for (const other of otherOccs)
      expect(other.title).toBe("Weekly standup");
  });

  it("modifiedStart replaces the occurrence startDate", () => {
    const event = makeWeeklyEvent();
    const modifiedStart = new Date("2024-06-03T14:00:00Z");
    const ex: CalendarEventException = {
      occurrenceStart,
      isCancelled: false,
      modifiedStart,
    };
    const results = expandToOccurrences(event, windowStart, windowEnd, [ex]);
    const occ = results.find((o) => o.startDate.toISOString() === modifiedStart.toISOString());
    expect(occ).toBeDefined();
  });

  it("BITE PROOF: without an exception the occurrence keeps original title (confirms the title replacement mechanism)", () => {
    const event = makeWeeklyEvent();
    const results = expandToOccurrences(event, windowStart, windowEnd, []);
    const occ = results.find((o) => o.startDate.getTime() === occurrenceStart.getTime());
    expect(occ).toBeDefined();
    expect(occ!.title).toBe("Weekly standup");
  });
});

describe("CalendarRecurrenceService.cancelOccurrence — exception row only, series event untouched", () => {
  beforeEach(() => jest.resetAllMocks());

  it("returns a row with isCancelled: true and does NOT call delete on any table", async () => {
    const returnedRow = { id: 10, eventId: EVENT_ID, isCancelled: true };
    const returning = jest.fn().mockResolvedValue([returnedRow]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insertFn = jest.fn().mockReturnValue({ values });

    const updateWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const updateFn = jest.fn().mockReturnValue({ set: updateSet });

    const deleteFn = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });

    const db = {
      ...makeOwnerDb({ id: MEMBER_ID }, { createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=MO" }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ insert: insertFn, update: updateFn, delete: deleteFn }),
      ),
    };

    const svc = new CalendarRecurrenceService(db as unknown as Db);
    const result = await svc.cancelOccurrence(ORG, USER, EVENT_ID, OCCURRENCE_ISO);

    expect(result).toBeDefined();
    expect(result).toMatchObject({ isCancelled: true });
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("the insert values carry isCancelled: true, not the shape of a calendar_events row", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: 11, isCancelled: true }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const capturedValues = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insertFn = jest.fn().mockReturnValue({ values: capturedValues });

    const updateWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const updateFn = jest.fn().mockReturnValue({ set: updateSet });

    const db = {
      ...makeOwnerDb({ id: MEMBER_ID }, { createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=MO" }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ insert: insertFn, update: updateFn }),
      ),
    };

    const svc = new CalendarRecurrenceService(db as unknown as Db);
    await svc.cancelOccurrence(ORG, USER, EVENT_ID, OCCURRENCE_ISO);

    expect(insertFn).toHaveBeenCalledTimes(1);
    const insertPayload = capturedValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload).toBeDefined();
    expect(insertPayload["isCancelled"]).toBe(true);
    expect(insertPayload["eventId"]).toBe(EVENT_ID);
    expect("rrule" in insertPayload).toBe(false);
    expect("title" in insertPayload).toBe(false);
  });
});

describe("CalendarRecurrenceService.upsertOccurrenceException — series rrule is NOT modified", () => {
  beforeEach(() => jest.resetAllMocks());

  it("insert payload has isCancelled: false and does not contain rrule — exception row only", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: 20 }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const capturedValues = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insertFn = jest.fn().mockReturnValue({ values: capturedValues });

    const updateWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const updateFn = jest.fn().mockReturnValue({ set: updateSet });

    const db = {
      ...makeOwnerDb({ id: MEMBER_ID }, { createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=MO" }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ insert: insertFn, update: updateFn }),
      ),
    };

    const svc = new CalendarRecurrenceService(db as unknown as Db);
    const result = await svc.upsertOccurrenceException(ORG, USER, EVENT_ID, OCCURRENCE_ISO, {
      modifiedTitle: "One-off title",
      modifiedStart: "2024-06-03T14:00:00Z",
      modifiedEnd: "2024-06-03T14:30:00Z",
    });

    expect(result).toBeDefined();

    expect(insertFn).toHaveBeenCalledTimes(1);
    const insertPayload = capturedValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload).toBeDefined();
    expect(insertPayload["isCancelled"]).toBe(false);
    expect(insertPayload["modifiedTitle"]).toBe("One-off title");
    expect("rrule" in insertPayload).toBe(false);
    expect("title" in insertPayload).toBe(false);

    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({ state: "DEAD" });
  });

  it("no update is issued when modifiedStart is absent (title-only edit, no reminder to kill)", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: 21 }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const capturedValues = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insertFn = jest.fn().mockReturnValue({ values: capturedValues });

    const updateFn = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) });

    const db = {
      ...makeOwnerDb({ id: MEMBER_ID }, { createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=MO" }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ insert: insertFn, update: updateFn }),
      ),
    };

    const svc = new CalendarRecurrenceService(db as unknown as Db);
    await svc.upsertOccurrenceException(ORG, USER, EVENT_ID, OCCURRENCE_ISO, {
      modifiedTitle: "Renamed",
    });

    expect(insertFn).toHaveBeenCalledTimes(1);
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("BITE PROOF: when the caller is not the event owner, the transaction is skipped entirely (gate is real)", async () => {
    const txSpy = jest.fn();
    const db = {
      ...makeOwnerDb(null, null),
      transaction: txSpy,
    };

    const svc = new CalendarRecurrenceService(db as unknown as Db);
    const result = await svc.upsertOccurrenceException(ORG, USER, EVENT_ID, OCCURRENCE_ISO, {
      modifiedTitle: "Should not reach",
    });

    expect(result).toBeNull();
    expect(txSpy).not.toHaveBeenCalled();
  });
});

describe("CalendarRecurrenceService — getRecurringEventForOwner blocks non-recurring events", () => {
  beforeEach(() => jest.resetAllMocks());

  it("cancelOccurrence returns null for a non-recurring event (rrule is null)", async () => {
    const txSpy = jest.fn();
    const db = {
      ...makeOwnerDb({ id: MEMBER_ID }, { createdByMembershipId: MEMBER_ID, rrule: null }),
      transaction: txSpy,
    };

    const svc = new CalendarRecurrenceService(db as unknown as Db);
    const result = await svc.cancelOccurrence(ORG, USER, EVENT_ID, OCCURRENCE_ISO);

    expect(result).toBeNull();
    expect(txSpy).not.toHaveBeenCalled();
  });

  it("BITE PROOF: with a non-null rrule, the transaction IS invoked (the rrule check is the gate)", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: 30, isCancelled: true }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insertFn = jest.fn().mockReturnValue({ values });
    const updateWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const updateFn = jest.fn().mockReturnValue({ set: updateSet });

    const txSpy = jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ insert: insertFn, update: updateFn }),
    );

    const db = {
      ...makeOwnerDb({ id: MEMBER_ID }, { createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=MO" }),
      transaction: txSpy,
    };

    const svc = new CalendarRecurrenceService(db as unknown as Db);
    await svc.cancelOccurrence(ORG, USER, EVENT_ID, OCCURRENCE_ISO);

    expect(txSpy).toHaveBeenCalledTimes(1);
  });

  it("upsertOccurrenceException also returns null for a non-recurring event", async () => {
    const txSpy = jest.fn();
    const db = {
      ...makeOwnerDb({ id: MEMBER_ID }, { createdByMembershipId: MEMBER_ID, rrule: null }),
      transaction: txSpy,
    };

    const svc = new CalendarRecurrenceService(db as unknown as Db);
    const result = await svc.upsertOccurrenceException(ORG, USER, EVENT_ID, OCCURRENCE_ISO, {
      modifiedTitle: "Should not be created",
    });

    expect(result).toBeNull();
    expect(txSpy).not.toHaveBeenCalled();
  });
});

describe("CalendarRecurrenceService.cancelOccurrence — reminder kill targets the exact occurrence dedupeKey", () => {
  beforeEach(() => jest.resetAllMocks());

  it("the WHERE condition for the outbox update contains the occurrence ISO LIKE prefix covering per-attendee keys", async () => {
    const occurrenceStart = new Date(OCCURRENCE_ISO);
    const expectedLikePrefix = `calendar:reminder:${EVENT_ID}:${occurrenceStart.toISOString()}%`;

    const returning = jest.fn().mockResolvedValue([{ id: 40, isCancelled: true }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insertFn = jest.fn().mockReturnValue({ values });

    const updateWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const updateFn = jest.fn().mockReturnValue({ set: updateSet });

    const db = {
      ...makeOwnerDb({ id: MEMBER_ID }, { createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=MO" }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ insert: insertFn, update: updateFn }),
      ),
    };

    const svc = new CalendarRecurrenceService(db as unknown as Db);
    await svc.cancelOccurrence(ORG, USER, EVENT_ID, OCCURRENCE_ISO);

    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({ state: "DEAD" });

    const whereCond = updateWhere.mock.calls[0]?.[0];
    const { params } = renderCond(whereCond);
    expect(params).toContain(expectedLikePrefix);
    expect(params).toContain("PENDING");
    expect(params).toContain(ORG);
  });

  it("BITE PROOF: a different occurrence ISO LIKE prefix is NOT in the WHERE params — the kill is occurrence-specific", async () => {
    const differentKey = `calendar:reminder:${EVENT_ID}:2024-06-10T10:00:00.000Z%`;

    const returning = jest.fn().mockResolvedValue([{ id: 41, isCancelled: true }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insertFn = jest.fn().mockReturnValue({ values });

    const updateWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const updateFn = jest.fn().mockReturnValue({ set: updateSet });

    const db = {
      ...makeOwnerDb({ id: MEMBER_ID }, { createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=MO" }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ insert: insertFn, update: updateFn }),
      ),
    };

    const svc = new CalendarRecurrenceService(db as unknown as Db);
    await svc.cancelOccurrence(ORG, USER, EVENT_ID, OCCURRENCE_ISO);

    const whereCond = updateWhere.mock.calls[0]?.[0];
    const { params } = renderCond(whereCond);
    expect(params).not.toContain(differentKey);
  });

  it("BITE PROOF: with a non-invoking transaction mock, the outbox update is never executed", async () => {
    const updateWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const updateFn = jest.fn().mockReturnValue({ set: updateSet });
    const insertFn = jest.fn();

    const db = {
      ...makeOwnerDb({ id: MEMBER_ID }, { createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=MO" }),
      insert: insertFn,
      update: updateFn,
      transaction: jest.fn().mockResolvedValue([]),
    };

    const svc = new CalendarRecurrenceService(db as unknown as Db);
    const result = await svc.cancelOccurrence(ORG, USER, EVENT_ID, OCCURRENCE_ISO);

    expect(result).toBeUndefined();
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(insertFn).not.toHaveBeenCalled();
    expect(updateFn).not.toHaveBeenCalled();
  });
});

describe("CalendarRecurrenceService — per-attendee reminder key coverage", () => {
  beforeEach(() => jest.resetAllMocks());

  it("cancelOccurrence LIKE prefix matches the per-attendee key format (eventId:occurrenceIso:membershipId)", () => {
    const occurrenceIso = new Date(OCCURRENCE_ISO).toISOString();
    const perAttendeeKey = `calendar:reminder:${EVENT_ID}:${occurrenceIso}:${MEMBER_ID}`;
    const likePrefix = `calendar:reminder:${EVENT_ID}:${occurrenceIso}%`;
    expect(perAttendeeKey.startsWith(likePrefix.slice(0, -1))).toBe(true);
  });

  it("cancelOccurrence LIKE prefix does NOT match a different event's per-attendee key", () => {
    const DIFFERENT_EVENT = 999;
    const occurrenceIso = new Date(OCCURRENCE_ISO).toISOString();
    const perAttendeeKey = `calendar:reminder:${DIFFERENT_EVENT}:${occurrenceIso}:${MEMBER_ID}`;
    const likePrefix = `calendar:reminder:${EVENT_ID}:${occurrenceIso}%`;
    expect(perAttendeeKey.startsWith(likePrefix.slice(0, -1))).toBe(false);
  });

  it("cancelOccurrence LIKE prefix does NOT match a different occurrence's per-attendee key", () => {
    const occurrenceIso = new Date(OCCURRENCE_ISO).toISOString();
    const differentOccurrenceIso = "2024-06-10T10:00:00.000Z";
    const perAttendeeKey = `calendar:reminder:${EVENT_ID}:${differentOccurrenceIso}:${MEMBER_ID}`;
    const likePrefix = `calendar:reminder:${EVENT_ID}:${occurrenceIso}%`;
    expect(perAttendeeKey.startsWith(likePrefix.slice(0, -1))).toBe(false);
  });
});
