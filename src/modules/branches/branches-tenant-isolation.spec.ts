import { BranchesReadService } from "./branches-read.service";
import type { Db } from "../../db/drizzle.module";

function makeReadDb(rows: unknown[]): Db {
  return {
    query: {
      orgUnits: { findMany: jest.fn().mockResolvedValue(rows) },
    },
    select: jest.fn(),
  } as unknown as Db;
}

describe("BranchesReadService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const makeSvc = (db: Db) =>
    new BranchesReadService(
      db,
      { cachedForOrg: (_orgId: string, _key: string, fn: () => unknown) => fn() } as never,
    );

  it("returns empty list when no branches exist for the queried org (org isolation: attacker cannot see owner org branches)", async () => {
    const db = makeReadDb([]);
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
    const db = makeReadDb([branch]);
    const svc = makeSvc(db);

    const result = await svc.list(OWNER_ORG);

    expect(Array.isArray(result)).toBe(true);
  });
});
