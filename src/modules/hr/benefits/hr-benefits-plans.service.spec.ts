import { BadRequestException } from "@nestjs/common";
import { HrBenefitsPlansService } from "./hr-benefits-plans.service";

describe("HrBenefitsPlansService.checkEnrollmentWindowOpen", () => {
  function buildDb(configured: number, open: number) {
    return {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ configured, open }]),
        }),
      }),
    };
  }

  it("allows enrollment when no window is configured for the plan at all", async () => {
    const service = new HrBenefitsPlansService(buildDb(0, 0) as never);
    expect(await service.checkEnrollmentWindowOpen("org-1", 1)).toBe(true);
  });

  it("blocks enrollment when a window is configured but currently closed/upcoming", async () => {
    const db = buildDb(1, 0);
    const service = new HrBenefitsPlansService(db as never);
    expect(await service.checkEnrollmentWindowOpen("org-1", 1)).toBe(false);
  });

  it("allows enrollment when the configured window is open and within range", async () => {
    const db = buildDb(1, 1);
    const service = new HrBenefitsPlansService(db as never);
    expect(await service.checkEnrollmentWindowOpen("org-1", 1)).toBe(true);
  });

  it("honors an org-wide window (null planId) for a plan with no plan-specific window", async () => {
    const db = buildDb(1, 0);
    const service = new HrBenefitsPlansService(db as never);
    expect(await service.checkEnrollmentWindowOpen("org-1", 1)).toBe(false);
  });
});

function plan(id: number, name: string) {
  return { id, name, orgId: "org-1", status: "active", category: "health" };
}

function listDb(rows: ReturnType<typeof plan>[]) {
  const query = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  return { db: { select: jest.fn().mockReturnValue(query) }, query };
}

describe("HrBenefitsPlansService.listPlans cursor pagination", () => {
  it("uses name and id ordering, trims the sentinel, and binds filters", async () => {
    const { db, query } = listDb([
      plan(1, "Health"),
      plan(2, "Health"),
      plan(3, "Retirement"),
    ]);
    const service = new HrBenefitsPlansService(db as never);

    const firstPage = await service.listPlans("org-1", {
      limit: 2,
      status: "active",
    });

    expect(query.orderBy.mock.calls[0]).toHaveLength(2);
    expect(query.limit).toHaveBeenCalledWith(3);
    expect(firstPage.data.map((row) => row.id)).toEqual([1, 2]);
    expect(firstPage.pagination).toMatchObject({ limit: 2, hasMore: true });

    await expect(
      service.listPlans("org-1", {
        limit: 2,
        status: "draft",
        cursor: firstPage.pagination.nextCursor ?? undefined,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.listPlans("org-2", {
        limit: 2,
        status: "active",
        cursor: firstPage.pagination.nextCursor ?? undefined,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed cursors before querying", async () => {
    const select = jest.fn();
    const service = new HrBenefitsPlansService({ select } as never);

    await expect(
      service.listPlans("org-1", { limit: 20, cursor: "not-a-cursor" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(select).not.toHaveBeenCalled();
  });
});
