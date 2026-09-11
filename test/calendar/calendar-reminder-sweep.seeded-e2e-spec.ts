import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import request from "supertest";
import { calendarEventExceptions, calendarEvents, notificationOutbox } from "src/db/schema";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * Reminders, end to end: one tick of `/cron/calendar-reminder-sweep` writes exactly one
 * `notification_outbox` intent per attendee per OCCURRENCE, writes none for an occurrence
 * that was cancelled before the tick, and writes no second copy when the tick is repeated.
 *
 * Everything below the cron route is unit-covered — `calendar-reminder-sweep-recurring`,
 * `-event-paging`, `-recipient-paging`, `-tenant-isolation` — and every one of them hands
 * the service a mocked transaction whose `onConflictDoNothing` is a `jest.fn()`. The
 * property that decides whether a person is paged twice for the same meeting is the
 * UNIQUE index `uniq_notification_outbox_dedupe (org_id, dedupe_key)` and the dedupe key
 * the sweep composes from `(event, NOMINAL occurrence, membership)`. A mock cannot
 * enforce a unique index, so a key that collapsed two attendees into one row, or that
 * varied per tick, would pass every existing spec and page the wrong set of people in
 * production.
 *
 * The cancel arm is the other half. `cancelledKeys` is keyed on the exception's NOMINAL
 * `occurrence_start`, which is not the instant the client names once the occurrence has
 * been moved, and it is the only thing stopping a reminder going out for a meeting that
 * is no longer happening.
 *
 * The sweep has no injectable clock — the cron route calls `run()` with the real `now` —
 * so the fixture is authored relative to wall-clock time, inside the service's own
 * 20-minute look-ahead.
 */
const REMINDER_WINDOW_MS = 20 * 60 * 1000;
const LEAD_MS = 8 * 60 * 1000;

interface OutboxRow {
  dedupeKey: string;
  state: string;
  targetUserIds: string[];
  entityId: string | null;
}

