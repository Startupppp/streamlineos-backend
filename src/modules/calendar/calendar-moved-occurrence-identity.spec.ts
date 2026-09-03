/**
 * Editing an already-moved occurrence was a silent no-op, and the projection id that
 * caused it meant two different things in the same response.
 *
 * THE KEY. `calendar_event_exceptions` is keyed on `(org_id, event_id, occurrence_start)`,
 * where `occurrence_start` is the NOMINAL instant the RRULE generates. `expandRecurring`
 * looks an exception up by exactly that (`exceptionMap.get(utcStart.getTime())`), so an
 * exception keyed on anything the RRULE does not generate is invisible for ever.
 *
 * THE HANDLE THE CLIENT HAS. `CalendarNativeEventSource` returns `start: occ.startDate`,
 * and for a moved occurrence that is the MODIFIED start. `use-event-series-scope.ts:47`
 * sends `occurrenceStart: event.start`. So the second edit of a moved occurrence arrives
 * keyed on the instant the occurrence currently sits at — never on the nominal one. The
 * upsert's `onConflictDoUpdate` therefore missed the existing row and INSERTED a second,
 * orphaned exception; `expandRecurring` ignored it (its key is not an RRULE instant) and
 * `collectRescheduledOccurrences` skipped it too (its key is inside the window, line 30).
 * The user saw "Occurrence updated" and the occurrence did not move.
 *
 * THE ID. The two projection paths in `calendar-native-event-source.ts` built the id from
 * two different instants — `occ.startDate` (modified) at :70 and `rs.nominalStartMs`
 * (nominal) at :102 — and which path emits a given moved occurrence depends only on
 * whether its nominal instant happens to fall in the requested window. So the SAME
 * occurrence has one id in a month view and a different id in a week view, and moving an
 * occurrence changes its id. An id that changes when the thing it names moves is not an
 * identity. It is now always the nominal instant, which is also the exception key.
 *
 * WHAT IS DELIBERATELY NOT FIXED HERE: the parent's provider copy. See
 * `calendar-occurrence-provider-divergence` below.
 */
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarNativeEventSource } from "./calendar-native-event-source";
import { CalendarEventSourceLoader } from "./calendar-event-source.loader";
import {
  expandToOccurrences,
  type CalendarEventException,
  type CalendarEventLike,
} from "./calendar-occurrence.service";
import { TOOL_SLUGS } from "./external-event-normalizers";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();

const ORG = "org-moved-occ";
const USER = "user-owner";
const MEMBER_ID = 5;
const EVENT_ID = 50;

/** A weekly Tuesday 10:00 UTC series. */
const NOMINAL = new Date("2024-06-04T10:00:00.000Z");
/** …whose 4 June instance the owner moved to Wednesday. */
const MOVED_ONCE = new Date("2024-06-05T10:00:00.000Z");
/** …and then, a day later, to Thursday. */
const MOVED_TWICE = new Date("2024-06-06T10:00:00.000Z");

function weeklyEvent(overrides: Partial<CalendarEventLike> = {}): CalendarEventLike {
  return {
    id: EVENT_ID,
    title: "Weekly standup",
    startDate: new Date("2024-05-28T10:00:00.000Z"),
    endDate: new Date("2024-05-28T10:30:00.000Z"),
    allDay: false,
    timezone: "UTC",
    orgId: ORG,
    rrule: "FREQ=WEEKLY;BYDAY=TU",
    recurrenceEnd: null,
    ...overrides,
  };
}

/* ------------------------------------------------- the write side: the key */

interface WriteHarness {
  db: Db;
  /** Every row handed to `insert(calendar_event_exceptions).values(…)`. */
  written: Record<string, unknown>[];
  /** Every patch handed to `update(calendar_events).set(…)`. */
  eventPatches: Record<string, unknown>[];
}

/**
 * A transaction over one event that already carries the exception rows given.
 * `select` answers the key-resolution lookups the way the unique index would.
 */
