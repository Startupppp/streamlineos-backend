import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { calendarEvents } from "src/db/schema";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * DST, end to end: a recurring series holds its authored WALL CLOCK across a daylight
 * saving transition, and the two hemispheres of the problem are exercised in the same
 * request.
 *
 * Everything below this route is unit-covered — `calendar-dst-edge.spec.ts`,
 * `calendar-timezone.spec.ts`, `common/date/zoned-wall-clock` — and every one of those
 * hands `expandToOccurrences` a hand-built object. None of them proves that the zone the
 * client authored survives the round trip through `calendar_events.timezone`, the
 * source registry and the aggregate projection, which is where a series that reads
 * correctly in a unit test still shifts by an hour for the person looking at it.
 *
 * Two series, authored in two zones whose transitions fall on DIFFERENT dates
 * (America/New_York on 2026-03-08, Europe/Berlin on 2026-03-29), are read back in one
 * window. A host- or UTC-naive expansion cannot satisfy both: holding the wall clock for
 * one zone moves it for the other.
 */
const NEW_YORK = "America/New_York";
const BERLIN = "Europe/Berlin";

function wallClock(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(instant));
}

function calendarDate(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

interface WireItem {
  id: string;
  title: string;
  start: string;
  end: string;
  timezone: string | null;
  isRecurring: boolean;
}

describe("[seeded-e2e] calendar recurrence across a DST boundary", () => {
  let seeded: SeededE2eApp;
  let org: SeededFixture;
  let token = "";
  let server: unknown;
  const createdEventIds: number[] = [];

  async function createSeries(
    title: string,
    startIso: string,
    endIso: string,
    timezone: string,
  ): Promise<number> {
    const response = await request(server as never)
      .post("/calendar/events")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .send({
        title,
        startDate: startIso,
        endDate: endIso,
        timezone,
        category: "general",
        rrule: "FREQ=WEEKLY;COUNT=6",
      });
    expect(response.status).toBe(201);
    const id: unknown = response.body?.event?.id;
    expect(typeof id).toBe("number");
    createdEventIds.push(id as number);
    return id as number;
  }

  async function readWindow(startIso: string, endIso: string): Promise<WireItem[]> {
    const response = await request(server as never)
      .get("/calendar/events")
      .query({ start: startIso, end: endIso })
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    return response.body.events as WireItem[];
  }

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();
    org = await seedOrg(seeded.seedDb).onPlan("PAID").addMember("organizer").build();
    token = await signSeededToken(seeded, org.members.organizer.userId, org.orgId);
  }, 180_000);

  afterAll(async () => {
    for (const id of createdEventIds)
      await seeded.seedDb.delete(calendarEvents).where(eq(calendarEvents.id, id));
    if (org) await org.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("holds the authored wall clock across the US spring-forward transition", async () => {
    // 2026-03-04 09:00 New York is EST (UTC-5); 2026-03-11 09:00 is EDT (UTC-4).
    const eventId = await createSeries(
      "US standup",
      "2026-03-04T14:00:00.000Z",
      "2026-03-04T14:30:00.000Z",
      NEW_YORK,
    );

    const items = (await readWindow("2026-03-01T00:00:00.000Z", "2026-04-10T00:00:00.000Z")).filter(
      (item) => item.id.startsWith(`event-${String(eventId)}-`),
    );

    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(new Set(items.map((item) => wallClock(item.start, NEW_YORK)))).toEqual(new Set(["09:00"]));
    expect(items.every((item) => item.timezone === NEW_YORK)).toBe(true);

    // The bite: the absolute instants are NOT all the same time of day in UTC. If the
    // expansion were UTC-naive the wall-clock assertion above would still hold for a
    // fixed-offset zone, so this is what distinguishes a correct expansion from one that
    // never converted at all.
    const beforeTransition = items.filter((item) => calendarDate(item.start, NEW_YORK) < "2026-03-08");
    const afterTransition = items.filter((item) => calendarDate(item.start, NEW_YORK) > "2026-03-08");
    expect(beforeTransition.length).toBeGreaterThan(0);
    expect(afterTransition.length).toBeGreaterThan(0);
    expect(new Set(beforeTransition.map((item) => item.start.slice(11, 16)))).toEqual(new Set(["14:00"]));
    expect(new Set(afterTransition.map((item) => item.start.slice(11, 16)))).toEqual(new Set(["13:00"]));
  }, 60_000);

  it("holds the authored wall clock across the EU spring-forward transition, in the same window", async () => {
    // 2026-03-25 09:00 Berlin is CET (UTC+1); 2026-04-01 09:00 is CEST (UTC+2). The EU
    // transition is three weeks after the US one, so a single global offset cannot serve
    // both this series and the one above.
    const eventId = await createSeries(
      "EU standup",
      "2026-03-25T08:00:00.000Z",
      "2026-03-25T08:30:00.000Z",
      BERLIN,
    );

    const items = (await readWindow("2026-03-01T00:00:00.000Z", "2026-04-10T00:00:00.000Z")).filter(
      (item) => item.id.startsWith(`event-${String(eventId)}-`),
    );

    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(new Set(items.map((item) => wallClock(item.start, BERLIN)))).toEqual(new Set(["09:00"]));
    expect(items.every((item) => item.timezone === BERLIN)).toBe(true);

    const beforeTransition = items.filter((item) => calendarDate(item.start, BERLIN) < "2026-03-29");
    const afterTransition = items.filter((item) => calendarDate(item.start, BERLIN) > "2026-03-29");
    expect(beforeTransition.length).toBeGreaterThan(0);
    expect(afterTransition.length).toBeGreaterThan(0);
    expect(new Set(beforeTransition.map((item) => item.start.slice(11, 16)))).toEqual(new Set(["08:00"]));
    expect(new Set(afterTransition.map((item) => item.start.slice(11, 16)))).toEqual(new Set(["07:00"]));
  }, 60_000);

  it("keeps the occurrence duration intact across the transition", async () => {
    const items = (await readWindow("2026-03-01T00:00:00.000Z", "2026-04-10T00:00:00.000Z")).filter(
      (item) => item.isRecurring,
    );
    expect(items.length).toBeGreaterThan(0);
    const durations = new Set(
      items.map((item) => new Date(item.end).getTime() - new Date(item.start).getTime()),
    );
    expect(durations).toEqual(new Set([30 * 60 * 1000]));
  }, 60_000);
});
