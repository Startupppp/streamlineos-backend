import type { Db } from "../../../db/drizzle.module";
import { FnfService } from "./fnf.service";

describe("FnfService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  it("listFnf returns only attacker-org records (empty) — orgId scoped (cross-tenant isolation)", async () => {
    const db = {
      query: {
        fnfSettlements: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
    const svc = new FnfService(db);
    const result = await svc.listFnf(ATTACKER_ORG, "u1", null, true);
    expect(result).toHaveLength(0);
    const call = (db.query.fnfSettlements.findMany as jest.Mock).mock.calls[0]?.[0];
    const vals: unknown[] = [];
    const seen = new Set<object>();
    function collect(v: unknown): void {
      if (typeof v === "string") vals.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") {
        if (seen.has(v as object)) return;
        seen.add(v as object);
        Object.values(v as Record<string, unknown>).forEach(collect);
      }
    }
    collect(call?.where);
    expect(vals).toContain(ATTACKER_ORG);
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
    const db = {
      query: {
        fnfSettlements: { findMany: jest.fn().mockResolvedValue([record]) },
      },
    } as unknown as Db;
    const svc = new FnfService(db);
    const result = await svc.listFnf(OWNER_ORG, "u1", null, true);
    expect(result).toHaveLength(1);
  });
});
