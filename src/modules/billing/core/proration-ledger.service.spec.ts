import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingModule } from "./billing.module";
import { ProrationLedgerService, type ProrationChangeInput } from "./proration-ledger.service";
import { ProrationLedgerReportsService } from "./proration-ledger-reports.service";
import { VersionedCatalogService } from "./versioned-catalog.service";

let ambientTx: unknown = null;

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(ambientTx),
}));

const PERIOD_START = new Date("2026-01-01T00:00:00Z");
const PERIOD_END = new Date("2026-02-01T00:00:00Z");
const MIDPOINT = new Date("2026-01-16T12:00:00Z");

function price(id: number, amountMinor: number, currency = "INR") {
  return {
    id,
    planId: 1,
    amountMinor,
    currency,
    billingInterval: "MONTH",
    taxBehavior: "EXCLUSIVE",
    effectiveFrom: PERIOD_START,
    effectiveUntil: null,
  };
}

function makeTx(options: { existing?: Record<string, unknown>[]; inserted?: { id: number }[] } = {}) {
  const insertedValues: Record<string, unknown>[] = [];
  const updatedValues: Record<string, unknown>[] = [];
  const selectResults: Record<string, unknown>[][] = [];
  if (options.existing) selectResults.push(options.existing);

  function nextRows(): Record<string, unknown>[] {
    return selectResults.shift() ?? [];
  }

  const chainOf = (resolve: () => Record<string, unknown>[]) => {
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    chain["from"] = passthrough;
    chain["where"] = passthrough;
    chain["orderBy"] = passthrough;
    chain["set"] = passthrough;
    chain["limit"] = () => Promise.resolve(resolve());
    chain["returning"] = () => Promise.resolve(resolve());
    chain["then"] = (onFulfilled: (rows: Record<string, unknown>[]) => unknown) => onFulfilled(resolve());
    return chain;
  };

  const tx = {
    select: jest.fn().mockImplementation(() => chainOf(nextRows)),
    update: jest.fn().mockImplementation(() => {
      const chain = chainOf(nextRows);
      chain["set"] = (values: Record<string, unknown>) => {
        updatedValues.push(values);
        return chain;
      };
      return chain;
    }),
    insert: jest.fn().mockImplementation(() => ({
      values: (values: Record<string, unknown>) => {
        insertedValues.push(values);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(options.inserted ?? [{ id: 1 }]),
          }),
        };
      },
    })),
    execute: jest.fn().mockResolvedValue([]),
  };

  return { tx, insertedValues, updatedValues, selectResults };
}

function makeCatalog(prices: Record<number, ReturnType<typeof price> | null>): VersionedCatalogService {
  return {
    getPriceVersionById: jest.fn().mockImplementation((id: number) => Promise.resolve(prices[id] ?? null)),
  } as unknown as VersionedCatalogService;
}

async function buildService(catalog: VersionedCatalogService): Promise<ProrationLedgerService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProrationLedgerService,
      { provide: DRIZZLE, useValue: {} },
      { provide: VersionedCatalogService, useValue: catalog },
    ],
  }).compile();
  return moduleRef.get(ProrationLedgerService);
}

async function buildReportsService(): Promise<ProrationLedgerReportsService> {
  const moduleRef = await Test.createTestingModule({
    providers: [ProrationLedgerReportsService, { provide: DRIZZLE, useValue: {} }],
  }).compile();
  return moduleRef.get(ProrationLedgerReportsService);
}

function changeInput(overrides: Partial<ProrationChangeInput> = {}): ProrationChangeInput {
  return {
    orgId: "org1",
    subscriptionId: 7,
    idempotencyKey: "sub7:upgrade:2026-01-16",
    oldPriceVersionId: 1,
    newPriceVersionId: 2,
    oldQuantity: 1,
    newQuantity: 1,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    effectiveFrom: MIDPOINT,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  ambientTx = null;
});

describe("ProrationLedgerService — registration", () => {
  it("is a provider of BillingModule", () => {
    const providers: unknown = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BillingModule);
    expect(Array.isArray(providers) ? providers : []).toContain(ProrationLedgerService);
  });

  it("is exported by BillingModule, so the plan-change path can inject it", () => {
    const exported: unknown = Reflect.getMetadata(MODULE_METADATA.EXPORTS, BillingModule);
    expect(Array.isArray(exported) ? exported : []).toContain(ProrationLedgerService);
  });
});

