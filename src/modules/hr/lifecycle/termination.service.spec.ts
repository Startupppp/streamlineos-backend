process.env.APP_URL ??= "http://localhost:1000";

import { BadRequestException } from "@nestjs/common";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import { users } from "../../../db/schema";
import { TerminationService } from "./termination.service";
import { TerminationReadService } from "./termination-read.service";

describe("TerminationService.create - structural owner block", () => {
  function buildSelectChain(): Record<string, jest.Mock> {
    const chain: Record<string, jest.Mock> = {
      from: jest.fn(),
      where: jest.fn().mockResolvedValue([]),
      innerJoin: jest.fn(),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    return chain;
  }

  function buildService(
    membershipRow: Record<string, unknown>,
    targetUserRow?: Record<string, unknown>,
  ) {
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(membershipRow),
        },
        users: {
          findFirst: jest.fn().mockResolvedValue(
            targetUserRow ?? { id: "target-1", isActive: true },
          ),
        },
        terminations: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
      select: jest.fn().mockReturnValue(buildSelectChain()),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest
            .fn()
            .mockResolvedValue([{ id: 1, orgId: "org-1", userId: "target-1" }]),
        }),
      }),
      execute: jest.fn().mockResolvedValue([{ relationAvailable: false }]),
      transaction: jest.fn(),
    };
    db.transaction.mockImplementation(
      async (operation: (transaction: typeof db) => Promise<unknown>) => operation(db),
    );
    return new TerminationService(
      db as never,
      { logCritical: jest.fn() } as never,
      undefined as never,
      undefined as never,
      {} as never,
      {} as never,
    );
  }

  it("blocks terminating the org owner regardless of their role slug", async () => {
    const service = buildService({ role: "MEMBER", isOwner: true });

    await expect(
      service.create("org-1", "actor-1", false, {
        userId: "target-1",
        reasons: ["misconduct"],
        detailedExplanation: "Details here",
        effectiveDate: "2026-08-01",
        noticePeriodWaived: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("allows terminating a FINAL-role user who is not the org owner", async () => {
    const service = buildService({ role: "FINAL", isOwner: false });

    await expect(
      service.create("org-1", "actor-1", false, {
        userId: "target-1",
        reasons: ["misconduct"],
        detailedExplanation: "Details here",
        effectiveDate: "2026-08-01",
        noticePeriodWaived: false,
      }),
    ).resolves.toBeDefined();
  });
});

describe("TerminationService.list - paginated envelope and status counts", () => {
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
    const db = {
      select: jest.fn(() => (call++ === 0 ? rowsChain : statusChain)),
      execute: jest.fn().mockResolvedValue([{ relationAvailable: false }]),
    };
    const reader = new TerminationReadService(db as never, {} as never);
    return new TerminationService(
      db as never,
      undefined as never,
      undefined as never,
      undefined as never,
      reader,
      {} as never,
    );
  }

  it("returns a bounded page and organization-wide status counts", async () => {
    const service = buildService(
      [{ id: 1, reasons: [] }],
      [
        { status: "DRAFT", count: "100" },
        { status: "COMPLETED", count: "37" },
      ],
    );
    const result = await service.list("org-1", { page: 2, limit: 500 });
    expect(result.data).toEqual([{ id: 1, reasons: [] }]);
    expect(result.pagination).toEqual({
      page: 2,
      limit: 100,
      total: 137,
      totalPages: 2,
    });
    expect(result.statusCounts).toEqual({ DRAFT: 100, COMPLETED: 37, ALL: 137 });
  });

  it("uses the selected status count for filtered pagination", async () => {
    const service = buildService(
      [],
      [
        { status: "DRAFT", count: "45" },
        { status: "APPROVED", count: "5" },
      ],
    );
    const result = await service.list("org-1", {
      page: 1,
      limit: 20,
      status: "DRAFT",
    });
    expect(result.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
    expect(result.statusCounts).toEqual({ DRAFT: 45, APPROVED: 5, ALL: 50 });
  });
});

describe("TerminationService.complete - tenant-scoped account access", () => {
  it("archives only the affected membership and never deactivates the global user", async () => {
    const returning = jest.fn().mockResolvedValue([{ rowVersion: 2 }]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({ onConflictDoNothing });
    const insert = jest.fn().mockReturnValue({ values });
    const tx = {
      update,
      insert,
      query: {
        assets: {
          findMany: jest.fn().mockResolvedValue([{ id: 7, name: "Laptop" }]),
        },
      },
    };
    const db = {
      query: {
        terminations: {
          findFirst: jest.fn().mockResolvedValue({
            id: 41,
            orgId: "org-1",
            userId: "member-1",
            status: "SENT",
            rowVersion: 1,
            reasons: ["Policy breach"],
            noticePeriodWaived: false,
          }),
        },
        users: {
          findFirst: jest.fn().mockResolvedValue({ name: "Multi Org Member" }),
        },
      },
      execute: jest.fn().mockResolvedValue([{ relationAvailable: false }]),
    };
    const memberships = {
      setMemberLifecycleStatus: jest.fn().mockResolvedValue({ success: true }),
    };
    const lifecycle = {
      invalidateHrDashboardCache: jest.fn().mockResolvedValue(undefined),
      dispatchEmployeeTerminated: jest.fn(),
    };
    const service = new TerminationService(
      db as never,
      { logCritical: jest.fn() } as never,
      undefined as never,
      memberships as never,
      {} as never,
      lifecycle as never,
    );

    const result = await runWithTenantContext(
      {
        orgId: "org-1",
        audience: "INTERNAL",
        tx: tx as never,
        afterCommit: [],
      },
      () => service.complete("org-1", "actor-1", 41),
    );

    expect(result).toEqual({ success: true });
    expect(memberships.setMemberLifecycleStatus).toHaveBeenCalledWith(
      "org-1",
      "actor-1",
      "member-1",
      "archived",
      {
        reason: "Employment terminated",
        auditAction: "org.member_archived_after_termination",
      },
    );
    expect(update.mock.calls.some(([table]) => table === users)).toBe(false);
    expect(lifecycle.invalidateHrDashboardCache).toHaveBeenCalledWith("org-1");
    expect(lifecycle.dispatchEmployeeTerminated).toHaveBeenCalled();
  });
});
