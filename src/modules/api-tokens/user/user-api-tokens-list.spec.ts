import { UserApiTokensService } from "./user-api-tokens.service";
import { BadRequestException } from "@nestjs/common";
import { decodeCursor, encodeCursor } from "../../../common/pagination/cursor";

const createdAt = new Date("2026-08-01T00:00:00.000Z");

function token(id: string, name = "Automation") {
  return {
    id,
    userId: "user-1",
    name,
    prefix: "pat_test",
    scopes: ["settings:view"],
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    lastUsedAt: null,
    createdAt,
  };
}

function listDb(rows: ReturnType<typeof token>[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { select }, limit, where };
}

describe("UserApiTokensService.list", () => {
  it("uses a duplicate-safe cursor and trims the sentinel row", async () => {
    const db = listDb([token("token-3"), token("token-2"), token("token-1")]);
    const service = new UserApiTokensService(
      db.db as never,
      {} as never,
      {} as never,
    );

    const result = await service.list("user-1", { limit: 2 });

    expect(db.limit).toHaveBeenCalledWith(3);
    expect(result.data).toEqual([token("token-3"), token("token-2")]);
    expect(result.pagination).toMatchObject({ limit: 2, hasMore: true });
    expect(JSON.parse(decodeCursor(result.pagination.nextCursor)?.id ?? "")).toEqual([
      "user-1",
      "token-2",
    ]);
  });

  it("returns no next cursor on the final page", async () => {
    const db = listDb([token("token-1")]);
    const service = new UserApiTokensService(db.db as never, {} as never, {} as never);

    const result = await service.list("user-1", { limit: 2 });

    expect(result).toEqual({
      data: [token("token-1")],
      pagination: { limit: 2, hasMore: false, nextCursor: null },
    });
  });

  it.each([
    ["malformed cursor", "not-a-cursor"],
    [
      "cross-user cursor",
      encodeCursor({
        sortValue: createdAt.toISOString(),
        id: JSON.stringify(["other-user", "token-1"]),
      }),
    ],
  ])("rejects a %s before querying", async (_label, cursor) => {
    const select = jest.fn();
    const service = new UserApiTokensService({ select } as never, {} as never, {} as never);

    await expect(service.list("user-1", { cursor, limit: 20 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(select).not.toHaveBeenCalled();
  });
});
