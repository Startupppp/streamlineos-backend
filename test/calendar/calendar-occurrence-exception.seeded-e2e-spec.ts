import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import request from "supertest";
import { calendarEventExceptions, calendarEvents } from "src/db/schema";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * Per-occurrence exceptions, end to end: an occurrence keeps its NOMINAL identity while it
 * is moved, so the second edit of a moved occurrence lands on the row the first one wrote.
 *
 * The only instant a client can name for an occurrence it can see is the one the occurrence
 * currently sits at — the projection carries `start`, and that is what the browser sends
 * back. A second edit therefore arrives keyed on the MODIFIED start, and without
 * `resolveOccurrenceKey` it misses the existing row's conflict target and writes a SECOND
 * exception keyed on an instant the RRULE never generates: invisible to `expandRecurring`
 * and skipped by `collectRescheduledOccurrences`. The user is told "Occurrence updated" and
 * nothing moves.
 *
 * `calendar-moved-occurrence-identity.spec.ts` pins that against a mocked transaction. This
 * pins it against the real route, the real unique index
 * `(org_id, event_id, occurrence_start)` and the real projection, which is where the
 * identity has to survive: the id the client sends back is produced by the read path, not
 * by a test fixture.
 */
const SERIES_START = "2026-05-06T10:00:00.000Z";
const SERIES_END = "2026-05-06T11:00:00.000Z";
const TARGET_NOMINAL = "2026-05-13T10:00:00.000Z";
const FIRST_MOVE = "2026-05-14T15:00:00.000Z";
const SECOND_MOVE = "2026-05-21T16:00:00.000Z";
const WINDOW_START = "2026-05-01T00:00:00.000Z";
const WINDOW_END = "2026-06-01T00:00:00.000Z";
const LATE_WINDOW_START = "2026-06-01T00:00:00.000Z";
const LATE_WINDOW_END = "2026-07-01T00:00:00.000Z";
const OUT_OF_WINDOW_MOVE = "2026-06-10T09:00:00.000Z";

interface WireItem {
  id: string;
  title: string;
  start: string;
  end: string;
  isRecurring: boolean;
}

