import { BadRequestException, NotFoundException } from "@nestjs/common";
import { HrBenefitsClaimsService } from "./hr-benefits-claims.service";

function claim(id: number, submittedAt: Date) {
  return {
    claim: {
      id,
      orgId: "org-1",
      userId: "employee-1",
      planId: 1,
      submittedAt,
      status: "submitted",
    },
    user: { id: "employee-1", name: "Ada", email: "ada@example.com" },
    plan: { id: 1, name: "Health" },
  };
}

function listDb(rows: ReturnType<typeof claim>[]) {
  const query = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.leftJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  return { db: { select: jest.fn().mockReturnValue(query) }, query };
}

describe("HrBenefitsClaimsService.listClaims cursor pagination", () => {
  it("uses a stable sentinel page and binds the cursor to tenant and filters", async () => {
    const at = new Date("2026-08-01T00:00:00.000Z");
    const { db, query } = listDb([claim(3, at), claim(2, at), claim(1, at)]);
    const service = new HrBenefitsClaimsService(db as never);

    const firstPage = await service.listClaims(
      "org-1",
      { limit: 2, status: "submitted" },
      "admin-1",
      7,
      true,
    );

    expect(query.orderBy.mock.calls[0]).toHaveLength(2);
    expect(query.limit).toHaveBeenCalledWith(3);
    expect(firstPage.data.map((row) => row.id)).toEqual([3, 2]);
    expect(firstPage.pagination).toMatchObject({ limit: 2, hasMore: true });

    await expect(
      service.listClaims(
        "org-2",
        {
          limit: 2,
          status: "submitted",
          cursor: firstPage.pagination.nextCursor ?? undefined,
        },
        "admin-1",
        7,
        true,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.listClaims(
        "org-1",
        {
          limit: 2,
          status: "approved",
          cursor: firstPage.pagination.nextCursor ?? undefined,
        },
        "admin-1",
        7,
        true,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed cursor before querying", async () => {
    const select = jest.fn();
    const service = new HrBenefitsClaimsService({ select } as never);

    await expect(
      service.listClaims(
        "org-1",
        { limit: 20, cursor: "not-a-cursor" },
        "employee-1",
        7,
        false,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects a revoked account-only principal before querying claims", async () => {
    const select = jest.fn();
    const service = new HrBenefitsClaimsService({ select } as never);

    await expect(
      service.listClaims("org-1", { limit: 20 }, "employee-1", null, false),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects an admin's cross-organization user filter before it becomes a membership predicate", async () => {
    const select = jest.fn();
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const service = new HrBenefitsClaimsService({
      select,
      query: { organizationMembers: { findFirst } },
    } as never);

    await expect(
      service.listClaims("org-1", { limit: 20, userId: "other-org-user" }, "admin-1", 7, true),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects an admin cursor before resolving a filtered member", async () => {
    const findFirst = jest.fn();
    const service = new HrBenefitsClaimsService({
      select: jest.fn(),
      query: { organizationMembers: { findFirst } },
    } as never);

    await expect(
      service.listClaims(
        "org-1",
        { limit: 20, userId: "employee-2", cursor: "not-a-cursor" },
        "admin-1",
        7,
        true,
      ),
    ).rejects.toMatchObject({
      response: { code: "INVALID_BENEFITS_CLAIMS_CURSOR" },
    });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
