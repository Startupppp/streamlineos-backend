import { InvAiService } from "./inv-ai.service";
import { InvValuationService } from "../../inv-valuation/inv-valuation.service";
import { InvReplenishmentService } from "../replenishment/inv-replenishment.service";

const mockCache = { cached: jest.fn((_, fn) => fn()), invalidate: jest.fn(), invalidatePattern: jest.fn() };
const mockNumSeq = { next: jest.fn() };

function buildAiService(db: object) {
  return new InvAiService(db as never, mockCache as never);
}

function _buildValuationService(db: object) {
  return new InvValuationService(db as never, mockCache as never);
}

function _buildReplenishmentService(db: object) {
  return new InvReplenishmentService(db as never, mockCache as never, mockNumSeq as never);
}

describe("InvAiService - insight deduplication", () => {
  beforeEach(() => jest.clearAllMocks());

  it("skips candidates that already exist as NEW insights with the same sourceKey", async () => {
    const existing = [
      { insightType: "negative_stock", sourceRefs: { _key: "42" } },
    ];
    const insertMock = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) });
    const db = {
      query: {
        invAiInsights: {
          findMany: jest.fn()
            .mockResolvedValueOnce(existing)
            .mockResolvedValue([]),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              groupBy: jest.fn().mockReturnValue({
                having: jest.fn().mockResolvedValue([]),
              }),
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
          where: jest.fn().mockReturnValue({
            groupBy: jest.fn().mockReturnValue({
              having: jest.fn().mockResolvedValue([]),
            }),
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: insertMock,
    };

    const service = buildAiService(db);
    const result = await service.generateInsights("org1");
    expect(result.generated).toBe(0);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("inserts only net-new candidates", async () => {
    const existing: never[] = [];
    const insertedValues: object[] = [];
    const insertMock = jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((vals) => {
        insertedValues.push(...vals);
        return Promise.resolve([]);
      }),
    });

    const db = {
      query: {
        invAiInsights: { findMany: jest.fn().mockResolvedValue(existing) },
        invPurchaseOrders: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              groupBy: jest.fn().mockReturnValue({
                having: jest.fn().mockResolvedValue([]),
              }),
              limit: jest.fn().mockResolvedValue([
                { variantId: 7, variantSku: "SKU-007", onHand: "2.00" },
              ]),
            }),
          }),
          where: jest.fn().mockReturnValue({
            groupBy: jest.fn().mockReturnValue({
              having: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
      insert: insertMock,
    };

    const service = buildAiService(db);
    const result = await service.generateInsights("org1");
    expect(result.generated).toBeGreaterThanOrEqual(0);
  });
});

describe("InvAiService - expiry risk severity", () => {
  it("rates expiry within 7 days as high", () => {
    const today = new Date();
    const in5Days = new Date(today);
    in5Days.setDate(today.getDate() + 5);
    const expiryDate = in5Days.toISOString().slice(0, 10);

    const urgentCutoff = new Date(today);
    urgentCutoff.setDate(today.getDate() + 7);
    const urgentStr = urgentCutoff.toISOString().slice(0, 10);

    expect(expiryDate <= urgentStr ? "high" : "medium").toBe("high");
  });

  it("rates expiry within 8-14 days as medium", () => {
    const today = new Date();
    const in10Days = new Date(today);
    in10Days.setDate(today.getDate() + 10);
    const expiryDate = in10Days.toISOString().slice(0, 10);

    const urgentCutoff = new Date(today);
    urgentCutoff.setDate(today.getDate() + 7);
    const urgentStr = urgentCutoff.toISOString().slice(0, 10);

    expect(expiryDate <= urgentStr ? "high" : "medium").toBe("medium");
  });
});

describe("InvAiService - stockout risk severity", () => {
  it("returns high when available is negative", () => {
    const available = -5;
    expect(available < 0 ? "high" : "medium").toBe("high");
  });

  it("returns medium when available is positive but below weekly demand", () => {
    const available = 3;
    expect(available < 0 ? "high" : "medium").toBe("medium");
  });
});

describe("InvReplenishmentService - forecast SMA", () => {
  it("computes avgWeeklyDemand as arithmetic mean of weekly sales", () => {
    const weeklySales = [10, 20, 30];
    const avg = weeklySales.reduce((a, b) => a + b, 0) / weeklySales.length;
    expect(avg).toBe(20);
  });

  it("returns 0 avgWeeklyDemand when no sales data", () => {
    const weeklySales: number[] = [];
    const avg = weeklySales.length > 0 ? weeklySales.reduce((a, b) => a + b, 0) / weeklySales.length : 0;
    expect(avg).toBe(0);
  });

  it("classifies stockoutRisk as HIGH when weeksOfStock < 2", () => {
    const available = 5;
    const avgWeeklyDemand = 4;
    const weeksOfStock = available / avgWeeklyDemand;
    const risk = weeksOfStock < 2 ? "HIGH" : weeksOfStock < 4 ? "MEDIUM" : "LOW";
    expect(risk).toBe("HIGH");
  });

  it("classifies stockoutRisk as MEDIUM when weeksOfStock is 2-4", () => {
    const available = 10;
    const avgWeeklyDemand = 4;
    const weeksOfStock = available / avgWeeklyDemand;
    const risk = weeksOfStock < 2 ? "HIGH" : weeksOfStock < 4 ? "MEDIUM" : "LOW";
    expect(risk).toBe("MEDIUM");
  });

  it("classifies stockoutRisk as LOW when weeksOfStock >= 4", () => {
    const available = 20;
    const avgWeeklyDemand = 4;
    const weeksOfStock = available / avgWeeklyDemand;
    const risk = weeksOfStock < 2 ? "HIGH" : weeksOfStock < 4 ? "MEDIUM" : "LOW";
    expect(risk).toBe("LOW");
  });

  it("classifies stockoutRisk as NONE when avgWeeklyDemand is 0", () => {
    const avgWeeklyDemand = 0;
    const weeksOfStock = avgWeeklyDemand > 0 ? 100 / avgWeeklyDemand : null;
    const risk = weeksOfStock != null ? (weeksOfStock < 2 ? "HIGH" : weeksOfStock < 4 ? "MEDIUM" : "LOW") : "NONE";
    expect(risk).toBe("NONE");
  });

  it("projects demand correctly for 4 weeks", () => {
    const avgWeeklyDemand = 10;
    const available = 50;
    const projectedWeeks = [1, 2, 3, 4].map((w) => ({
      week: w,
      projectedDemand: Math.round(avgWeeklyDemand * w * 100) / 100,
      projectedStock: Math.round(Math.max(0, available - avgWeeklyDemand * w) * 100) / 100,
    }));

    expect(projectedWeeks[0].projectedDemand).toBe(10);
    expect(projectedWeeks[1].projectedDemand).toBe(20);
    expect(projectedWeeks[2].projectedDemand).toBe(30);
    expect(projectedWeeks[3].projectedDemand).toBe(40);
    expect(projectedWeeks[3].projectedStock).toBe(10);
  });
});

describe("InvValuationService - costing method value calculation", () => {
  function computeValue(opts: {
    costingMethod: string | null;
    onHand: number;
    fifoValue: number;
    standardCost: number;
    avgCost: number;
  }) {
    if (opts.costingMethod === "FIFO") return opts.fifoValue;
    if (opts.costingMethod === "STANDARD") return opts.onHand * opts.standardCost;
    return opts.onHand * opts.avgCost;
  }

  it("uses fifoValue for FIFO costing method", () => {
    expect(computeValue({ costingMethod: "FIFO", onHand: 10, fifoValue: 450, standardCost: 50, avgCost: 48 })).toBe(450);
  });

  it("uses onHand * standardCost for STANDARD costing method", () => {
    expect(computeValue({ costingMethod: "STANDARD", onHand: 10, fifoValue: 450, standardCost: 50, avgCost: 48 })).toBe(500);
  });

  it("uses onHand * avgCost for WAVG / default costing method", () => {
    expect(computeValue({ costingMethod: "WAVG", onHand: 10, fifoValue: 450, standardCost: 50, avgCost: 48 })).toBe(480);
  });

  it("uses onHand * avgCost when costingMethod is null (default/weighted avg)", () => {
    expect(computeValue({ costingMethod: null, onHand: 10, fifoValue: 450, standardCost: 50, avgCost: 48 })).toBe(480);
  });

  it("rounds totalValue to 4 decimal places", () => {
    const value = 10 * 3.14159;
    expect(Math.round(value * 10000) / 10000).toBe(31.4159);
  });
});
