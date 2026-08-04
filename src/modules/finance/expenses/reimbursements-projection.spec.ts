import { ReimbursementsService } from "./reimbursements.service";

describe("ReimbursementsService relation projection", () => {
  it("never hydrates sensitive global-user columns for list actors", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: { finReimbursementBatches: { findMany } },
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ total: 0 }]) }),
      }),
    };
    const service = new ReimbursementsService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.listBatches("org-1", { page: 1, pageSize: 25 });

    const options = findMany.mock.calls[0]?.[0];
    expect(options.with.creator.columns).toEqual({
      id: true,
      name: true,
      firstName: true,
      lastName: true,
      email: true,
      image: true,
    });
    expect(options.with.approver.columns).toEqual(options.with.creator.columns);
    expect(options.with.creator.columns).not.toHaveProperty("bankDetails");
    expect(options.with.creator.columns).not.toHaveProperty("taxId");
    expect(options.with.creator.columns).not.toHaveProperty("totpSecret");
  });
});
