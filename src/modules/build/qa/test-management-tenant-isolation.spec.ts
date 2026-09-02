import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { TestManagementService } from "./test-management.service";

const MEMBERSHIP_ID = 7;

function makeU(orgId: string, isOrgOwner = false): CurrentUserContext {
  return {
    userId: "user-7",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, isOrgOwner),
  };
}

describe("TestManagementService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

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

  function makeAccessGranted() {
    return { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as unknown as AccessService;
  }

  function makeAccessEmpty() {
    return { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
  }

  it("throws NotFoundException for listSuites when project not in org (cross-tenant isolation)", async () => {
    const db = makeDb(null, []);
    const svc = new TestManagementService(db, makeAccessEmpty());
    await expect(svc.listSuites(makeU(ATTACKER_ORG), 99)).rejects.toThrow(NotFoundException);
  });

  it("returns suites for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG, managerMembershipId: null };
    const suite = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Suite A" };
    const db = makeDb(project, [suite]);
    const svc = new TestManagementService(db, makeAccessGranted());
    const result = await svc.listSuites(makeU(OWNER_ORG), 1);
    expect(result).toHaveLength(1);
  });
});

describe("TestManagementService — project membership gate (assertProjectAccess)", () => {
  function makeNonMemberDb() {
    const limit = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ limit });
    const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
    const from = jest.fn().mockReturnValue({ innerJoin, where });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        testSuites: { findFirst: jest.fn() },
        testCases: { findFirst: jest.fn() },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  function makeMemberDb() {
    let callCount = 0;
    const makeLimitChain = (rows: unknown[]) => {
      const limit = jest.fn().mockResolvedValue(rows);
      const where = jest.fn().mockReturnValue({ limit });
      const innerJoin = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
      return { from: jest.fn().mockReturnValue({ innerJoin, where }) };
    };
    const suitesChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        testSuites: { findFirst: jest.fn() },
        testCases: { findFirst: jest.fn() },
      },
      select: jest.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? makeLimitChain([{ role: "MEMBER" }]) : suitesChain;
      }),
    } as unknown as Db;
  }

  it("rejects a non-member with ForbiddenException", async () => {
    const db = makeNonMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new TestManagementService(db, access);
    await expect(svc.listSuites(makeU("org-1"), 1)).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member through the gate", async () => {
    const db = makeMemberDb();
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as AccessService;
    const svc = new TestManagementService(db, access);
    await expect(svc.listSuites(makeU("org-1"), 1)).resolves.toEqual([]);
  });
});
