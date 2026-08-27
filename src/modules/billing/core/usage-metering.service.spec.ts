import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { PaymentRequiredException } from "../../../common/http/api-exceptions";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingModule } from "./billing.module";
import { UsageMeteringService, type ReservationInput } from "./usage-metering.service";

let ambientTx: unknown = null;

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(ambientTx),
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(ambientTx),
}));

const dialect = new PgDialect();

function renderSql(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

const PERIOD_START = new Date("2026-08-01T00:00:00Z");
const PERIOD_END = new Date("2026-09-01T00:00:00Z");

function makeTx(options: { inserted?: { id: number }[] } = {}) {
  const calls: string[] = [];
  const executedSql: string[] = [];
  const predicates: string[] = [];
  const insertedValues: Record<string, unknown>[] = [];
  const updatedValues: Record<string, unknown>[] = [];
  const selectResults: Record<string, unknown>[][] = [];

  const execute = jest.fn().mockImplementation((statement: unknown) => {
    const rendered = renderSql(statement);
    executedSql.push(rendered);
    calls.push(rendered.includes("pg_advisory_xact_lock") ? "lock" : "execute");
    return Promise.resolve([]);
  });

  function nextRows(): Record<string, unknown>[] {
    return selectResults.shift() ?? [];
  }

  const chainOf = () => {
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    chain["from"] = passthrough;
    chain["where"] = (condition: unknown) => {
      if (condition) predicates.push(renderSql(condition));
      return chain;
    };
    chain["orderBy"] = passthrough;
    chain["limit"] = () => Promise.resolve(nextRows());
    chain["then"] = (onFulfilled: (rows: Record<string, unknown>[]) => unknown) => onFulfilled(nextRows());
    return chain;
  };

  const tx = {
    execute,
    select: jest.fn().mockImplementation(() => {
      calls.push("select");
      return chainOf();
    }),
    update: jest.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain["set"] = (values: Record<string, unknown>) => {
        updatedValues.push(values);
        calls.push("update");
        return chain;
      };
      chain["where"] = () => Promise.resolve([]);
      return chain;
    }),
    insert: jest.fn().mockImplementation(() => ({
      values: (values: Record<string, unknown>) => {
        insertedValues.push(values);
        calls.push("insert");
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(options.inserted ?? [{ id: 1 }]),
          }),
          onConflictDoUpdate: () => Promise.resolve([]),
          returning: () => Promise.resolve(options.inserted ?? [{ id: 1 }]),
        };
      },
    })),
  };

  return { tx, calls, executedSql, predicates, insertedValues, updatedValues, selectResults };
}

/** The reads `acquireReservation` makes, in order: the replay lookup, then settled and reserved usage. */
function queueAcquire(
  selectResults: Record<string, unknown>[][],
  usage: { settled?: number; reserved?: number; replay?: Record<string, unknown> } = {},
) {
  selectResults.push(usage.replay ? [usage.replay] : []);
  if (usage.replay) return;
  selectResults.push([{ settled: usage.settled ?? 0 }]);
  selectResults.push([{ reserved: usage.reserved ?? 0 }]);
}