describe("ProrationLedgerService — upgrade, downgrade and quantity change produce lines", () => {
  it("writes an UPGRADE line for a mid-period price increase", async () => {
    const { tx, insertedValues } = makeTx();
    const service = await buildService(makeCatalog({ 1: price(1, 100_000), 2: price(2, 300_000) }));

    const result = await service.recordPlanChange(changeInput(), tx as never);

    expect(result.lineType).toBe("UPGRADE");
    expect(result.amountMinor).toBe(100_000);
    expect(insertedValues[0]).toMatchObject({ lineType: "UPGRADE", amountMinor: 100_000, currency: "INR" });
  });

  it("writes a DOWNGRADE line as a negative amount, so the credit is a stored fact", async () => {
    const { tx, insertedValues } = makeTx();
    const service = await buildService(makeCatalog({ 1: price(1, 300_000), 2: price(2, 100_000) }));

    const result = await service.recordPlanChange(changeInput(), tx as never);

    expect(result.lineType).toBe("DOWNGRADE");
    expect(result.amountMinor).toBe(-100_000);
    expect(insertedValues[0]).toMatchObject({ amountMinor: -100_000 });
  });

  it("writes a QUANTITY_CHANGE line when only the seat count moves", async () => {
    const { tx } = makeTx();
    const service = await buildService(makeCatalog({ 1: price(1, 100_000), 2: price(2, 100_000) }));

    const result = await service.recordPlanChange(
      changeInput({ oldQuantity: 5, newQuantity: 8 }),
      tx as never,
    );

    expect(result.lineType).toBe("QUANTITY_CHANGE");
    expect(result.amountMinor).toBe(150_000);
    expect(result.quantity).toBe(8);
  });

  it("derives the line type from the money, so a caller cannot mislabel a downgrade", async () => {
    const { tx } = makeTx();
    const service = await buildService(makeCatalog({ 1: price(1, 300_000), 2: price(2, 100_000) }));

    const result = await service.recordPlanChange(changeInput(), tx as never);

    expect(result.lineType).toBe("DOWNGRADE");
    expect(Object.keys(changeInput())).not.toContain("lineType");
  });

  it("names old and new price version, interval, quantity, currency and rounding on the row", async () => {
    const { tx, insertedValues } = makeTx();
    const service = await buildService(makeCatalog({ 1: price(1, 100_000), 2: price(2, 300_000) }));

    await service.recordPlanChange(changeInput({ roundingRule: "HALF_EVEN" }), tx as never);

    expect(insertedValues[0]).toMatchObject({
      oldPriceVersionId: 1,
      newPriceVersionId: 2,
      effectiveFrom: MIDPOINT,
      effectiveUntil: PERIOD_END,
      quantity: 1,
      currency: "INR",
      roundingRule: "HALF_EVEN",
    });
  });

  it("takes the currency from the price version rather than from the caller", async () => {
    const { tx, insertedValues } = makeTx();
    const service = await buildService(makeCatalog({ 1: price(1, 100_000, "USD"), 2: price(2, 300_000, "USD") }));

    await service.recordPlanChange(changeInput(), tx as never);

    expect(insertedValues[0]).toMatchObject({ currency: "USD" });
  });

  it("refuses to prorate across currencies rather than silently mixing them", async () => {
    const { tx } = makeTx();
    const service = await buildService(makeCatalog({ 1: price(1, 100_000, "USD"), 2: price(2, 300_000, "INR") }));

    await expect(service.recordPlanChange(changeInput(), tx as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("refuses a price version that does not exist rather than writing a line with no basis", async () => {
    const { tx } = makeTx();
    const service = await buildService(makeCatalog({ 1: price(1, 100_000), 2: null }));

    await expect(service.recordPlanChange(changeInput(), tx as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("writes through the caller's transaction, never its own handle", async () => {
    const { tx } = makeTx();
    const db = { insert: jest.fn(), select: jest.fn(), update: jest.fn(), transaction: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProrationLedgerService,
        { provide: DRIZZLE, useValue: db },
        { provide: VersionedCatalogService, useValue: makeCatalog({ 1: price(1, 1), 2: price(2, 2) }) },
      ],
    }).compile();

    await moduleRef.get(ProrationLedgerService).recordPlanChange(changeInput(), tx as never);

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalled();
  });
});

describe("ProrationLedgerService — retry with the same idempotency key returns the same result", () => {
  const STORED = {
    id: 55,
    lineType: "UPGRADE",
    oldPriceVersionId: 1,
    newPriceVersionId: 2,
    effectiveFrom: MIDPOINT,
    effectiveUntil: PERIOD_END,
    quantity: 1,
    currency: "INR",
    amountMinor: 100_000,
    roundingRule: "HALF_UP",
  };

  it("returns the stored line without inserting a second one", async () => {
    const { tx } = makeTx({ existing: [STORED] });
    const catalog = makeCatalog({ 1: price(1, 100_000), 2: price(2, 300_000) });
    const service = await buildService(catalog);

    const result = await service.recordPlanChange(changeInput(), tx as never);

    expect(result).toMatchObject({ id: 55, amountMinor: 100_000, replayed: true });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("does not even reprice on replay, so a catalog edit cannot change a stored line", async () => {
    const { tx } = makeTx({ existing: [STORED] });
    const catalog = makeCatalog({ 1: price(1, 999_999), 2: price(2, 999_999) });
    const service = await buildService(catalog);

    const result = await service.recordPlanChange(changeInput(), tx as never);

    expect(result.amountMinor).toBe(100_000);
    expect(catalog.getPriceVersionById).not.toHaveBeenCalled();
  });

  it("recovers the stored line when a concurrent writer wins the unique index", async () => {
    const { tx, selectResults } = makeTx({ inserted: [] });
    selectResults.push([]);
    selectResults.push([{ ...STORED, id: 77 }]);
    const service = await buildService(makeCatalog({ 1: price(1, 100_000), 2: price(2, 300_000) }));

    const result = await service.recordPlanChange(changeInput(), tx as never);

    expect(result).toMatchObject({ id: 77, replayed: true });
  });

  it("does not silently return an unwritten line", async () => {
    const { tx } = makeTx({ inserted: [] });
    const service = await buildService(makeCatalog({ 1: price(1, 100_000), 2: price(2, 300_000) }));

    await expect(service.recordPlanChange(changeInput(), tx as never)).rejects.toThrow(
      /neither inserted nor replayable/,
    );
  });
});

describe("ProrationLedgerService — provider proration is reconciled, not trusted", () => {
  it("stores the provider figure and reports the variance without touching the computed amount", async () => {
    const { tx, updatedValues, selectResults } = makeTx();
    selectResults.push([{ id: 55, amountMinor: 100_000 }]);
    ambientTx = tx;
    const service = await buildService(makeCatalog({}));

    const result = await service.reconcileProviderAmount("org1", "sub7:upgrade", 100_500, "pi_abc");

    expect(result).toMatchObject({
      amountMinor: 100_000,
      providerAmountMinor: 100_500,
      varianceMinor: 500,
      agrees: false,
      providerRef: "pi_abc",
    });
    expect(Object.keys(updatedValues[0] ?? {})).toEqual(
      expect.arrayContaining(["providerAmountMinor", "providerRef", "reconciledAt"]),
    );
    expect(Object.keys(updatedValues[0] ?? {})).not.toContain("amountMinor");
  });

  it("agrees when the provider matches to the minor unit", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([{ id: 55, amountMinor: 100_000 }]);
    ambientTx = tx;
    const service = await buildService(makeCatalog({}));

    const result = await service.reconcileProviderAmount("org1", "sub7:upgrade", 100_000, "pi_abc");

    expect(result).toMatchObject({ varianceMinor: 0, agrees: true });
  });

  it("refuses a fractional provider amount rather than storing a rounded lie", async () => {
    ambientTx = makeTx().tx;
    const service = await buildService(makeCatalog({}));

    await expect(
      service.reconcileProviderAmount("org1", "sub7:upgrade", 100.5, "pi_abc"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("reports a missing line rather than reconciling nothing", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([]);
    ambientTx = tx;
    const service = await buildService(makeCatalog({}));

    await expect(
      service.reconcileProviderAmount("org1", "no-such-key", 1, "pi_abc"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ProrationLedgerReportsService — reading the ledger back", () => {
  it("is a provider of BillingModule", () => {
    const providers: unknown = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BillingModule);
    expect(Array.isArray(providers) ? providers : []).toContain(ProrationLedgerReportsService);
  });

  it("separates charges from credits so a negative adjustment is never netted away silently", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([
      { id: 1, lineType: "UPGRADE", amountMinor: 300_000, currency: "INR" },
      { id: 2, lineType: "DOWNGRADE", amountMinor: -120_000, currency: "INR" },
      { id: 3, lineType: "QUANTITY_CHANGE", amountMinor: 40_000, currency: "INR" },
    ]);
    ambientTx = tx;
    const service = await buildReportsService();

    const result = await service.listForSubscription("org1", 7);

    expect(result.chargeMinor).toBe(340_000);
    expect(result.creditMinor).toBe(-120_000);
    expect(result.netMinor).toBe(220_000);
    expect(result.lines).toHaveLength(3);
  });

  it("caps a page at 100 however large a limit is asked for", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([]);
    ambientTx = tx;
    const service = await buildReportsService();

    await expect(service.listUnreconciled("org1", 10_000)).resolves.toEqual([]);
  });

  it("sums a period to zero rather than undefined when there are no lines", async () => {
    const { tx, selectResults } = makeTx();
    selectResults.push([]);
    ambientTx = tx;
    const service = await buildReportsService();

    await expect(service.sumForPeriod("org1", 7, PERIOD_START, PERIOD_END)).resolves.toEqual({
      netMinor: 0,
      lineCount: 0,
    });
  });
});
