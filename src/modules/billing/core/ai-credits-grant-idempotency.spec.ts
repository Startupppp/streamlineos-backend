jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
}));

import { milliToCredits } from "../../ai/core/billing/ai-model-pricing.constants";
import { drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { AiCreditsService } from "./ai-credits.service";

describe("AiCreditsService.grantCredits — replay safety", () => {
  it("returns the committed canonical balance when a concurrent grant wins the replay key", async () => {
    const committedMilli = 42_000;
    const db = {
      transaction: jest.fn().mockRejectedValue(
        drizzleUniqueViolation("uq_ai_credit_txns_refund_ref"),
      ),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ balance: committedMilli }]),
          }),
        }),
      }),
    };
    const service = new AiCreditsService(db as never, {} as never, {} as never);

    await expect(service.grantCredits({
      orgId: "org-a",
      userId: "user-a",
      credits: 5,
      feature: "kb.admin",
      reason: "correction",
      idempotencyKey: "correction:19",
    })).resolves.toEqual({ balance: milliToCredits(committedMilli) });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("does not treat an unrelated unique violation as an idempotent replay", async () => {
    const error = drizzleUniqueViolation("some_other_unique_index");
    const db = {
      transaction: jest.fn().mockRejectedValue(error),
      select: jest.fn(),
    };
    const service = new AiCreditsService(db as never, {} as never, {} as never);

    await expect(service.grantCredits({
      orgId: "org-a",
      userId: null,
      credits: 1,
      feature: "kb.admin",
      reason: "correction",
      idempotencyKey: "correction:20",
    })).rejects.toBe(error);
    expect(db.select).not.toHaveBeenCalled();
  });
});
