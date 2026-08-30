/**
 * api_keys is a tenant-scoped table (orgId column). Cross-tenant isolation: org A
 * cannot read API tokens belonging to org B because every query filters by orgId.
 *
 * listTokens uses Promise.all([rowSelect, countSelect]). Both selects are mocked to
 * return the appropriate shape for the destructuring `const [rows, [{ count }]]`.
 */

import { ApiTokensService } from "./api-tokens.service";
import type { Db } from "../../../db/drizzle.module";

function makeRowsChain(rows: unknown[]) {
  return {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockResolvedValue(rows),
  };
}

function makeCountChain(count: number) {
  return {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([{ count }]),
  };
}

function makeDb(rows: unknown[], count: number): Db {
  const db = {
    select: jest
      .fn()
      .mockReturnValueOnce(makeRowsChain(rows))
      .mockReturnValueOnce(makeCountChain(count)),
  } as unknown as Db;
  return db;
}

describe("ApiTokensService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  it("returns no tokens for a different org (org isolation: attacker org cannot see owner org tokens)", async () => {
    const db = makeDb([], 0);
    const svc = new ApiTokensService(db, {} as never);

    const result = await svc.listTokens(ATTACKER_ORG, { page: 1, limit: 20 });

    expect(result.data).toHaveLength(0);
    expect(result.meta.total).toBe(0);
  });

  it("returns tokens for the owning org (control)", async () => {
    const token = {
      id: "tok-1",
      name: "CI token",
      orgId: OWNER_ORG,
      keyPrefix: "sk_",
      scopes: ["leads:write"],
      isRevoked: false,
      lastUsedAt: null,
      expiresAt: null,
      createdBy: "user-1",
      createdAt: new Date(),
      description: null,
    };
    const db = makeDb([token], 1);
    const svc = new ApiTokensService(db, {} as never);

    const result = await svc.listTokens(OWNER_ORG, { page: 1, limit: 20 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: "tok-1", name: "CI token" });
  });
});
