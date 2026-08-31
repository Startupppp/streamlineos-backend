import type { Db } from "../../../db/drizzle.module";
import { AffiliateService } from "./affiliate.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("AffiliateService — cross-tenant isolation", () => {
  const USER_A = "user-a";
  const USER_B = "user-b";

  function makeDb(affiliateRow: unknown, commissions: unknown[] = []): { db: Db; where: jest.Mock } {
    const where = jest.fn().mockResolvedValue(affiliateRow ? [affiliateRow] : []);
    const orderBy = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(commissions) });
    const fromAffiliate = jest.fn().mockReturnValue({ where });
    const fromCommission = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy }) });
    let callCount = 0;
    const select = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return { from: fromAffiliate };
      return { from: fromCommission };
    });
    const db = { select } as unknown as Db;
    return { db, where };
  }

  it("returns null dashboard for a user with no affiliate record (isolation — no cross-user affiliate data)", async () => {
    const { db } = makeDb(null);
    const svc = new AffiliateService(db);
    const result = await svc.getDashboard(USER_B);
    expect(result).toBeNull();
  });

  it("returns dashboard for the affiliated user (control — correct user)", async () => {
    const affiliateRow = { id: 1, userId: USER_A, orgId: "org-1", referralCode: "CODE1", status: "ACTIVE" };
    const { db } = makeDb(affiliateRow, [{ id: 1, amount: 100 }]);
    const svc = new AffiliateService(db);
    const result = await svc.getDashboard(USER_A);
    expect(result).toHaveProperty("affiliate");
  });
});
