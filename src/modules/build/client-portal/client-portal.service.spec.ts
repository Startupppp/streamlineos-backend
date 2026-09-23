import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ClientPortalService } from "./client-portal.service";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const dialect = new PgDialect();
function renderSql(cond: unknown): string {
  return dialect.sqlToQuery(cond as SQL).sql;
}

function makeU(orgId: string, isOrgOwner = true): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, isOrgOwner),
  };
}

const mockAccess = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
} as unknown as AccessService;

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
  (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
});

describe("ClientPortalService.listPortalProjects — membership-scoped listing", () => {
  it("returns empty array when no portal membership is found for the caller", async () => {
    const membershipChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = { select: jest.fn().mockReturnValue(membershipChain) } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    const result = await svc.listPortalProjects("org-1", 7);
    expect(result).toEqual([]);
    expect((db.select as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it("returns projects when active grants exist for the portal membership", async () => {
    const projectRow = { id: 1, name: "P", key: "P1", status: "active", startDate: null, targetEndDate: null };
    const membershipChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: "pm-abc" }]),
    };
    const grantsChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ projectId: 1 }]),
    };
    const projectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([projectRow]),
    };
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(membershipChain)
        .mockReturnValueOnce(grantsChain)
        .mockReturnValueOnce(projectChain),
    } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    const result = await svc.listPortalProjects("org-1", 7);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("id", 1);
  });

  it("SELECT projection for projects does not include internal fields", async () => {
    const membershipChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: "pm-abc" }]),
    };
    const grantsChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ projectId: 1 }]),
    };
    const projectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const selectMock = jest.fn()
      .mockReturnValueOnce(membershipChain)
      .mockReturnValueOnce(grantsChain)
      .mockReturnValueOnce(projectChain);
    const db = { select: selectMock } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.listPortalProjects("org-1", 7);
    const projectProjection = (selectMock.mock.calls[2] as [Record<string, unknown>])[0];
    expect(projectProjection).not.toHaveProperty("budget");
    expect(projectProjection).not.toHaveProperty("budgetCents");
    expect(projectProjection).not.toHaveProperty("estimateCents");
    expect(projectProjection).not.toHaveProperty("managerId");
    expect(projectProjection).toHaveProperty("id");
    expect(projectProjection).toHaveProperty("name");
    expect(projectProjection).toHaveProperty("key");
    expect(projectProjection).toHaveProperty("status");
    expect(projectProjection).toHaveProperty("targetEndDate");
  });

  it("grants query excludes a grant whose expiresAt has passed, not just ACTIVE status", async () => {
    const membershipChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: "pm-abc" }]),
    };
    const grantsWhere = jest.fn().mockReturnThis();
    const grantsChain = {
      from: jest.fn().mockReturnThis(),
      where: grantsWhere,
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(membershipChain)
        .mockReturnValueOnce(grantsChain),
    } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.listPortalProjects("org-1", 7);
    expect(renderSql(grantsWhere.mock.calls[0]?.[0]).toLowerCase()).toContain("expires_at");
  });
});

