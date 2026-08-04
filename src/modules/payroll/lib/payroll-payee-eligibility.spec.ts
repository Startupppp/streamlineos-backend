import { ForbiddenException } from "@nestjs/common";
import {
  assertPayrollPayeeEligible,
  assertPayrollWorkerPayeeEligible,
} from "./payroll-payee-eligibility";

describe("assertPayrollPayeeEligible", () => {
  const orgId = "org-1";
  const userId = "user-payee";

  function createDb(options: { membership?: boolean; payeeWorker?: boolean }) {
    return {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(options.membership ? { id: "mem-1" } : null),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(options.payeeWorker ? [{ workerId: "w-1" }] : []),
            }),
          }),
        }),
      }),
    };
  }

  it("allows active organization members", async () => {
    await expect(
      assertPayrollPayeeEligible(createDb({ membership: true }) as never, orgId, userId),
    ).resolves.toBeUndefined();
  });

  it("allows workforce payees without membership", async () => {
    await expect(
      assertPayrollPayeeEligible(createDb({ payeeWorker: true }) as never, orgId, userId),
    ).resolves.toBeUndefined();
  });

  it("rejects users who are neither members nor payee workers", async () => {
    await expect(
      assertPayrollPayeeEligible(createDb({}) as never, orgId, userId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("assertPayrollWorkerPayeeEligible", () => {
  const orgId = "org-1";
  const workerId = "worker-1";

  function createWorkerDb(options: { row?: { workerId: string; userId: string | null } | null }) {
    return {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(options.row ? [options.row] : []),
            }),
          }),
        }),
      }),
    };
  }

  it("allows login-less payee workers", async () => {
    await expect(
      assertPayrollWorkerPayeeEligible(
        createWorkerDb({ row: { workerId, userId: null } }) as never,
        orgId,
        workerId,
      ),
    ).resolves.toEqual({ workerId, userId: null });
  });

  it("returns linked userId when present", async () => {
    await expect(
      assertPayrollWorkerPayeeEligible(
        createWorkerDb({ row: { workerId, userId: "user-linked" } }) as never,
        orgId,
        workerId,
      ),
    ).resolves.toEqual({ workerId, userId: "user-linked" });
  });

  it("rejects non-payee or missing workers", async () => {
    await expect(
      assertPayrollWorkerPayeeEligible(createWorkerDb({ row: null }) as never, orgId, workerId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
