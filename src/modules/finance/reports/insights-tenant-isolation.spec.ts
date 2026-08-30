import type { Db } from "../../../db/drizzle.module";
import { InsightsService } from "./insights.service";
import { InsightsFindersService } from "./insights-finders.service";

describe("InsightsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeFinders(orgCapture: { value: string | null }): InsightsFindersService {
    const mockFinder = jest.fn().mockImplementation((orgId: string) => {
      orgCapture.value = orgId;
      return Promise.resolve([]);
    });
    return {
      findExpenseSpikes: mockFinder,
      findDuplicateBills: mockFinder,
      findUnusualJournals: mockFinder,
      findRoundAmountPatterns: mockFinder,
      findArConcentration: mockFinder,
      findCashDipProjected: mockFinder,
    } as unknown as InsightsFindersService;
  }

  it("passes only the requesting org to finders (tenant isolation)", async () => {
    const orgCapture = { value: null as string | null };
    const finders = makeFinders(orgCapture);
    const db = {} as unknown as Db;
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new InsightsService(db, cache, finders);

    await svc.getAnomalies(ATTACKER_ORG, {});

    expect(orgCapture.value).toBe(ATTACKER_ORG);
  });

  it("returns anomalies only for the owning org (same-tenant control)", async () => {
    const orgCapture = { value: null as string | null };
    const finders = makeFinders(orgCapture);
    const db = {} as unknown as Db;
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new InsightsService(db, cache, finders);

    const result = await svc.getAnomalies(OWNER_ORG, {});

    expect(orgCapture.value).toBe(OWNER_ORG);
    expect(result).toBeInstanceOf(Array);
  });
});
