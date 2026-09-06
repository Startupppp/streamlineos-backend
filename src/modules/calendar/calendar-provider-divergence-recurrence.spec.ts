jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { forEachOrg } from "../../common/tenant";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CalendarProviderSyncSweepService } from "./calendar-provider-sync-sweep.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarService } from "./calendar.service";
import { CalendarExportService } from "./calendar-export.service";
import { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import { ProviderCapabilityError } from "./external-event-normalizers";
import type { ComposioGateway } from "../integrations/core/composio.gateway";
import type { Db } from "../../db/drizzle.module";

/**
 * "Prevent permanent local/external divergence" (PRD-C129), on the four paths that
 * silently produced it. Each is a state the user is never told about: the local calendar
 * and the provider disagree for ever and `getSyncStatus` says `synced`.
 *
 *  1. NO RECURRENCE IN THE PUSH. `PushEventInput` had no rrule field, so a weekly series
 *     reached Google as ONE meeting at the first occurrence — wrong from the very first
 *     push, and uncorrectable because nothing recorded that anything was missing.
 *  2. OCCURRENCE EDITS ENQUEUED NOTHING. `calendar-recurrence.service.ts` appeared at no
 *     `insert(calendarProviderSyncQueue)` site at all, so moving or cancelling ONE
 *     occurrence changed the local calendar and told the provider nothing.
 *  3. A REFUSED PUSH REPORTED `synced`. `pushUpdate`/`pushDelete` return
 *     `{ success: false }` when `PROVIDER_CAPABILITIES` cannot express the write; the
 *     sweep logged a warning and returned normally, so the row was marked PROCESSED and
 *     `mapState` projected `synced` — beyond the reach of FAILED-only `retrySync`.
 *  4. A DELETE CARRIED NO `eventLocalVersion`, so the last link in an event's version
 *     chain could not be ordered against the create and update rows before it.
 */
const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const mockedRunInTx = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

const ORG = "org-recurrence";
const USER = "user-1";
const EVENT_ID = 31;
const MEMBER_ID = 7;
const CONNECTION_ID = 4;
const EXT_ID = "ext-master";
const RRULE = "FREQ=WEEKLY;COUNT=6";
const NOW = new Date("2026-09-01T12:00:00Z");
const OCCURRENCE_START = new Date("2026-09-15T09:00:00.000Z");

const GOOGLE_CONN = { id: CONNECTION_ID, toolkit: "googlecalendar" as const, composioConnectedAccountId: "ca_1" };
const OUTLOOK_CONN = { ...GOOGLE_CONN, toolkit: "outlook" as const };

const BASE_PUSH = {
  title: "Standup",
  description: null,
  startIso: "2026-09-02T09:00:00.000Z",
  endIso: "2026-09-02T09:30:00.000Z",
  allDay: false,
  attendeeEmails: [],
  addConference: false,
};

function makeGateway(result: unknown = { id: "gev1" }) {
  return {
    executeTool: jest.fn().mockResolvedValue(result),
  } as unknown as ComposioGateway;
}

function makeMarkTx() {
  return {
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

function makeQueueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: ORG,
    connectionId: CONNECTION_ID,
    operation: "update" as const,
    state: "PENDING" as const,
    payload: { userId: USER },
    eventId: EVENT_ID,
    externalEventId: EXT_ID,
    eventLocalVersion: null as number | null,
    attemptCount: 0,
    leaseExpiresAt: null,
    processedAt: null,
    lastError: null,
    createdAt: NOW,
    ...overrides,
  };
}

/** The connection lookup plus the event read the sweep performs after claiming a row. */
function makeSweepDb(eventRow: Record<string, unknown>) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([GOOGLE_CONN]),
        }),
      }),
    }),
    query: {
      calendarEvents: { findFirst: jest.fn().mockResolvedValue(eventRow) },
    },
  } as unknown as Db;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockedRunInTx.mockImplementation(async (db, _orgId, cb) =>
    cb({ ...(db as object), ...makeMarkTx() } as never),
  );
});

