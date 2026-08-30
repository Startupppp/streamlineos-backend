import type { Db } from "../../../db/drizzle.module";
import { HrAnalyticsPlusService } from "./hr-analytics-plus.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as Record<string, unknown>;
  return [
    ...(Array.isArray(r["queryChunks"]) ? sqlValues(r["queryChunks"], seen) : []),
    ...("value" in r ? sqlValues(r["value"], seen) : []),
  ];
}

describe("HrAnalyticsPlusService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeService(dbRows: unknown[]) {
    const execute = jest.fn().mockResolvedValue(dbRows);
    const mockDb = { execute } as unknown as Db;
    const mockCache = {
      cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()),
    };
    const mockCmd = { getCommandCenter: jest.fn().mockResolvedValue({}) };
    const svc = new HrAnalyticsPlusService(mockDb, mockCache as never, mockCmd as never);
    return { svc, execute };
  }

  it("scopes attrition query to attacker org (cross-tenant isolation)", async () => {
    const { svc, execute } = makeService([]);
    await svc.getAttrition(ATTACKER);
    expect(execute).toHaveBeenCalled();
    const firstCallArg = execute.mock.calls[0]?.[0];
    expect(sqlValues(firstCallArg)).toContain(ATTACKER);
  });

  it("scopes attrition query to owner org (control — same-tenant access works)", async () => {
    const { svc, execute } = makeService([]);
    await svc.getAttrition(OWNER);
    expect(execute).toHaveBeenCalled();
    const firstCallArg = execute.mock.calls[0]?.[0];
    expect(sqlValues(firstCallArg)).toContain(OWNER);
  });
});
