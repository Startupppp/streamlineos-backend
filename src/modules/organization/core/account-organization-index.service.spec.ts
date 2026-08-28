import { AccountOrganizationIndexService } from "./account-organization-index.service";

type MockRow = { orgId: string; cellId: string };

function buildService(indexRows: MockRow[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(indexRows);

  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    select: chain.select,
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue([]),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue([]),
    }),
  };

  const db = {
    transaction: jest
      .fn()
      .mockImplementation(
        async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      ),
  };

  const service = new AccountOrganizationIndexService(db as never);
  return { service, db, tx, chain };
}

describe("AccountOrganizationIndexService.resolvePreferredOrg", () => {
  it("returns null when the user has no index entries", async () => {
    const { service } = buildService([]);
    await expect(service.resolvePreferredOrg("user-1")).resolves.toBeNull();
  });

  it("returns orgId and cellId from the first index row (DB controls ordering)", async () => {
    const { service } = buildService([{ orgId: "org-alpha", cellId: "cell-primary" }]);
    await expect(service.resolvePreferredOrg("user-1")).resolves.toEqual({
      orgId: "org-alpha",
      cellId: "cell-primary",
    });
  });

  it(
    "after preferred-org membership is removed the remaining org becomes the landing target",
    async () => {
      const { service } = buildService([{ orgId: "org-remaining", cellId: "cell-2" }]);

      const result = await service.resolvePreferredOrg("user-two-orgs");

      expect(result).toEqual({ orgId: "org-remaining", cellId: "cell-2" });
    },
  );

  it("does not throw when the user has never been in any organization", async () => {
    const { service } = buildService([]);
    await expect(service.resolvePreferredOrg("user-fresh")).resolves.toBeNull();
  });
});
