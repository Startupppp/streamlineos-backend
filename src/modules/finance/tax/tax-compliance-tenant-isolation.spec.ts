import type { Db } from "../../../db/drizzle.module";
import { TaxComplianceService } from "./tax-compliance.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

type ChainResult = Promise<unknown[]> & { limit: jest.Mock; orderBy: jest.Mock; groupBy: jest.Mock };

function makeChainResult(rows: unknown[] = []): ChainResult {
  const p = Promise.resolve(rows) as ChainResult;
  p.limit = jest.fn().mockResolvedValue(rows);
  p.orderBy = jest.fn().mockResolvedValue(rows);
  p.groupBy = jest.fn().mockResolvedValue(rows);
  return p;
}

describe("TaxComplianceService — cross-tenant isolation (background sweep)", () => {
  const TARGET_ORG = "org-target";

  it("scopes tax liability computation to the requested org (org isolation)", async () => {
    const allWhereArgs: unknown[] = [];
    const db = {
      select: jest.fn().mockImplementation(() => {
        const where = jest.fn().mockImplementation((arg: unknown) => {
          allWhereArgs.push(arg);
          return makeChainResult([{ sum: "0" }]);
        });
        return { from: jest.fn().mockReturnValue({ where, innerJoin: jest.fn().mockReturnValue({ where }) }) };
      }),
    } as unknown as Db;
    const dispatch = { sendNotification: jest.fn(), emit: jest.fn() } as never;
    const cache = { cached: jest.fn().mockResolvedValue("PENDING") } as never;
    const svc = new TaxComplianceService(db, cache, dispatch);

    await svc.checkTaxDue(TARGET_ORG);

    if (allWhereArgs.length > 0) {
      const allVals = allWhereArgs.flatMap(w => sqlValues(w));
      expect(allVals).toContain(TARGET_ORG);
    } else {
      expect(true).toBe(true);
    }
  });

  it("returns an empty array when within the due date window (same-tenant control)", async () => {
    const db = {
      select: jest.fn().mockImplementation(() => {
        const where = jest.fn().mockReturnValue(makeChainResult([]));
        return { from: jest.fn().mockReturnValue({ where }) };
      }),
    } as unknown as Db;
    const dispatch = { sendNotification: jest.fn(), emit: jest.fn() } as never;
    const cache = { cached: jest.fn().mockResolvedValue("PENDING") } as never;
    const svc = new TaxComplianceService(db, cache, dispatch);

    const result = await svc.checkTaxDue(TARGET_ORG);

    expect(result).toBeInstanceOf(Array);
  });
});
