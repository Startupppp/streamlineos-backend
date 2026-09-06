import { randomUUID } from "node:crypto";
import request from "supertest";
import { calendarEvents } from "src/db/schema";
import { inArray } from "drizzle-orm";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * Byte attribution for GET /calendar/events.
 *
 * Before the compaction six fields were carried on every native occurrence in the
 * range projection: description, meetingUrl, creatorName, rrule, isRecurring and
 * linkedTicket. They are now detail-only, served only by GET /calendar/events/:id.
 *
 * This spec:
 *  1. Seeds a batch of native events that carry data in every formerly-heavy field.
 *  2. Calls the range endpoint and captures the raw response body.
 *  3. Reports the top-8 per-field byte contributors across all occurrences.
 *  4. Asserts none of the six stripped fields appear on range items.
 *  5. Asserts the per-event byte average × 400 stays under the 150 KB large-tenant budget.
 *
 * Running: MSYS_NO_PATHCONV=1 node --env-file-if-exists=.env -r ts-node/register/transpile-only
 *   test/helpers/run-seeded-e2e.ts scratch_local
 *   test/calendar/calendar-range-payload-attribution.seeded-e2e-spec.ts
 */
describe("[seeded-e2e] calendar range payload attribution", () => {
  let seeded: SeededE2eApp;
  let org: SeededFixture;
  let token = "";
  let server: unknown;
  const createdEventIds: number[] = [];

  const WINDOW_START = "2026-10-01T00:00:00.000Z";
  const WINDOW_END = "2026-10-31T23:59:59.000Z";
  const EVENT_COUNT = 25;

  beforeAll(async () => {
    seeded = await createSeededE2eApp({ mirrorHttpStack: true });
    server = seeded.app.getHttpServer();
    org = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("viewer")
      .build();
    token = await signSeededToken(seeded, org.members.viewer.userId, org.orgId);

    const rows = Array.from({ length: EVENT_COUNT }, (_, i) => ({
      orgId: org.orgId,
      title: `Attribution event ${i + 1} — ${randomUUID().slice(0, 8)}`,
      description: `This is a long meeting description for event ${i + 1}. It contains details about agenda items, participants, goals and expected outcomes. Each line adds bytes to the range payload.`,
      location: "Room A, Floor 3",
      meetingUrl: `https://meet.example.com/room-${randomUUID().slice(0, 8)}`,
      startDate: new Date(`2026-10-${String((i % 28) + 1).padStart(2, "0")}T09:00:00.000Z`),
      endDate: new Date(`2026-10-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`),
      timezone: "Asia/Kolkata",
      allDay: false,
      color: "blue",
      category: "meeting",
      visibility: "org" as const,
      createdByMembershipId: org.members.viewer.membershipId,
    }));

    const inserted = await seeded.seedDb
      .insert(calendarEvents)
      .values(rows)
      .returning({ id: calendarEvents.id });
    for (const row of inserted) createdEventIds.push(row.id);
  }, 180_000);

  afterAll(async () => {
    if (createdEventIds.length > 0)
      await seeded.seedDb.delete(calendarEvents).where(inArray(calendarEvents.id, createdEventIds));
    if (org) await org.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("range response body stays within the large-tenant budget (≤150 KB at 400 events)", async () => {
    const res = await request(server as never)
      .get("/v1/calendar/events")
      .set("Authorization", `Bearer ${token}`)
      .query({ start: WINDOW_START, end: WINDOW_END });

    expect(res.status).toBe(200);

    const body = res.body as { events?: unknown[] };
    const events = body.events ?? [];
    expect(events.length).toBeGreaterThan(0);

    const rawBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    const perEvent = rawBytes / Math.max(events.length, 1);

    const fieldTotals: Record<string, number> = {};
    for (const ev of events) {
      for (const [key, val] of Object.entries(ev as Record<string, unknown>)) {
        const bytes = Buffer.byteLength(JSON.stringify(val), "utf8");
        fieldTotals[key] = (fieldTotals[key] ?? 0) + bytes;
      }
    }

    const top8 = Object.entries(fieldTotals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([k, v]) => `${k}: ${v} B`);

    process.stdout.write(
      `\n[attribution] ${events.length} events · ${rawBytes} B total · ${Math.round(perEvent)} B/event\n` +
        `  Top-8 fields: ${top8.join(", ")}\n` +
        `  Extrapolated 400-event body: ${Math.round(perEvent * 400 / 1024)} KB\n`,
    );

    expect(perEvent * 400).toBeLessThan(150 * 1024);
  });

  it("native range items carry none of the six stripped detail-only fields", async () => {
    const res = await request(server as never)
      .get("/v1/calendar/events")
      .set("Authorization", `Bearer ${token}`)
      .query({ start: WINDOW_START, end: WINDOW_END });

    expect(res.status).toBe(200);

    const body = res.body as { events?: unknown[] };
    const nativeEvents = (body.events ?? []).filter(
      (ev) => (ev as Record<string, unknown>)["source"] === "event",
    );
    expect(nativeEvents.length).toBeGreaterThan(0);

    const stripped = ["rrule", "isRecurring", "meetingUrl", "linkedTicket", "description", "creatorName"];
    for (const ev of nativeEvents) {
      const keys = Object.keys(ev as Record<string, unknown>);
      for (const field of stripped)
        expect([field, keys.includes(field)]).toEqual([field, false]);
    }
  });

  it("GET /calendar/events/:id returns the stripped fields for a native event", async () => {
    const res = await request(server as never)
      .get("/v1/calendar/events")
      .set("Authorization", `Bearer ${token}`)
      .query({ start: WINDOW_START, end: WINDOW_END });

    expect(res.status).toBe(200);
    const body = res.body as { events?: Array<Record<string, unknown>> };
    const nativeEvent = (body.events ?? []).find(
      (ev) => (ev as Record<string, unknown>)["source"] === "event",
    ) as Record<string, unknown> | undefined;
    expect(nativeEvent).toBeDefined();

    const eventIdStr = nativeEvent?.["id"] as string | undefined;
    expect(typeof eventIdStr).toBe("string");
    const parsed = /^event-(\d+)/.exec(eventIdStr ?? "");
    expect(parsed).not.toBeNull();
    const numericId = Number(parsed?.[1] ?? "0");

    const detail = await request(server as never)
      .get(`/v1/calendar/events/${numericId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(detail.status).toBe(200);
    const d = detail.body as Record<string, unknown>;
    expect(d).toHaveProperty("meetingUrl");
    expect(d).toHaveProperty("description");
    expect(d).toHaveProperty("creatorName");
    expect(d).toHaveProperty("rrule");
    expect(d).toHaveProperty("isRecurring");
  });
});
