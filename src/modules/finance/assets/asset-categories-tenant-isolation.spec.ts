import type { Db } from "../../../db/drizzle.module";
import { AssetCategoriesService } from "./asset-categories.service";

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

describe("AssetCategoriesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeService(rows: unknown[]): { svc: AssetCategoriesService; where: jest.Mock } {
    const where = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
    });
    const db = { select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }) } as unknown as Db;
    const cache = { cachedVersioned: jest.fn().mockImplementation((_ns: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new AssetCategoriesService(db, cache);
    return { svc, where };
  }

  it("scopes list to the requesting org (tenant isolation)", async () => {
    const { svc, where } = makeService([]);

    await svc.list(ATTACKER_ORG, { limit: 20 });

    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns items for the owning org (same-tenant control)", async () => {
    const { svc } = makeService([{ id: 1, orgId: OWNER_ORG }]);

    const result = await svc.list(OWNER_ORG, { limit: 20 });

    expect(result.data).toHaveLength(1);
  });
});
