jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { forEachOrg } from "../../common/tenant";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CalendarProviderSyncSweepService } from "./calendar-provider-sync-sweep.service";
import { CalendarSyncStatusService } from "./calendar-sync-status.service";
import { CalendarService } from "./calendar.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarExportService } from "./calendar-export.service";
import type { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const mockedRunInTx = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

const ORG = "org-divergence";
const OTHER_ORG = "org-divergence-other";
const DELETER = "user-deleter";
const BYSTANDER = "user-bystander";
const EVENT_ID = 77;
const MEMBER_ID = 9;
const CONNECTION_ID = 5;
const EXT_ID = "ext-provider-copy";
const NOW = new Date("2026-09-01T12:00:00Z");

function makeMarkTx() {
  return {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        // Drizzle's update builder is a thenable, so this stands in for both `await
        // …where(…)` (the queue-row mark) and `await …where(…).returning(…)` (the
        // external-id write-back, which now checks how many rows it matched so a
        // create-then-delete race can enqueue a compensating delete). One matched row
        // is the ordinary case these tests are about.
        where: jest.fn().mockImplementation(() =>
          Object.assign(Promise.resolve([]), {
            returning: jest.fn().mockResolvedValue([{ id: 10 }]),
          }),
        ),
      }),
    }),
  };
}

function makeClaimingTx(rows: unknown[]) {
  return {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  };
}

function makeQueueRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    orgId: ORG,
    connectionId: CONNECTION_ID,
    operation: "create" as const,
    state: "PENDING" as const,
    payload: {
      userId: DELETER,
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

function makeResolveConnectionDb() {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([
            {
              id: CONNECTION_ID,
              toolkit: "googlecalendar",
              composioConnectedAccountId: "c-1",
            },
          ]),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  // See calendar-provider-sync-tenant-context.spec.ts: the sweep's post-claim reads now
  // open their own tenant transaction, because on the pool `app.organization_id` is unset
  // and every RLS-protected table raises 42501. The read surface each test builds is
  // therefore reachable through the tenant tx too; `makeMarkTx()` keeps `update`.
  // `return`, not `await`: the reads that moved inside the tenant transaction consume
  // its result, so a mock that swallows it makes every one of them undefined.
  mockedRunInTx.mockImplementation(async (db, _orgId, cb) =>
    cb({ ...(db as object), ...makeMarkTx() } as never),
  );
});

describe("a delete leaves a tombstone that still names the event it removed", () => {
  it("enqueues the delete intent with the deleted event's own id, not null", async () => {
    const enqueued: Record<string, unknown>[] = [];

    const tx = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }),
        },
      },
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            { integrationConnectionId: CONNECTION_ID, externalEventId: EXT_ID },
          ]),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
          enqueued.push(row);
          return Promise.resolve([]);
        }),
      }),
    };

    const db = {
      transaction: jest.fn().mockImplementation((cb: (t: unknown) => unknown) => cb(tx)),
    } as unknown as Db;

    const svc = new CalendarService(
      db,
      {} as never,
      { checkConflictsInTx: jest.fn(), getOooConflicts: jest.fn() } as never,
      {} as never,
      new CalendarRecurrenceService(db),
      new CalendarExportService(db),
      {} as never,
    );

    const result = await svc.deleteEvent(ORG, DELETER, EVENT_ID);

    expect(result).toEqual({ deleted: true });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      orgId: ORG,
      eventId: EVENT_ID,
      operation: "delete",
      externalEventId: EXT_ID,
    });
    expect(enqueued[0]?.eventId).not.toBeNull();
  });
});