function makeWriteHarness(
  existing: Array<{ occurrenceStart: Date; modifiedStart: Date | null }>,
): WriteHarness {
  const written: Record<string, unknown>[] = [];
  const eventPatches: Record<string, unknown>[] = [];

  /**
   * Reads the instants the predicate binds, so the fake can answer like the index would.
   * Drizzle maps a Date through the timestamp column's driver mapper before it reaches
   * `params`, so a bound instant arrives as a string, not as a Date.
   */
  const boundDates = (predicate: SQL): number[] =>
    dialect
      .sqlToQuery(predicate)
      .params.flatMap((param) => {
        if (param instanceof Date) return [param.getTime()];
        if (typeof param !== "string") return [];
        const parsed = Date.parse(param.includes("Z") || param.includes("+") ? param : `${param}Z`);
        return Number.isNaN(parsed) ? [] : [parsed];
      });

  const tx = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation((table: Parameters<typeof getTableName>[0]) => ({
        where: jest.fn().mockImplementation((predicate: SQL) => {
          if (getTableName(table) !== "calendar_event_exceptions")
            return { limit: jest.fn().mockResolvedValue([]) };
          const wanted = boundDates(predicate);
          const sql = dialect.sqlToQuery(predicate).sql;
          const rows = existing.filter((row) =>
            sql.includes("modified_start")
              ? row.modifiedStart !== null && wanted.includes(row.modifiedStart.getTime())
              : wanted.includes(row.occurrenceStart.getTime()),
          );
          return { limit: jest.fn().mockResolvedValue(rows) };
        }),
      })),
    })),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
        written.push(row);
        return {
          onConflictDoUpdate: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1, ...row }]),
          }),
        };
      }),
    }),
    update: jest.fn().mockImplementation((table: Parameters<typeof getTableName>[0]) => ({
      set: jest.fn().mockImplementation((patch: Record<string, unknown>) => {
        if (getTableName(table) === "calendar_events") eventPatches.push(patch);
        return { where: jest.fn().mockResolvedValue([]) };
      }),
    })),
  };

  const db = {
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest
            .fn()
            .mockResolvedValue([{ createdByMembershipId: MEMBER_ID, rrule: "FREQ=WEEKLY;BYDAY=TU" }]),
        }),
      }),
    }),
    transaction: jest.fn().mockImplementation((cb: (t: unknown) => unknown) => cb(tx)),
  };

  return { db: db as unknown as Db, written, eventPatches };
}

describe("occurrence exceptions are keyed on the nominal instant, whatever the client sends", () => {
  it("re-keys a second edit that names the occurrence's CURRENT start", async () => {
    // The state after one move: the RRULE still generates Tuesday, the occurrence sits
    // on Wednesday, and Wednesday is the only instant the client can name.
    const harness = makeWriteHarness([{ occurrenceStart: NOMINAL, modifiedStart: MOVED_ONCE }]);
    const service = new CalendarRecurrenceService(harness.db);

    await service.upsertOccurrenceException(ORG, USER, EVENT_ID, MOVED_ONCE.toISOString(), {
      modifiedStart: MOVED_TWICE.toISOString(),
      modifiedEnd: new Date(MOVED_TWICE.getTime() + 1_800_000).toISOString(),
    });

    expect(harness.written).toHaveLength(1);
    // The row must land on the SAME key as the first move, so onConflictDoUpdate updates
    // it. Keyed on MOVED_ONCE it would insert a second, permanently invisible row.
    expect(harness.written[0]).toMatchObject({
      orgId: ORG,
      eventId: EVENT_ID,
      occurrenceStart: NOMINAL,
      modifiedStart: MOVED_TWICE,
    });
  });

  it("leaves a first edit — which names a nominal instant — exactly as it was", async () => {
    // Anti-vacuity: a re-keying that fired on every write would break the ordinary path.
    const harness = makeWriteHarness([]);
    const service = new CalendarRecurrenceService(harness.db);

    await service.upsertOccurrenceException(ORG, USER, EVENT_ID, NOMINAL.toISOString(), {
      modifiedStart: MOVED_ONCE.toISOString(),
    });

    expect(harness.written[0]).toMatchObject({ occurrenceStart: NOMINAL });
  });

  it("prefers an exact key match over a coincidental modified_start collision", async () => {
    // Two instances of the series collided: 11 June was moved onto 4 June, which is
    // itself a nominal instant with its own exception. Editing 4 June must edit 4 June.
    const collided = new Date("2024-06-11T10:00:00.000Z");
    const harness = makeWriteHarness([
      { occurrenceStart: NOMINAL, modifiedStart: null },
      { occurrenceStart: collided, modifiedStart: NOMINAL },
    ]);
    const service = new CalendarRecurrenceService(harness.db);

    await service.upsertOccurrenceException(ORG, USER, EVENT_ID, NOMINAL.toISOString(), {
      modifiedTitle: "Renamed",
    });

    expect(harness.written[0]).toMatchObject({ occurrenceStart: NOMINAL });
  });

  it("re-keys a cancellation the same way", async () => {
    const harness = makeWriteHarness([{ occurrenceStart: NOMINAL, modifiedStart: MOVED_ONCE }]);
    const service = new CalendarRecurrenceService(harness.db);

    await service.cancelOccurrence(ORG, USER, EVENT_ID, MOVED_ONCE.toISOString());

    expect(harness.written[0]).toMatchObject({ occurrenceStart: NOMINAL, isCancelled: true });
  });

  it("records the series as locally changed, so provider drift still resolves local-wins", async () => {
    // `handleScoped` discards a provider notification whose timestamp is not newer than
    // calendar_events.updated_at. An occurrence edit that left the parent's updated_at
    // alone made a local change invisible to that comparison.
    const harness = makeWriteHarness([]);
    const service = new CalendarRecurrenceService(harness.db);

    await service.upsertOccurrenceException(ORG, USER, EVENT_ID, NOMINAL.toISOString(), {
      modifiedStart: MOVED_ONCE.toISOString(),
    });

    expect(harness.eventPatches).toHaveLength(1);
    expect(harness.eventPatches[0]).toHaveProperty("updatedAt");
    expect(harness.eventPatches[0]).toHaveProperty("localVersion");
  });
});

