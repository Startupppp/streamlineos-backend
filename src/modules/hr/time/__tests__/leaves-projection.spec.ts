import { LeavesService } from "../leaves.service";

describe("LeavesService user projection", () => {
  it("projects public user fields for this-week leave rows", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new LeavesService(
      { query: { leaveRequests: { findMany } } } as never,
      {} as never,
      {} as never,
      {} as never,
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
      designation: true,
    });
    expect(columns).not.toHaveProperty("totpSecret");
    expect(columns).not.toHaveProperty("bankDetails");
    expect(columns).not.toHaveProperty("taxId");
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
