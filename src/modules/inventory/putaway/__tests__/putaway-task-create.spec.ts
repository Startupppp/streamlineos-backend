import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import type { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import type { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import type { PutawayService } from "../../warehouses/putaway.service";
import type { SlottedSuggestion } from "../../slotting/slotting-rules";
import type { ReceiptGrain } from "../putaway-receipt-grains";
import { createFromReceipt, type PutawayTaskCreateDeps } from "../lib/putaway-task-create";

/**
 * `createFromReceipt` had no test at all.
 *
 * Found when it moved out of `putaway-task.service.ts` into
 * `lib/putaway-task-create.ts`: nothing anywhere called it except the
 * controller, and the only putaway spec (`inv-ops-isolation-2.spec.ts`) drives
 * `list`. Deleting each of its seven refusals in turn left the whole inventory
 * suite green, INCLUDING the warehouse-scope gate on the receipt's receiving
 * location — an operator outside that warehouse could raise a putaway walk over
 * its stock and nothing would have noticed the gate going.
 *
 * Every case below kills exactly the mutation it is named for; the last one is
 * the control that proves the harness can reach a successful create at all, so
 * a refusal test cannot pass by the harness failing for some other reason.
 */

const mockReadReceiptGrains = jest.fn<Promise<ReceiptGrain[]>, [unknown, string, number, number]>();
const mockFindQuarantineLocation = jest.fn<Promise<number | null>, [unknown, string, number]>();

jest.mock("../putaway-receipt-grains", () => ({
  readReceiptGrains: (...args: [unknown, string, number, number]) => mockReadReceiptGrains(...args),
}));
jest.mock("../putaway-destination", () => ({
  findQuarantineLocation: (...args: [unknown, string, number]) => mockFindQuarantineLocation(...args),
}));

const ORG = "org-1";
const USER = "user-1";
const GRN_ID = 501;
const RECEIVING = 11;
const WAREHOUSE = 3;

type GrnRow = { id: number; status: string; locationId: number | null; grnNumber: string };

const POSTED_GRN: GrnRow = { id: GRN_ID, status: "POSTED", locationId: RECEIVING, grnNumber: "GRN-0001" };

const STORAGE_GRAINS: ReceiptGrain[] = [
  { productVariantId: 7, lotId: 1, serialId: null, quantity: "4.0000", disposition: "STORAGE" },
  { productVariantId: 7, lotId: 2, serialId: null, quantity: "6.0000", disposition: "STORAGE" },
];
const QUARANTINE_GRAIN: ReceiptGrain = {
  productVariantId: 8,
  lotId: null,
  serialId: null,
  quantity: "1.0000",
  disposition: "QUARANTINE",
};

function suggestion(locationId: number, fits: boolean): SlottedSuggestion {
  return {
    locationId,
    code: `BIN-${locationId}`,
    name: `Bin ${locationId}`,
    capacity: null,
    onHand: "0.0000",
    remaining: null,
    holdsVariant: false,
    fits,
    inSlot: false,
    slotRuleName: null,
  };
}

interface Options {
  grn?: GrnRow | undefined;
  location?: { warehouse_id: number } | undefined;
  scopeRejects?: boolean;
}

function harness(opts: Options = {}) {
  const grn = "grn" in opts ? opts.grn : POSTED_GRN;
  const location = "location" in opts ? opts.location : { warehouse_id: WAREHOUSE };

  const assertLocationVisible = jest.fn<Promise<void>, [string, string, number | null | undefined]>(
    async () => {
      if (opts.scopeRejects) throw new NotFoundException("Not found");
    },
  );
  const execute = jest.fn<Promise<Array<{ warehouse_id: number }>>, [unknown]>(async () =>
    location ? [location] : [],
  );
  // The task insert chains `.returning()`; the lines insert is awaited as-is.
  const values = jest.fn<Promise<void> & { returning: jest.Mock }, [unknown]>(() =>
    Object.assign(Promise.resolve(), { returning: jest.fn(async () => [{ id: 55 }]) }),
  );
  const tx = { insert: jest.fn(() => ({ values })) };
  // A transaction double that never ran its callback would void every
  // assertion about what happens inside it.
  const transaction = jest.fn(async (fn: (t: typeof tx) => Promise<number>) => fn(tx));
  const suggest = jest.fn<Promise<SlottedSuggestion[]>, [string, string, unknown]>(async () => [
    suggestion(RECEIVING, true),
    suggestion(21, true),
  ]);
  const next = jest.fn<Promise<string>, [string, string]>(async () => "PUT-0001");
  const auditInsert = jest.fn<Promise<void>, [unknown, unknown]>(async () => undefined);

  const deps: PutawayTaskCreateDeps = {
    db: {
      query: { invGrns: { findFirst: jest.fn(async () => grn) } },
      execute,
      transaction,
    } as unknown as Db,
    warehouseScope: { assertLocationVisible } as unknown as WarehouseScopeService,
    numSeq: { next } as unknown as NumberSequenceService,
    suggestions: { suggest } as unknown as PutawayService,
    audit: { insert: auditInsert } as unknown as InventoryAuditService,
  };
  return { deps, assertLocationVisible, execute, transaction, suggest, values };
}

beforeEach(() => {
  mockReadReceiptGrains.mockReset().mockResolvedValue(STORAGE_GRAINS);
  mockFindQuarantineLocation.mockReset().mockResolvedValue(99);
});

describe("createFromReceipt — the refusals", () => {
  it("G1: 404s a receipt that is not in the caller's org, before any gate or write", async () => {
    const h = harness({ grn: undefined });

    await expect(createFromReceipt(h.deps, ORG, USER, { grnId: GRN_ID })).rejects.toThrow(
      NotFoundException,
    );
    expect(h.assertLocationVisible).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("G2: refuses a receipt that has not posted", async () => {
    const h = harness({ grn: { ...POSTED_GRN, status: "DRAFT" } });

    await expect(createFromReceipt(h.deps, ORG, USER, { grnId: GRN_ID })).rejects.toThrow(
      "Only a posted goods receipt has stock to put away",
    );
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("G3: refuses a receipt with no receiving location, rather than scoping on null", async () => {
    const h = harness({ grn: { ...POSTED_GRN, locationId: null } });

    await expect(createFromReceipt(h.deps, ORG, USER, { grnId: GRN_ID })).rejects.toThrow(
      "This goods receipt has no receiving location",
    );
    expect(h.assertLocationVisible).not.toHaveBeenCalled();
  });

  it("G4: a receiving location outside the caller's warehouses is refused, and nothing after it runs", async () => {
    const h = harness({ scopeRejects: true });

    await expect(createFromReceipt(h.deps, ORG, USER, { grnId: GRN_ID })).rejects.toThrow(
      NotFoundException,
    );
    expect(h.assertLocationVisible).toHaveBeenCalledWith(ORG, USER, RECEIVING);
    // The gate stands in front of every read of the warehouse's contents.
    expect(h.execute).not.toHaveBeenCalled();
    expect(mockReadReceiptGrains).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("G5: refuses when the receiving location has since been deleted", async () => {
    const h = harness({ location: undefined });

    await expect(createFromReceipt(h.deps, ORG, USER, { grnId: GRN_ID })).rejects.toThrow(
      new BadRequestException("The receiving location no longer exists"),
    );
  });

  it("G6: refuses a receipt that left nothing at its receiving location", async () => {
    mockReadReceiptGrains.mockResolvedValue([]);
    const h = harness();

    await expect(createFromReceipt(h.deps, ORG, USER, { grnId: GRN_ID })).rejects.toThrow(
      "This goods receipt left no stock at its receiving location",
    );
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("G7: refuses quarantined goods when the warehouse has no quarantine location", async () => {
    mockReadReceiptGrains.mockResolvedValue([...STORAGE_GRAINS, QUARANTINE_GRAIN]);
    mockFindQuarantineLocation.mockResolvedValue(null);
    const h = harness();

    await expect(createFromReceipt(h.deps, ORG, USER, { grnId: GRN_ID })).rejects.toThrow(
      "These goods are quarantined and this warehouse has no quarantine location",
    );
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

describe("createFromReceipt — the control", () => {
  it("raises one task: storage lines to the suggested bin, quarantine lines to quarantine", async () => {
    mockReadReceiptGrains.mockResolvedValue([...STORAGE_GRAINS, QUARANTINE_GRAIN]);
    const h = harness();

    await expect(createFromReceipt(h.deps, ORG, USER, { grnId: GRN_ID })).resolves.toEqual({
      taskId: 55,
      taskNumber: "PUT-0001",
      lineCount: 3,
      quarantineLineCount: 1,
    });

    // One suggestion query per distinct storage variant — two lots of variant 7
    // ask the same question — and none for the quarantined one.
    expect(h.suggest).toHaveBeenCalledTimes(1);

    // Second `values()` call is the lines. The receiving bin itself fits but is
    // excluded, so the suggestion lands on 21.
    const lines = h.values.mock.calls[1]![0] as Array<{
      productVariantId: number;
      disposition: string;
      toLocationId: number | null;
    }>;
    expect(lines.map((l) => [l.productVariantId, l.disposition, l.toLocationId])).toEqual([
      [7, "STORAGE", 21],
      [7, "STORAGE", 21],
      [8, "QUARANTINE", 99],
    ]);
  });
});
