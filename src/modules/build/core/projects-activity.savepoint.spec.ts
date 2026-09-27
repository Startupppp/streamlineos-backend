import { withSavepoint } from "../../data-quality/savepoint";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../db/drizzle.types";

describe("withSavepoint in projects-activity — savepoint isolates the mention insert (ticket 38)", () => {
  it("processCommentMentions: a failing mention insert propagates out of withSavepoint and the outer transaction remains callable", async () => {
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
      { orgId: "org-activity-1", audience: "INTERNAL" as const, tx: outerTx },
      async () => {
        let caughtError: unknown;
        try {
          await withSavepoint(() =>
            Promise.reject(new Error("insert ticketCommentMentions failed")),
          );
        } catch (error: unknown) {
          caughtError = error;
        }
        expect(caughtError).toBeInstanceOf(Error);
        expect((caughtError as Error).message).toBe("insert ticketCommentMentions failed");

        let outerWorkCompleted = false;
        await withSavepoint(async () => {
          outerWorkCompleted = true;
        });
        expect(outerWorkCompleted).toBe(true);
        expect(transactionCallCount).toBe(2);
      },
    );
  });

  it("processCommentMentions: the catch-swallow pattern leaves the main request work able to return its result — modelling the withSavepoint fix at line 428", async () => {
    const savepointTx = {} as unknown as TenantTx;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => fn(savepointTx),
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    const mainResult = { ticketId: 42, commentId: 7 };

    const result = await runWithTenantContext(
      { orgId: "org-activity-2", audience: "INTERNAL" as const, tx: outerTx },
      async () => {
        await withSavepoint(() =>
          Promise.reject(new Error("mention insert failed")),
        ).catch(() => undefined);
        return mainResult;
      },
    );

    expect(result).toEqual(mainResult);
    expect(outerTransaction).toHaveBeenCalledTimes(1);
  });
});
