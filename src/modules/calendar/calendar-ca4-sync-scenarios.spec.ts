jest.mock("../integrations/core/composio.gateway", () => ({
  ComposioGateway: class {},
  ComposioToolError: class extends Error {
    constructor(message: string, public readonly isAuthError: boolean) {
      super(message);
      this.name = "ComposioToolError";
    }
  },
}));

jest.mock("../../common/tenant", () => ({ forEachOrg: jest.fn() }));
jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { forEachOrg } from "../../common/tenant";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { ComposioToolError } from "../integrations/core/composio.gateway";
import { CalendarProviderSyncSweepService } from "./calendar-provider-sync-sweep.service";
import { CalendarProviderWebhookService } from "./calendar-provider-webhook.service";
import { ExternalCalendarEventsService } from "./external-calendar-events.service";
import type { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import type { Db } from "../../db/drizzle.module";

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const mockedRunInTx = runInNewTenantTransaction as jest.MockedFunction<typeof runInNewTenantTransaction>;

const ORG = "org-ca4";
const NOW = new Date("2026-09-12T10:00:00Z");
const CONNECTION_ID = 7;
const EVENT_ID = 42;
const EXT_ID = "ext-ca4-event";
const USER_ID = "user-ca4";
const LOCAL_UPDATED_AT = new Date("2026-09-12T09:00:00Z");

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

function makeSweepRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    orgId: ORG,
    connectionId: CONNECTION_ID,
    operation: "create" as const,
    state: "IN_FLIGHT" as const,
    payload: { userId: USER_ID },
    eventId: EVENT_ID,
    externalEventId: null as string | null,
    eventLocalVersion: 1 as number | null,
    attemptCount: 0,
    leaseExpiresAt: null,
    processedAt: null,
    lastError: null as string | null,
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("CA4: revoked provider connection — auth error is terminal, not retried", () => {
  it("BITE: when pushCreate throws ComposioToolError(isAuthError=true), row is FAILED on first attempt, not retried", async () => {
    const row = makeSweepRow();
    const connectionUpdatePatches: unknown[] = [];
    const rowMarkPatches: unknown[] = [];

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([row]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    mockedRunInTx.mockImplementation(async (_db, _orgId, cb) => {
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([
                { id: CONNECTION_ID, toolkit: "googlecalendar", composioConnectedAccountId: "acct-1" },
              ]),
            }),
          }),
        }),
        query: {
          calendarEvents: {
            findFirst: jest.fn().mockResolvedValue({
              id: EVENT_ID, title: "Standup", description: null,
              startDate: new Date("2026-09-13T09:00:00Z"),
              endDate: new Date("2026-09-13T09:30:00Z"),
              allDay: false, externalEventId: null, localVersion: 1, rrule: null,
            }),
          },
        },
        update: jest.fn().mockImplementation(() => ({
          set: jest.fn().mockImplementation((patch: unknown) => ({
            where: jest.fn().mockImplementation(() => {
              const p = patch as Record<string, unknown>;
              if (p.status === "needs_reauth") connectionUpdatePatches.push(patch);
              else rowMarkPatches.push(patch);
              return Object.assign(Promise.resolve([]), {
                returning: jest.fn().mockResolvedValue([{ id: 1 }]),
              });
            }),
          })),
        })),
      };
      return cb(tx as never);
    });

    const sync = {
      pushCreate: jest.fn().mockRejectedValue(new ComposioToolError("token expired", true)),
    } as unknown as ExternalCalendarSyncService;

    const svc = new CalendarProviderSyncSweepService({} as Db, sync);
    const result = await svc.run(NOW);

    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);
    expect(result.processed).toBe(0);
  });

  it("BITE: the revoked connection is marked needs_reauth so the user sees a reconnect prompt", async () => {
    const row = makeSweepRow();
    const connectionUpdatePatches: unknown[] = [];

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([row]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    mockedRunInTx.mockImplementation(async (_db, _orgId, cb) => {
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([
                { id: CONNECTION_ID, toolkit: "googlecalendar", composioConnectedAccountId: "acct-1" },
              ]),
            }),
          }),
        }),
        query: {
          calendarEvents: {
            findFirst: jest.fn().mockResolvedValue({
              id: EVENT_ID, title: "Standup", description: null,
              startDate: new Date("2026-09-13T09:00:00Z"),
              endDate: new Date("2026-09-13T09:30:00Z"),
              allDay: false, externalEventId: null, localVersion: 1, rrule: null,
            }),
          },
        },
        update: jest.fn().mockImplementation(() => ({
          set: jest.fn().mockImplementation((patch: unknown) => ({
            where: jest.fn().mockImplementation(() => {
              const p = patch as Record<string, unknown>;
              if (p.status === "needs_reauth") connectionUpdatePatches.push(patch);
              return Object.assign(Promise.resolve([]), {
                returning: jest.fn().mockResolvedValue([{ id: 1 }]),
              });
            }),
          })),
        })),
      };
      return cb(tx as never);
    });

    const sync = {
      pushCreate: jest.fn().mockRejectedValue(new ComposioToolError("invalid_grant", true)),
    } as unknown as ExternalCalendarSyncService;

    const svc = new CalendarProviderSyncSweepService({} as Db, sync);
    await svc.run(NOW);

    expect(connectionUpdatePatches).toHaveLength(1);
    expect(connectionUpdatePatches[0]).toMatchObject({ status: "needs_reauth" });
  });

  it("a transient network error still retries — auth revocation does not make all errors permanent", async () => {
    const row = makeSweepRow();

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([row]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    mockedRunInTx.mockImplementation(async (_db, _orgId, cb) => {
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([
                { id: CONNECTION_ID, toolkit: "googlecalendar", composioConnectedAccountId: "acct-1" },
              ]),
            }),
          }),
        }),
        query: {
          calendarEvents: {
            findFirst: jest.fn().mockResolvedValue({
              id: EVENT_ID, title: "Standup", description: null,
              startDate: new Date("2026-09-13T09:00:00Z"),
              endDate: new Date("2026-09-13T09:30:00Z"),
              allDay: false, externalEventId: null, localVersion: 1, rrule: null,
            }),
          },
        },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation(() =>
              Object.assign(Promise.resolve([]), {
                returning: jest.fn().mockResolvedValue([{ id: 1 }]),
              }),
            ),
          }),
        }),
      };
      return cb(tx as never);
    });

    const sync = {
      pushCreate: jest.fn().mockRejectedValue(new Error("ECONNRESET")),
    } as unknown as ExternalCalendarSyncService;

    const svc = new CalendarProviderSyncSweepService({} as Db, sync);
    const result = await svc.run(NOW);

    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("ComposioToolError with isAuthError = false is treated as transient (retried, not terminal)", async () => {
    const row = makeSweepRow();

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([row]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    mockedRunInTx.mockImplementation(async (_db, _orgId, cb) => {
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([
                { id: CONNECTION_ID, toolkit: "googlecalendar", composioConnectedAccountId: "acct-1" },
              ]),
            }),
          }),
        }),
        query: {
          calendarEvents: {
            findFirst: jest.fn().mockResolvedValue({
              id: EVENT_ID, title: "Standup", description: null,
              startDate: new Date("2026-09-13T09:00:00Z"),
              endDate: new Date("2026-09-13T09:30:00Z"),
              allDay: false, externalEventId: null, localVersion: 1, rrule: null,
            }),
          },
        },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation(() =>
              Object.assign(Promise.resolve([]), {
                returning: jest.fn().mockResolvedValue([{ id: 1 }]),
              }),
            ),
          }),
        }),
      };
      return cb(tx as never);
    });

    const sync = {
      pushCreate: jest.fn().mockRejectedValue(new ComposioToolError("rate limited", false)),
    } as unknown as ExternalCalendarSyncService;

    const svc = new CalendarProviderSyncSweepService({} as Db, sync);
    const result = await svc.run(NOW);

    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe("CA4: duplicate and out-of-order webhook delivery", () => {
  function makeWebhookHarness(options: {
    event?: {
      id: number;
      updatedAt: Date;
      localVersion: number;
      integrationConnectionId: number | null;
      externalEventId: string;
      createdByMembershipId: number;
    } | null;
    pendingSyncRows?: { id: number }[];
    memberUserId?: string | null;
    inserted?: Record<string, unknown>[];
  }) {
    const {
      event = null,
      pendingSyncRows = [],
      memberUserId = "user-webhook",
      inserted: capturedInserts = [],
    } = options;

    let selectCall = 0;
    const tx = {
      select: jest.fn().mockImplementation(() => {
        const callIdx = selectCall++;
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(
                callIdx === 0 ? (event ? [event] : []) : pendingSyncRows,
              ),
            }),
          }),
        };
      }),
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(
            memberUserId !== null ? { userId: memberUserId } : undefined,
          ),
        },
      },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
          capturedInserts.push(row);
          return Promise.resolve([]);
        }),
      }),
    };

    mockedRunInTx.mockImplementation(async (_db, _orgId, cb) => cb(tx as never));

    const db = {} as unknown as Db;
    return { db, inserts: capturedInserts };
  }

  const baseEvent = {
    id: EVENT_ID,
    updatedAt: LOCAL_UPDATED_AT,
    localVersion: 3,
    integrationConnectionId: CONNECTION_ID,
    externalEventId: EXT_ID,
    createdByMembershipId: 5,
  };

  const newerTimestamp = new Date(LOCAL_UPDATED_AT.getTime() + 10_000).toISOString();
  const olderTimestamp = new Date(LOCAL_UPDATED_AT.getTime() - 10_000).toISOString();
  const sameTimestamp = LOCAL_UPDATED_AT.toISOString();

  it("BITE: discards a delivery where providerUpdatedAt is older than the local event.updatedAt", async () => {
    const { db } = makeWebhookHarness({ event: baseEvent });
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(ORG, EXT_ID, olderTimestamp);

    expect(result.action).toBe("discarded");
  });

  it("BITE: discards a delivery where providerUpdatedAt equals the local event.updatedAt (boundary)", async () => {
    const { db } = makeWebhookHarness({ event: baseEvent });
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(ORG, EXT_ID, sameTimestamp);

    expect(result.action).toBe("discarded");
  });

  it("a delivery with a timestamp strictly newer than updatedAt is NOT discarded as out-of-order (anti-vacuity)", async () => {
    const inserts: Record<string, unknown>[] = [];
    const { db } = makeWebhookHarness({ event: baseEvent, memberUserId: "user-ok", inserted: inserts });
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(ORG, EXT_ID, newerTimestamp);

    expect(result.action).toBe("requeued");
    expect(inserts).toHaveLength(1);
  });

  it("BITE: discards a newer delivery when a pending sync row already exists (duplicate protection)", async () => {
    const inserts: Record<string, unknown>[] = [];
    const { db } = makeWebhookHarness({
      event: baseEvent,
      pendingSyncRows: [{ id: 99 }],
      inserted: inserts,
    });
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(ORG, EXT_ID, newerTimestamp);

    expect(result.action).toBe("discarded");
    expect(inserts).toHaveLength(0);
  });

  it("a newer delivery with no pending sync row proceeds to requeue (anti-vacuity for pending check)", async () => {
    const inserts: Record<string, unknown>[] = [];
    const { db } = makeWebhookHarness({
      event: baseEvent,
      pendingSyncRows: [],
      memberUserId: "user-ok",
      inserted: inserts,
    });
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(ORG, EXT_ID, newerTimestamp);

    expect(result.action).toBe("requeued");
    expect(inserts).toHaveLength(1);
  });
});

