const mockRunInNewTenantTransaction = jest.fn();

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (...args: unknown[]) => mockRunInNewTenantTransaction(...args),
  runInTenantTransaction: jest.fn(
    async (db: unknown, fn: (tx: unknown) => Promise<void>, opts?: { orgId?: string }) =>
      mockRunInNewTenantTransaction(db, opts?.orgId ?? "", fn),
  ),
}));

import { purgeReviewsForPages } from "./kb-purge-reviews";

describe("purgeReviewsForPages — explicit deletion of review history before page row destruction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls runInNewTenantTransaction with the orgId supplied by the caller", async () => {
    const mockDeleteResult = { where: jest.fn().mockResolvedValue(undefined) };
    const mockTx = { delete: jest.fn().mockReturnValue(mockDeleteResult) };
    mockRunInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: unknown, fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx),
    );

    await purgeReviewsForPages({} as never, "org-purge-test", [10, 20, 30]);

    expect(mockRunInNewTenantTransaction).toHaveBeenCalledWith(
      expect.anything(),
      "org-purge-test",
      expect.any(Function),
    );
  });

  it("issues a delete inside the transaction so the deletion is atomic and tenant-scoped", async () => {
    const mockDeleteResult = { where: jest.fn().mockResolvedValue(undefined) };
    const mockTx = { delete: jest.fn().mockReturnValue(mockDeleteResult) };
    mockRunInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: unknown, fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx),
    );

    await purgeReviewsForPages({} as never, "org-purge-test", [10, 20]);

    expect(mockTx.delete).toHaveBeenCalledTimes(1);
    expect(mockDeleteResult.where).toHaveBeenCalledTimes(1);
  });

  it("does nothing when pageIds is empty, so the caller can safely pass an empty batch without opening a transaction", async () => {
    await purgeReviewsForPages({} as never, "org-purge-test", []);

    expect(mockRunInNewTenantTransaction).not.toHaveBeenCalled();
  });

  it("the empty-batch guard is not vacuous: a non-empty batch does call the transaction", async () => {
    const mockDeleteResult = { where: jest.fn().mockResolvedValue(undefined) };
    const mockTx = { delete: jest.fn().mockReturnValue(mockDeleteResult) };
    mockRunInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: unknown, fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx),
    );

    await purgeReviewsForPages({} as never, "org-purge-test", [99]);

    expect(mockRunInNewTenantTransaction).toHaveBeenCalledTimes(1);
  });
});