async function buildService(db: unknown = {}): Promise<UsageMeteringService> {
  const moduleRef = await Test.createTestingModule({
    providers: [UsageMeteringService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return moduleRef.get(UsageMeteringService);
}

function reservationInput(overrides: Partial<ReservationInput> = {}): ReservationInput {
  return {
    orgId: "org1",
    meterKey: "api.calls",
    idempotencyKey: "req-1",
    quantity: 10,
    limit: 100,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    ...overrides,
  };
}

function activeReservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    meterKey: "api.calls",
    reservedQuantity: 10,
    status: "ACTIVE",
    expiresAt: new Date("2026-08-27T12:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  ambientTx = null;
});

describe("UsageMeteringService — registration", () => {
  it("is a provider of BillingModule", () => {
    const providers: unknown = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BillingModule);
    expect(Array.isArray(providers) ? providers : []).toContain(UsageMeteringService);
  });

  it("is exported by BillingModule, so a chargeable action can reserve before it spends", () => {
    const exported: unknown = Reflect.getMetadata(MODULE_METADATA.EXPORTS, BillingModule);
    expect(Array.isArray(exported) ? exported : []).toContain(UsageMeteringService);
  });
});

describe("UsageMeteringService — the reservation is atomic, never check-then-spend", () => {
  it("locks the meter, reads usage and inserts inside one transaction, in that order", async () => {
    const { tx, calls, selectResults } = makeTx();
    queueAcquire(selectResults, { settled: 20, reserved: 5 });
    ambientTx = tx;
    const service = await buildService();

    await service.acquireReservation(reservationInput());

    expect(calls[0]).toBe("lock");
    expect(calls.indexOf("select")).toBeGreaterThan(calls.indexOf("lock"));
    expect(calls.indexOf("insert")).toBeGreaterThan(calls.lastIndexOf("select"));
  });

  it("serializes on a key scoped to the organisation and the meter", async () => {
    const { tx, executedSql, selectResults } = makeTx();
    queueAcquire(selectResults);
    ambientTx = tx;
    const service = await buildService();

    await service.acquireReservation(reservationInput());

    expect(executedSql[0]).toContain("pg_advisory_xact_lock");
    expect(executedSql[0]).toContain("hashtextextended");
  });

  it("counts active reservations against the limit, so two callers cannot both take the last unit", async () => {
    const { tx, selectResults } = makeTx();
    queueAcquire(selectResults, { settled: 80, reserved: 15 });
    ambientTx = tx;
    const service = await buildService();

    await expect(service.acquireReservation(reservationInput({ quantity: 10 }))).rejects.toBeInstanceOf(
      PaymentRequiredException,
    );
  });

  it("does not insert a reservation it refused", async () => {
    const { tx, selectResults } = makeTx();
    queueAcquire(selectResults, { settled: 100 });
    ambientTx = tx;
    const service = await buildService();

    await expect(service.acquireReservation(reservationInput())).rejects.toBeInstanceOf(
      PaymentRequiredException,
    );
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("allows the reservation that exactly fills the limit", async () => {
    const { tx, selectResults } = makeTx();
    queueAcquire(selectResults, { settled: 85, reserved: 5 });
    ambientTx = tx;
    const service = await buildService();

    await expect(service.acquireReservation(reservationInput({ quantity: 10 }))).resolves.toMatchObject({
      status: "ACTIVE",
      reservedQuantity: 10,
    });
  });

  it("reserves without a ceiling when the meter is unlimited, so the ledger stays complete", async () => {
    const { tx, selectResults, insertedValues } = makeTx();
    queueAcquire(selectResults, { settled: 999_999 });
    ambientTx = tx;
    const service = await buildService();

    const result = await service.acquireReservation(reservationInput({ limit: null }));

    expect(result.status).toBe("ACTIVE");
    expect(insertedValues[0]).toMatchObject({ reservedQuantity: 10 });
  });

  it("only counts reservations that are active and have not expired", async () => {
    const { tx, predicates, selectResults } = makeTx();
    queueAcquire(selectResults);
    ambientTx = tx;
    const service = await buildService();

    await service.acquireReservation(reservationInput());

    const reservedPredicate = predicates.find((predicate) => predicate.includes("expires_at"));
    expect(reservedPredicate).toBeDefined();
    expect(reservedPredicate).toContain('"status" =');
    expect(reservedPredicate).toContain('"expires_at" >');
  });

  it("bounds settled usage to the billing period rather than counting all history", async () => {
    const { tx, predicates, selectResults } = makeTx();
    queueAcquire(selectResults);
    ambientTx = tx;
    const service = await buildService();

    await service.acquireReservation(reservationInput());

    const settledPredicate = predicates.find((predicate) => predicate.includes("occurred_at"));
    expect(settledPredicate).toContain('"occurred_at" >=');
    expect(settledPredicate).toContain('"occurred_at" <');
  });

  it("refuses rather than reserving against a usage figure it could not read", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([]);
    selectResults.push([]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.acquireReservation(reservationInput())).rejects.toThrow(/no row returned/);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("refuses a non-positive or fractional quantity before it touches the database", async () => {
    const { tx } = makeTx();
    ambientTx = tx;
    const service = await buildService();

    await expect(service.acquireReservation(reservationInput({ quantity: 0 }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.acquireReservation(reservationInput({ quantity: 1.5 }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it("stamps an expiry so an abandoned reservation stops holding quota", async () => {
    const { tx, selectResults, insertedValues } = makeTx();
    queueAcquire(selectResults);
    ambientTx = tx;
    const service = await buildService();

    const before = Date.now();
    await service.acquireReservation(reservationInput({ ttlMs: 60_000 }));
    const expiresAt = insertedValues[0]?.["expiresAt"];

    expect(expiresAt).toBeInstanceOf(Date);
    expect((expiresAt as Date).getTime()).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("returns the existing reservation for a repeated idempotency key rather than reserving twice", async () => {
    const { tx, selectResults } = makeTx();
    queueAcquire(selectResults, { replay: activeReservation() });
    ambientTx = tx;
    const service = await buildService();

    const result = await service.acquireReservation(reservationInput());

    expect(result).toMatchObject({ id: 5, replayed: true, status: "ACTIVE" });
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe("UsageMeteringService — settle and release", () => {
  it("records the settled quantity as a usage fact keyed on the reservation", async () => {
    const { tx, selectResults, insertedValues, updatedValues } = makeTx();
    selectResults.push([activeReservation()]);
    ambientTx = tx;
    const service = await buildService();

    const result = await service.settleReservation("org1", "api.calls", "req-1", 7);

    expect(result).toEqual({ settledQuantity: 7, alreadySettled: false });
    expect(updatedValues[0]).toMatchObject({ status: "SETTLED", settledQuantity: 7 });
    expect(insertedValues[0]).toMatchObject({ sourceKey: "reservation:5", quantity: 7 });
  });

  it("settles the full reservation when no actual quantity is given", async () => {
    const { tx, selectResults, insertedValues } = makeTx();
    selectResults.push([activeReservation()]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.settleReservation("org1", "api.calls", "req-1")).resolves.toEqual({
      settledQuantity: 10,
      alreadySettled: false,
    });
    expect(insertedValues[0]).toMatchObject({ quantity: 10 });
  });

  it("refuses to settle more than was reserved, so the reservation stays a ceiling", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([activeReservation()]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.settleReservation("org1", "api.calls", "req-1", 11)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("writes no usage event when the action consumed nothing", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([activeReservation()]);
    ambientTx = tx;
    const service = await buildService();

    await service.settleReservation("org1", "api.calls", "req-1", 0);

    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("is a no-op on a second settle rather than double-counting", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([activeReservation({ status: "SETTLED" })]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.settleReservation("org1", "api.calls", "req-1")).resolves.toEqual({
      settledQuantity: 10,
      alreadySettled: true,
    });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("reports a missing reservation rather than settling nothing", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.settleReservation("org1", "api.calls", "nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("releases an active reservation without recording usage", async () => {
    const { tx, selectResults, updatedValues } = makeTx();
    selectResults.push([activeReservation()]);
    ambientTx = tx;
    const service = await buildService();

    await service.releaseReservation("org1", "api.calls", "req-1", "provider call failed");

    expect(updatedValues[0]).toMatchObject({ status: "RELEASED", settledQuantity: 0 });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("refuses to release a settled reservation, because the money was already spent", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([activeReservation({ status: "SETTLED" })]);
    ambientTx = tx;
    const service = await buildService();

    await expect(
      service.releaseReservation("org1", "api.calls", "req-1", "too late"),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("is a no-op on a second release", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([activeReservation({ status: "RELEASED" })]);
    ambientTx = tx;
    const service = await buildService();

    await expect(
      service.releaseReservation("org1", "api.calls", "req-1", "again"),
    ).resolves.toBeUndefined();
    expect(tx.update).not.toHaveBeenCalled();
  });
});

describe("UsageMeteringService — duplicate and out-of-order events do not double-count", () => {
  it("reports a repeated source key as a duplicate rather than inserting again", async () => {
    const { tx } = makeTx({ inserted: [] });
    ambientTx = tx;
    const service = await buildService();

    await expect(
      service.ingestEvent({ orgId: "org1", meterKey: "api.calls", sourceKey: "s1", quantity: 3 }),
    ).resolves.toEqual({ id: null, duplicate: true });
  });

  it("accepts a late event under its own occurred-at rather than reordering it", async () => {
    const { tx, insertedValues } = makeTx();
    const occurredAt = new Date("2026-08-02T00:00:00Z");
    ambientTx = tx;
    const service = await buildService();

    await service.ingestEvent({
      orgId: "org1",
      meterKey: "api.calls",
      sourceKey: "late-1",
      quantity: 3,
      occurredAt,
    });

    expect(insertedValues[0]).toMatchObject({ occurredAt, sourceKey: "late-1" });
  });

  it("refuses a fractional quantity", async () => {
    const service = await buildService();
    await expect(
      service.ingestEvent({ orgId: "org1", meterKey: "api.calls", sourceKey: "s1", quantity: 1.5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("UsageMeteringService — rollups are rebuildable projections", () => {
  it("recomputes the period from the raw events and upserts the rollup", async () => {
    const { tx, selectResults, insertedValues } = makeTx();
    selectResults.push([{ total: 4200, events: 130 }]);
    ambientTx = tx;
    const service = await buildService();

    const result = await service.rebuildRollup("org1", "api.calls", "DAY", PERIOD_START, PERIOD_END);

    expect(result).toEqual({ totalQuantity: 4200, eventCount: 130 });
    expect(insertedValues[0]).toMatchObject({
      granularity: "DAY",
      totalQuantity: 4200,
      eventCount: 130,
      periodStart: PERIOD_START,
    });
  });

  it("refuses rather than writing a zero rollup it could not compute", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([]);
    ambientTx = tx;
    const service = await buildService();

    await expect(
      service.rebuildRollup("org1", "api.calls", "DAY", PERIOD_START, PERIOD_END),
    ).rejects.toThrow(/no row returned/);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe("UsageMeteringService — readMeterUsage", () => {
  const meter = { orgId: "org1", meterKey: "api.calls", periodStart: PERIOD_START, periodEnd: PERIOD_END };

  it("reports settled, reserved, committed and remaining against the limit", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([{ settled: 60 }]);
    selectResults.push([{ reserved: 15 }]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.readMeterUsage({ ...meter, limit: 100 })).resolves.toEqual({
      settledQuantity: 60,
      reservedQuantity: 15,
      committedQuantity: 75,
      limit: 100,
      remaining: 25,
    });
  });

  it("reports no remaining figure for an unlimited meter rather than a misleading number", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([{ settled: 60 }]);
    selectResults.push([{ reserved: 15 }]);
    ambientTx = tx;
    const service = await buildService();

    await expect(service.readMeterUsage({ ...meter, limit: null })).resolves.toMatchObject({
      limit: null,
      remaining: null,
    });
  });
});

describe("UsageMeteringService — no JS Date reaches a raw SQL template", () => {
  it("executes no raw statement but the advisory lock, so no period bound is interpolated", async () => {
    const { tx, executedSql, selectResults } = makeTx();
    queueAcquire(selectResults);
    selectResults.push([{ total: 1, events: 1 }]);
    ambientTx = tx;
    const service = await buildService();

    await service.acquireReservation(reservationInput());
    await service.rebuildRollup("org1", "api.calls", "DAY", PERIOD_START, PERIOD_END);

    expect(executedSql.length).toBeGreaterThan(0);
    for (const statement of executedSql) expect(statement).toContain("pg_advisory_xact_lock");
  });
});