describe("CA4: disconnected user — departed member webhook is discarded", () => {
  function makeWebhookHarness(memberUserId: string | null) {
    const baseEvent = {
      id: EVENT_ID,
      updatedAt: LOCAL_UPDATED_AT,
      localVersion: 3,
      integrationConnectionId: CONNECTION_ID,
      externalEventId: EXT_ID,
      createdByMembershipId: 5,
    };
    const newerTimestamp = new Date(LOCAL_UPDATED_AT.getTime() + 10_000).toISOString();

    let selectCall = 0;
    const tx = {
      select: jest.fn().mockImplementation(() => {
        const callIdx = selectCall++;
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(callIdx === 0 ? [baseEvent] : []),
            }),
          }),
        };
      }),
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(
            memberUserId !== null ? { userId: memberUserId } : undefined,
          ),
        },
      },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockResolvedValue([]),
      }),
    };

    mockedRunInTx.mockImplementation(async (_db, _orgId, cb) => cb(tx as never));
    return { db: {} as unknown as Db, newerTimestamp };
  }

  it("BITE: discards a drift webhook when the event creator has departed (membership lookup returns null)", async () => {
    const { db, newerTimestamp } = makeWebhookHarness(null);
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(ORG, EXT_ID, newerTimestamp);

    expect(result.action).toBe("discarded");
  });

  it("an active member's webhook is still requeued (anti-vacuity)", async () => {
    const { db, newerTimestamp } = makeWebhookHarness("user-active");
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(ORG, EXT_ID, newerTimestamp);

    expect(result.action).toBe("requeued");
  });
});

