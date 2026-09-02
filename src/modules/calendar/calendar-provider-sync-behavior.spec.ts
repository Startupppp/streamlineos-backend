jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { forEachOrg } from "../../common/tenant";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CalendarProviderSyncSweepService } from "./calendar-provider-sync-sweep.service";
import type { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const mockedRunInTx = runInNewTenantTransaction as jest.MockedFunction<typeof runInNewTenantTransaction>;

const ORG = "org-sync-behavior";
const NOW = new Date("2026-09-01T12:00:00Z");

function makeMarkTx() {
  return {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
  };
}

function makeClaimingTx(rows: unknown[], captureWhere?: (w: unknown) => void) {
  return {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((w: unknown) => {
          captureWhere?.(w);
          return { returning: jest.fn().mockResolvedValue(rows) };
        }),
      }),
    }),
  };
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    orgId: ORG,
    connectionId: 5,
    operation: "create" as const,
    state: "PENDING" as const,
    payload: {
      userId: "user-1",
      title: "Standup",
      startIso: "2026-09-02T09:00:00Z",
      endIso: "2026-09-02T09:30:00Z",
      allDay: false,
      attendeeEmails: [],
      addConference: false,
    },
    eventId: 10,
    externalEventId: null,
    eventLocalVersion: null as number | null,
    attemptCount: 0,
    leaseExpiresAt: null,
    processedAt: null,
    lastError: null,
    createdAt: NOW,
    ...overrides,
  };
}

function makeResolveConnectionDb(connOverride: Record<string, unknown> = {}) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([
            { id: 5, toolkit: "googlecalendar", composioConnectedAccountId: "c-1", ...connOverride },
          ]),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockedRunInTx.mockImplementation(async (_db, _orgId, cb) => {
    await cb(makeMarkTx() as never);
  });
});

describe("(a) PENDING intent persists after provider failure", () => {
  it("when pushCreate throws a network error, the queue row is retried — not removed — durable pending intent", async () => {
    const row = makeRow();

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([row]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const pushCreate = jest.fn().mockRejectedValue(new Error("network timeout"));
    const sync = { pushCreate } as unknown as ExternalCalendarSyncService;

    const db = {
      ...makeResolveConnectionDb(),
      query: {
        calendarEvents: {
          findFirst: jest.fn().mockResolvedValue({
            id: 10,
            title: "Standup",
            description: null,
            startDate: new Date("2026-09-02T09:00:00Z"),
            endDate: new Date("2026-09-02T09:30:00Z"),
            allDay: false,
            externalEventId: null,
          }),
        },
      },
    } as unknown as Db;

    const svc = new CalendarProviderSyncSweepService(db, sync);
    const result = await svc.run(NOW);

    expect(pushCreate).toHaveBeenCalledTimes(1);
    expect(result.claimed).toBe(1);
    expect(result.retried).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);

    expect(mockedRunInTx).toHaveBeenCalledTimes(1);
  });

  it("a row that has already exhausted MAX_ATTEMPTS is marked FAILED, not silently dropped", async () => {
    const row = makeRow({ attemptCount: 4 });

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([row]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const pushCreate = jest.fn().mockRejectedValue(new Error("persistent failure"));
    const sync = { pushCreate } as unknown as ExternalCalendarSyncService;

    const db = {
      ...makeResolveConnectionDb(),
      query: {
        calendarEvents: {
          findFirst: jest.fn().mockResolvedValue({
            id: 10,
            title: "Standup",
            description: null,
            startDate: new Date("2026-09-02T09:00:00Z"),
            endDate: new Date("2026-09-02T09:30:00Z"),
            allDay: false,
            externalEventId: null,
          }),
        },
      },
    } as unknown as Db;

    const svc = new CalendarProviderSyncSweepService(db, sync);
    const result = await svc.run(NOW);

    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);
    expect(mockedRunInTx).toHaveBeenCalledTimes(1);
  });
});

