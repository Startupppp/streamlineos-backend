import type { Db } from "../../../db/drizzle.module";
import { VendorCreditsService } from "./vendor-credits.service";

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

describe("VendorCreditsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeService(rows: unknown[]): { svc: VendorCreditsService; where: jest.Mock } {
    const where = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
    });
    const db = { select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ leftJoin: jest.fn().mockReturnValue({ where }) }) }) } as unknown as Db;
    const audit = { log: jest.fn() } as never;
    const cache = { cachedForOrg: jest.fn().mockImplementation((_o: unknown, _k: unknown, fn: () => unknown) => fn()), invalidateForOrg: jest.fn() } as never;
    const svc = new VendorCreditsService(db, audit, cache, {} as never, {} as never);
    return { svc, where };
  }

  it("scopes the query to the requesting org (tenant isolation)", async () => {
    const { svc, where } = makeService([]);

    await svc.listVendorCredits(ATTACKER_ORG, { limit: 20 });

    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns items for the owning org (same-tenant control)", async () => {
    const { svc } = makeService([{ id: 1, orgId: OWNER_ORG }]);

    const result = await svc.listVendorCredits(OWNER_ORG, { limit: 20 });

    expect(result.data).toHaveLength(1);
  });
});