describe("CA4: disconnected user — auth error in external events marks connection needs_reauth", () => {
  it("BITE: when fetching external events returns an auth error, the connection is marked needs_reauth", async () => {
    const { ComposioToolError: MockToolError } = await import(
      "../integrations/core/composio.gateway"
    );
    const authErr = new MockToolError("token expired", true);

    mockedRunInTx.mockImplementation(async (_db, _orgId, cb) => cb(_db as never));

    const connectionUpdateArgs: unknown[] = [];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            {
              id: CONNECTION_ID,
              toolkit: "googlecalendar",
              accountEmail: "me@gmail.com",
              composioConnectedAccountId: "ca-1",
            },
          ]),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((patch: unknown) => {
          connectionUpdateArgs.push(patch);
          return {
            where: jest.fn().mockReturnValue({
              catch: jest.fn().mockResolvedValue(undefined),
            }),
          };
        }),
      }),
    } as unknown as Db;

    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const gateway = {
      isConfigured: jest.fn().mockReturnValue(true),
      executeTool: jest.fn().mockRejectedValue(authErr),
    } as never;

    const svc = new ExternalCalendarEventsService(db, cache, gateway);
    const result = await svc.getExternalEvents(ORG, USER_ID, "2026-09-01", "2026-09-30");

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.connectionId).toBe(CONNECTION_ID);
    expect(connectionUpdateArgs).toHaveLength(1);
    expect(connectionUpdateArgs[0]).toMatchObject({ status: "needs_reauth" });
  });

  it("a non-auth error is reported in errors but does NOT mark the connection", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            {
              id: CONNECTION_ID,
              toolkit: "googlecalendar",
              accountEmail: "me@gmail.com",
              composioConnectedAccountId: "ca-1",
            },
          ]),
        }),
      }),
      update: jest.fn(),
    } as unknown as Db;

    const { ComposioToolError: MockToolError } = await import(
      "../integrations/core/composio.gateway"
    );
    const nonAuthErr = new MockToolError("provider 503", false);

    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const gateway = {
      isConfigured: jest.fn().mockReturnValue(true),
      executeTool: jest.fn().mockRejectedValue(nonAuthErr),
    } as never;

    const svc = new ExternalCalendarEventsService(db, cache, gateway);
    const result = await svc.getExternalEvents(ORG, USER_ID, "2026-09-01", "2026-09-30");

    expect(result.errors).toHaveLength(1);
    expect(db.update as jest.Mock).not.toHaveBeenCalled();
  });
});

