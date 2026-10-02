import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { PaymentRequiredException } from "../../../common/http/api-exceptions";
import { PlanLimitsService } from "./plan-limits.service";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));
jest.mock("../../../common/tenant", () => ({ registerAfterCommit: () => false }));

/**
 * BUG-HRMS-001/002. A preview (`headroomFor`, what the bulk-onboarding preview
 * and invite notice show) and a confirm (`assertWithinLimit`, what admission
 * enforces) must give the same answer over the same seat state: a row the
 * preview calls ready is admitted, and a row it blocks is refused with 402.
 */
describe("seat preview and confirm agree", () => {
  async function serviceWith(used: number): Promise<PlanLimitsService> {
    // One row answers both reads: the tier lookup reads plan/status, the seat count reads count.
    const row = { plan: "STARTER", status: "ACTIVE", trial_ends_at: null, count: used };
    const module = await Test.createTestingModule({
      providers: [
        PlanLimitsService,
        { provide: DRIZZLE, useValue: { execute: jest.fn().mockResolvedValue([row]) } },
        {
          provide: CacheService,
          useValue: {
            cached: jest.fn((_key: string, fn: () => Promise<unknown>) => fn()),
            set: jest.fn(),
            invalidate: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();
    return module.get(PlanLimitsService);
  }

  for (const used of [0, 7, 9, 10, 12]) {
    it(`with ${used} seats used, every batch size the preview admits is admitted and the next is refused`, async () => {
      const service = await serviceWith(used);
      const { limit, available } = await service.headroomFor("org1", "members");

      expect(limit).toBe(10);
      expect(available).toBe(Math.max(0, 10 - used));

      for (let rows = 1; rows <= 12; rows++) {
        const confirm = service.assertWithinLimit("org1", "members", rows);
        if (rows <= (available ?? 0)) await expect(confirm).resolves.toBeUndefined();
        else await expect(confirm).rejects.toBeInstanceOf(PaymentRequiredException);
      }
    });
  }
});
