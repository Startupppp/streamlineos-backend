/**
 * user_api_tokens is scoped by userId. Cross-user isolation: user A cannot list
 * user B's personal API tokens because every query filters by userId.
 *
 * list() keeps the user predicate on every keyset query.
 */

import { UserApiTokensService } from "./user-api-tokens.service";
import type { Db } from "../../../db/drizzle.module";

function makeDb(rows: unknown[]): Db {
  const rowsChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  const db = {
    select: jest.fn().mockReturnValue(rowsChain),
  } as unknown as Db;
  return db;
}

describe("UserApiTokensService — cross-user isolation", () => {
  const OWNER_USER = "user-owner";
  const ATTACKER_USER = "user-attacker";

  it("returns no tokens for a different user (cross-user isolation: attacker cannot see owner personal tokens)", async () => {
    const db = makeDb([]);
    const svc = new UserApiTokensService(db, {} as never, {} as never);

    const result = await svc.list(ATTACKER_USER, { limit: 20 });

    expect(result.data).toHaveLength(0);
    expect(result.pagination).toEqual({ limit: 20, hasMore: false, nextCursor: null });
  });

  it("returns tokens for the owning user (control)", async () => {
    const token = {
      id: "tok-user-1",
      userId: OWNER_USER,
      name: "My token",
      prefix: "pat_abc",
      scopes: ["build:tickets:view"],
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
    };
    const db = makeDb([token]);
    const svc = new UserApiTokensService(db, {} as never, {} as never);

    const result = await svc.list(OWNER_USER, { limit: 20 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: "tok-user-1" });
  });
});
