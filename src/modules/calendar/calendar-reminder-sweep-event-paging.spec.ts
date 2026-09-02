jest.mock("../../common/tenant", () => ({ forEachOrg: jest.fn() }));

import { forEachOrg } from "../../common/tenant";
import { CalendarReminderSweepService } from "./calendar-reminder-sweep.service";
import type { Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../db/drizzle.types";

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

const ORG = "org-reminder-paging";
const EVENT_BATCH_LIMIT = 200;
const OVERFLOW = 5;

function eventPage(startId: number, count: number, startDate: Date) {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    title: `Event ${startId + i}`,
    startDate,
  }));
}

function resolvingChain(result: unknown[]) {
  const limit = jest.fn().mockResolvedValue(result);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ limit, orderBy });
  const innerJoin = jest.fn().mockReturnValue({ where });
  return { from: jest.fn().mockReturnValue({ where, innerJoin }) };
}

describe("CalendarReminderSweepService — event paging", () => {
  beforeEach(() => jest.resetAllMocks());

  it("drains past EVENT_BATCH_LIMIT instead of silently dropping every event after the first page", async () => {
    const now = new Date("2024-03-11T09:45:00Z");
    const eventStart = new Date("2024-03-11T10:00:00Z");

    const firstPage = eventPage(1, EVENT_BATCH_LIMIT, eventStart);
    const secondPage = eventPage(EVENT_BATCH_LIMIT + 1, OVERFLOW, eventStart);
    const totalEvents = EVENT_BATCH_LIMIT + OVERFLOW;

    const attendees = [
      { id: 1, eventId: 1, userId: "user-1", membershipId: 11 },
      { id: 2, eventId: EVENT_BATCH_LIMIT + OVERFLOW, userId: "user-2", membershipId: 12 },
    ];

    const insertedBatches: { entityId: string }[][] = [];
    const returning = jest.fn().mockImplementation(() => {
      const batch = insertedBatches[insertedBatches.length - 1] ?? [];
      return Promise.resolve(batch.map((_, i) => ({ id: i + 1 })));
    });
    const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockImplementation((payload: { entityId: string }[]) => {
      insertedBatches.push(Array.isArray(payload) ? payload : [payload]);
      return { onConflictDoNothing };
    });

    const markedWheres: unknown[] = [];
    const updateWhere = jest.fn().mockImplementation((w: unknown) => {
      markedWheres.push(w);
      return Promise.resolve([]);
    });
    const set = jest.fn().mockReturnValue({ where: updateWhere });

    let selectCall = 0;
    let eventReads = 0;
    let attendeeReads = 0;

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      const tx = {
        select: jest.fn().mockImplementation(() => {
          const idx = selectCall++;
          if (idx < 3) {
            eventReads += 1;
            if (idx === 0) return resolvingChain(firstPage);
            if (idx === 1) return resolvingChain(secondPage);
            return resolvingChain([]);
          }
          attendeeReads += 1;
          return resolvingChain(attendeeReads === 1 ? attendees : []);
        }),
        insert: jest.fn().mockReturnValue({ values }),
        update: jest.fn().mockReturnValue({ set }),
      } as unknown as TenantTx;

      await cb(tx, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const svc = new CalendarReminderSweepService({} as unknown as Db);
    const result = await svc.run(now);

    expect(result.candidates).toBe(totalEvents);
    expect(eventReads).toBe(3);

    const entityIds = new Set(insertedBatches.flat().map((row) => row.entityId));
    expect(entityIds.has(String(EVENT_BATCH_LIMIT + OVERFLOW))).toBe(true);
    expect(markedWheres).toHaveLength(1);
  });
});
