import { UnprocessableEntityException } from "@nestjs/common";
import { ValuationService, weightedAverage, type IssueInput, type ReceiptInput } from "../valuation.service";

type Inserted = { table: string; values: Record<string, unknown> };

function buildTx(layers: Array<{ id: number; remaining_quantity: string; unit_cost: string }>) {
  const inserted: Inserted[] = [];
  const updated: Array<Record<string, unknown>> = [];
  let insertCall = 0;

  const tx = {
    inserted,
    updated,
    execute: jest.fn().mockResolvedValue(layers),
    insert: jest.fn().mockImplementation(() => {
      const call = insertCall++;
      return {
        values: jest.fn().mockImplementation((values: Record<string, unknown>) => {
          inserted.push({ table: `insert${call}`, values });
          return Object.assign(Promise.resolve(undefined), {
            returning: jest.fn().mockResolvedValue([{ id: 9000 + call }]),
          });
        }),
      };
    }),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
        updated.push(values);
        return { where: jest.fn().mockResolvedValue(undefined) };
      }),
    })),
  };
  return tx;
}

const baseIssue: Omit<IssueInput, "costingMethod"> = {
  orgId: "org1",
  productVariantId: 1,
  locationId: 1,
  lotId: null,
  stockTransactionId: 500,
  quantity: "8.0000",
  averageCost: "8.0000",
  standardCost: "7.0000",
  allowUncovered: false,
  sourceType: "sale",
  sourceId: "so-1",
};

const baseReceipt: Omit<ReceiptInput, "costingMethod"> = {
  orgId: "org1",
  productVariantId: 1,
  locationId: 1,
  lotId: null,
  stockTransactionId: 400,
  quantity: "10.0000",
  unitCost: "12.0000",
  onHandBefore: "10.0000",
  averageCostBefore: "8.0000",
  sourceType: "grn",
  sourceId: "grn-1",
};

describe("weightedAverage", () => {
  it("blends the existing value with the incoming value", () => {
    // (10 * 8 + 10 * 12) / 20 = 10
    expect(weightedAverage("10.0000", "8.0000", "10.0000", "12.0000")).toBe("10.0000");
  });

  it("falls back to the incoming cost when there is no prior stock", () => {
    expect(weightedAverage("0.0000", null, "5.0000", "3.5000")).toBe("3.5000");
  });

  it("is exact where float arithmetic drifts", () => {
    // 0.1 + 0.2 style drift must not appear in a money figure
    expect(weightedAverage("1.0000", "0.1000", "2.0000", "0.2000")).toBe("0.1667");
  });
});

