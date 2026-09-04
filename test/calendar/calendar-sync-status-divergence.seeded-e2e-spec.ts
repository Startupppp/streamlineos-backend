import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { calendarEvents, calendarProviderSyncQueue } from "src/db/schema";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * `GET /calendar/events/:id/sync-status` must not answer `synced` while a push for that
 * event is still refused at the provider.
 *
 * Occurrence-scoped queue rows share the parent's `event_id`, so an event now has SEVERAL
 * independent provider targets on one id: the series itself, and one per edited occurrence.
 * The projection read only the NEWEST row, so any later series write that succeeded buried a
 * FAILED occurrence write underneath it — the endpoint reported `synced`, `retryable` was
 * false, and the provider kept the un-moved occurrence for ever with nothing anywhere saying
 * the two copies had parted. That is the divergence PRD-C129 forbids, arrived at through the
 * READ side rather than the sweep.
 *
 * The second case is the boundary that keeps the first honest: a failure the user has
 * already overwritten on the SAME target is not divergence, and must still read `synced`.
 */
const WINDOW_START = "2026-10-07T09:00:00.000Z";
const WINDOW_END = "2026-10-07T10:00:00.000Z";
const OCCURRENCE_START = "2026-10-21T09:00:00.000Z";
const CONNECTION_ID = 987_654;

interface SyncStatusWire {
  status: "synced" | "pending" | "in_flight" | "failed" | "not_synced";
  attemptCount: number;
  lastError: string | null;
  operation: "create" | "update" | "delete" | null;
  retryable: boolean;
}

describe("[seeded-e2e] sync status never reports synced over an unresolved provider failure", () => {
  let seeded: SeededE2eApp;
  let org: SeededFixture;
  let token = "";
  let server: unknown;
  const createdEventIds: number[] = [];

  async function createEvent(title: string): Promise<number> {
    const response = await request(server as never)
      .post("/calendar/events")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .send({
        title,
        startDate: WINDOW_START,
        endDate: WINDOW_END,
        timezone: "UTC",
        category: "general",
        rrule: "FREQ=WEEKLY;COUNT=4",
      });
    expect(response.status).toBe(201);
    const id = (response.body as { event: { id: number } }).event.id;
    createdEventIds.push(id);
    return id;
  }

  async function enqueue(
    eventId: number,
    row: {
      operation: "create" | "update" | "delete";
      state: "PENDING" | "IN_FLIGHT" | "PROCESSED" | "FAILED";
      occurrenceStart?: string;
      lastError?: string;
      attemptCount?: number;
    },
  ): Promise<number> {
    const [inserted] = await seeded.seedDb
      .insert(calendarProviderSyncQueue)
      .values({
        orgId: org.orgId,
        eventId,
        connectionId: CONNECTION_ID,
        operation: row.operation,
        externalEventId: "ext-series-1",
        state: row.state,
        attemptCount: row.attemptCount ?? 0,
        lastError: row.lastError ?? null,
        processedAt: row.state === "PROCESSED" ? new Date() : null,
        payload: row.occurrenceStart
          ? { userId: org.members.organizer.userId, occurrenceStart: row.occurrenceStart }
          : { userId: org.members.organizer.userId },
      })
      .returning({ id: calendarProviderSyncQueue.id });
    return inserted?.id ?? 0;
  }

  async function readStatus(eventId: number): Promise<SyncStatusWire> {
    const response = await request(server as never)
      .get(`/calendar/events/${eventId}/sync-status`)
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    return response.body as SyncStatusWire;
  }

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();
    org = await seedOrg(seeded.seedDb).onPlan("PAID").withModules("hr").addMember("organizer").build();
    token = await signSeededToken(seeded, org.members.organizer.userId, org.orgId);
  });

  afterAll(async () => {
    if (createdEventIds.length > 0) {
      await seeded.seedDb
        .delete(calendarProviderSyncQueue)
        .where(inArray(calendarProviderSyncQueue.eventId, createdEventIds));
      await seeded.seedDb.delete(calendarEvents).where(inArray(calendarEvents.id, createdEventIds));
    }
    await org.teardown();
    await seeded.close();
  });

  it("BITE: a failed OCCURRENCE push is still reported after a later series push succeeds", async () => {
    const eventId = await createEvent("Weekly sync — occurrence diverged");

    await enqueue(eventId, { operation: "create", state: "PROCESSED" });
    await enqueue(eventId, {
      operation: "update",
      state: "FAILED",
      occurrenceStart: OCCURRENCE_START,
      lastError: "outlook cannot express an instance update",
      attemptCount: 5,
    });
    await enqueue(eventId, { operation: "update", state: "PROCESSED" });

    const status = await readStatus(eventId);

    expect(status.status).toBe("failed");
    expect(status.retryable).toBe(true);
    expect(status.lastError).toBe("outlook cannot express an instance update");
    expect(status.attemptCount).toBe(5);
  });

  it("still reports synced when the failure was superseded on the SAME target", async () => {
    const eventId = await createEvent("Weekly sync — retried successfully");

    await enqueue(eventId, {
      operation: "update",
      state: "FAILED",
      lastError: "transient 503 from the provider",
      attemptCount: 5,
    });
    await enqueue(eventId, { operation: "update", state: "PROCESSED" });

    const status = await readStatus(eventId);

    expect(status.status).toBe("synced");
    expect(status.retryable).toBe(false);
  });

  it("a PROCESSED whole-series delete supersedes every earlier failure", async () => {
    const eventId = await createEvent("Weekly sync — removed at the provider");

    await enqueue(eventId, {
      operation: "update",
      state: "FAILED",
      occurrenceStart: OCCURRENCE_START,
      lastError: "instance write refused",
      attemptCount: 5,
    });
    await enqueue(eventId, { operation: "delete", state: "PROCESSED" });

    const status = await readStatus(eventId);

    expect(status.status).toBe("synced");
    expect(status.retryable).toBe(false);
  });

  it("retrySync revives the buried occurrence failure the status now exposes", async () => {
    const eventId = await createEvent("Weekly sync — retried by the user");

    await enqueue(eventId, {
      operation: "update",
      state: "FAILED",
      occurrenceStart: OCCURRENCE_START,
      lastError: "instance write refused",
      attemptCount: 5,
    });
    await enqueue(eventId, { operation: "update", state: "PROCESSED" });

    const retry = await request(server as never)
      .post(`/calendar/events/${eventId}/sync-retry`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .send({});
    expect(retry.status).toBe(200);
    expect((retry.body as { requeued: number }).requeued).toBe(1);

    const status = await readStatus(eventId);
    expect(status.status).toBe("pending");
  });

  it("leaves an event with no queue rows at not_synced", async () => {
    const eventId = await createEvent("Weekly sync — never synced");
    const status = await readStatus(eventId);
    expect(status.status).toBe("not_synced");
    expect(status.retryable).toBe(false);
  });
});
