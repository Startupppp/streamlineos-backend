process.env.APP_URL ??= "http://localhost:1000";

import { BadRequestException } from "@nestjs/common";
import { TerminationService } from "./termination.service";

describe("TerminationService.create — structural owner block", () => {
  function buildService(membershipRow: Record<string, unknown>, targetUserRow?: Record<string, unknown>) {
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(membershipRow),
        },
        users: {
          findFirst: jest.fn().mockResolvedValue(targetUserRow ?? { id: "target-1", isActive: true }),
        },
        terminations: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 1, orgId: "org-1", userId: "target-1" }]),
        }),
      }),
    };
    return new TerminationService(
      db as never,
      { log: jest.fn() } as never,
      { invalidate: jest.fn() } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
  }

  it("blocks terminating the org owner regardless of their role slug", async () => {
    const service = buildService({ role: "MEMBER", isOwner: true });

    await expect(
      service.create("org-1", "actor-1", "HR_ADMIN", {
        userId: "target-1",
        reasons: ["misconduct"],
        detailedExplanation: "Details here",
        effectiveDate: "2026-08-01",
        noticePeriodWaived: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("allows terminating a CEO-role user who is not the org owner", async () => {
    const service = buildService({ role: "CEO", isOwner: false });

    await expect(
      service.create("org-1", "actor-1", "HR_ADMIN", {
        userId: "target-1",
        reasons: ["misconduct"],
        detailedExplanation: "Details here",
        effectiveDate: "2026-08-01",
        noticePeriodWaived: false,
      }),
    ).resolves.toBeDefined();
  });
});

describe("TerminationService.list — paginated envelope + status counts", () => {
  function buildService(rows: unknown[], statusRows: { status: string; count: string }[]) {
    const rowsChain = {
      from: () => rowsChain,
      leftJoin: () => rowsChain,
      where: () => rowsChain,
      orderBy: () => rowsChain,
      limit: () => rowsChain,
      offset: () => Promise.resolve(rows),
    };
    const statusChain = {
      from: () => statusChain,
      where: () => statusChain,
      groupBy: () => Promise.resolve(statusRows),
    };
    let call = 0;
    const db = { select: jest.fn(() => (call++ === 0 ? rowsChain : statusChain)) };
    return new TerminationService(
      db as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
  }

  it("returns data + pagination + statusCounts; caps limit at 100; unfiltered total is org-wide", async () => {
    const service = buildService(
      [{ id: 1 }],
      [
        { status: "DRAFT", count: "100" },
        { status: "COMPLETED", count: "37" },
      ],
    );
    const result = await service.list("org-1", { page: 2, limit: 500 });
    expect(result.data).toEqual([{ id: 1 }]);
    expect(result.pagination).toEqual({ page: 2, limit: 100, total: 137, totalPages: 2 });
    expect(result.statusCounts).toEqual({ DRAFT: 100, COMPLETED: 37, ALL: 137 });
  });

  it("total reflects the filtered status count when a status is given", async () => {
    const service = buildService(
      [],
      [
        { status: "DRAFT", count: "45" },
        { status: "APPROVED", count: "5" },
      ],
    );
    const result = await service.list("org-1", { page: 1, limit: 20, status: "DRAFT" });
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 45, totalPages: 3 });
    expect(result.statusCounts).toEqual({ DRAFT: 45, APPROVED: 5, ALL: 50 });
  });
});
