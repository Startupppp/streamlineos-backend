import { LeavesService } from "../leaves.service";

describe("LeavesService user projection", () => {
  it("projects public user fields for this-week leave rows", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new LeavesService(
      { query: { leaveRequests: { findMany } } } as never,
      {} as never,
      {} as never,
      {} as never,
      { getFactsBatch: jest.fn().mockResolvedValue(new Map()) } as never,
    );

    await service.thisWeek("org-1");

    const columns = findMany.mock.calls[0]?.[0]?.with?.user?.columns;
    expect(columns).toEqual({
      id: true,
      name: true,
      firstName: true,
      lastName: true,
      email: true,
      image: true,
    });
    expect(columns).not.toHaveProperty("totpSecret");
    expect(columns).not.toHaveProperty("bankDetails");
    expect(columns).not.toHaveProperty("taxId");
  });

  it("serves designation from the employment accessor, not from the users row", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 1, user: { id: "user-1" } }]);
    const getFactsBatch = jest
      .fn()
      .mockResolvedValue(new Map([["user-1", { designation: "Staff Engineer" }]]));
    const service = new LeavesService(
      { query: { leaveRequests: { findMany } } } as never,
      {} as never,
      {} as never,
      {} as never,
      { getFactsBatch } as never,
    );

    const rows = await service.thisWeek("org-1");

    expect(getFactsBatch).toHaveBeenCalledWith("org-1", ["user-1"]);
    expect(rows[0]?.user?.designation).toBe("Staff Engineer");
  });

  it("uses an id cursor and a bounded self-service window", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 9 },
      { id: 8 },
      { id: 7 },
    ]);
    const service = new LeavesService(
      { query: { leaveRequests: { findMany } } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await service.my("org-1", "user-1", {
      cursor: 10,
      limit: 2,
    });

    expect(findMany.mock.calls[0]?.[0]?.limit).toBe(3);
    expect(result).toEqual({
      data: [{ id: 9 }, { id: 8 }],
      pageInfo: { limit: 2, hasMore: true, nextCursor: 8 },
    });
  });
});
