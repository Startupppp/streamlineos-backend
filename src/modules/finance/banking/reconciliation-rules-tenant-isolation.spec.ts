import type { Db } from "../../../db/drizzle.module";
import { ReconciliationRulesService } from "./reconciliation-rules.service";
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

describe("ReconciliationRulesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeService(rows: unknown[]): { svc: ReconciliationRulesService; where: jest.Mock } {
    const where = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
    });
    const db = { select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }) } as unknown as Db;
    const svc = new ReconciliationRulesService(db, {} as never);
    return { svc, where };
  }

  it("scopes listRules to the requesting org (tenant isolation)", async () => {
    const { svc, where } = makeService([]);

    await svc.listRules(makeUser(ATTACKER_ORG), { limit: 20 });

    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns items for the owning org (same-tenant control)", async () => {
    const { svc } = makeService([{ id: 1, orgId: OWNER_ORG }]);

    const result = await svc.listRules(makeUser(OWNER_ORG), { limit: 20 });

    expect(result.data).toHaveLength(1);
  });
});
