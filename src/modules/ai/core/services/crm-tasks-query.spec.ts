jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import { CrmTasksService } from "./crm-tasks.service";

describe("CrmTasksService assignment query", () => {
  it("projects and bounds tickets without hydrating unused assignees", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new CrmTasksService(
      { query: { tickets: { findMany } } } as never,
      {} as never,
    );

    await service.suggestTaskAssignments("org-1", 7);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: { id: true, title: true, priority: true, assigneeMembershipId: true },
        limit: 100,
      }),
    );
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty("with");
  });
});
