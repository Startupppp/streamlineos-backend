/**
 * The second half of the provider-sync P0: wiring the cron route makes the sweep RUN,
 * and at journal head a sweep that runs fails every row it claims.
 *
 * `forEachOrg` establishes a tenant transaction — and therefore the `app.organization_id`
 * GUC — only for the duration of its own callback. `run()` uses that callback purely to
 * CLAIM rows; the processing loop runs afterwards, in a `@Public()` cron request that has
 * no ambient tenant context at all. Every read `processRow` then issued went straight to
 * the pool:
 *
 *   resolveConnection            → this.db.select().from(userIntegrationConnections)
 *   the event lookup             → this.db.query.calendarEvents.findFirst
 *   hasNewerPendingUpdateFor     → this.db.select().from(calendarProviderSyncQueue)
 *
 * All three tables carry `relrowsecurity = t` with `USING (org_id = app.current_org_id())`,
 * and that function RAISES rather than returning NULL when the GUC is unset. Measured on
 * scratch_head_1010 as `streamline_app` (rolbypassrls = false):
 *
 *   $ psql -c 'select count(*) from calendar_events'
 *   ERROR:  no tenant context: app.organization_id is not set for this transaction
 *   $ psql -c 'select count(*) from calendar_provider_sync_queue'
 *   ERROR:  no tenant context: app.organization_id is not set for this transaction
 *   $ psql -c 'select id, org_id from user_integration_connections limit 1'
 *   ERROR:  no tenant context: app.organization_id is not set for this transaction
 *
 * `resolveConnection` is the first of the three, so every claimed row threw before the
 * provider was ever called, was retried on the documented backoff, and reached FAILED
 * after five attempts. Adding the cron route without this would have turned "the queue
 * never drains" into "the queue drains into FAILED" — the same divergence with a
 * misleading status attached, which is why the two are fixed together.
 *
 * WHY THE EXISTING SWEEP SPECS ARE ALL GREEN OVER IT. Nine of them hand the service a
 * `db` whose `select`/`query` are jest mocks that resolve. A mock cannot raise a policy
 * error, so "reads outside a tenant transaction" and "reads inside one" are the same
 * thing to them. The harness below is the one that tells them apart: its POOL handle
 * refuses, exactly as the measured database does, and only the handle handed out by
 * `runInNewTenantTransaction` answers.
 */
jest.mock("../../common/tenant", () => ({ forEachOrg: jest.fn() }));
jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { forEachOrg } from "../../common/tenant";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CalendarProviderSyncSweepService } from "./calendar-provider-sync-sweep.service";
import type { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import type { Db } from "../../db/drizzle.module";

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const mockedRunInTx = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

const ORG = "org-sync-guc";
const CONNECTION_ID = 7;
const EVENT_ID = 42;

/** The error the real pool raises; `app.current_org_id()` uses ERRCODE 42501. */
function untenanted(): Promise<never> {
  const error: Error & { code?: string } = new Error(
    "no tenant context: app.organization_id is not set for this transaction",
  );
  error.code = "42501";
  return Promise.reject(error);
}

interface Harness {
  db: Db;
  sync: ExternalCalendarSyncService;
  txOrgIds: string[];
  pushedCreates: number;
  writeBacks: Record<string, unknown>[];
  marks: Record<string, unknown>[];
}

interface HarnessOptions {
  /** What the external-id write-back matches. `[]` models the event deleted mid-push. */
  writeBackRows?: { id: number }[];
  /** Rows inserted into calendar_provider_sync_queue from inside the sweep. */
  captureInserts?: Record<string, unknown>[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const { writeBackRows = [{ id: EVENT_ID }], captureInserts = [] } = options;
  const txOrgIds: string[] = [];
  const writeBacks: Record<string, unknown>[] = [];
  const marks: Record<string, unknown>[] = [];
  const counters = { pushedCreates: 0 };

  const claimedRow = {
    id: 1,
    orgId: ORG,
    eventId: EVENT_ID,
    connectionId: CONNECTION_ID,
    operation: "create",
    externalEventId: null,
    payload: { userId: "user-owner", title: "Standup" },
    state: "IN_FLIGHT",
    attemptCount: 0,
    lastError: null,
    leaseExpiresAt: null,
    createdAt: new Date(),
    processedAt: null,
    eventLocalVersion: 1,
  };

  const connectionRow = {
    id: CONNECTION_ID,
    toolkit: "googlecalendar",
    composioConnectedAccountId: "acct-1",
    userId: "user-owner",
    membershipId: 11,
  };

  const eventRow = {
    id: EVENT_ID,
    title: "Standup",
    description: null,
    startDate: new Date("2026-09-10T09:00:00Z"),
    endDate: new Date("2026-09-10T09:30:00Z"),
    allDay: false,
    externalEventId: null,
    localVersion: 1,
  };

  // The handle a tenant transaction hands out: the GUC is set, so reads answer.
  const tx = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          // The connection resolve wants the connection; the newer-update probe wants none.
          limit: jest.fn().mockImplementation(() => Promise.resolve([connectionRow])),
        }),
      }),
    })),
    query: {
      calendarEvents: { findFirst: jest.fn().mockResolvedValue(eventRow) },
      calendarProviderSyncQueue: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((patch: Record<string, unknown>) => ({
        // Drizzle's builder is itself a thenable, so `where(...)` has to answer both
        // `await …where(…)` (the mark) and `await …where(…).returning(…)` (the
        // write-back, which now has to see how many rows it actually matched).
        where: jest.fn().mockImplementation(() => {
          const isWriteBack = "externalEventId" in patch;
          if (isWriteBack) writeBacks.push(patch);
          else marks.push(patch);
          const rows = isWriteBack ? writeBackRows : [{ id: EVENT_ID }];
          return Object.assign(Promise.resolve(rows), {
            returning: jest.fn().mockResolvedValue(rows),
          });
        }),
      })),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
        captureInserts.push(row);
        return Promise.resolve([]);
      }),
    }),
  };

  mockedRunInTx.mockImplementation(async (_db, orgId, cb) => {
    txOrgIds.push(orgId);
    return cb(tx as never);
  });

  mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
    const claimTx = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([claimedRow]),
          }),
        }),
      }),
    };
    await cb(claimTx as never, ORG);
    return { organizations: 1, succeeded: 1, failed: 0 };
  });

  // The POOL handle. Nothing that a background sweep does may reach this: outside a
  // tenant transaction every one of these tables refuses the read.
  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockImplementation(untenanted) }),
      }),
    })),
    query: {
      calendarEvents: { findFirst: jest.fn().mockImplementation(untenanted) },
      calendarProviderSyncQueue: { findFirst: jest.fn().mockImplementation(untenanted) },
    },
  };

  const sync = {
    pushCreate: jest.fn().mockImplementation(() => {
      counters.pushedCreates += 1;
      return Promise.resolve({ externalEventId: "google-evt-1", meetingUrl: null });
    }),
    pushUpdate: jest.fn().mockResolvedValue({ success: true }),
    pushDelete: jest.fn().mockResolvedValue({ success: true }),
  };

  return {
    db: db as unknown as Db,
    sync: sync as unknown as ExternalCalendarSyncService,
    txOrgIds,
    writeBacks,
    marks,
    get pushedCreates() {
      return counters.pushedCreates;
    },
  };
}

