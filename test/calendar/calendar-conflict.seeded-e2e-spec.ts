import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { calendarEvents, eventAttendees, leaveRequests, leaveTypes } from "src/db/schema";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * Conflicts, end to end: the 201 that creates an event carries the two conflict lists the
 * booking UI renders, computed inside the same write.
 *
 * `calendar-conflict.service.spec.ts` covers the service against mocks, and nothing covers
 * the SURFACE — that the lists survive the controller, reach the wire non-empty, and are
 * scoped to the caller. That last part is the one a mock cannot answer: `checkConflictsInTx`
 * only counts events the caller created or is an attendee of, so a colleague's private
 * meeting must NOT come back as a conflict, and the only way to be sure the filter is
 * really applied is to put a second member's event in the same slot in a real database.
 */
const SLOT_START = "2026-08-12T10:00:00.000Z";
const SLOT_END = "2026-08-12T11:00:00.000Z";
const OVERLAP_START = "2026-08-12T10:30:00.000Z";
const OVERLAP_END = "2026-08-12T11:30:00.000Z";

interface ConflictWire {
  eventId: number;
  title: string;
  startDate: string;
  endDate: string;
}

interface OooWire {
  userId: string;
  userName: string | null;
  leaveStart: string;
  leaveEnd: string;
}

describe("[seeded-e2e] calendar conflict detection on create", () => {
  let seeded: SeededE2eApp;
  let org: SeededFixture;
  let organizerToken = "";
  let colleagueToken = "";
  let server: unknown;
  const createdEventIds: number[] = [];
  let leaveTypeId = 0;
  let leaveRequestId = 0;

  async function createEvent(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, never> }> {
    const response = await request(server as never)
      .post("/calendar/events")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .send(body);
    if (response.status === 201) createdEventIds.push(response.body.event.id as number);
    return response as never;
  }

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();
    org = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("hr")
      .addMember("organizer")
      .addMember("colleague")
      .build();
    organizerToken = await signSeededToken(seeded, org.members.organizer.userId, org.orgId);
    colleagueToken = await signSeededToken(seeded, org.members.colleague.userId, org.orgId);

    const [type] = await seeded.seedDb
      .insert(leaveTypes)
      .values({ orgId: org.orgId, name: `conflict-e2e-${randomUUID().slice(0, 8)}`, daysPerYear: 20 })
      .returning({ id: leaveTypes.id });
    leaveTypeId = type?.id ?? 0;

    const [leave] = await seeded.seedDb
      .insert(leaveRequests)
      .values({
        orgId: org.orgId,
        userId: org.members.colleague.userId,
        userMembershipId: org.members.colleague.membershipId,
        leaveTypeId,
        startDate: "2026-08-10",
        endDate: "2026-08-14",
        status: "APPROVED",
      })
      .returning({ id: leaveRequests.id });
    leaveRequestId = leave?.id ?? 0;
  }, 180_000);

  afterAll(async () => {
    if (leaveRequestId > 0)
      await seeded.seedDb.delete(leaveRequests).where(eq(leaveRequests.id, leaveRequestId));
    if (leaveTypeId > 0) await seeded.seedDb.delete(leaveTypes).where(eq(leaveTypes.id, leaveTypeId));
    if (createdEventIds.length > 0) {
      await seeded.seedDb.delete(eventAttendees).where(inArray(eventAttendees.eventId, createdEventIds));
      await seeded.seedDb.delete(calendarEvents).where(inArray(calendarEvents.id, createdEventIds));
    }
    if (org) await org.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("reports the caller's own overlapping event as an event conflict", async () => {
    const first = await createEvent(organizerToken, {
      title: "Design review",
      startDate: SLOT_START,
      endDate: SLOT_END,
      timezone: "UTC",
      category: "general",
    });
    expect(first.status).toBe(201);
    expect(first.body.eventConflicts).toEqual([]);

    const second = await createEvent(organizerToken, {
      title: "Budget sync",
      startDate: OVERLAP_START,
      endDate: OVERLAP_END,
      timezone: "UTC",
      category: "general",
    });
    expect(second.status).toBe(201);

    const conflicts = second.body.eventConflicts as unknown as ConflictWire[];
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.map((c) => c.title)).toContain("Design review");
    expect(new Date(conflicts[0]!.startDate).toISOString()).toBe(SLOT_START);
  }, 60_000);

  it("reports an attendee's approved leave as an out-of-office conflict", async () => {
    const response = await createEvent(organizerToken, {
      title: "Roadmap workshop",
      startDate: "2026-08-13T09:00:00.000Z",
      endDate: "2026-08-13T10:00:00.000Z",
      timezone: "UTC",
      category: "general",
      attendeeIds: [org.members.colleague.userId],
    });
    expect(response.status).toBe(201);

    const ooo = response.body.oooConflicts as unknown as OooWire[];
    expect(ooo.length).toBe(1);
    expect(ooo[0]!.userId).toBe(org.members.colleague.userId);
    expect(ooo[0]!.leaveStart).toBe("2026-08-10");
    expect(ooo[0]!.leaveEnd).toBe("2026-08-14");
  }, 60_000);

  it("reports no out-of-office conflict for a date the leave does not cover", async () => {
    const response = await createEvent(organizerToken, {
      title: "Later workshop",
      startDate: "2026-08-20T09:00:00.000Z",
      endDate: "2026-08-20T10:00:00.000Z",
      timezone: "UTC",
      category: "general",
      attendeeIds: [org.members.colleague.userId],
    });
    expect(response.status).toBe(201);
    expect(response.body.oooConflicts).toEqual([]);
  }, 60_000);

  it("does not report a colleague's event the caller is not on as the caller's conflict", async () => {
    const colleagueEvent = await createEvent(colleagueToken, {
      title: "Colleague only",
      startDate: "2026-08-25T10:00:00.000Z",
      endDate: "2026-08-25T11:00:00.000Z",
      timezone: "UTC",
      category: "general",
    });
    expect(colleagueEvent.status).toBe(201);

    const mine = await createEvent(organizerToken, {
      title: "Organizer slot",
      startDate: "2026-08-25T10:30:00.000Z",
      endDate: "2026-08-25T11:30:00.000Z",
      timezone: "UTC",
      category: "general",
    });
    expect(mine.status).toBe(201);
    expect(mine.body.eventConflicts).toEqual([]);
  }, 60_000);

  it("expands a recurring series when deciding whether a new booking conflicts", async () => {
    const series = await createEvent(organizerToken, {
      title: "Weekly retro",
      startDate: "2026-09-02T14:00:00.000Z",
      endDate: "2026-09-02T15:00:00.000Z",
      timezone: "UTC",
      category: "general",
      rrule: "FREQ=WEEKLY;COUNT=4",
    });
    expect(series.status).toBe(201);

    // Three weeks after the series' own start date, so only an EXPANDED occurrence can
    // conflict with it — the stored row's start/end are nowhere near this slot.
    const clash = await createEvent(organizerToken, {
      title: "Clashing booking",
      startDate: "2026-09-23T13:30:00.000Z",
      endDate: "2026-09-23T14:30:00.000Z",
      timezone: "UTC",
      category: "general",
    });
    expect(clash.status).toBe(201);

    const conflicts = clash.body.eventConflicts as unknown as ConflictWire[];
    expect(conflicts.map((c) => c.title)).toContain("Weekly retro");
    expect(
      conflicts.some((c) => new Date(c.startDate).toISOString() === "2026-09-23T14:00:00.000Z"),
    ).toBe(true);
  }, 60_000);
});
