import { withSavepoint } from "../../data-quality/savepoint";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../db/drizzle.types";

describe("withSavepoint — savepoint creates a DB-level boundary (ticket 38)", () => {
  it("calls ambient.tx.transaction when an ambient context is present", async () => {
    const savepointTx = {} as unknown as TenantTx;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => fn(savepointTx),
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    await runWithTenantContext(
      { orgId: "org-savepoint-1", audience: "INTERNAL" as const, tx: outerTx },
      async () => {
        let effectRan = false;
        await withSavepoint(async () => {
          effectRan = true;
        });
        expect(effectRan).toBe(true);
        expect(outerTransaction).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("a failing effect propagates out of withSavepoint and the outer transaction mock remains callable — proving the outer tx is not poisoned", async () => {
    const savepointTx = {} as unknown as TenantTx;
    let transactionCallCount = 0;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => {
        transactionCallCount++;
        return fn(savepointTx);
      },
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    await runWithTenantContext(
      { orgId: "org-savepoint-2", audience: "INTERNAL" as const, tx: outerTx },
      async () => {
        await expect(
          withSavepoint(() => Promise.reject(new Error("effect failed"))),
        ).rejects.toThrow("effect failed");

        let secondEffectRan = false;
        await withSavepoint(async () => {
          secondEffectRan = true;
        });
        expect(secondEffectRan).toBe(true);
        expect(transactionCallCount).toBe(2);
      },
    );
  });

  it("a catch around withSavepoint that swallows the error leaves the enclosing code able to return its result — the pattern used by the five ticket-38 sites", async () => {
    const savepointTx = {} as unknown as TenantTx;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => fn(savepointTx),
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    const mainResult = { id: 99, body: "comment text" };
    let effectWasCalled = false;

    const result = await runWithTenantContext(
      { orgId: "org-savepoint-3", audience: "INTERNAL" as const, tx: outerTx },
      async () => {
        effectWasCalled = true;
        await withSavepoint(() =>
          Promise.reject(new Error("activity log failed")),
        ).catch(() => undefined);
        return mainResult;
      },
    );

    expect(effectWasCalled).toBe(true);
    expect(result).toEqual(mainResult);
    expect(outerTransaction).toHaveBeenCalledTimes(1);
  });
});