describe("calendar provider-sync sweep — every post-claim read carries a tenant", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("processes a claimed create instead of raising 42501 on the pool", async () => {
    const harness = makeHarness();
    const service = new CalendarProviderSyncSweepService(harness.db, harness.sync);

    const result = await service.run();

    expect(result.claimed).toBe(1);
    // The whole point: the row is PROCESSED, not retried into FAILED.
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.retried).toBe(0);
    expect(harness.pushedCreates).toBe(1);
    expect(harness.writeBacks[0]).toMatchObject({ externalEventId: "google-evt-1" });
  });

  it("opens every one of those reads for the row's own organisation", async () => {
    const harness = makeHarness();
    const service = new CalendarProviderSyncSweepService(harness.db, harness.sync);

    await service.run();

    // Connection resolve, event read, write-back and the terminal mark: every one of
    // them names the claimed row's org, and no other.
    expect(harness.txOrgIds.length).toBeGreaterThanOrEqual(4);
    expect(new Set(harness.txOrgIds)).toEqual(new Set([ORG]));
  });
});

/**
 * F6 in the same audit: a create-then-delete race orphans the provider copy for ever.
 *
 * `pushCreate` mints the Google/Outlook event, and the id it returns is written back to
 * `calendar_events` in a SEPARATE transaction. The row count of that write-back was never
 * checked. If the user deletes the event in the gap — the gap is a whole provider round
 * trip wide — the update matches nothing, and `deleteEvent` (calendar.service.ts:433) only
 * enqueues a delete when the row it removed already carried `external_event_id`, which by
 * then it does not. So the local record is gone, the provider copy exists for ever, and
 * the queue row is marked PROCESSED with no signal that anything was lost.
 *
 * The compensating delete is enqueued from the one place that still knows the external
 * id: the push's own return value. `calendar_provider_sync_queue.event_id` is nullable and
 * the sweep's delete branch keys on `external_event_id` alone (it returns before the
 * `!row.eventId` guard), so a tombstone with no event behind it is a shape the queue and
 * the processor already support.
 */
describe("calendar provider-sync sweep — a create whose event vanished mid-push", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("enqueues a compensating delete carrying the id the provider just minted", async () => {
    const enqueued: Record<string, unknown>[] = [];
    const harness = makeHarness({ writeBackRows: [], captureInserts: enqueued });
    const service = new CalendarProviderSyncSweepService(harness.db, harness.sync);

    const result = await service.run();

    expect(harness.pushedCreates).toBe(1);
    // The write-back found nothing: the event was deleted while the push was in flight.
    expect(result.processed).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      orgId: ORG,
      operation: "delete",
      externalEventId: "google-evt-1",
      eventId: null,
      connectionId: CONNECTION_ID,
    });
  });

  it("enqueues nothing when the write-back lands, which is the ordinary case", async () => {
    const enqueued: Record<string, unknown>[] = [];
    const harness = makeHarness({ captureInserts: enqueued });
    const service = new CalendarProviderSyncSweepService(harness.db, harness.sync);

    await service.run();

    expect(harness.writeBacks).toHaveLength(1);
    expect(enqueued).toEqual([]);
  });
});
