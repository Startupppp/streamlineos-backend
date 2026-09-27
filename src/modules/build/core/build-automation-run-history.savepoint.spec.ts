import { withSavepoint } from "../../data-quality/savepoint";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../db/drizzle.types";

describe("withSavepoint in build-automation-run-history — savepoint isolates each audit write (ticket 38)", () => {
  it("recordRun: withSavepoint calls ambient.tx.transaction so a DB failure rolls back only the savepoint", async () => {
    const savepointTx = {} as unknown as TenantTx;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => fn(savepointTx),
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    await runWithTenantContext(
      { orgId: "org-history-1", audience: "INTERNAL" as const, tx: outerTx },
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

  it("recordRun: a failing insert rolls back only the savepoint and the outer transaction remains callable for recordRunActions", async () => {
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
      { orgId: "org-history-2", audience: "INTERNAL" as const, tx: outerTx },
      async () => {
        const recordRunResult = await withSavepoint(() =>
          Promise.reject(new Error("insert failed: unique violation")),
        ).catch((error: unknown) => {
          expect(error).toBeInstanceOf(Error);
          return null;
        });
        expect(recordRunResult).toBeNull();

        let recordActionsRan = false;
        await withSavepoint(async () => {
          recordActionsRan = true;
        });
        expect(recordActionsRan).toBe(true);
        expect(transactionCallCount).toBe(2);
      },
    );
  });

  it("recordRunActions: a failing insert is caught by .catch() and the outer transaction mock remains callable", async () => {
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
      { orgId: "org-history-3", audience: "INTERNAL" as const, tx: outerTx },
      async () => {
        let caughtError: unknown;
        await withSavepoint(() =>
          Promise.reject(new Error("insert failed: FK violation")),
        ).catch((error: unknown) => {
          caughtError = error;
        });
        expect(caughtError).toBeInstanceOf(Error);

        let subsequentEffectRan = false;
        await withSavepoint(async () => {
          subsequentEffectRan = true;
        });
        expect(subsequentEffectRan).toBe(true);
        expect(transactionCallCount).toBe(2);
      },
    );
  });
});