describe("CA4: account ownership — user isolation in external event reads", () => {
  it("BITE: getExternalEvents only returns connections for the requesting userId, not other users in the same org", async () => {
    const VIEWER = "user-viewer";
    const OTHER = "user-other";
    const capturedPredicateValues: unknown[] = [];

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((pred: unknown) => {
            function extract(v: unknown, seen = new Set<object>()): unknown[] {
              if (v === null || v === undefined || typeof v === "string" || typeof v === "number") return [v];
              if (Array.isArray(v)) return v.flatMap((i) => extract(i, seen));
              if (typeof v !== "object" || seen.has(v)) return [];
              seen.add(v);
              const r = v as { queryChunks?: unknown[]; value?: unknown };
              return [...(r.queryChunks ? extract(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? extract(r.value, seen) : [])];
            }
            capturedPredicateValues.push(...extract(pred));
            return Promise.resolve([]);
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ catch: jest.fn() }) }),
      }),
    } as unknown as Db;

    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const gateway = { isConfigured: jest.fn().mockReturnValue(true), executeTool: jest.fn().mockResolvedValue({ items: [] }) } as never;

    const svc = new ExternalCalendarEventsService(db, cache, gateway);
    await svc.getExternalEvents(ORG, VIEWER, "2026-09-01", "2026-09-30");

    expect(capturedPredicateValues).toContain(VIEWER);
    expect(capturedPredicateValues).toContain(ORG);
    expect(capturedPredicateValues).not.toContain(OTHER);
  });

  it("when two users in the same org each call getExternalEvents, their connection queries are scoped independently", async () => {
    const USER_A = "user-alice";
    const USER_B = "user-bob";
    const aPredicates: unknown[] = [];
    const bPredicates: unknown[] = [];

    function makeDb(capture: unknown[]) {
      return {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((pred: unknown) => {
              function extract(v: unknown, seen = new Set<object>()): unknown[] {
                if (v === null || v === undefined || typeof v === "string" || typeof v === "number") return [v];
                if (Array.isArray(v)) return v.flatMap((i) => extract(i, seen));
                if (typeof v !== "object" || seen.has(v)) return [];
                seen.add(v);
                const r = v as { queryChunks?: unknown[]; value?: unknown };
                return [...(r.queryChunks ? extract(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? extract(r.value, seen) : [])];
              }
              capture.push(...extract(pred));
              return Promise.resolve([]);
            }),
          }),
        }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ catch: jest.fn() }) }),
        }),
      } as unknown as Db;
    }

    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const gateway = { isConfigured: jest.fn().mockReturnValue(true), executeTool: jest.fn().mockResolvedValue({ items: [] }) } as never;

    await new ExternalCalendarEventsService(makeDb(aPredicates), cache, gateway)
      .getExternalEvents(ORG, USER_A, "2026-09-01", "2026-09-30");
    await new ExternalCalendarEventsService(makeDb(bPredicates), cache, gateway)
      .getExternalEvents(ORG, USER_B, "2026-09-01", "2026-09-30");

    expect(aPredicates).toContain(USER_A);
    expect(aPredicates).not.toContain(USER_B);
    expect(bPredicates).toContain(USER_B);
    expect(bPredicates).not.toContain(USER_A);
  });
});