describe("1. the series' recurrence rule reaches the provider", () => {
  it("BITE: a Google create carries the RRULE as a recurrence content line", async () => {
    const gateway = makeGateway();
    const service = new ExternalCalendarSyncService(gateway);

    await service.pushCreate(USER, GOOGLE_CONN, { ...BASE_PUSH, rrule: RRULE });

    const args = (gateway.executeTool as jest.Mock).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(args.recurrence).toEqual([`RRULE:${RRULE}`]);
  });

  it("does not invent a recurrence for a one-off event", async () => {
    const gateway = makeGateway();
    const service = new ExternalCalendarSyncService(gateway);

    await service.pushCreate(USER, GOOGLE_CONN, { ...BASE_PUSH, rrule: null });

    const args = (gateway.executeTool as jest.Mock).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(args.recurrence).toBeUndefined();
  });

  it("keeps an already-prefixed rule intact rather than double-prefixing it", async () => {
    const gateway = makeGateway();
    const service = new ExternalCalendarSyncService(gateway);

    await service.pushCreate(USER, GOOGLE_CONN, { ...BASE_PUSH, rrule: `RRULE:${RRULE}` });

    const args = (gateway.executeTool as jest.Mock).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(args.recurrence).toEqual([`RRULE:${RRULE}`]);
  });

  it("BITE: refuses the push outright when the provider cannot represent a series", async () => {
    const gateway = makeGateway();
    const service = new ExternalCalendarSyncService(gateway);

    // The honest alternative to a silently-wrong single meeting. Outlook's create tool
    // exposes no recurrence argument, so the series must not be pushed at all.
    await expect(
      service.pushCreate(USER, OUTLOOK_CONN, { ...BASE_PUSH, rrule: RRULE }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    expect(gateway.executeTool).not.toHaveBeenCalled();
  });

  it("still pushes a one-off to that same provider", async () => {
    const gateway = makeGateway({ id: "oev1" });
    const service = new ExternalCalendarSyncService(gateway);

    await service.pushCreate(USER, OUTLOOK_CONN, { ...BASE_PUSH, rrule: null });

    expect(gateway.executeTool).toHaveBeenCalledTimes(1);
  });

  it("the create enqueued beside a recurring event carries its rrule", async () => {
    const enqueued: Record<string, unknown>[] = [];
    const tx = {
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }) } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() =>
            Object.assign(Promise.resolve([{ id: CONNECTION_ID }]), {
              limit: jest.fn().mockResolvedValue([{ id: CONNECTION_ID }]),
            }),
          ),
        }),
      }),
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
          enqueued.push(row);
          return Object.assign(Promise.resolve([{ id: EVENT_ID, localVersion: 1 }]), {
            returning: jest.fn().mockResolvedValue([{ id: EVENT_ID, localVersion: 1 }]),
            onConflictDoNothing: jest.fn().mockResolvedValue([]),
          });
        }),
      })),
    };
    const db = {
      transaction: jest.fn().mockImplementation((cb: (t: unknown) => unknown) => cb(tx)),
    } as unknown as Db;

    const svc = new CalendarService(
      db,
      {} as never,
      { checkConflictsInTx: jest.fn().mockResolvedValue([]), getOooConflicts: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      new CalendarRecurrenceService(db),
      new CalendarExportService(db),
      {} as never,
    );

    await svc.createEvent(ORG, USER, {
      title: "Standup",
      startDate: BASE_PUSH.startIso,
      endDate: BASE_PUSH.endIso,
      timezone: "UTC",
      category: "general",
      rrule: RRULE,
      syncConnectionId: CONNECTION_ID,
    } as never);

    const queued = enqueued.find((row) => row.operation === "create");
    expect(queued).toBeDefined();
    expect((queued?.payload as Record<string, unknown>).rrule).toBe(RRULE);
  });
});

