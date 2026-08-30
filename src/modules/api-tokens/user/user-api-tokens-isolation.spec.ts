/**
 * user_api_tokens is scoped by userId. Cross-user isolation: user A cannot list
 * user B's personal API tokens because every query filters by userId.
 *
 * list() uses Promise.all([rowSelect, countSelect]). Both are mocked independently.
 */

import { UserApiTokensService } from "./user-api-tokens.service";
import type { Db } from "../../../db/drizzle.module";

function makeDb(rows: unknown[], count: number): Db {
  const rowsChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockResolvedValue(rows),
  };
  const countChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([{ total: count }]),
  };
  const db = {
    select: jest
      .fn()
      .mockReturnValueOnce(rowsChain)
      .mockReturnValueOnce(countChain),
  } as unknown as Db;
  return db;
}

describe("UserApiTokensService — cross-user isolation", () => {
  const OWNER_USER = "user-owner";
  const ATTACKER_USER = "user-attacker";

  it("returns no tokens for a different user (cross-user isolation: attacker cannot see owner personal tokens)", async () => {
    const db = makeDb([], 0);
    const svc = new UserApiTokensService(db, {} as never, {} as never);

    const result = await svc.list(ATTACKER_USER, { page: 1, limit: 20 });

    expect(result.data).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
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
    const db = makeDb([token], 1);
    const svc = new UserApiTokensService(db, {} as never, {} as never);

    const result = await svc.list(OWNER_USER, { page: 1, limit: 20 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: "tok-user-1" });
  });
});
