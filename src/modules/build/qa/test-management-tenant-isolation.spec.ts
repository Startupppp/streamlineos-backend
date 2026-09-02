import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { TestManagementService } from "./test-management.service";

function makeU(orgId: string, isOrgOwner = false): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(42, isOrgOwner),
  };
}

describe("TestManagementService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const mockAccess = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;

  beforeEach(() => jest.resetAllMocks());

  function makeDb(projectRow: unknown | null, suiteRows: unknown[]) {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(suiteRows) }) });
    const from = jest.fn().mockReturnValue({ where });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
        testSuites: { findFirst: jest.fn().mockResolvedValue(null) },
        testCases: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  it("throws NotFoundException for listSuites when project not in org (cross-tenant isolation)", async () => {
    const db = makeDb(null, []);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
    const svc = new TestManagementService(db, mockAccess);
    await expect(svc.listSuites(makeU(ATTACKER_ORG), 99)).rejects.toThrow(NotFoundException);
  });

  it("returns suites for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const suite = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Suite A" };
    const db = makeDb(project, [suite]);
    const svc = new TestManagementService(db, mockAccess);
    const result = await svc.listSuites(makeU(OWNER_ORG, true), 1);
    expect(result).toHaveLength(1);
  });
});

describe("TestManagementService — project membership gate", () => {
  const mockAccess = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;

  beforeEach(() => jest.resetAllMocks());

  it("rejects a non-member (isOrgOwner=false, no build:manage, no membership row)", async () => {
    const innerJoin = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    });
    const teamInnerJoin = jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    });
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }) } },
      select: jest.fn()
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ innerJoin }) })
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ innerJoin: teamInnerJoin }) }),
    } as unknown as Db;
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
    const svc = new TestManagementService(db, mockAccess);

    await expect(svc.listSuites(makeU("org-1", false), 1)).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member to list suites", async () => {
    const memberRow = [{ role: "MEMBER" }];
    const innerJoin = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(memberRow) }),
    });
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }) } },
      select: jest.fn()
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ innerJoin }) })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
            }),
          }),
        }),
    } as unknown as Db;
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
    const svc = new TestManagementService(db, mockAccess);

    const result = await svc.listSuites(makeU("org-1", false), 1);
    expect(result).toEqual([]);
  });
});
