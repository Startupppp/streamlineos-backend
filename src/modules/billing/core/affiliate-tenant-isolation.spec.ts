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
  const ORG_A = "org-a";
  const MEMBERSHIP_A = 42;
  const MEMBERSHIP_B = 99;

  function makeDb(affiliateRow: unknown, commissions: unknown[] = []): { db: Db; where: jest.Mock } {
    const where = jest.fn().mockResolvedValue(affiliateRow ? [affiliateRow] : []);
    const membershipWhere = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ id: MEMBERSHIP_A }]) });
    const orderBy = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(commissions) });
    const membership = jest.fn().mockReturnValue({ where: membershipWhere });
    const fromAffiliate = jest.fn().mockReturnValue({ where });
    const fromCommission = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy }) });
    let callCount = 0;
    const select = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return { from: membership };
      if (callCount === 2) return { from: fromAffiliate };
      return { from: fromCommission };
    });
    const db = { select } as unknown as Db;
    return { db, where };
  }

  it("returns null dashboard when membershipId does not match (isolation)", async () => {
    const { db } = makeDb(null);
    const svc = new AffiliateService(db);
    const result = await svc.getDashboard(USER_B, ORG_A, MEMBERSHIP_B);
    expect(result).toBeNull();
  });

  it("returns dashboard for the affiliated user (control)", async () => {
    const affiliateRow = { id: 1, userId: USER_A, orgId: ORG_A, userMembershipId: MEMBERSHIP_A, referralCode: "CODE1", status: "ACTIVE" };
    const { db } = makeDb(affiliateRow, [{ id: 1, amount: 100 }]);
    const svc = new AffiliateService(db);
    const result = await svc.getDashboard(USER_A, ORG_A, MEMBERSHIP_A);
    expect(result).toHaveProperty("affiliate");
  });

  it("REVOCATION: getDashboard scopes to membershipId, not userId", async () => {
    const { db, where } = makeDb(null);
    const svc = new AffiliateService(db);
    await svc.getDashboard(USER_A, ORG_A, MEMBERSHIP_A);

    const predicate = where.mock.calls[0]?.[0];
    const values = sqlValues(predicate);
    expect(values).toContain(MEMBERSHIP_A);
    expect(values).toContain(ORG_A);
  });
});