describe("CA4: retry/cancel race — state machine is self-consistent", () => {
  it("retrySync resets FAILED → PENDING, making the row visible to cancelSync", async () => {
    const { CalendarSyncStatusService } = await import("./calendar-sync-status.service");

    const deleted: unknown[] = [];
    const returning = jest.fn().mockResolvedValue([{ id: 1 }]);
    const updateWhere = jest.fn().mockReturnValue({ returning });
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const update = jest.fn().mockReturnValue({ set: updateSet });

    const del = jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation((pred: unknown) => {
        deleted.push(pred);
        return { returning: jest.fn().mockResolvedValue([{ id: 1 }]) };
      }),
    });

    const visibilityLimitFn = jest.fn().mockResolvedValue([
      { id: EVENT_ID, createdByMembershipId: 10 },
    ]);
    const visibilityFrom = jest.fn().mockReturnValue({
      leftJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: visibilityLimitFn }),
      }),
    });

    const db = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 10 }) },
      },
      select: jest.fn().mockReturnValue({ from: visibilityFrom }),
      update,
      delete: del,
    } as unknown as Db;

    const svc = new CalendarSyncStatusService(db);

    const retryResult = await svc.retrySync(ORG, USER_ID, EVENT_ID);
    expect(retryResult.requeued).toBe(1);

    const cancelResult = await svc.cancelSync(ORG, USER_ID, EVENT_ID);
    expect(cancelResult.cancelled).toBe(1);
    expect(deleted).toHaveLength(1);
  });

  it("cancelSync on an IN_FLIGHT row reports 0 — sweep-held row cannot be cancelled", async () => {
    const { CalendarSyncStatusService } = await import("./calendar-sync-status.service");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const dialect = new PgDialect();
    const { sql } = await import("drizzle-orm");

    let capturedDeleteWhere: import("drizzle-orm").SQL | undefined;

    const db = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 10 }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ id: EVENT_ID, createdByMembershipId: 10 }]),
            }),
          }),
        }),
      }),
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((pred: import("drizzle-orm").SQL) => {
          capturedDeleteWhere = pred;
          return { returning: jest.fn().mockResolvedValue([]) };
        }),
      }),
    } as unknown as Db;

    const svc = new CalendarSyncStatusService(db);
    const result = await svc.cancelSync(ORG, USER_ID, EVENT_ID);

    expect(result.cancelled).toBe(0);
    expect(capturedDeleteWhere).toBeDefined();
    const { params } = dialect.sqlToQuery(capturedDeleteWhere as import("drizzle-orm").SQL);
    expect(params).toContain("PENDING");
    expect(params).not.toContain("IN_FLIGHT");
  });
});