describe("ValuationService.recordIssue", () => {
  it("consumes layers oldest-first and charges FIFO at each layer's own cost", async () => {
    const service = new ValuationService();
    const tx = buildTx([
      { id: 10, remaining_quantity: "5.0000", unit_cost: "6.0000" },
      { id: 11, remaining_quantity: "10.0000", unit_cost: "9.0000" },
    ]);

    const result = await service.recordIssue(tx as never, { ...baseIssue, costingMethod: "FIFO" });

    // 5 @ 6 + 3 @ 9 = 57 over 8 units
    expect(result.totalCost).toBe("57.0000");
    expect(result.unitCost).toBe("7.1250");
    expect(result.uncoveredQuantity).toBe("0.0000");
  });

  it("records one consumption row per layer touched, so COGS is reproducible", async () => {
    const service = new ValuationService();
    const tx = buildTx([
      { id: 10, remaining_quantity: "5.0000", unit_cost: "6.0000" },
      { id: 11, remaining_quantity: "10.0000", unit_cost: "9.0000" },
    ]);

    await service.recordIssue(tx as never, { ...baseIssue, costingMethod: "FIFO" });

    const consumptions = tx.inserted.filter((i) => "valuationLayerId" in i.values);
    expect(consumptions).toHaveLength(2);
    expect(consumptions[0]!.values).toMatchObject({ valuationLayerId: 10, quantity: "5.0000", totalCost: "30.0000" });
    expect(consumptions[1]!.values).toMatchObject({ valuationLayerId: 11, quantity: "3.0000", totalCost: "27.0000" });
  });

  it("charges weighted average at the running average, not the layer cost", async () => {
    const service = new ValuationService();
    const tx = buildTx([{ id: 10, remaining_quantity: "20.0000", unit_cost: "6.0000" }]);

    const result = await service.recordIssue(tx as never, { ...baseIssue, costingMethod: "WEIGHTED_AVERAGE" });

    expect(result.unitCost).toBe("8.0000");
    expect(result.totalCost).toBe("64.0000");
  });

  it("charges standard costing at the effective standard, not the layer cost", async () => {
    const service = new ValuationService();
    const tx = buildTx([{ id: 10, remaining_quantity: "20.0000", unit_cost: "6.0000" }]);

    const result = await service.recordIssue(tx as never, { ...baseIssue, costingMethod: "STANDARD" });

    expect(result.unitCost).toBe("7.0000");
    expect(result.totalCost).toBe("56.0000");
  });

  it("throws rather than silently under-valuing when layers do not cover the issue", async () => {
    const service = new ValuationService();
    const tx = buildTx([{ id: 10, remaining_quantity: "2.0000", unit_cost: "6.0000" }]);

    await expect(
      service.recordIssue(tx as never, { ...baseIssue, costingMethod: "FIFO" }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("records a backfill layer for the uncovered part when negative stock is allowed", async () => {
    const service = new ValuationService();
    const tx = buildTx([{ id: 10, remaining_quantity: "2.0000", unit_cost: "6.0000" }]);

    const result = await service.recordIssue(tx as never, {
      ...baseIssue,
      costingMethod: "FIFO",
      allowUncovered: true,
    });

    expect(result.uncoveredQuantity).toBe("6.0000");
    const backfill = tx.inserted.find((i) => i.values.sourceType === "negative_stock_backfill");
    expect(backfill).toBeDefined();
    expect(backfill!.values).toMatchObject({ quantity: "6.0000", remainingQuantity: "0" });
    // 2 @ 6 covered + 6 @ 8 (average fallback) = 60
    expect(result.totalCost).toBe("60.0000");
  });

  it("is a no-op for a zero quantity", async () => {
    const service = new ValuationService();
    const tx = buildTx([]);

    const result = await service.recordIssue(tx as never, { ...baseIssue, quantity: "0.0000", costingMethod: "FIFO" });

    expect(result.totalCost).toBe("0.0000");
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe("ValuationService.recordReceipt", () => {
  it("records the recomputation so a past average can be explained", async () => {
    const service = new ValuationService();
    const tx = buildTx([]);

    const average = await service.recordReceipt(tx as never, { ...baseReceipt, costingMethod: "WEIGHTED_AVERAGE" });

    expect(average).toBe("10.0000");
    const history = tx.inserted.find((i) => "averageAfter" in i.values);
    expect(history!.values).toMatchObject({
      quantityBefore: "10.0000",
      averageBefore: "8.0000",
      quantityIn: "10.0000",
      unitCostIn: "12.0000",
      averageAfter: "10.0000",
    });
  });

  it("does not recompute an average for FIFO products", async () => {
    const service = new ValuationService();
    const tx = buildTx([]);

    const average = await service.recordReceipt(tx as never, { ...baseReceipt, costingMethod: "FIFO" });

    expect(average).toBe("8.0000");
    expect(tx.inserted.some((i) => "averageAfter" in i.values)).toBe(false);
  });

  it("opens the layer at the receipt cost with its full quantity remaining", async () => {
    const service = new ValuationService();
    const tx = buildTx([]);

    await service.recordReceipt(tx as never, { ...baseReceipt, costingMethod: "FIFO" });

    expect(tx.inserted[0]!.values).toMatchObject({
      quantity: "10.0000",
      unitCost: "12.0000",
      totalValue: "120.0000",
      remainingQuantity: "10.0000",
      remainingValue: "120.0000",
      locationId: 1,
    });
  });
});

describe("ValuationService.reverseReceiptLayer", () => {
  it("refuses to reverse a receipt that has already been partly issued", async () => {
    const service = new ValuationService();
    const tx = buildTx([]);
    tx.execute = jest.fn().mockResolvedValue([{ id: 10, remaining_quantity: "4.0000", quantity: "10.0000" }]);

    await expect(
      service.reverseReceiptLayer(tx as never, "org1", 400),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("zeroes an untouched layer", async () => {
    const service = new ValuationService();
    const tx = buildTx([]);
    tx.execute = jest.fn().mockResolvedValue([{ id: 10, remaining_quantity: "10.0000", quantity: "10.0000" }]);

    await expect(service.reverseReceiptLayer(tx as never, "org1", 400)).resolves.toBe(true);
    expect(tx.updated[0]).toMatchObject({ remainingQuantity: "0", remainingValue: "0" });
  });
});