/* -------------------------------------------- the read side: the identity */

function projectionsFor(window: { start: Date; end: Date }, exceptions: CalendarEventException[]) {
  const event = {
    ...weeklyEvent(),
    color: "blue",
    category: "meeting",
    location: null,
    meetingUrl: null,
    description: null,
    creatorName: null,
    entityId: null,
    entityType: null,
    rsvpStatus: null,
  };

  const loader: Pick<CalendarEventSourceLoader, "load"> = {
    load: jest.fn().mockResolvedValue({
      eventsData: [event],
      linkedTicketMap: new Map(),
      exceptionsByEvent: new Map([[EVENT_ID, exceptions]]),
    }),
  };

  const source = new CalendarNativeEventSource({} as Db, { register: jest.fn() } as never);
  Object.assign(source, { loader });
  return source.load({ orgId: ORG, userId: USER, start: window.start, end: window.end });
}

describe("a recurring occurrence keeps one id, whatever window asks for it and wherever it moved", () => {
  const moved: CalendarEventException = {
    occurrenceStart: NOMINAL,
    isCancelled: false,
    modifiedStart: MOVED_ONCE,
    modifiedEnd: new Date(MOVED_ONCE.getTime() + 1_800_000),
    modifiedTitle: null,
  };

  it("names the moved occurrence by its nominal instant, not the instant it moved to", async () => {
    // A window holding both the nominal Tuesday and the moved Wednesday: the in-window
    // expansion path emits it.
    const rows = await projectionsFor(
      { start: new Date("2024-06-03T00:00:00Z"), end: new Date("2024-06-08T00:00:00Z") },
      [moved],
    );
    const occurrence = rows.find((row) => row.start.getTime() === MOVED_ONCE.getTime());

    expect(occurrence).toBeDefined();
    expect(occurrence?.id).toBe(`event-${EVENT_ID}-${NOMINAL.toISOString()}`);
  });

  it("gives the same occurrence the same id from a window that excludes its nominal instant", async () => {
    // Wednesday 5 June only: the nominal Tuesday is outside, so this is the
    // collectRescheduledOccurrences path. Same occurrence — so the same id, or the id is
    // not an identity and a client keyed on it sees two events where there is one.
    const rows = await projectionsFor(
      { start: new Date("2024-06-05T00:00:00Z"), end: new Date("2024-06-06T00:00:00Z") },
      [moved],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.start.getTime()).toBe(MOVED_ONCE.getTime());
    expect(rows[0]?.id).toBe(`event-${EVENT_ID}-${NOMINAL.toISOString()}`);
  });

  it("leaves an unmoved occurrence's id alone", async () => {
    const rows = await projectionsFor(
      { start: new Date("2024-06-03T00:00:00Z"), end: new Date("2024-06-08T00:00:00Z") },
      [],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(`event-${EVENT_ID}-${NOMINAL.toISOString()}`);
  });

  it("carries the nominal instant on the occurrence itself, so both paths read one field", async () => {
    const occurrences = expandToOccurrences(
      weeklyEvent(),
      new Date("2024-06-03T00:00:00Z"),
      new Date("2024-06-08T00:00:00Z"),
      [moved],
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.startDate.getTime()).toBe(MOVED_ONCE.getTime());
    expect(occurrences[0]?.nominalStart.getTime()).toBe(NOMINAL.getTime());
  });

  it("gives a non-recurring event a nominalStart equal to its own start", () => {
    const single = weeklyEvent({ rrule: null, startDate: NOMINAL, endDate: MOVED_ONCE });
    const occurrences = expandToOccurrences(
      single,
      new Date("2024-06-03T00:00:00Z"),
      new Date("2024-06-08T00:00:00Z"),
    );

    expect(occurrences[0]?.nominalStart.getTime()).toBe(NOMINAL.getTime());
  });
});

/* --------------------------------------------------- what is NOT fixed here */

describe("calendar-occurrence-provider-divergence — stated, not silently papered over", () => {
  it("has no per-instance provider operation to enqueue", () => {
    // The audit proposed enqueueing a provider-sync UPDATE when the parent event carries
    // an integration connection. That would not work, and it is worth pinning why so the
    // next reader does not re-propose it: the sweep's update branch re-reads the PARENT
    // row and pushes the parent's own title/description/start/end through
    // `pushUpdate(userId, conn, externalEventId, …)`. There is one external id — the
    // series' — and no instance handle anywhere in `ExternalCalendarSyncService` or in
    // TOOL_SLUGS. Enqueueing would therefore re-push unchanged parent fields and leave
    // the moved instance exactly where it was on Google, while making `sync-status`
    // report success. A per-instance push (Google's `instances` collection, Outlook's
    // `seriesMaster` exceptions) is new capability, not a defect fix.
    expect(Object.keys(TOOL_SLUGS)).not.toContain("googleUpdateInstance");
    expect(Object.values(TOOL_SLUGS).join(" ")).not.toContain("INSTANCE");
  });
});
