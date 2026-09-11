/**
 * api_keys is a tenant-scoped table (orgId column). Cross-tenant isolation: org A
 * cannot read API tokens belonging to org B because every query filters by orgId.
 *
 * listTokens scopes every keyset query by orgId, so a cursor issued to one
 * organization cannot be replayed by another.
 */

import { ApiTokensService } from "./api-tokens.service";
import type { Db } from "../../../db/drizzle.module";
import { BadRequestException } from "@nestjs/common";
import { decodeCursor, encodeCursor } from "../../../common/pagination/cursor";

function makeRowsChain(rows: unknown[]) {
  return {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  };
}

function makeDb(rows: unknown[]): Db {
  const db = {
    select: jest.fn().mockReturnValue(makeRowsChain(rows)),
  } as unknown as Db;
  return db;
}

describe("ApiTokensService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  it("returns no tokens for a different org (org isolation: attacker org cannot see owner org tokens)", async () => {
    const db = makeDb([]);
    const svc = new ApiTokensService(db, {} as never);

    const result = await svc.listTokens(ATTACKER_ORG, { limit: 20 });

    expect(result.data).toHaveLength(0);
    expect(result.pagination).toEqual({ limit: 20, hasMore: false, nextCursor: null });
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
    const db = makeDb([token]);
    const svc = new ApiTokensService(db, {} as never);

    const result = await svc.listTokens(OWNER_ORG, { limit: 20 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: "tok-1", name: "CI token" });
  });

  it("uses the last kept token as the duplicate-safe next cursor", async () => {
    const createdAt = new Date("2026-08-01T00:00:00.000Z");
    const db = makeDb([
      { id: "tok-3", createdAt },
      { id: "tok-2", createdAt },
      { id: "tok-1", createdAt },
    ]);
    const svc = new ApiTokensService(db, {} as never);

    const result = await svc.listTokens(OWNER_ORG, { limit: 2 });

    expect(result.data).toHaveLength(2);
    expect(result.pagination.hasMore).toBe(true);
    expect(JSON.parse(decodeCursor(result.pagination.nextCursor)?.id ?? "")).toEqual([
      OWNER_ORG,
      "tok-2",
    ]);
  });

  it.each([
    ["malformed cursor", "not-a-cursor"],
    [
      "cross-organization cursor",
      encodeCursor({
        sortValue: "2026-08-01T00:00:00.000Z",
        id: JSON.stringify([ATTACKER_ORG, "tok-1"]),
      }),
    ],
  ])("rejects a %s before querying", async (_label, cursor) => {
    const db = makeDb([]);
    const svc = new ApiTokensService(db, {} as never);

    await expect(svc.listTokens(OWNER_ORG, { cursor, limit: 20 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(db.select).not.toHaveBeenCalled();
  });
});