describe("[seeded-e2e] calendar reminder sweep", () => {
  let seeded: SeededE2eApp;
  let org: SeededFixture;
  let organizerToken = "";
  let server: unknown;
  let liveEventId = 0;
  let cancelledEventId = 0;
  let nominalStartIso = "";
  const cronSecret = process.env.CRON_SECRET ?? "";

  async function createSeries(title: string, startIso: string, endIso: string): Promise<number> {
    const response = await request(server as never)
      .post("/calendar/events")
      .set("Authorization", `Bearer ${organizerToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({
        title,
        startDate: startIso,
        endDate: endIso,
        timezone: "UTC",
        category: "general",
        rrule: "FREQ=DAILY;COUNT=3",
        attendeeIds: [org.members.attendeeOne.userId, org.members.attendeeTwo.userId],
      });
    expect(response.status).toBe(201);
    return response.body.event.id as number;
  }

  async function tick(): Promise<void> {
    const response = await request(server as never)
      .post("/cron/calendar-reminder-sweep")
      .set("Authorization", `Bearer ${cronSecret}`)
      .send();
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    // A lease refusal would make every assertion below vacuously true.
    expect(response.body.skipped).toBeUndefined();
  }

  function reminderRows(eventId: number): Promise<OutboxRow[]> {
    return seeded.seedDb
      .select({
        dedupeKey: notificationOutbox.dedupeKey,
        state: notificationOutbox.state,
        targetUserIds: notificationOutbox.targetUserIds,
        entityId: notificationOutbox.entityId,
      })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.orgId, org.orgId),
          eq(notificationOutbox.eventKey, "calendar.reminder"),
          like(notificationOutbox.dedupeKey, `calendar:reminder:${String(eventId)}:%`),
        ),
      );
  }

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();
    if (!cronSecret)
      throw new Error(
        "[seeded-e2e] CRON_SECRET must be set — without it /cron/calendar-reminder-sweep answers 503 " +
          "and the failure reads as a routing defect rather than a missing environment variable.",
      );
    org = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("organizer")
      .addMember("attendeeOne")
      .addMember("attendeeTwo")
      .build();
    organizerToken = await signSeededToken(seeded, org.members.organizer.userId, org.orgId);

    // Inside the sweep's look-ahead with margin on both sides: far enough ahead that the
    // occurrence has not passed by the time the tick runs, near enough that it is due.
    const start = new Date(Date.now() + LEAD_MS);
    start.setUTCSeconds(0, 0);
    nominalStartIso = start.toISOString();
    const endIso = new Date(start.getTime() + 30 * 60 * 1000).toISOString();
    expect(start.getTime() - Date.now()).toBeLessThan(REMINDER_WINDOW_MS);

    liveEventId = await createSeries("Standup sync", nominalStartIso, endIso);
    cancelledEventId = await createSeries("Cancelled sync", nominalStartIso, endIso);
  }, 180_000);

  afterAll(async () => {
    const ids = [liveEventId, cancelledEventId].filter((id) => id > 0);
    if (ids.length > 0) {
      await seeded.seedDb
        .delete(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.orgId, org.orgId),
            inArray(notificationOutbox.entityType, ["calendar_event"]),
          ),
        );
      await seeded.seedDb
        .delete(calendarEventExceptions)
        .where(inArray(calendarEventExceptions.eventId, ids));
      await seeded.seedDb.delete(calendarEvents).where(inArray(calendarEvents.id, ids));
    }
    if (org) await org.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("writes exactly one reminder intent per attendee for the due occurrence", async () => {
    // Cancelled BEFORE the first tick, so the assertion below is about the sweep declining
    // to write rather than about a later cleanup removing them.
    const cancelled = await request(server as never)
      .delete(
        `/calendar/events/${String(cancelledEventId)}/occurrences/${encodeURIComponent(nominalStartIso)}`,
      )
      .set("Authorization", `Bearer ${organizerToken}`)
      .set("Idempotency-Key", randomUUID());
    expect(cancelled.status).toBe(200);

    await tick();

    const rows = await reminderRows(liveEventId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.dedupeKey))).toEqual(
      new Set([
        `calendar:reminder:${String(liveEventId)}:${nominalStartIso}:${String(org.members.attendeeOne.membershipId)}`,
        `calendar:reminder:${String(liveEventId)}:${nominalStartIso}:${String(org.members.attendeeTwo.membershipId)}`,
      ]),
    );
    // One recipient per row: a reminder fans out per attendee, so a row addressed to both
    // would mean the dedupe key had collapsed them and one revocation would silence both.
    expect(rows.every((row) => row.targetUserIds.length === 1)).toBe(true);
    expect(new Set(rows.flatMap((row) => row.targetUserIds))).toEqual(
      new Set([org.members.attendeeOne.userId, org.members.attendeeTwo.userId]),
    );
    expect(new Set(rows.map((row) => row.entityId))).toEqual(new Set([String(liveEventId)]));
    expect(rows.every((row) => row.state === "PENDING")).toBe(true);
  }, 90_000);

  it("writes nothing for an occurrence cancelled before the tick", async () => {
    expect(await reminderRows(cancelledEventId)).toEqual([]);
  }, 60_000);

  it("writes no second copy when the same tick is repeated", async () => {
    await tick();
    const rows = await reminderRows(liveEventId);
    expect(rows).toHaveLength(2);
    expect(await reminderRows(cancelledEventId)).toEqual([]);
  }, 90_000);

  it("dead-letters the already-written reminders when the occurrence is cancelled afterwards", async () => {
    const cancelled = await request(server as never)
      .delete(
        `/calendar/events/${String(liveEventId)}/occurrences/${encodeURIComponent(nominalStartIso)}`,
      )
      .set("Authorization", `Bearer ${organizerToken}`)
      .set("Idempotency-Key", randomUUID());
    expect(cancelled.status).toBe(200);

    const rows = await reminderRows(liveEventId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.state))).toEqual(new Set(["DEAD"]));
  }, 90_000);
});
