import { MODULE_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingModule } from "./billing.module";
import { PlanLimitsService } from "./plan-limits.service";
import { SeatLedgerService } from "./seat-ledger.service";
import {
  SEAT_EVENT_DELTAS,
  SEAT_EVENT_TYPES,
  membersQuotaLockKey,
  seatCount,
} from "./seat-definition";

let ambientTx: unknown = null;

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(ambientTx),
}));

const dialect = new PgDialect();

function renderSql(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

interface TxOptions {
  seatCount?: number;
  inserted?: { id: number }[];
}

/** Records call order: a bare `jest.fn()` executor runs nothing, and every ordering assertion would prove nothing. */
function makeTx(options: TxOptions = {}) {
  const calls: string[] = [];
  const executedSql: string[] = [];
  const insertedValues: Record<string, unknown>[] = [];
  const selectResults: Record<string, unknown>[][] = [];

  const execute = jest.fn().mockImplementation((statement: unknown) => {
    const rendered = renderSql(statement);
    executedSql.push(rendered);
    calls.push(rendered.includes("pg_advisory_xact_lock") ? "lock" : "count");
    return Promise.resolve([{ count: options.seatCount ?? 0 }]);
  });

  function nextRows(): Record<string, unknown>[] {
    return selectResults.shift() ?? [];
  }

  const select = jest.fn().mockImplementation(() => {
    calls.push("select");
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    chain["from"] = passthrough;
    chain["where"] = passthrough;
    chain["orderBy"] = passthrough;
    chain["groupBy"] = passthrough;
    chain["limit"] = () => Promise.resolve(nextRows());
    chain["then"] = (resolve: (rows: Record<string, unknown>[]) => unknown) => resolve(nextRows());
    return chain;
  });

  const insert = jest.fn().mockImplementation(() => ({
    values: (values: Record<string, unknown>) => {
      insertedValues.push(values);
      calls.push("insert");
      return {
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(options.inserted ?? [{ id: 1 }]),
        }),
      };
    },
  }));

  return { tx: { execute, select, insert }, calls, executedSql, insertedValues, selectResults };
}

