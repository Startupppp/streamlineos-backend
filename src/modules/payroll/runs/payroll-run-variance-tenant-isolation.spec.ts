import type { Db } from "../../../db/drizzle.module";
import { PayrollRunVarianceService } from "./payroll-run-variance.service";

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

describe("PayrollRunVarianceService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(runRows: unknown[], prevRunRows: unknown[] = [], empRows: unknown[] = []) {
    // First select: current run by (runId, orgId) with .limit()
    const runLimit = jest.fn().mockResolvedValue(runRows);
    const runWhere = jest.fn().mockReturnValue({ limit: runLimit });
    const runFrom = jest.fn().mockReturnValue({ where: runWhere });

    // Second select: previous run by (orgId, month<, status) with .orderBy().limit()
    const prevLimit = jest.fn().mockResolvedValue(prevRunRows);
    const prevOrderBy = jest.fn().mockReturnValue({ limit: prevLimit });
    const prevWhere = jest.fn().mockReturnValue({ orderBy: prevOrderBy });
    const prevFrom = jest.fn().mockReturnValue({ where: prevWhere });

    // Third select: employees with innerJoin, .orderBy().limit()
    const empLimit = jest.fn().mockResolvedValue(empRows);
    const empOrderBy = jest.fn().mockReturnValue({ limit: empLimit });
    const empWhere = jest.fn().mockReturnValue({ orderBy: empOrderBy });
    const empInnerJoin = jest.fn().mockReturnValue({ where: empWhere });
    const empFrom = jest.fn().mockReturnValue({ innerJoin: empInnerJoin });

    const select = jest.fn()
      .mockReturnValueOnce({ from: runFrom })
      .mockReturnValueOnce({ from: prevFrom })
      .mockReturnValue({ from: empFrom });

    return { db: { select } as unknown as Db, runWhere };
  }

  it("returns null for getVariance when run belongs to a different org (cross-tenant isolation)", async () => {
    const { db, runWhere } = makeDb([]);
    const svc = new PayrollRunVarianceService(db);
    const result = await svc.getVariance(ATTACKER_ORG, 99);
    expect(result).toBeNull();
    expect(sqlValues(runWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns variance data for the owning org (same-tenant control)", async () => {
    const run = { id: 1, month: "2024-01", grossTotal: "5000", netTotal: "4000" };
    const { db } = makeDb([run], [], []);
    const svc = new PayrollRunVarianceService(db);
    const result = await svc.getVariance(OWNER_ORG, 1);
    expect(result).not.toBeNull();
    expect(result?.currentRun.id).toBe(1);
  });
});