describe("(a) Backoff is enforced — retried PENDING rows with future leaseExpiresAt excluded from claim", () => {
  it("the claim SQL includes a lease_expires_at IS NULL check for PENDING rows", async () => {
    let capturedWhere: unknown;

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([], (w) => { capturedWhere = w; }) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const svc = new CalendarProviderSyncSweepService({} as Db, {} as never);
    await svc.run(NOW);

    expect(capturedWhere).toBeDefined();
    const { sql } = dialect.sqlToQuery(capturedWhere as SQL);
    expect(sql.toLowerCase()).toContain("is null");
    expect(sql.toLowerCase()).toContain("lease_expires_at");
  });

  it("the backoff clause gates PENDING state (not only IN_FLIGHT)", async () => {
    let capturedWhere: unknown;

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([], (w) => { capturedWhere = w; }) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const svc = new CalendarProviderSyncSweepService({} as Db, {} as never);
    await svc.run(NOW);

    const { sql } = dialect.sqlToQuery(capturedWhere as SQL);
    const lowerSql = sql.toLowerCase();
    const pendingIdx = lowerSql.indexOf("pending");
    const inFlightIdx = lowerSql.indexOf("in_flight");
    const isNullIdx = lowerSql.indexOf("is null");
    expect(pendingIdx).toBeGreaterThanOrEqual(0);
    expect(inFlightIdx).toBeGreaterThanOrEqual(0);
    expect(isNullIdx).toBeGreaterThanOrEqual(0);
    expect(isNullIdx).toBeLessThan(inFlightIdx);
  });
});

