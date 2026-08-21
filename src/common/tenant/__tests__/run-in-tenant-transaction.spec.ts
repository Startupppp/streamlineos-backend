import { runInTenantTransaction } from "../run-in-tenant-transaction";
import { TenantContextService, type TenantContext } from "../tenant-context";
import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../with-tenant";

describe("runInTenantTransaction", () => {
  const service = new TenantContextService();
  const mockExecute = jest.fn().mockResolvedValue([]);
  const mockTx = { execute: mockExecute } as unknown as TenantTx;

  type MockDb = { transaction: jest.Mock };

  function makeMockDb(): MockDb {
    return {
      transaction: jest.fn().mockImplementation(
        (fn: (tx: TenantTx) => Promise<unknown>) => fn(mockTx),
      ),
    };
  }

  beforeEach(() => {
    mockExecute.mockClear();
  });

  it("reuses the ambient transaction when a context exists and no explicit org is given", async () => {
    const mockDb = makeMockDb();
    const fn = jest.fn().mockResolvedValue("result");
    const ctx: TenantContext = {
      orgId: "org-ambient",
      audience: "INTERNAL",
      tx: mockTx,
    };

    await service.run(ctx, () => runInTenantTransaction(mockDb as unknown as Db, fn));

    expect(fn).toHaveBeenCalledWith(mockTx);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("rejects when there is no ambient context and no explicit orgId", async () => {
    const mockDb = makeMockDb();

    await expect(runInTenantTransaction(mockDb as unknown as Db, jest.fn())).rejects.toThrow(
      /background jobs/i,
    );
  });

  it("opens a new transaction and sets the tenant GUC when an explicit orgId is given with no active context", async () => {
    const mockDb = makeMockDb();
    const fn = jest.fn().mockResolvedValue("swept");

    await runInTenantTransaction(mockDb as unknown as Db, fn, { orgId: "org-explicit" });

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);

    function containsString(value: unknown, target: string): boolean {
      if (typeof value === "string") return value === target;
      if (!value || typeof value !== "object") return false;
      const obj = value as Record<string, unknown>;
      if ("queryChunks" in obj && Array.isArray(obj.queryChunks))
        return (obj.queryChunks as unknown[]).some((c) => containsString(c, target));
      return false;
    }
    const sqlArg = mockExecute.mock.calls[0]?.[0];
    expect(containsString(sqlArg, "org-explicit")).toBe(true);
    expect(fn).toHaveBeenCalledWith(mockTx);
  });

  it("throws and names both orgs when the explicit orgId differs from the ambient context", async () => {
    const mockDb = makeMockDb();
    const ctx: TenantContext = {
      orgId: "org-a",
      audience: "INTERNAL",
      tx: mockTx,
    };

    let caught: unknown;
    await service.run(ctx, async () => {
      try {
        await runInTenantTransaction(mockDb as unknown as Db, jest.fn(), { orgId: "org-b" });
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("org-a");
    expect(msg).toContain("org-b");
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("reuses the ambient transaction when the explicit orgId matches the ambient context", async () => {
    const mockDb = makeMockDb();
    const fn = jest.fn().mockResolvedValue("result");
    const ctx: TenantContext = {
      orgId: "org-same",
      audience: "INTERNAL",
      tx: mockTx,
    };

    await service.run(ctx, () =>
      runInTenantTransaction(mockDb as unknown as Db, fn, { orgId: "org-same" }),
    );

    expect(fn).toHaveBeenCalledWith(mockTx);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