describe("[seeded-e2e] calendar occurrence exceptions keep their nominal identity", () => {
  let seeded: SeededE2eApp;
  let org: SeededFixture;
  let token = "";
  let server: unknown;
  let eventId = 0;

  async function readWindow(startIso: string, endIso: string): Promise<WireItem[]> {
    const response = await request(server as never)
      .get("/calendar/events")
      .query({ start: startIso, end: endIso })
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    return (response.body.events as WireItem[]).filter((item) =>
      item.id.startsWith(`event-${String(eventId)}-`),
    );
  }

  function moveOccurrence(namedStart: string, modifiedStart: string, modifiedEnd: string) {
    return request(server as never)
      .patch(
        `/calendar/events/${String(eventId)}/occurrences/${encodeURIComponent(namedStart)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ modifiedStart, modifiedEnd });
  }

  function exceptionRows() {
    return seeded.seedDb
      .select({
        occurrenceStart: calendarEventExceptions.occurrenceStart,
        modifiedStart: calendarEventExceptions.modifiedStart,
        isCancelled: calendarEventExceptions.isCancelled,
      })
      .from(calendarEventExceptions)
      .where(
        and(
          eq(calendarEventExceptions.orgId, org.orgId),
          eq(calendarEventExceptions.eventId, eventId),
        ),
      )
      .orderBy(asc(calendarEventExceptions.id));
  }

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();
    org = await seedOrg(seeded.seedDb).onPlan("PAID").addMember("organizer").build();
    token = await signSeededToken(seeded, org.members.organizer.userId, org.orgId);

    const created = await request(server as never)
      .post("/calendar/events")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .send({
        title: "Weekly sync",
        startDate: SERIES_START,
        endDate: SERIES_END,
        timezone: "UTC",
        category: "general",
        rrule: "FREQ=WEEKLY;COUNT=8",
      });
    expect(created.status).toBe(201);
    eventId = created.body.event.id as number;
  }, 180_000);

  afterAll(async () => {
    if (eventId > 0) {
      await seeded.seedDb
        .delete(calendarEventExceptions)
        .where(eq(calendarEventExceptions.eventId, eventId));
      await seeded.seedDb.delete(calendarEvents).where(eq(calendarEvents.id, eventId));
    }
    if (org) await org.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("names every occurrence by its nominal instant before anything is moved", async () => {
    const items = await readWindow(WINDOW_START, WINDOW_END);
    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        `event-${String(eventId)}-${SERIES_START}`,
        `event-${String(eventId)}-${TARGET_NOMINAL}`,
      ]),
    );
    const target = items.find((item) => item.id === `event-${String(eventId)}-${TARGET_NOMINAL}`);
    expect(target?.start).toBe(TARGET_NOMINAL);
  }, 60_000);

  it("keeps the id on the nominal instant when the occurrence is moved", async () => {
    const response = await moveOccurrence(TARGET_NOMINAL, FIRST_MOVE, "2026-05-14T16:00:00.000Z");
    expect(response.status).toBe(200);

    const items = await readWindow(WINDOW_START, WINDOW_END);
    const moved = items.find((item) => item.start === FIRST_MOVE);
    expect(moved).toBeDefined();
    expect(moved?.id).toBe(`event-${String(eventId)}-${TARGET_NOMINAL}`);
    expect(items.some((item) => item.start === TARGET_NOMINAL)).toBe(false);

    expect(await exceptionRows()).toEqual([
      {
        occurrenceStart: new Date(TARGET_NOMINAL),
        modifiedStart: new Date(FIRST_MOVE),
        isCancelled: false,
      },
    ]);
  }, 60_000);

  it("routes a SECOND edit named by the moved start onto the SAME exception row", async () => {
    // This is the id the client actually holds: the projection's `start`, not the nominal
    // instant it was expanded from.
    const response = await moveOccurrence(FIRST_MOVE, SECOND_MOVE, "2026-05-21T17:00:00.000Z");
    expect(response.status).toBe(200);

    const rows = await exceptionRows();
    expect(rows).toEqual([
      {
        occurrenceStart: new Date(TARGET_NOMINAL),
        modifiedStart: new Date(SECOND_MOVE),
        isCancelled: false,
      },
    ]);

    const items = await readWindow(WINDOW_START, WINDOW_END);
    const moved = items.find((item) => item.start === SECOND_MOVE);
    expect(moved?.id).toBe(`event-${String(eventId)}-${TARGET_NOMINAL}`);
    expect(items.some((item) => item.start === FIRST_MOVE)).toBe(false);
  }, 60_000);

  it("carries a moved occurrence into the window it landed in, still named by its nominal instant", async () => {
    const response = await moveOccurrence(
      SECOND_MOVE,
      OUT_OF_WINDOW_MOVE,
      "2026-06-10T10:00:00.000Z",
    );
    expect(response.status).toBe(200);

    const lateItems = await readWindow(LATE_WINDOW_START, LATE_WINDOW_END);
    const moved = lateItems.find((item) => item.start === OUT_OF_WINDOW_MOVE);
    expect(moved).toBeDefined();
    // The nominal instant is in MAY and the window is JUNE, so this projection can only
    // come from `collectRescheduledOccurrences` — and it still names the occurrence by the
    // instant the RRULE generated.
    expect(moved?.id).toBe(`event-${String(eventId)}-${TARGET_NOMINAL}`);

    // Read from the window the occurrence LEFT: the id is the same string there too, and
    // it still reports the instant the occurrence was moved to. The identity does not
    // depend on which window asked. (`expandRecurring` does not drop an occurrence whose
    // modified start left the window, so it is projected from both — that is a separate
    // question from identity and is not what this file pins.)
    const mayItems = await readWindow(WINDOW_START, WINDOW_END);
    const fromOldWindow = mayItems.find(
      (item) => item.id === `event-${String(eventId)}-${TARGET_NOMINAL}`,
    );
    expect(fromOldWindow?.start).toBe(OUT_OF_WINDOW_MOVE);
    expect(await exceptionRows()).toHaveLength(1);
  }, 60_000);

  it("moves the occurrence back onto its nominal instant without writing a second row", async () => {
    const response = await moveOccurrence(
      OUT_OF_WINDOW_MOVE,
      TARGET_NOMINAL,
      "2026-05-13T11:00:00.000Z",
    );
    expect(response.status).toBe(200);

    expect(await exceptionRows()).toEqual([
      {
        occurrenceStart: new Date(TARGET_NOMINAL),
        modifiedStart: new Date(TARGET_NOMINAL),
        isCancelled: false,
      },
    ]);

    const items = await readWindow(WINDOW_START, WINDOW_END);
    const restored = items.find((item) => item.id === `event-${String(eventId)}-${TARGET_NOMINAL}`);
    expect(restored?.start).toBe(TARGET_NOMINAL);
  }, 60_000);

  it("cancels one occurrence and leaves the rest of the series standing", async () => {
    const before = await readWindow(WINDOW_START, WINDOW_END);
    const cancelTarget = "2026-05-20T10:00:00.000Z";
    expect(before.some((item) => item.id === `event-${String(eventId)}-${cancelTarget}`)).toBe(true);

    const response = await request(server as never)
      .delete(
        `/calendar/events/${String(eventId)}/occurrences/${encodeURIComponent(cancelTarget)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID());
    expect(response.status).toBe(200);

    const after = await readWindow(WINDOW_START, WINDOW_END);
    expect(after.some((item) => item.id === `event-${String(eventId)}-${cancelTarget}`)).toBe(false);
    expect(after.length).toBe(before.length - 1);
    expect(
      (await exceptionRows()).find((row) => row.occurrenceStart.toISOString() === cancelTarget),
    ).toMatchObject({ isCancelled: true });
  }, 60_000);
});
