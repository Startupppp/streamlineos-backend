import type { Db } from "../../../db/drizzle.module";

const mockLogWarn = jest.fn();
jest.mock("../../../common/logger/side-effect", () => ({
  logSideEffectFailure: jest.fn().mockImplementation((label: string, _ctx: unknown) => {
    return (err: unknown) => {
      mockLogWarn(label, err instanceof Error ? err.message : String(err));
    };
  }),
}));

import { InsightsService } from "./insights.service";
import type { InsightsFindersService } from "./insights-finders.service";

const ORG = "org-insights-test";

function makeFinders(overrides: Partial<Record<keyof InsightsFindersService, jest.Mock>> = {}): InsightsFindersService {
  return {
    findExpenseSpikes: jest.fn().mockResolvedValue([]),
    findDuplicateBills: jest.fn().mockResolvedValue([]),
    findUnusualJournals: jest.fn().mockResolvedValue([]),
    findRoundAmountPatterns: jest.fn().mockResolvedValue([]),
    findArConcentration: jest.fn().mockResolvedValue([]),
    findCashDipProjected: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as InsightsFindersService;
}

function makeCache(result: unknown = []): { cached: jest.Mock; cachedVersioned: jest.Mock } {
  return {
    cached: jest.fn().mockImplementation((_key: unknown, fn: () => Promise<unknown>) => fn()),
    cachedVersioned: jest.fn().mockImplementation((_ns: unknown, _key: unknown, fn: () => Promise<unknown>) => fn()),
  };
}

describe("InsightsService — finder errors are logged, not silently dropped", () => {
  beforeEach(() => {
    mockLogWarn.mockClear();
  });

  it("logs a warning when findExpenseSpikes rejects, and still returns other results", async () => {
    const finders = makeFinders({
      findExpenseSpikes: jest.fn().mockRejectedValue(new Error("spike-db-error")),
    });
    const svc = new InsightsService({} as Db, makeCache() as never, finders);

    const result = await svc.getAnomalies(ORG, {});

    expect(result).toEqual([]);
    expect(mockLogWarn).toHaveBeenCalledWith("findExpenseSpikes", "spike-db-error");
  });

  it("logs a warning when findDuplicateBills rejects", async () => {
    const finders = makeFinders({
      findDuplicateBills: jest.fn().mockRejectedValue(new Error("dup-bills-error")),
    });
    const svc = new InsightsService({} as Db, makeCache() as never, finders);

    await svc.getAnomalies(ORG, {});

    expect(mockLogWarn).toHaveBeenCalledWith("findDuplicateBills", "dup-bills-error");
  });

  it("logs a warning when findUnusualJournals rejects", async () => {
    const finders = makeFinders({
      findUnusualJournals: jest.fn().mockRejectedValue(new Error("journal-error")),
    });
    const svc = new InsightsService({} as Db, makeCache() as never, finders);

    await svc.getAnomalies(ORG, {});

    expect(mockLogWarn).toHaveBeenCalledWith("findUnusualJournals", "journal-error");
  });

  it("logs a warning when findArConcentration rejects", async () => {
    const finders = makeFinders({
      findArConcentration: jest.fn().mockRejectedValue(new Error("ar-error")),
    });
    const svc = new InsightsService({} as Db, makeCache() as never, finders);

    await svc.getAnomalies(ORG, {});

    expect(mockLogWarn).toHaveBeenCalledWith("findArConcentration", "ar-error");
  });

  it("still returns results from successful finders when one fails", async () => {
    const finders = makeFinders({
      findExpenseSpikes: jest.fn().mockRejectedValue(new Error("spike-error")),
      findDuplicateBills: jest.fn().mockResolvedValue([{ type: "duplicate_bill", severity: "warning", detail: "dup" }]),
    });
    const svc = new InsightsService({} as Db, makeCache() as never, finders);

    const result = await svc.getAnomalies(ORG, {});

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "duplicate_bill" });
    expect(mockLogWarn).toHaveBeenCalledWith("findExpenseSpikes", "spike-error");
  });
});
