import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PayoutValidationService } from "./payout-validation.service";

describe("PayoutValidationService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const efService = {
    getWorkerForUser: jest.fn().mockResolvedValue(null),
    getDirectReportUserIds: jest.fn().mockResolvedValue([]),
    getFactsBatch: jest.fn().mockResolvedValue(new Map()),
    getSensitiveFactsBatch: jest.fn().mockResolvedValue(new Map()),
    getSensitiveFactsByPersonBatch: jest.fn().mockResolvedValue(new Map()),
  } as never;

  it("throws NotFoundException for validatePayout when run belongs to a different org (cross-tenant isolation)", async () => {
    const db = {
      query: {
        payrollRuns: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
    const svc = new PayoutValidationService(db, efService);
    await expect(svc.validatePayout(ATTACKER_ORG, 99)).rejects.toThrow(NotFoundException);
  });

  it("proceeds for the owning org (same-tenant control)", async () => {
    const run = { id: 1, status: "APPROVED" };
    const chain = Object.assign(Promise.resolve([]), {
      leftJoin: jest.fn(),
      innerJoin: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn(),
    });
    chain.leftJoin.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    chain.limit.mockReturnValue(chain);
    const from = jest.fn().mockReturnValue(chain);
    const select = jest.fn().mockReturnValue({ from });
    const db = {
      query: {
        payrollRuns: { findFirst: jest.fn().mockResolvedValue(run) },
        workers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select,
    } as unknown as Db;
    const svc = new PayoutValidationService(db, efService);
    const result = await svc.validatePayout(OWNER_ORG, 1);
    expect(Array.isArray(result)).toBe(true);
  });
});
