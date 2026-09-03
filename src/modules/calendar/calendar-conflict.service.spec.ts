import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { CalendarConflictService } from "./calendar-conflict.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { TenantTx } from "../../db/drizzle.types";

const WINDOW_START = new Date("2024-03-10T09:00:00Z");
const WINDOW_END = new Date("2024-03-10T10:00:00Z");

function makeEventRow(overrides: {
  id?: number;
  orgId?: string;
  createdByMembershipId?: number;
  startDate?: Date;
  endDate?: Date;
  allDay?: boolean;
}) {
  return {
    id: overrides.id ?? 1,
    title: "Meeting",
    startDate: overrides.startDate ?? WINDOW_START,
    endDate: overrides.endDate ?? WINDOW_END,
    allDay: overrides.allDay ?? false,
    timezone: "UTC",
    orgId: overrides.orgId ?? "org-1",
    createdByMembershipId: overrides.createdByMembershipId ?? 99,
    rrule: null,
    recurrenceEnd: null,
  };
}

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

interface TxProbe {
  tx: TenantTx;
  whereArgs: unknown[];
  memberFindFirst: jest.Mock;
}

function makeTxProbe(
  eventRows: ReturnType<typeof makeEventRow>[],
  attendeeRows: Array<{ eventId: number; status: string }>,
): TxProbe {
  let selectCallCount = 0;
  const whereArgs: unknown[] = [];
  const memberFindFirst = jest.fn().mockResolvedValue({ id: 1 });
  const record = (arg: unknown) => {
    whereArgs.push(arg);
  };
  const tx = {
    query: { organizationMembers: { findFirst: memberFindFirst } },
    select: jest.fn().mockImplementation(() => {
      selectCallCount += 1;
      if (selectCallCount === 1) {
        const chain = {
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockImplementation(function (this: unknown, arg: unknown) {
            record(arg);
            return this;
          }),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue(eventRows),
        };
        return chain;
      }
      return {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockImplementation((arg: unknown) => {
          record(arg);
          return Promise.resolve(attendeeRows);
        }),
      };
    }),
  } as unknown as TenantTx;
  return { tx, whereArgs, memberFindFirst };
}

function makeTx(eventRows: ReturnType<typeof makeEventRow>[], attendeeRows: Array<{ eventId: number; status: string }>): TenantTx {
  return makeTxProbe(eventRows, attendeeRows).tx;
}

describe("CalendarConflictService.checkConflictsInTx", () => {
  let service: CalendarConflictService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        CalendarConflictService,
        { provide: DRIZZLE, useValue: { transaction: jest.fn() } },
      ],
    }).compile();
    service = module.get(CalendarConflictService);
  });

  it("returns an occurrence when the organizer has a conflicting event", async () => {
    const tx = makeTx([makeEventRow({ createdByMembershipId: 1 })], []);
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(1);
    expect(result[0]?.eventId).toBe(1);
  });

  it("returns an occurrence when the user is an accepted attendee", async () => {
    const tx = makeTx(
      [makeEventRow({ id: 5, createdByMembershipId: 2 })],
      [{ eventId: 5, status: "accepted" }],
    );
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(1);
  });

  it("excludes the event when the user declined the invitation", async () => {
    const tx = makeTx(
      [makeEventRow({ id: 7, createdByMembershipId: 2 })],
      [{ eventId: 7, status: "declined" }],
    );
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(0);
  });

  it("excludes an event the user is neither organizer of nor invited to", async () => {
    const tx = makeTx([makeEventRow({ createdByMembershipId: 2 })], []);
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(0);
  });

  it("returns empty when there are no overlapping events", async () => {
    const tx = makeTx([], []);
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(0);
  });

  it("cross-tenant isolation: orgId is always bound (select is called with org-scoped predicates)", async () => {
    // This test asserted nothing at all: it called the service and ended. It was
    // green whether or not a single predicate carried the org.
    const { tx, whereArgs, memberFindFirst } = makeTxProbe(
      [makeEventRow({ createdByMembershipId: 1 })],
      [],
    );

    await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);

    const memberWhere = memberFindFirst.mock.calls[0]?.[0] as { where: unknown };
    expect(sqlValues(memberWhere.where)).toContain("org-1");

    // Every predicate individually: one org-unbound predicate among org-bound
    // siblings is invisible to a flattened check.
    expect(whereArgs.length).toBeGreaterThan(0);
    const unbound = whereArgs
      .map((w, i) => ({ i, values: sqlValues(w) }))
      .filter((e) => !e.values.includes("org-1"))
      .map((e) => `predicate #${e.i} does not bind the org: ${JSON.stringify(e.values)}`);
    expect(unbound).toEqual([]);
    expect(whereArgs.flatMap((w) => sqlValues(w))).not.toContain("org-2");
  });

  it("includes a pending attendee (not yet responded)", async () => {
    const tx = makeTx(
      [makeEventRow({ id: 9, createdByMembershipId: 2 })],
      [{ eventId: 9, status: "pending" }],
    );
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(1);
  });

  it("DST spring-forward: event spanning the DST gap is still a conflict", async () => {
    const dstStart = new Date("2024-03-10T06:59:00Z");
    const dstEnd = new Date("2024-03-10T07:30:00Z");
    const tx = makeTx(
      [makeEventRow({ createdByMembershipId: 1, startDate: dstStart, endDate: dstEnd })],
      [],
    );
    const winStart = new Date("2024-03-10T06:00:00Z");
    const winEnd = new Date("2024-03-10T08:00:00Z");
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", winStart, winEnd);
    expect(result).toHaveLength(1);
  });

  it("cancelled/declined attendance is not a conflict", async () => {
    const tx = makeTx(
      [makeEventRow({ id: 11, createdByMembershipId: 2 })],
      [{ eventId: 11, status: "declined" }],
    );
    const result = await service.checkConflictsInTx(tx, "org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(result).toHaveLength(0);
  });
});

describe("CalendarConflictService.checkConflicts wraps a transaction", () => {
  it("invokes db.transaction and passes its result through", async () => {
    const fakeOccurrence = {
      eventId: 1,
      title: "Fake",
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      allDay: false,
      timezone: "UTC",
      orgId: "org-1",
    };
    const mockDb = {
      transaction: jest.fn(async (fn: (tx: TenantTx) => Promise<unknown>) => {
        const tx = makeTx([makeEventRow({ createdByMembershipId: 1 })], []);
        return fn(tx);
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        CalendarConflictService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();
    const svc = module.get(CalendarConflictService);

    const result = await svc.checkConflicts("org-1", "user-1", WINDOW_START, WINDOW_END);
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ eventId: 1 });
    void fakeOccurrence;
  });
});
