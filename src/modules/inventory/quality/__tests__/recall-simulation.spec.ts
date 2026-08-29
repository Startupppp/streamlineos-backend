import { getTableName } from "drizzle-orm";
import { BadRequestException } from "@nestjs/common";
import {
  invCustomerReturnLines,
  invLots,
  invShipmentLines,
  invStockLevels,
  invStockTransferLines,
} from "../../../../db/schema";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { RecallSimulationService } from "../recall-simulation.service";

/**
 * D4 — the recall simulator answers the question and touches nothing.
 *
 * "Read-only" is easy to write in a comment and easy to break in the next
 * commit: one `await tx.insert(...)` added to warm a cache, or a service
 * quietly swapped for one that writes, and the simulate button starts placing
 * holds. So it is not asserted by reading the code — the service is handed a
 * database whose every writing method throws, and the assertion is that the
 * simulation completes anyway.
 *
 * The second guarantee is determinism. An evidence hash that changes between
 * two simulates of an unchanged warehouse would make the execute's conflict
 * check fire constantly, and a check that always fires is a check operators
 * learn to click through.
 */

type Row = Record<string, unknown>;

/**
 * A database that can only be read from.
 *
 * Every chain link returns itself and every link is awaitable, so it satisfies
 * `.from().innerJoin().leftJoin().where().orderBy().limit()` in any order the
 * service happens to use. Rows are keyed by the table named in `.from(...)`,
 * which is what makes a five-query parallel read deterministic without
 * depending on the order the promises settle.
 */
function readOnlyDb(rowsByTable: Record<string, Row[]>): {
  db: unknown;
  selectsFrom: string[];
} {
  const selectsFrom: string[] = [];

  const refuse = (method: string) => (): never => {
    throw new Error(
      `RecallSimulationService called db.${method}() — the recall simulator must write nothing`,
    );
  };

  const builder = (rows: Row[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const link of ["innerJoin", "leftJoin", "where", "orderBy", "limit", "offset", "groupBy"]) {
      chain[link] = () => chain;
    }
    chain["then"] = (
      resolve: (value: Row[]) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return chain;
  };

  const db = {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table as Parameters<typeof getTableName>[0]);
        selectsFrom.push(name);
        return builder(rowsByTable[name] ?? []);
      },
    }),
    insert: refuse("insert"),
    update: refuse("update"),
    delete: refuse("delete"),
    transaction: refuse("transaction"),
    execute: refuse("execute"),
    get query(): never {
      throw new Error(
        "RecallSimulationService used the relational query API — every read here is an explicit projection",
      );
    },
  };

  return { db, selectsFrom };
}

const LOT = (id: number, lotNumber: string): Row => ({
  lotId: id,
  lotNumber,
  productVariantId: 40,
  variantSku: "SKU-40",
  variantName: "Default",
  status: "ACTIVE",
  manufactureDate: "2026-03-01",
  expiryDate: "2027-03-01",
});

function scene(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    [getTableName(invLots)]: [LOT(1, "L-001"), LOT(2, "L-002")],
    [getTableName(invStockLevels)]: [
      {
        lotId: 1,
        locationId: 7,
        locationName: "Bin A",
        warehouseId: 3,
        warehouseName: "Main",
        onHand: "100.0000",
        qualityHold: "10.0000",
      },
      {
        lotId: 2,
        locationId: 8,
        locationName: "Bin B",
        warehouseId: 3,
        warehouseName: "Main",
        onHand: "0.5000",
        qualityHold: "0.0000",
      },
    ],
    [getTableName(invStockTransferLines)]: [
      {
        lotId: 1,
        transferId: 12,
        referenceNumber: "TR-00012",
        status: "IN_TRANSIT",
        quantity: "25.0000",
        fromLocationId: 7,
        toLocationId: 9,
      },
    ],
    [getTableName(invShipmentLines)]: [
      {
        lotId: 1,
        shipmentId: 55,
        shipmentNumber: "SH-00055",
        status: "DELIVERED",
        shippedAt: "2026-04-02T09:00:00Z",
        salesOrderId: 31,
        salesOrderNumber: "SO-00031",
        quantity: "12.0000",
      },
    ],
    [getTableName(invCustomerReturnLines)]: [
      {
        lotId: 1,
        returnId: 4,
        returnNumber: "CRET-00004",
        status: "POSTED",
        quantity: "2.0000",
      },
    ],
    ...overrides,
  };
}