describe("CA4: provider timeout — transient failure with retry", () => {
  it("a provider timeout is retried with exponential backoff, not marked terminal", async () => {
    const row = makeSweepRow();

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([row]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const marks: unknown[] = [];
    mockedRunInTx.mockImplementation(async (_db, _orgId, cb) => {
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([
                { id: CONNECTION_ID, toolkit: "googlecalendar", composioConnectedAccountId: "acct-1" },
              ]),
            }),
          }),
        }),
        query: {
          calendarEvents: {
            findFirst: jest.fn().mockResolvedValue({
              id: EVENT_ID, title: "Standup", description: null,
              startDate: new Date("2026-09-13T09:00:00Z"),
              endDate: new Date("2026-09-13T09:30:00Z"),
              allDay: false, externalEventId: null, localVersion: 1, rrule: null,
            }),
          },
        },
        update: jest.fn().mockImplementation(() => ({
          set: jest.fn().mockImplementation((patch: unknown) => ({
            where: jest.fn().mockImplementation(() => {
              marks.push(patch);
              return Object.assign(Promise.resolve([]), {
                returning: jest.fn().mockResolvedValue([{ id: 1 }]),
              });
            }),
          })),
        })),
      };
      return cb(tx as never);
    });

    const timeoutError = new Error("Request timed out after 30000ms");
    const sync = {
      pushCreate: jest.fn().mockRejectedValue(timeoutError),
    } as unknown as ExternalCalendarSyncService;

    const svc = new CalendarProviderSyncSweepService({} as Db, sync);
    const result = await svc.run(NOW);

    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.processed).toBe(0);

    const rowMark = (marks as Array<Record<string, unknown>>).find((p) => p.state !== undefined);
    expect(rowMark?.state).toBe("PENDING");
    expect(rowMark?.lastError).toContain("timed out");
    expect(rowMark?.leaseExpiresAt).toBeInstanceOf(Date);
  });
});