describe("ClientPortalService.getProjectOverview — deny-by-default via grant capabilities", () => {
  const ORG = "org-1";
  const u = makeU(ORG, true);

  function makeDb(grantCapabilities: {
    canViewMilestones: boolean;
    canViewTasks: boolean;
    canViewAttachments: boolean;
    canViewComments: boolean;
  } | null): Db {
    const projectRow = {
      id: 1, name: "P", key: "P1", status: "active", startDate: null, targetEndDate: null,
    };
    const projectSelectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([projectRow]),
    };
    const grantSelectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(grantCapabilities !== null ? [grantCapabilities] : []),
    };
    const parallelChain = {
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: 99 }]),
    };
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
      },
      select: jest.fn()
        .mockReturnValueOnce(projectSelectChain)
        .mockReturnValueOnce(grantSelectChain)
        .mockReturnValue(parallelChain),
    } as unknown as Db;
  }

  it("returns empty milestones/tasks/attachments/comments when all capabilities are false (deny-by-default)", async () => {
    const db = makeDb({ canViewMilestones: false, canViewTasks: false, canViewAttachments: false, canViewComments: false });
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    const result = await svc.getProjectOverview(u, 1);
    expect(result.milestones).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(result.attachments).toEqual([]);
    expect(result.comments).toEqual([]);
  });

  it("returns empty collections when no active grant exists for the project", async () => {
    const db = makeDb(null);
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    const result = await svc.getProjectOverview(u, 1);
    expect(result.milestones).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(result.attachments).toEqual([]);
    expect(result.comments).toEqual([]);
  });

  it("loads milestones when canViewMilestones is true", async () => {
    const db = makeDb({ canViewMilestones: true, canViewTasks: false, canViewAttachments: false, canViewComments: false });
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    const result = await svc.getProjectOverview(u, 1);
    expect(result.milestones).toHaveLength(1);
    expect(result.tasks).toEqual([]);
    expect(result.attachments).toEqual([]);
    expect(result.comments).toEqual([]);
  });

  it("loads tasks when canViewTasks is true", async () => {
    const db = makeDb({ canViewMilestones: false, canViewTasks: true, canViewAttachments: false, canViewComments: false });
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    const result = await svc.getProjectOverview(u, 1);
    expect(result.tasks).toHaveLength(1);
    expect(result.milestones).toEqual([]);
  });

  it("throws NotFoundException for wrong-org project (cross-tenant)", async () => {
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue(null) } },
      select: jest.fn(),
    } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await expect(svc.getProjectOverview(makeU("org-attacker", true), 1)).rejects.toThrow(NotFoundException);
  });

  it("throws ForbiddenException when employee has no project membership (right org, no access)", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
      },
      select: jest.fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
              }),
            }),
          }),
        }),
    } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await expect(svc.getProjectOverview(makeU("org-1", false), 1)).rejects.toThrow(ForbiddenException);
  });

  it("SELECT projection does not include internal/budget fields", async () => {
    const projectSelectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const selectMock = jest.fn().mockReturnValue(projectSelectChain);
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) } },
      select: selectMock,
    } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await expect(svc.getProjectOverview(u, 1)).rejects.toThrow(NotFoundException);
    const projection = (selectMock.mock.calls[0] as [Record<string, unknown>])[0];
    expect(projection).not.toHaveProperty("budget");
    expect(projection).not.toHaveProperty("budgetCents");
    expect(projection).not.toHaveProperty("estimateCents");
    expect(projection).not.toHaveProperty("managerId");
    expect(projection).toHaveProperty("id");
    expect(projection).toHaveProperty("name");
    expect(projection).toHaveProperty("key");
    expect(projection).toHaveProperty("status");
    expect(projection).toHaveProperty("startDate");
    expect(projection).toHaveProperty("targetEndDate");
  });

  it("grant capabilities query excludes a grant whose expiresAt has passed, not just ACTIVE status", async () => {
    const projectRow = { id: 1, name: "P", key: "P1", status: "active", startDate: null, targetEndDate: null };
    const projectSelectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([projectRow]),
    };
    const grantWhere = jest.fn().mockReturnThis();
    const grantSelectChain = {
      from: jest.fn().mockReturnThis(),
      where: grantWhere,
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const parallelChain = {
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) } },
      select: jest.fn()
        .mockReturnValueOnce(projectSelectChain)
        .mockReturnValueOnce(grantSelectChain)
        .mockReturnValue(parallelChain),
    } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await svc.getProjectOverview(u, 1);
    expect(renderSql(grantWhere.mock.calls[0]?.[0]).toLowerCase()).toContain("expires_at");
  });
});

describe("ClientPortalService.listPortalChangeRequests — portal grant access gate", () => {
  const ORG = "org-1";

  it("throws NotFoundException when no active grant exists for the project", async () => {
    const noGrantChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: jest.fn().mockReturnValue(noGrantChain),
    } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await expect(svc.listPortalChangeRequests(makeU(ORG, false), 1)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when the project does not belong to the caller org", async () => {
    const noGrantChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: jest.fn().mockReturnValue(noGrantChain),
    } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await expect(svc.listPortalChangeRequests(makeU("org-attacker", false), 1)).rejects.toThrow(NotFoundException);
  });

  it("returns change requests when an active portal grant exists", async () => {
    const crRow = { id: 1, crNumber: 1, title: "T", status: "submitted", createdAt: new Date() };
    const crChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([crRow]),
    };
    const db = {
      select: jest.fn().mockReturnValue(crChain),
    } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    const result = await svc.listPortalChangeRequests(makeU(ORG, true), 1);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it("grant lookup excludes a grant whose expiresAt has passed, not just ACTIVE status", async () => {
    const membershipChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: "pm-abc" }]),
    };
    const grantWhere = jest.fn().mockReturnThis();
    const grantChain = {
      from: jest.fn().mockReturnThis(),
      where: grantWhere,
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: jest.fn()
        .mockReturnValueOnce(membershipChain)
        .mockReturnValueOnce(grantChain),
    } as unknown as Db;
    const svc = new ClientPortalService(db, mockAccess, mockAudit);
    await expect(svc.listPortalChangeRequests(makeU(ORG, false), 1)).rejects.toThrow(NotFoundException);
    expect(renderSql(grantWhere.mock.calls[0]?.[0]).toLowerCase()).toContain("expires_at");
  });
});