function build(rows: Record<string, Row[]>, scope: number[] | null = null) {
  const { db, selectsFrom } = readOnlyDb(rows);
  const warehouseScope = new WarehouseScopeService({} as never, {} as never);
  jest.spyOn(warehouseScope, "resolve").mockResolvedValue(scope);
  return {
    service: new RecallSimulationService(db as never, warehouseScope),
    selectsFrom,
  };
}

const SELECTION = { lotIds: [1, 2] };

describe("D4 — the recall simulator", () => {
  it("returns the full impact without writing anything", async () => {
    const { service } = build(scene());

    const impact = await service.simulate("org_1", "user_1", { ...SELECTION });

    expect(impact.lots.map((l) => l.lotNumber)).toEqual(["L-001", "L-002"]);
    expect(impact.totals).toEqual({
      lots: 2,
      // 100 + 0.5 — the fractional row matters: a lot holding 0.0001 units is
      // still on the shelf and still has to be recalled.
      onHand: "100.5000",
      onQualityHold: "10.0000",
      inTransit: "25.0000",
      shipped: "12.0000",
      returned: "2.0000",
    });
    expect(impact.evidenceVersion).toMatch(/^[0-9a-f]{32}$/);
  });

  it("names the documents that already hold the goods", async () => {
    const { service } = build(scene());

    const impact = await service.simulate("org_1", "user_1", { ...SELECTION });

    // "Who has it" is the question a recall exists to answer, so the shipped
    // figure is useless without the shipment and the order behind it.
    expect(impact.shipped[0]).toMatchObject({
      shipmentNumber: "SH-00055",
      salesOrderNumber: "SO-00031",
    });
    expect(impact.inTransit[0]).toMatchObject({ referenceNumber: "TR-00012" });
    expect(impact.returned[0]).toMatchObject({ returnNumber: "CRET-00004" });
  });

  it("simulating twice yields the same set and the same evidence version", async () => {
    const { service } = build(scene());

    const first = await service.simulate("org_1", "user_1", { ...SELECTION });
    const second = await service.simulate("org_1", "user_1", { ...SELECTION });

    expect(second.evidenceVersion).toBe(first.evidenceVersion);
    expect(second.lots).toEqual(first.lots);
    expect(second.onHand).toEqual(first.onHand);
    expect(second.shipped).toEqual(first.shipped);
    expect(second.totals).toEqual(first.totals);
  });

  it("moves the evidence version the moment any part of the picture moves", async () => {
    const before = await build(scene()).service.simulate("org_1", "user_1", { ...SELECTION });

    const shifted = scene({
      [getTableName(invStockLevels)]: [
        {
          lotId: 1,
          locationId: 7,
          locationName: "Bin A",
          warehouseId: 3,
          warehouseName: "Main",
          onHand: "99.0000",
          qualityHold: "10.0000",
        },
      ],
    });
    const after = await build(shifted).service.simulate("org_1", "user_1", { ...SELECTION });

    expect(after.evidenceVersion).not.toBe(before.evidenceVersion);
  });

  it("binds the evidence to the actor's warehouse scope", async () => {
    // A scoped operator sees — and can post holds against — a narrower set of
    // warehouses than an unrestricted one, so the same selection is honestly a
    // different picture for each. Sharing one hash between them would let one
    // operator's simulate authorise another's execute.
    const unrestricted = await build(scene(), null).service.simulate("org_1", "user_1", {
      ...SELECTION,
    });
    const scoped = await build(scene(), [3]).service.simulate("org_1", "user_1", { ...SELECTION });

    expect(scoped.warehouseScope).toBe("3");
    expect(unrestricted.warehouseScope).toBe("all");
    expect(scoped.evidenceVersion).not.toBe(unrestricted.evidenceVersion);
  });

  it("reports an empty picture rather than inventing one", async () => {
    const { service, selectsFrom } = build({ [getTableName(invLots)]: [] });

    const impact = await service.simulate("org_1", "user_1", { ...SELECTION });

    expect(impact.lots).toEqual([]);
    expect(impact.totals.onHand).toBe("0");
    expect(impact.evidenceVersion).toMatch(/^[0-9a-f]{32}$/);
    // No lots means no `lot_id IN ()` reads to issue.
    expect(selectsFrom).toEqual([getTableName(invLots)]);
  });

  it("refuses a selection wider than it can honestly display", async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => LOT(i + 1, `L-${i}`));
    const { service } = build({ [getTableName(invLots)]: tooMany });

    await expect(
      service.simulate("org_1", "user_1", { productVariantIds: [40] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