describe("(c) Stale UPDATE job cancellation — superseded by newer PENDING/IN_FLIGHT job", () => {
  it("skips a stale UPDATE (eventLocalVersion < event.localVersion) when a newer PENDING job exists", async () => {
    const updateRow = makeRow({
      operation: "update" as const,
      externalEventId: "ext-cancel",
      eventLocalVersion: 1,
    });

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([updateRow]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const pushUpdate = jest.fn().mockResolvedValue({ success: true });
    const sync = { pushUpdate } as unknown as ExternalCalendarSyncService;

    const newerPendingRow = [{ id: updateRow.id + 1 }];
    let syncQueueSelectCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        const callIdx = syncQueueSelectCount++;
        if (callIdx === 0) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([
                  { id: 5, toolkit: "googlecalendar", composioConnectedAccountId: "c-1" },
                ]),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(newerPendingRow) }),
          }),
        };
      }),
      query: {
        calendarEvents: {
          findFirst: jest.fn().mockResolvedValue({
            id: 10,
            title: "Superseded Event",
            description: null,
            startDate: new Date("2026-09-02T09:00:00Z"),
            endDate: new Date("2026-09-02T09:30:00Z"),
            allDay: false,
            externalEventId: "ext-cancel",
            localVersion: 2,
          }),
        },
      },
    } as unknown as Db;

    const svc = new CalendarProviderSyncSweepService(db, sync);
    const result = await svc.run(NOW);

    expect(result.processed).toBe(1);
    expect(pushUpdate).not.toHaveBeenCalled();
  });

  it("does NOT skip an UPDATE job when eventLocalVersion is null (pre-migration rows are always processed)", async () => {
    const updateRow = makeRow({
      operation: "update" as const,
      externalEventId: "ext-legacy",
      eventLocalVersion: null,
    });

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([updateRow]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const pushUpdate = jest.fn().mockResolvedValue({ success: true });
    const sync = { pushUpdate } as unknown as ExternalCalendarSyncService;

    const db = {
      ...makeResolveConnectionDb(),
      query: {
        calendarEvents: {
          findFirst: jest.fn().mockResolvedValue({
            id: 10,
            title: "Legacy Event",
            description: null,
            startDate: new Date("2026-09-02T09:00:00Z"),
            endDate: new Date("2026-09-02T09:30:00Z"),
            allDay: false,
            externalEventId: "ext-legacy",
            localVersion: 5,
          }),
        },
      },
    } as unknown as Db;

    const svc = new CalendarProviderSyncSweepService(db, sync);
    const result = await svc.run(NOW);

    expect(result.processed).toBe(1);
    expect(pushUpdate).toHaveBeenCalledTimes(1);
  });

  it("does NOT skip an UPDATE when eventLocalVersion matches event.localVersion (job is current — not stale)", async () => {
    const currentVersion = 3;
    const updateRow = makeRow({
      operation: "update" as const,
      externalEventId: "ext-current",
      eventLocalVersion: currentVersion,
    });

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([updateRow]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const pushUpdate = jest.fn().mockResolvedValue({ success: true });
    const sync = { pushUpdate } as unknown as ExternalCalendarSyncService;

    const db = {
      ...makeResolveConnectionDb(),
      query: {
        calendarEvents: {
          findFirst: jest.fn().mockResolvedValue({
            id: 10,
            title: "Current Event",
            description: null,
            startDate: new Date("2026-09-02T09:00:00Z"),
            endDate: new Date("2026-09-02T09:30:00Z"),
            allDay: false,
            externalEventId: "ext-current",
            localVersion: currentVersion,
          }),
        },
      },
    } as unknown as Db;

    const svc = new CalendarProviderSyncSweepService(db, sync);
    const result = await svc.run(NOW);

    expect(result.processed).toBe(1);
    expect(pushUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("(b) Drift conflict — local wins: UPDATE uses live event state, ignores stale payload", () => {
  it("pushUpdate receives current eventRow title and times, not the stale payload snapshot", async () => {
    const STALE_TITLE = "Old Title from payload";
    const LIVE_TITLE = "Current Title in DB";
    const STALE_START = "2026-09-01T09:00:00.000Z";
    const LIVE_START = "2026-09-03T10:00:00.000Z";

    const updateRow = makeRow({
      operation: "update" as const,
      externalEventId: "ext-abc",
      payload: {
        userId: "user-1",
        title: STALE_TITLE,
        startIso: STALE_START,
        endIso: "2026-09-01T10:00:00.000Z",
        allDay: false,
        attendeeEmails: [],
        addConference: false,
      },
    });

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([updateRow]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const pushUpdate = jest.fn().mockResolvedValue({ success: true });
    const sync = { pushUpdate } as unknown as ExternalCalendarSyncService;

    const db = {
      ...makeResolveConnectionDb(),
      query: {
        calendarEvents: {
          findFirst: jest.fn().mockResolvedValue({
            id: 10,
            title: LIVE_TITLE,
            description: "Current description",
            startDate: new Date(LIVE_START),
            endDate: new Date("2026-09-03T11:00:00.000Z"),
            allDay: false,
            externalEventId: "ext-abc",
          }),
        },
      },
    } as unknown as Db;

    const svc = new CalendarProviderSyncSweepService(db, sync);
    const result = await svc.run(NOW);

    expect(result.processed).toBe(1);
    expect(pushUpdate).toHaveBeenCalledTimes(1);

    const [, , , pushed] = pushUpdate.mock.calls[0] as [unknown, unknown, unknown, { title: string; startIso: string; description: string | null; endIso: string }];
    expect(pushed.title).toBe(LIVE_TITLE);
    expect(pushed.startIso).toBe(LIVE_START);
    expect(pushed.title).not.toBe(STALE_TITLE);
    expect(pushed.startIso).not.toBe(STALE_START);
  });

  it("two stale UPDATE jobs for the same event both push the same current state (idempotent local-wins)", async () => {
    const LIVE_TITLE = "Final Title";

    const updateRow1 = makeRow({
      id: 2,
      operation: "update" as const,
      externalEventId: "ext-xyz",
      payload: { userId: "user-1", title: "First stale title", startIso: "2026-09-01T09:00:00.000Z", endIso: "2026-09-01T10:00:00.000Z", allDay: false },
    });
    const updateRow2 = makeRow({
      id: 3,
      operation: "update" as const,
      externalEventId: "ext-xyz",
      payload: { userId: "user-1", title: "Second stale title", startIso: "2026-09-01T09:30:00.000Z", endIso: "2026-09-01T10:30:00.000Z", allDay: false },
    });

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([updateRow1, updateRow2]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const pushUpdate = jest.fn().mockResolvedValue({ success: true });
    const sync = { pushUpdate } as unknown as ExternalCalendarSyncService;

    const liveEvent = {
      id: 10,
      title: LIVE_TITLE,
      description: null,
      startDate: new Date("2026-09-03T10:00:00Z"),
      endDate: new Date("2026-09-03T11:00:00Z"),
      allDay: false,
      externalEventId: "ext-xyz",
    };

    const db = {
      ...makeResolveConnectionDb(),
      query: {
        calendarEvents: {
          findFirst: jest.fn().mockResolvedValue(liveEvent),
        },
      },
    } as unknown as Db;

    const svc = new CalendarProviderSyncSweepService(db, sync);
    const result = await svc.run(NOW);

    expect(result.processed).toBe(2);
    expect(pushUpdate).toHaveBeenCalledTimes(2);
    for (const call of pushUpdate.mock.calls) {
      const pushed = call[3] as { title: string };
      expect(pushed.title).toBe(LIVE_TITLE);
    }
  });
});