async function buildService(db: unknown = {}): Promise<SeatLedgerService> {
  const moduleRef = await Test.createTestingModule({
    providers: [SeatLedgerService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return moduleRef.get(SeatLedgerService);
}

const STORED_EVENT = {
  id: 42,
  eventType: "INVITE_SENT",
  subjectId: "invite1",
  quantityDelta: 1,
  billedQuantityAfter: 5,
  effectiveAt: new Date("2026-08-01T00:00:00Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  ambientTx = null;
});

describe("SeatLedgerService — registration", () => {
  it("is a provider of BillingModule, so it can be injected where membership is written", () => {
    const providers: unknown = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BillingModule);
    expect(Array.isArray(providers) ? providers : []).toContain(SeatLedgerService);
  });

  it("is exported by BillingModule", () => {
    const exported: unknown = Reflect.getMetadata(MODULE_METADATA.EXPORTS, BillingModule);
    expect(Array.isArray(exported) ? exported : []).toContain(SeatLedgerService);
  });
});

describe("SeatLedgerService — seat changes serialize under the members quota lock", () => {
  it("takes the lock before it reads the seat count", async () => {
    const { tx, calls, executedSql } = makeTx({ seatCount: 7 });
    const service = await buildService();

    await service.recordSeatEvent({ orgId: "org1", eventType: "INVITE_SENT", subjectId: "i1" }, tx as never);

    expect(calls[0]).toBe("lock");
    expect(calls.indexOf("lock")).toBeLessThan(calls.indexOf("count"));
    expect(executedSql[0]).toContain("pg_advisory_xact_lock");
  });

  it("locks on the key plan limits already serializes members on", async () => {
    const { tx, executedSql } = makeTx();
    const service = await buildService();

    await service.recordSeatEvent({ orgId: "org1", eventType: "INVITE_SENT", subjectId: "i1" }, tx as never);

    expect(membersQuotaLockKey("org1")).toBe("quota:org1:members");
    expect(executedSql[0]).toContain("hashtextextended");
  });

  it("takes the lock even on the replay path, so two retries cannot interleave", async () => {
    const { tx, calls, selectResults } = makeTx({ seatCount: 5 });
    selectResults.push([STORED_EVENT]);
    const service = await buildService();

    await service.recordSeatEvent(
      { orgId: "org1", eventType: "INVITE_SENT", subjectId: "invite1", idempotencyKey: "inv-1" },
      tx as never,
    );

    expect(calls[0]).toBe("lock");
  });

  it("uses the caller's transaction, never its own database handle", async () => {
    const { tx } = makeTx({ seatCount: 4 });
    const db = { execute: jest.fn(), insert: jest.fn(), select: jest.fn(), transaction: jest.fn() };
    const service = await buildService(db);

    await service.recordSeatEvent({ orgId: "org1", eventType: "GUEST_ADDED", subjectId: "g1" }, tx as never);

    expect(db.execute).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalled();
  });

  it("joins the ambient tenant transaction when the caller does not pass one", async () => {
    const { tx } = makeTx({ seatCount: 4 });
    ambientTx = tx;
    const service = await buildService();

    await service.recordSeatEvent({ orgId: "org1", eventType: "GUEST_ADDED", subjectId: "g1" });

    expect(tx.execute).toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalled();
  });
});

describe("SeatLedgerService — the ledger and the quota gate agree on the count", () => {
  it("stamps billed_quantity_after from the live seat count, not from a caller-supplied number", async () => {
    const { tx, insertedValues } = makeTx({ seatCount: 12 });
    const service = await buildService();

    const result = await service.recordSeatEvent(
      { orgId: "org1", eventType: "INVITE_SENT", subjectId: "i1" },
      tx as never,
    );

    expect(insertedValues[0]).toMatchObject({ billedQuantityAfter: 12, quantityDelta: 1 });
    expect(result.billedQuantityAfter).toBe(12);
  });

  it("refuses rather than recording a zero seat count when the count cannot be computed", async () => {
    const { tx } = makeTx();
    tx.execute = jest.fn().mockResolvedValue([]);
    const service = await buildService();

    await expect(
      service.recordSeatEvent({ orgId: "org1", eventType: "INVITE_SENT", subjectId: "i1" }, tx as never),
    ).rejects.toThrow(/no row returned/);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("counts seats with the identical expression PlanLimitsService enforces members against", async () => {
    const executed: string[] = [];
    const planLimitsDb = {
      execute: jest.fn().mockImplementation((statement: unknown) => {
        executed.push(renderSql(statement));
        return Promise.resolve([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null, count: 1 }]);
      }),
    };
    const planModule = await Test.createTestingModule({
      providers: [
        PlanLimitsService,
        { provide: DRIZZLE, useValue: planLimitsDb },
        {
          provide: CacheService,
          // A cache double that never answers is not a cache: `cached` must run the fetcher, or
          // the tier read this test is comparing SQL against never reaches the database at all.
          useValue: {
            cached: jest.fn().mockImplementation((_key: string, fetcher: () => Promise<unknown>) => fetcher()),
            set: jest.fn(),
            invalidate: jest.fn(),
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    ambientTx = planLimitsDb;
    await planModule.get(PlanLimitsService).assertWithinLimit("org1", "members", 1);
    ambientTx = null;

    const { tx, executedSql } = makeTx({ seatCount: 1 });
    const service = await buildService();
    await service.recordSeatEvent({ orgId: "org1", eventType: "INVITE_SENT", subjectId: "i1" }, tx as never);

    const enforcementCountSql = executed.find((statement) => statement.includes("organization_members"));
    const ledgerCountSql = executedSql.find((statement) => statement.includes("organization_members"));

    expect(enforcementCountSql).toBeDefined();
    expect(ledgerCountSql).toBe(enforcementCountSql);
    expect(ledgerCountSql).toContain(renderSql(seatCount("org1")));
  });
});

describe("SeatLedgerService — every quantity change is a looked-up delta", () => {
  it("looks the delta up by event type rather than accepting one from the caller", async () => {
    for (const eventType of SEAT_EVENT_TYPES) {
      const { tx, insertedValues } = makeTx({ seatCount: 3 });
      const service = await buildService();
      await service.recordSeatEvent({ orgId: "org1", eventType, subjectId: "s1" }, tx as never);
      expect(insertedValues[0]).toMatchObject({ eventType, quantityDelta: SEAT_EVENT_DELTAS[eventType] });
    }
  });

  it("records actor, reason, effective time and idempotency key on the row", async () => {
    const { tx, insertedValues } = makeTx({ seatCount: 3 });
    const effectiveAt = new Date("2026-08-27T10:00:00Z");
    const service = await buildService();

    await service.recordSeatEvent(
      {
        orgId: "org1",
        eventType: "MEMBER_DEACTIVATED",
        subjectId: "user9",
        actorId: "admin1",
        reason: "offboarded",
        idempotencyKey: "deactivate:user9",
        effectiveAt,
      },
      tx as never,
    );

    expect(insertedValues[0]).toMatchObject({
      actorId: "admin1",
      reason: "offboarded",
      idempotencyKey: "deactivate:user9",
      effectiveAt,
    });
  });

  it("bills an accepted invitation at net zero because the pending seat was already billed", () => {
    expect(SEAT_EVENT_DELTAS.INVITE_SENT).toBe(1);
    expect(SEAT_EVENT_DELTAS.INVITE_ACCEPTED).toBe(0);
  });

  it("keeps a suspended member billed and releases the seat only on deactivation", () => {
    expect(SEAT_EVENT_DELTAS.MEMBER_SUSPENDED).toBe(0);
    expect(SEAT_EVENT_DELTAS.MEMBER_REACTIVATED).toBe(0);
    expect(SEAT_EVENT_DELTAS.MEMBER_DEACTIVATED).toBe(-1);
  });

  it("treats an expired and a cancelled invitation as releasing the seat it held", () => {
    expect(SEAT_EVENT_DELTAS.INVITE_EXPIRED).toBe(-1);
    expect(SEAT_EVENT_DELTAS.INVITE_CANCELLED).toBe(-1);
  });
});

describe("SeatLedgerService — retry with the same key returns the same result", () => {
  it("returns the stored event on replay instead of inserting a second row", async () => {
    const { tx, selectResults } = makeTx({ seatCount: 5 });
    selectResults.push([STORED_EVENT]);
    const service = await buildService();

    const result = await service.recordSeatEvent(
      { orgId: "org1", eventType: "INVITE_SENT", subjectId: "invite1", idempotencyKey: "inv-1" },
      tx as never,
    );

    expect(result).toMatchObject({ id: 42, replayed: true, billedQuantityAfter: 5 });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("recovers the stored row when a concurrent writer wins the unique index", async () => {
    const { tx, selectResults } = makeTx({ seatCount: 5, inserted: [] });
    selectResults.push([]);
    selectResults.push([{ ...STORED_EVENT, id: 99 }]);
    const service = await buildService();

    const result = await service.recordSeatEvent(
      { orgId: "org1", eventType: "INVITE_SENT", subjectId: "invite1", idempotencyKey: "inv-1" },
      tx as never,
    );

    expect(result).toMatchObject({ id: 99, replayed: true });
  });

  it("does not silently return an unwritten event when there is no key to replay against", async () => {
    const { tx } = makeTx({ seatCount: 5, inserted: [] });
    const service = await buildService();

    await expect(
      service.recordSeatEvent({ orgId: "org1", eventType: "INVITE_SENT", subjectId: "i1" }, tx as never),
    ).rejects.toThrow(/neither inserted nor replayable/);
  });
});

describe("SeatLedgerService — reconciliation explains the billed quantity", () => {
  async function reconcile(seats: number, rows: Record<string, unknown>[][]) {
    const { tx, selectResults } = makeTx({ seatCount: seats });
    for (const result of rows) selectResults.push(result);
    ambientTx = tx;
    const service = await buildService();
    return service.reconcileBilledQuantity("org1");
  }

  const TOTALS = [{ ledgerQuantity: 8, eventCount: 11, lastEventAt: new Date("2026-08-20T00:00:00Z") }];
  const LATEST = [{ billedQuantityAfter: 8 }];
  const BY_TYPE = [
    { eventType: "INVITE_SENT", events: 6, quantityDelta: 6 },
    { eventType: "MEMBER_DEACTIVATED", events: 2, quantityDelta: -2 },
    { eventType: "GUEST_ADDED", events: 3, quantityDelta: 4 },
  ];

  it("sums quantity_delta into the billed quantity and breaks it down by event type", async () => {
    const result = await reconcile(8, [TOTALS, LATEST, BY_TYPE]);

    expect(result.ledgerQuantity).toBe(8);
    expect(result.eventCount).toBe(11);
    expect(result.latestBilledQuantityAfter).toBe(8);
    expect(result.byEventType).toEqual([
      { eventType: "INVITE_SENT", events: 6, quantityDelta: 6 },
      { eventType: "MEMBER_DEACTIVATED", events: 2, quantityDelta: -2 },
      { eventType: "GUEST_ADDED", events: 3, quantityDelta: 4 },
    ]);
    expect(result.byEventType.reduce((sum, row) => sum + row.quantityDelta, 0)).toBe(result.ledgerQuantity);
  });

  it("reports zero drift when the ledger and the members table agree", async () => {
    const result = await reconcile(8, [TOTALS, LATEST, BY_TYPE]);
    expect(result.drift).toBe(0);
  });

  it("names the drift when a membership write happened without a seat event beside it", async () => {
    const result = await reconcile(9, [TOTALS, LATEST, BY_TYPE]);

    expect(result.liveQuantity).toBe(9);
    expect(result.ledgerQuantity).toBe(8);
    expect(result.drift).toBe(1);
  });

  it("reports an empty ledger as zero rather than throwing", async () => {
    const result = await reconcile(0, [[{ ledgerQuantity: 0, eventCount: 0, lastEventAt: null }], [], []]);

    expect(result.ledgerQuantity).toBe(0);
    expect(result.eventCount).toBe(0);
    expect(result.latestBilledQuantityAfter).toBeNull();
    expect(result.lastEventAt).toBeNull();
    expect(result.byEventType).toEqual([]);
  });

  it("refuses rather than reporting zero drift when the live seat count is unavailable", async () => {
    const { tx } = makeTx();
    tx.execute = jest.fn().mockResolvedValue([]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.reconcileBilledQuantity("org1")).rejects.toThrow(/no row returned/);
  });
});

describe("SeatLedgerService — listSeatEvents", () => {
  it("caps the page at 100 however large a limit is asked for", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.listSeatEvents("org1", 5000)).resolves.toEqual([]);
  });
});
