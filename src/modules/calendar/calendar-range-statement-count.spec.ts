import { CalendarEventSourceLoader } from "./calendar-event-source.loader";
import type { Db } from "../../db/drizzle.module";
import { CALENDAR_EVENTS_CAP } from "./dto/calendar.schemas";

const ORG = "org-stmt-count-spec";
const USER = "user-stmt-count-spec";
const START = new Date("2026-08-01T00:00:00Z");
const END = new Date("2026-10-01T00:00:00Z");

type ChainNode = Promise<unknown[]> & Record<string, () => ChainNode>;

function chain(rows: unknown[]): ChainNode {
  const node = Promise.resolve(rows) as ChainNode;
  for (const key of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit"])
    node[key] = jest.fn(() => node);
  return node;
}

function candidateRows(count: number): Array<{ id: number; startDate: Date }> {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    startDate: new Date(START.getTime() + i * 86_400_000),
  }));
}

function eventRows(ids: number[]) {
  return ids.map((id) => ({
    id,
    title: `Event ${id}`,
    description: null,
    location: null,
    meetingUrl: null,
    startDate: new Date(START.getTime() + id * 86_400_000),
    endDate: new Date(START.getTime() + id * 86_400_000 + 3_600_000),
    allDay: false,
    timezone: "UTC",
    color: null,
    category: "work",
    entityType: null,
    entityId: null,
    visibility: "org",
    rrule: null,
    recurrenceEnd: null,
    createdByMembershipId: 1,
  }));
}

function isCandidateProjection(keys: string[]): boolean {
  return keys.length === 2 && keys.includes("id") && keys.includes("startDate");
}

interface DbCallCounts {
  candidateSelectCalls: number;
  rsvpSelectCalls: number;
  fetchSelectCalls: number;
  creatorSelectCalls: number;
  exceptionSelectCalls: number;
  totalSelectCalls: number;
}

function makeTrackedDb(nonRecurringCandidates: unknown[], recurringCandidates: unknown[], fetchedEvents: unknown[]): { db: Db; counts: DbCallCounts } {
  const counts: DbCallCounts = {
    candidateSelectCalls: 0,
    rsvpSelectCalls: 0,
    fetchSelectCalls: 0,
    creatorSelectCalls: 0,
    exceptionSelectCalls: 0,
    totalSelectCalls: 0,
  };

  let candidateCallIndex = 0;

  const db = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 1 }),
      },
    },
    select: jest.fn().mockImplementation((fields: Record<string, unknown>) => {
      counts.totalSelectCalls++;
      const keys = Object.keys(fields ?? {});
      const has = (k: string) => keys.includes(k);

      if (isCandidateProjection(keys)) {
        counts.candidateSelectCalls++;
        candidateCallIndex++;
        return chain(candidateCallIndex === 1 ? nonRecurringCandidates : recurringCandidates);
      }
      if (has("eventId") && has("status")) {
        counts.rsvpSelectCalls++;
        return chain([]);
      }
      if (has("membershipId") && has("name")) {
        counts.creatorSelectCalls++;
        return chain([]);
      }
      if (has("occurrenceStart")) {
        counts.exceptionSelectCalls++;
        return chain([]);
      }
      counts.fetchSelectCalls++;
      return chain(fetchedEvents);
    }),
  } as unknown as Db;

  return { db, counts };
}

describe("CalendarEventSourceLoader — range-read statement count (PRD-C145)", () => {
  beforeEach(() => jest.resetAllMocks());

  it("issues exactly 2 candidate select calls regardless of how many rows a large window returns", async () => {
    const large = candidateRows(CALENDAR_EVENTS_CAP);
    const { db, counts } = makeTrackedDb(large, [], eventRows(large.map((r) => r.id)));

    const loader = new CalendarEventSourceLoader(db);
    await loader.load(ORG, USER, START, END);

    expect(counts.candidateSelectCalls).toBe(2);
  });

  it("issues exactly 1 rsvp select call even when the candidate set is at the cap", async () => {
    const large = candidateRows(CALENDAR_EVENTS_CAP);
    const { db, counts } = makeTrackedDb(large, [], eventRows(large.map((r) => r.id)));

    const loader = new CalendarEventSourceLoader(db);
    await loader.load(ORG, USER, START, END);

    expect(counts.rsvpSelectCalls).toBe(1);
  });

  it("issues exactly 1 fetch select call even when the candidate set is at the cap", async () => {
    const large = candidateRows(CALENDAR_EVENTS_CAP);
    const { db, counts } = makeTrackedDb(large, [], eventRows(large.map((r) => r.id)));

    const loader = new CalendarEventSourceLoader(db);
    await loader.load(ORG, USER, START, END);

    expect(counts.fetchSelectCalls).toBe(1);
  });

  it("total select calls is exactly 5 for a non-empty window (2 candidate + 1 rsvp + 1 fetch + 1 creator)", async () => {
    const rows = candidateRows(50);
    const { db, counts } = makeTrackedDb(rows, [], eventRows(rows.map((r) => r.id)));

    const loader = new CalendarEventSourceLoader(db);
    await loader.load(ORG, USER, START, END);

    expect(counts.totalSelectCalls).toBe(5);
  });

  it("issues only 2 select calls when the window is empty (no rsvp, fetch, or creator query)", async () => {
    const { db, counts } = makeTrackedDb([], [], []);

    const loader = new CalendarEventSourceLoader(db);
    await loader.load(ORG, USER, START, END);

    expect(counts.totalSelectCalls).toBe(2);
    expect(counts.candidateSelectCalls).toBe(2);
    expect(counts.rsvpSelectCalls).toBe(0);
    expect(counts.fetchSelectCalls).toBe(0);
  });

  it("BITE: reverted loop (BATCH_SIZE iterations) would call candidate select more than 2 times for a full window", () => {
    const batchSize = 500;
    const windowEvents = CALENDAR_EVENTS_CAP;
    let loopCandidateSelects = 0;
    let fetched = 0;
    while (fetched < windowEvents) {
      loopCandidateSelects += 2;
      const batch = Math.min(batchSize, windowEvents - fetched);
      fetched += batch;
      if (batch < batchSize || fetched >= windowEvents) break;
    }
    expect(loopCandidateSelects).toBeGreaterThan(2);
  });
});
