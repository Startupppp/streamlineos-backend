import type { Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../common/tenant";
import { CalendarReminderSweepService } from "./calendar-reminder-sweep.service";

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

import { forEachOrg } from "../../common/tenant";

const ORG = "org-paging";
const EVENT_ID = 900;
const ATTENDEE_PAGE_SIZE = 1000;
const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

interface AttendeeRow {
  id: number;
  eventId: number;
  userId: string;
  membershipId: number;
}

function attendeePage(startId: number, count: number): AttendeeRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    eventId: EVENT_ID,
    userId: `user-${startId + i}`,
    membershipId: startId + i,
  }));
}

function resolvingChain(result: unknown[]) {
  const limit = jest.fn().mockResolvedValue(result);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ limit, orderBy });
  const innerJoin = jest.fn().mockReturnValue({ where });
  return { from: jest.fn().mockReturnValue({ where, innerJoin }) };
}

describe("CalendarReminderSweepService — attendee recipient paging", () => {
  beforeEach(() => jest.resetAllMocks());

  it("emits an intent for every attendee across pages instead of truncating at one capped read", async () => {
    const now = new Date("2024-03-11T09:45:00Z");
    const eventStart = new Date("2024-03-11T10:00:00Z");

    const firstPage = attendeePage(1, ATTENDEE_PAGE_SIZE);
    const secondPage = attendeePage(ATTENDEE_PAGE_SIZE + 1, 7);

    const insertedBatches: { dedupeKey: string; targetUserIds: string[] }[][] = [];
    const returning = jest.fn().mockImplementation(() => {
      const batch = insertedBatches[insertedBatches.length - 1] ?? [];
      return Promise.resolve(batch.map((_, i) => ({ id: i + 1 })));
    });
    const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
    const values = jest
      .fn()
      .mockImplementation((payload: { dedupeKey: string; targetUserIds: string[] }[]) => {
        insertedBatches.push(Array.isArray(payload) ? payload : [payload]);
        return { onConflictDoNothing };
      });

    const updateWhere = jest.fn().mockResolvedValue([]);
    const set = jest.fn().mockReturnValue({ where: updateWhere });

    let attendeeReads = 0;

    mockedForEachOrg.mockImplementation(async (_db, _key, cb, _intent?) => {
      let selectCall = 0;
      const tx = {
        select: jest.fn().mockImplementation(() => {
          const idx = selectCall++;
          if (idx === 0)
            return resolvingChain([
              { id: EVENT_ID, title: "All hands", startDate: eventStart },
            ]);
          if (idx === 1) return resolvingChain([]);
          attendeeReads += 1;
          if (attendeeReads === 1) return resolvingChain(firstPage);
          if (attendeeReads === 2) return resolvingChain(secondPage);
          return resolvingChain([]);
        }),
        insert: jest.fn().mockReturnValue({ values }),
        update: jest.fn().mockReturnValue({ set }),
      } as unknown as TenantTx;

      await cb(tx, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const svc = new CalendarReminderSweepService({} as unknown as Db);
    const result = await svc.run(now);

    const allRows = insertedBatches.flat();
    expect(attendeeReads).toBe(2);
    expect(allRows).toHaveLength(ATTENDEE_PAGE_SIZE + secondPage.length);
    expect(result.intentsWritten).toBe(ATTENDEE_PAGE_SIZE + secondPage.length);

    const lastAttendee = secondPage[secondPage.length - 1];
    expect(lastAttendee).toBeDefined();
    expect(allRows.map((r) => r.targetUserIds[0])).toContain(lastAttendee?.userId);
  });
});
