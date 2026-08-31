import type { Db } from "../../../db/drizzle.module";
import { MatchingService } from "./matching.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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

function makeUser(orgId: string): CurrentUserContext {
  return { orgId, userId: "user-1", role: "MEMBER", isOrgOwner: false, enabledModules: [] } as unknown as CurrentUserContext;
}

describe("MatchingService — cross-tenant isolation", () => {
  it("returns early when the bank account does not belong to the org (tenant isolation)", async () => {
    const selectWhere = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        finBankAccounts: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: selectWhere }) }),
    } as unknown as Db;
    const svc = new MatchingService(db);

    await svc.suggestMatches(makeUser("org-attacker"), 99);

    expect(selectWhere).not.toHaveBeenCalled();
  });

  it("queries rules scoped to the owning org (same-tenant control)", async () => {
    const account = { id: 99, orgId: "org-owner", ledgerAccountId: 1 };
    const orderBy = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ orderBy });
    const selectWhere = jest.fn().mockResolvedValue([]);
    let call = 0;
    const db = {
      query: {
        finBankAccounts: { findFirst: jest.fn().mockResolvedValue(account) },
      },
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) return { from: jest.fn().mockReturnValue({ where }) };
        return { from: jest.fn().mockReturnValue({ where: selectWhere }) };
      }),
    } as unknown as Db;
    const svc = new MatchingService(db);

    await svc.suggestMatches(makeUser("org-owner"), 99);

    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain("org-owner");
  });
});
