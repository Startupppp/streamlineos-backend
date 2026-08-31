import type { Db } from "../../../db/drizzle.module";
import { ScenariosService } from "./scenarios.service";

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

describe("ScenariosService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeService(rows: unknown[]): { svc: ScenariosService; where: jest.Mock } {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }) });
    const db = { select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }) } as unknown as Db;
    const svc = new ScenariosService(db, {} as never, {} as never);
    return { svc, where };
  }

  it("scopes scenario list to the requesting org (tenant isolation)", async () => {
    const { svc, where } = makeService([]);

    const result = await svc.listScenarios(ATTACKER_ORG);

    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns scenarios for the owning org (same-tenant control)", async () => {
    const { svc } = makeService([{ id: 1, orgId: OWNER_ORG }]);

    const result = await svc.listScenarios(OWNER_ORG);

    expect(result).toHaveLength(1);
  });
});
