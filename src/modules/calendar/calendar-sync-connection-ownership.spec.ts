/**
 * BOLA on `POST /calendar/events`: an attacker-supplied `syncConnectionId`.
 *
 * `createEventSchema` validates the field as `z.number().int().positive()` and nothing
 * else, and `createEvent` wrote it straight into `calendar_provider_sync_queue.connectionId`
 * with no check that the caller owns it. The sweep's `resolveConnection` checked org,
 * status and toolkit — but not who the connection belongs to — and
 * `ExternalCalendarSyncService` hands `conn.composioConnectedAccountId` to
 * `ComposioGateway.executeTool`, which passes it to `client.tools.execute` as
 * `connectedAccountId`. It is the CONNECTION, not the `userId` argument travelling beside
 * it, that selects the Google or Outlook account the write lands in.
 *
 * So user A in org X sets `syncConnectionId` to user B's calendar connection — a serial,
 * trivially enumerable integer — and A's event title, description and attendee emails are
 * written into B's personal calendar, with A's later updates and deletes following. Root
 * CLAUDE.md §4 calls object-level authorization the first risk, and this endpoint had none
 * for this field. It was latent only because the queue had no drain; wiring
 * `/cron/calendar-provider-sync-sweep` is what makes it live, which is why the two are
 * fixed together.
 *
 * The check is the module's own `connectionOwnerPredicate` — membership first, `user_id`
 * only as the fallback for pre-membership rows — rather than a second ownership rule
 * written here. It runs before anything is written, so a refused sync leaves no event
 * behind, and it is applied inside the create transaction, on the membership row that
 * transaction has already resolved.
 */
import { NotFoundException } from "@nestjs/common";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { CalendarService } from "./calendar.service";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();

const ORG = "org-sync-ownership";
const ATTACKER = "user-attacker";
const ATTACKER_MEMBERSHIP = 31;
/** The victim's connection id: a serial, so guessing it is not the hard part. */
const VICTIM_CONNECTION_ID = 7;

interface Harness {
  db: Db;
  connectionWheres: SQL[];
  inserted: Array<{ table: string; row: Record<string, unknown> }>;
}

/**
 * A create-transaction whose `user_integration_connections` read answers only with the
 * connections the caller may actually use. `ownedConnections: []` is the attack: the row
 * exists in the tenant, it simply is not the caller's.
 */
function makeHarness(options: { ownedConnections: Array<{ id: number }> }): Harness {
  const connectionWheres: SQL[] = [];
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];

  const tx = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: ATTACKER_MEMBERSHIP }),
      },
    },
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation((table: Parameters<typeof getTableName>[0]) => {
        const name = getTableName(table);
        if (name === "user_integration_connections")
          return {
            where: jest.fn().mockImplementation((predicate: SQL) => {
              connectionWheres.push(predicate);
              return { limit: jest.fn().mockResolvedValue(options.ownedConnections) };
            }),
          };
        // organization_members, for the attendee expansion.
        return { where: jest.fn().mockResolvedValue([]) };
      }),
    })),
    insert: jest.fn().mockImplementation((table: Parameters<typeof getTableName>[0]) => {
      const name = getTableName(table);
      const record = (row: Record<string, unknown>) => {
        inserted.push({ table: name, row });
      };
      const returned = name === "calendar_events" ? [{ id: 99, localVersion: 1 }] : [];
      return {
        values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
          record(row);
          const result = Promise.resolve(returned);
          return Object.assign(result, {
            returning: jest.fn().mockResolvedValue(returned),
            onConflictDoNothing: jest.fn().mockResolvedValue(returned),
          });
        }),
      };
    }),
  };

  const db = {
    transaction: jest.fn().mockImplementation((cb: (t: unknown) => unknown) => cb(tx)),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
    }),
  };

  return { db: db as unknown as Db, connectionWheres, inserted };
}

function makeService(db: Db): CalendarService {
  return new CalendarService(
    db,
    {} as never,
    {
      checkConflictsInTx: jest.fn().mockResolvedValue([]),
      getOooConflicts: jest.fn().mockResolvedValue([]),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

const INPUT = {
  title: "Board review",
  description: "internal",
  startDate: "2026-09-10T09:00:00.000Z",
  endDate: "2026-09-10T10:00:00.000Z",
  timezone: "Asia/Kolkata",
  category: "meeting" as const,
  syncConnectionId: VICTIM_CONNECTION_ID,
};

describe("createEvent — syncConnectionId is an object reference, so it is authorized", () => {
  it("refuses a connection the caller does not own, and writes nothing at all", async () => {
    const harness = makeHarness({ ownedConnections: [] });
    const service = makeService(harness.db);

    await expect(service.createEvent(ORG, ATTACKER, INPUT)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // Not "no queue row" — NOTHING. A refused sync must not leave a half-created event
    // behind, which is why the check runs before the insert rather than beside it.
    expect(harness.inserted).toEqual([]);
  });

  it("binds the caller's own membership into that lookup, not the supplied id alone", async () => {
    const harness = makeHarness({ ownedConnections: [] });
    const service = makeService(harness.db);

    await service.createEvent(ORG, ATTACKER, INPUT).catch(() => undefined);

    expect(harness.connectionWheres).toHaveLength(1);
    const { sql, params } = dialect.sqlToQuery(harness.connectionWheres[0] as SQL);
    // The ownership rule is membership-first with a user_id fallback for pre-membership
    // rows; both columns must appear, or the predicate is not the shared one.
    expect(sql).toContain("membership_id");
    expect(sql).toContain("user_id");
    expect(params).toContain(ATTACKER_MEMBERSHIP);
    expect(params).toContain(ATTACKER);
    expect(params).toContain(ORG);
  });

  it("still enqueues the sync when the connection really is the caller's", async () => {
    // Anti-vacuity: a check that refused everything would pass the two tests above.
    const harness = makeHarness({ ownedConnections: [{ id: VICTIM_CONNECTION_ID }] });
    const service = makeService(harness.db);

    const result = await service.createEvent(ORG, ATTACKER, INPUT);

    expect(result.syncQueued).toBe(true);
    const queued = harness.inserted.find((row) => row.table === "calendar_provider_sync_queue");
    expect(queued?.row).toMatchObject({
      orgId: ORG,
      connectionId: VICTIM_CONNECTION_ID,
      operation: "create",
    });
  });

  it("does not look a connection up at all when no sync was requested", async () => {
    const harness = makeHarness({ ownedConnections: [] });
    const service = makeService(harness.db);

    const { syncConnectionId: _omitted, ...noSync } = INPUT;
    const result = await service.createEvent(ORG, ATTACKER, noSync);

    expect(result.syncQueued).toBe(false);
    expect(harness.connectionWheres).toEqual([]);
    expect(harness.inserted.map((row) => row.table)).toEqual(["calendar_events"]);
  });
});
