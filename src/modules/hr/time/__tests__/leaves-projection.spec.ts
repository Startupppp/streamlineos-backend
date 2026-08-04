import { LeavesService } from "../leaves.service";

describe("LeavesService user projection", () => {
  it("projects public user fields for this-week leave rows", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new LeavesService(
      { query: { leaveRequests: { findMany } } } as never,
      {} as never,
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
});
