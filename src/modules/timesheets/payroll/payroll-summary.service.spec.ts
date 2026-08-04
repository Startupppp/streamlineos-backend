import { ForbiddenException } from "@nestjs/common";
import { PayrollSummaryService } from "./payroll-summary.service";

describe("PayrollSummaryService.getPeriodSummary scope gate", () => {
  const orgId = "org-1";
  const actorUserId = "actor-1";

  function createService() {
    const entryRows: unknown[] = [];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => ({
            limit: jest.fn().mockResolvedValue([
              {
                overtimeDailyHours: "8",
                overtimeWeeklyHours: "40",
                includeNonBillable: true,
              },
            ]),
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue(entryRows),
            }),
          })),
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(entryRows),
          }),
        }),
      }),
    };
    const cache = {
      cachedVersioned: jest.fn(
        (_namespace: string, _key: string, fn: () => Promise<unknown>) => fn(),
      ),
    };
    return new PayrollSummaryService(db as never, cache as never);
  }

  it("rejects cross-user filter when scope is not all", async () => {
    const service = createService();
    await expect(
      service.getPeriodSummary(
        orgId,
        { start: "2026-01-01", end: "2026-01-31", includeExported: false, userId: "other-user" },
        "own",
        actorUserId,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
