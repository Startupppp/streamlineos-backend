import { ConflictException } from "@nestjs/common";
import { PayrollJobsService } from "../payroll-jobs.service";
import { logger } from "../../../../common/logger/logger.service";

jest.mock("../../../../common/logger/logger.service", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const ORG = "org-1";

function makeDb(opts: { findFirst?: unknown; onInsert: () => Promise<unknown> }) {
  return {
    query: {
      payrollJobs: {
        findFirst: jest.fn().mockResolvedValue(opts.findFirst ?? undefined),
      },
    },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockImplementation(opts.onInsert),
      }),
    }),
  };
}

const baseParams = {
  orgId: ORG,
  jobType: "GENERATE" as const,
  actorId: "actor-1",
};

describe("PayrollJobsService enqueue error handling", () => {
  beforeEach(() => jest.clearAllMocks());

  it("logs error and rethrows on a non-23505 insert failure (no idempotency key)", async () => {
    const dbErr = Object.assign(new Error("connection reset"), { code: "08006" });
    const svc = new PayrollJobsService(makeDb({ onInsert: () => Promise.reject(dbErr) }) as never);

    await expect(svc.enqueue(baseParams)).rejects.toBe(dbErr);
    expect(logger.error as jest.Mock).toHaveBeenCalledWith(
      "payroll-jobs.enqueue: insert failed unexpectedly",
      expect.objectContaining({ cause: "connection reset" }),
    );
  });

  it("throws ConflictException on a 23505 insert failure (no idempotency key)", async () => {
    const dbErr = Object.assign(new Error("unique violation"), { code: "23505" });
    const svc = new PayrollJobsService(makeDb({ onInsert: () => Promise.reject(dbErr) }) as never);

    await expect(svc.enqueue(baseParams)).rejects.toBeInstanceOf(ConflictException);
    expect(logger.error as jest.Mock).not.toHaveBeenCalled();
  });

  it("logs error and rethrows on a non-23505 insert failure (with idempotency key, no prior job)", async () => {
    const dbErr = Object.assign(new Error("rls deny"), { code: "42501" });
    const svc = new PayrollJobsService(
      makeDb({ findFirst: undefined, onInsert: () => Promise.reject(dbErr) }) as never,
    );

    await expect(svc.enqueue({ ...baseParams, idempotencyKey: "key-abc" })).rejects.toBe(dbErr);
    expect(logger.error as jest.Mock).toHaveBeenCalledWith(
      "payroll-jobs.enqueue: insert failed unexpectedly",
      expect.objectContaining({ cause: "rls deny" }),
    );
  });
});