describe("2. a per-occurrence edit enqueues a provider-sync intent", () => {
  function makeRecurrenceDb(captured: Record<string, unknown>[]) {
    const tx = {
      query: {
        calendarEvents: {
          findFirst: jest.fn().mockResolvedValue({ id: EVENT_ID, createdByMembershipId: MEMBER_ID }),
        },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
          captured.push(row);
          return Object.assign(Promise.resolve([row]), {
            returning: jest.fn().mockResolvedValue([row]),
            onConflictDoUpdate: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([row]),
            }),
          });
        }),
      })),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() =>
            Object.assign(Promise.resolve([]), {
              returning: jest.fn().mockResolvedValue([
                {
                  integrationConnectionId: CONNECTION_ID,
                  externalEventId: EXT_ID,
                  localVersion: 9,
                },
              ]),
            }),
          ),
        }),
      }),
    };
    return {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }) },
      },
      // `getRecurringEventForOwner` reads the series off the pool, before the write
      // transaction opens: it decides whether there is anything to edit at all.
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest
              .fn()
              .mockResolvedValue([{ createdByMembershipId: MEMBER_ID, rrule: RRULE }]),
          }),
        }),
      }),
      transaction: jest.fn().mockImplementation((cb: (t: unknown) => unknown) => cb(tx)),
    } as unknown as Db;
  }

  it("BITE: moving one occurrence queues an occurrence-scoped update", async () => {
    const captured: Record<string, unknown>[] = [];
    const svc = new CalendarRecurrenceService(makeRecurrenceDb(captured));

    await svc.upsertOccurrenceException(ORG, USER, EVENT_ID, OCCURRENCE_START.toISOString(), {
      modifiedStart: "2026-09-16T09:00:00.000Z",
      modifiedEnd: "2026-09-16T10:00:00.000Z",
    });

    const queued = captured.find((row) => row.operation === "update");
    expect(queued).toBeDefined();
    expect(queued).toMatchObject({
      orgId: ORG,
      eventId: EVENT_ID,
      connectionId: CONNECTION_ID,
      externalEventId: EXT_ID,
      // The just-bumped version, so the occurrence write takes its place in the same
      // monotonic chain as the create/update/delete rows rather than sitting outside it.
      eventLocalVersion: 9,
    });
    expect((queued?.payload as Record<string, unknown>).occurrenceStart).toBe(
      OCCURRENCE_START.toISOString(),
    );
  });

  it("BITE: cancelling one occurrence queues an occurrence-scoped delete", async () => {
    const captured: Record<string, unknown>[] = [];
    const svc = new CalendarRecurrenceService(makeRecurrenceDb(captured));

    await svc.cancelOccurrence(ORG, USER, EVENT_ID, OCCURRENCE_START.toISOString());

    const queued = captured.find((row) => row.operation === "delete");
    expect(queued).toBeDefined();
    expect((queued?.payload as Record<string, unknown>).occurrenceStart).toBe(
      OCCURRENCE_START.toISOString(),
    );
  });

  it("an instance write addresses the occurrence, not the whole series", async () => {
    const gateway = makeGateway();
    const service = new ExternalCalendarSyncService(gateway);

    await service.pushUpdate(
      USER,
      GOOGLE_CONN,
      EXT_ID,
      {
        title: "Standup",
        description: null,
        startIso: "2026-09-16T09:00:00.000Z",
        endIso: "2026-09-16T10:00:00.000Z",
        rrule: null,
      },
      { nominalStart: OCCURRENCE_START, allDay: false },
    );

    const args = (gateway.executeTool as jest.Mock).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(args.event_id).toBe(`${EXT_ID}_20260915T090000Z`);
    // Carrying the series rule on an instance write would rewrite the whole series from
    // the one occurrence being moved.
    expect(args.recurrence).toBeUndefined();
  });
});

describe("3. a refused push is reported as failed, never as synced", () => {
  function runSweep(row: Record<string, unknown>, sync: Partial<ExternalCalendarSyncService>) {
    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([row]) as never, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });
    const db = makeSweepDb({
      id: EVENT_ID,
      title: "Standup",
      description: null,
      startDate: new Date(BASE_PUSH.startIso),
      endDate: new Date(BASE_PUSH.endIso),
      allDay: false,
      externalEventId: EXT_ID,
      localVersion: 1,
      rrule: null,
    });
    return new CalendarProviderSyncSweepService(db, sync as ExternalCalendarSyncService);
  }

  it("BITE: an update the provider refuses ends FAILED, not PROCESSED", async () => {
    const svc = runSweep(makeQueueRow(), {
      pushUpdate: jest
        .fn()
        .mockResolvedValue({ success: false, reason: "outlook does not support event updates" }),
    });

    const result = await svc.run(NOW);

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);
  });

  it("BITE: a delete the provider refuses ends FAILED, not PROCESSED", async () => {
    const svc = runSweep(makeQueueRow({ operation: "delete" as const }), {
      pushDelete: jest
        .fn()
        .mockResolvedValue({ success: false, reason: "outlook does not support event deletion" }),
    });

    const result = await svc.run(NOW);

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("a capability refusal is terminal on the first attempt rather than burning the ladder", async () => {
    const svc = runSweep(makeQueueRow({ attemptCount: 0 }), {
      pushUpdate: jest.fn().mockRejectedValue(new ProviderCapabilityError("cannot represent")),
    });

    const result = await svc.run(NOW);

    // `retried` would mean a backoff was scheduled for a push that can never succeed.
    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);
  });

  it("an ordinary transient failure still retries", async () => {
    const svc = runSweep(makeQueueRow({ attemptCount: 0 }), {
      pushUpdate: jest.fn().mockRejectedValue(new Error("provider 503")),
    });

    const result = await svc.run(NOW);

    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("a push the provider accepts is still PROCESSED", async () => {
    const svc = runSweep(makeQueueRow(), {
      pushUpdate: jest.fn().mockResolvedValue({ success: true }),
    });

    const result = await svc.run(NOW);

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe("4. a delete takes its place in the event's version chain", () => {
  it("BITE: the delete queue row is stamped with the version it removed", async () => {
    const enqueued: Record<string, unknown>[] = [];
    const tx = {
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBER_ID }) } },
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            {
              integrationConnectionId: CONNECTION_ID,
              externalEventId: EXT_ID,
              localVersion: 4,
            },
          ]),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
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

    await svc.deleteEvent(ORG, USER, EVENT_ID);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.eventLocalVersion).toBe(4);
  });
});
