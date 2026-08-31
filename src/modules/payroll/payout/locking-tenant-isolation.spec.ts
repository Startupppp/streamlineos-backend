import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { LockingService } from "./locking.service";

describe("LockingService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;
  const generate = {
    generateRun: jest.fn().mockResolvedValue(undefined),
    postPayrollLock: jest.fn().mockResolvedValue(undefined),
  } as never;
  const payrollPosting = { postFinalized: jest.fn().mockResolvedValue(undefined) } as never;

  it("throws NotFoundException when run belongs to a different org (cross-tenant isolation)", async () => {
    const db = {
      query: { payrollRuns: { findFirst: jest.fn().mockResolvedValue(null) } },
    } as unknown as Db;
    const svc = new LockingService(db, audit, generate, payrollPosting);
    await expect(svc.lock(ATTACKER_ORG, "u1", 99)).rejects.toThrow(NotFoundException);
  });

  it("proceeds for the owning org when run is found in APPROVED status (same-tenant control)", async () => {
    const run = { id: 1, orgId: OWNER_ORG, status: "APPROVED", month: "2024-01", runType: "REGULAR", policyVersionId: 1, grossTotal: "0", deductionTotal: "0", netTotal: "0", employerCostTotal: "0" };
    const txFn = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      query: {
        payrollRunEmployees: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue([]),
          returning: jest.fn().mockResolvedValue([]),
        }),
      }),
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    }));
    let outerSelectIdx = 0;
    const db = {
      query: { payrollRuns: { findFirst: jest.fn().mockResolvedValue(run) } },
      transaction: txFn,
      select: jest.fn().mockImplementation(() => {
        const idx = outerSelectIdx++;
        const data =
          idx === 0
            ? [{ id: 99, orgId: OWNER_ORG, userId: "u1", role: "MEMBER", isOwner: false, status: "ACTIVE" }]
            : [];
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(data),
            }),
          }),
        };
      }),
    } as unknown as Db;
    const svc = new LockingService(db, audit, generate, payrollPosting);
    await expect(svc.lock(OWNER_ORG, "u1", 1)).resolves.not.toThrow();
  });
});
