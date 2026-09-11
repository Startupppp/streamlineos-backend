import type { Db } from "../../../db/drizzle.module";
import { FnfService } from "./fnf.service";

/**
 * `select({ total }).from(t).where(p)` — the COUNT half of the list envelope.
 *
 * A second read of the same table, held to the same tenant predicate as the page read:
 * a count outside the org scope would disclose another tenant's settlement count.
 */
function countSelect(total: number) {
  const countWhere = jest.fn();
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve([{ total }]).then(resolve),
  };
  chain["from"] = jest.fn().mockReturnValue(chain);
  chain["where"] = countWhere.mockReturnValue(chain);
  return { select: jest.fn().mockReturnValue(chain), countWhere };
}

describe("FnfService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  it("listFnf returns only attacker-org records (empty) — orgId scoped (cross-tenant isolation)", async () => {
    const { select, countWhere } = countSelect(0);
    const db = {
      query: {
        fnfSettlements: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select,
    } as unknown as Db;
    const svc = new FnfService(db);
    const result = await svc.listFnf(ATTACKER_ORG, "u1", null, true);
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(countWhere).toHaveBeenCalledTimes(1);
    const call = (db.query.fnfSettlements.findMany as jest.Mock).mock.calls[0]?.[0];
    function collect(root: unknown): unknown[] {
      const vals: unknown[] = [];
      const seen = new Set<object>();
      const walk = (v: unknown): void => {
        if (typeof v === "string") vals.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          if (seen.has(v as object)) return;
          seen.add(v as object);
          Object.values(v as Record<string, unknown>).forEach(walk);
        }
      };
      walk(root);
      return vals;
    }
    expect(collect(call?.where)).toContain(ATTACKER_ORG);
    // The count is a second read of the same table — it carries the org predicate too.
    expect(collect(countWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("createFnf returns ok:false when member not found in attacker org (cross-tenant isolation)", async () => {
    const db = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
        fnfSettlements: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
    const svc = new FnfService(db);
    const result = await svc.createFnf(ATTACKER_ORG, { userId: "victim", basicDues: 1000 } as never);
    expect(result).toMatchObject({ ok: false });
  });

  it("listFnf returns records for the owning org (same-tenant control)", async () => {
    const record = { id: 1, orgId: OWNER_ORG, userId: "u1" };
    const { select } = countSelect(1);
    const db = {
      query: {
        fnfSettlements: { findMany: jest.fn().mockResolvedValue([record]) },
      },
      select,
    } as unknown as Db;
    const svc = new FnfService(db);
    const result = await svc.listFnf(OWNER_ORG, "u1", null, true);
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});
