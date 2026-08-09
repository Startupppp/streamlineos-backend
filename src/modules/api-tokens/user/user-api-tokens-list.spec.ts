import { UserApiTokensService } from "./user-api-tokens.service";

describe("UserApiTokensService.list", () => {
  it("returns the requested active-token page and total", async () => {
    const token = {
      id: "token-1",
      userId: "user-1",
      name: "Automation",
      prefix: "pat_test",
      scopes: ["settings:view"],
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      lastUsedAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const offset = jest.fn().mockResolvedValue([token]);
    const limit = jest.fn().mockReturnValue({ offset });
    const orderBy = jest.fn().mockReturnValue({ limit });
    const dataWhere = jest.fn().mockReturnValue({ orderBy });
    const countWhere = jest.fn().mockResolvedValue([{ total: 21 }]);
    const select = jest
      .fn()
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({ where: dataWhere }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({ where: countWhere }),
      });
    const service = new UserApiTokensService(
      { select } as never,
      {} as never,
      {} as never,
    );

    const result = await service.list("user-1", { page: 2, limit: 20 });

    expect(limit).toHaveBeenCalledWith(20);
    expect(offset).toHaveBeenCalledWith(20);
    expect(result).toEqual({
      data: [token],
      pagination: { page: 2, limit: 20, total: 21, totalPages: 2 },
    });
  });
});
