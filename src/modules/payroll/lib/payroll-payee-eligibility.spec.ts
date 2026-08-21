import { ForbiddenException } from "@nestjs/common";
import {
  assertPayrollPayeeEligible,
  assertPayrollPersonPayeeEligible,
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

describe("assertPayrollPersonPayeeEligible", () => {
  const orgId = "org-1";

  function createPersonDb(rows: Array<Array<Record<string, unknown>>>) {
    let cursor = 0;
    const chain = () => {
      const link: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "where"]) link[method] = () => link;
      link["limit"] = () => Promise.resolve(rows[cursor++] ?? []);
      return link;
    };
    return { select: jest.fn(() => chain()) } as never;
  }

  it("pays a person with no login through their payee worker record", async () => {
    const payee = await assertPayrollPersonPayeeEligible(
      createPersonDb([
        [{ organizationPersonId: "p-1", userId: null, membershipId: null }],
        [{ workerId: "w-1", isPayee: true }],
        [],
      ]),
      orgId,
      "p-1",
    );
    expect(payee.subject).toEqual({ userId: null, workerId: "w-1" });
    expect(payee.identity).toEqual({ kind: "worker", workerId: "w-1" });
    expect(payee.resolvedVia).toBe("person-record");
  });

  it("pays a person who holds a login through their membership", async () => {
    const payee = await assertPayrollPersonPayeeEligible(
      createPersonDb([
        [{ organizationPersonId: "p-2", userId: "user-2", membershipId: 5 }],
        [],
        [],
      ]),
      orgId,
      "p-2",
    );
    expect(payee.subject).toEqual({ userId: "user-2", workerId: null });
  });

  it("refuses a person who holds an employment but was never made a payee", async () => {
    await expect(
      assertPayrollPersonPayeeEligible(
        createPersonDb([
          [{ organizationPersonId: "p-3", userId: null, membershipId: null }],
          [{ workerId: "w-3", isPayee: false }],
          [{ employmentId: 9, employeeNumber: "E-9", lifecycleStatus: "ACTIVE" }],
        ]),
        orgId,
        "p-3",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses an unknown person with the same refusal as the other two paths", async () => {
    await expect(
      assertPayrollPersonPayeeEligible(createPersonDb([[]]), orgId, "nobody"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
