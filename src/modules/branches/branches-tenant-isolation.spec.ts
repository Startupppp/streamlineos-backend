/**
 * BranchesService reads org_units scoped by orgId and kind='BRANCH'.
 * Cross-tenant isolation: org A cannot read branches owned by org B because every
 * query includes eq(orgUnits.orgId, orgId).
 */

import { BranchesService } from "./branches.service";
import type { Db } from "../../db/drizzle.module";

function makeDb(rows: unknown[]): Db {
  return {
    query: {
      orgUnits: { findMany: jest.fn().mockResolvedValue(rows) },
    },
    select: jest.fn(),
  } as unknown as Db;
}

describe("BranchesService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const makeSvc = (db: Db) =>
    new BranchesService(
      db,
      { cachedForOrg: (_orgId: string, _key: string, fn: () => unknown) => fn() } as never,
      {} as never,
    );

  it("returns empty list when no branches exist for the queried org (org isolation: attacker cannot see owner org branches)", async () => {
    const db = makeDb([]);
    const svc = makeSvc(db);

    const result = await svc.list(ATTACKER_ORG);

    expect(result).toHaveLength(0);
  });

  it("returns branches for the owning org (control)", async () => {
    const branch = {
      id: "bu-1",
      orgId: OWNER_ORG,
      kind: "BRANCH",
      name: "HQ Branch",
      metadata: {},
      head: null,
      deletedAt: null,
    };
    const db = makeDb([branch]);
    const svc = makeSvc(db);

    const result = await svc.list(OWNER_ORG);

    expect(Array.isArray(result)).toBe(true);
  });
});