describe("a failed delete is observable and retryable after the local row is gone", () => {
  function makeStatusDb(opts: {
    memberRow?: { id: number };
    visibleEvent?: { id: number; createdByMembershipId: number };
    tombstoneRows?: unknown[];
    queueRows?: unknown[];
    captureTombstoneWhere?: (pred: SQL) => void;
    updateReturning?: { id: number }[];
  }): Db {
    const {
      memberRow,
      visibleEvent,
      tombstoneRows = [],
      queueRows = [],
      captureTombstoneWhere,
      updateReturning = [],
    } = opts;

    const visibilityFrom = jest.fn().mockReturnValue({
      leftJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(visibleEvent ? [visibleEvent] : []),
        }),
      }),
    });

    const queueShapedFrom = (rows: unknown[], capture?: (pred: SQL) => void) =>
      jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((pred: SQL) => {
          capture?.(pred);
          return {
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(rows),
            }),
          };
        }),
      });

    let call = 0;
    const select = jest.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) return { from: visibilityFrom };
      if (call === 2 && !visibleEvent)
        return { from: queueShapedFrom(tombstoneRows, captureTombstoneWhere) };
      return { from: queueShapedFrom(queueRows) };
    });

    return {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(memberRow) },
      },
      select,
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(updateReturning),
          }),
        }),
      }),
    } as unknown as Db;
  }

  const failedTombstone = {
    state: "FAILED" as const,
    attemptCount: 5,
    lastError: "provider 503",
    operation: "delete" as const,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    processedAt: null,
  };

  it("BITE: getSyncStatus surfaces the failed delete instead of a 404 that hides the divergence", async () => {
    const db = makeStatusDb({
      memberRow: { id: MEMBER_ID },
      visibleEvent: undefined,
      tombstoneRows: [{ id: 3 }],
      queueRows: [failedTombstone],
    });
    const svc = new CalendarSyncStatusService(db);

    const result = await svc.getSyncStatus(ORG, DELETER, EVENT_ID);

    expect(result.status).toBe("failed");
    expect(result.operation).toBe("delete");
    expect(result.retryable).toBe(true);
    expect(result.lastError).toBe("provider 503");
  });

  it("retrySync re-queues the orphaned delete, so the provider copy can still be removed", async () => {
    const db = makeStatusDb({
      memberRow: { id: MEMBER_ID },
      visibleEvent: undefined,
      tombstoneRows: [{ id: 3 }],
      updateReturning: [{ id: 3 }],
    });
    const svc = new CalendarSyncStatusService(db);

    const result = await svc.retrySync(ORG, DELETER, EVENT_ID);

    expect(result.requeued).toBe(1);
  });

  it("scopes the tombstone lookup to the org and to the person who issued the delete", async () => {
    let captured: SQL | undefined;
    const db = makeStatusDb({
      memberRow: { id: MEMBER_ID },
      visibleEvent: undefined,
      tombstoneRows: [{ id: 3 }],
      queueRows: [failedTombstone],
      captureTombstoneWhere: (pred) => {
        captured = pred;
      },
    });
    const svc = new CalendarSyncStatusService(db);

    await svc.getSyncStatus(ORG, DELETER, EVENT_ID);

    expect(captured).toBeDefined();
    const { sql, params } = dialect.sqlToQuery(captured as SQL);
    expect(sql).toContain("org_id");
    expect(sql).toContain("userId");
    expect(params).toContain(ORG);
    expect(params).toContain(DELETER);
    expect(params).toContain("delete");
    expect(params).not.toContain(OTHER_ORG);
  });

  it("BITE: a bystander gets a 404 — a tombstone is not a hole in event visibility", async () => {
    const bystanderDb = () =>
      makeStatusDb({
        memberRow: { id: MEMBER_ID },
        visibleEvent: undefined,
        tombstoneRows: [],
      });

    await expect(
      new CalendarSyncStatusService(bystanderDb()).getSyncStatus(ORG, BYSTANDER, EVENT_ID),
    ).rejects.toThrow(NotFoundException);
    await expect(
      new CalendarSyncStatusService(bystanderDb()).retrySync(ORG, BYSTANDER, EVENT_ID),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("a re-claimed CREATE never mints a second provider event", () => {
  function runSweep(externalEventId: string | null) {
    const row = makeQueueRow({ operation: "create" as const });

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([row]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const pushCreate = jest
      .fn()
      .mockResolvedValue({ externalEventId: "ext-second", meetingUrl: null });
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
            externalEventId,
            localVersion: 1,
          }),
        },
      },
    } as unknown as Db;

    const svc = new CalendarProviderSyncSweepService(db, sync);
    return { svc, pushCreate };
  }

  it("BITE: skips the push when the event already carries an external id from an earlier attempt", async () => {
    const { svc, pushCreate } = runSweep("ext-already-created");

    const result = await svc.run(NOW);

    expect(pushCreate).not.toHaveBeenCalled();
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("still pushes when the event has no external id yet", async () => {
    const { svc, pushCreate } = runSweep(null);

    const result = await svc.run(NOW);

    expect(pushCreate).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
  });
});
