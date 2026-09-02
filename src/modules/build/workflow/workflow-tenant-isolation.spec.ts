import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { WorkflowService } from "./workflow.service";

const audit = { log: jest.fn() } as never;

function makeU(orgId: string, isOrgOwner = false, membershipId = 42): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, isOrgOwner),
  };
}

function makeAccess(perms: Set<string> = new Set()): AccessService {
  return { resolveUserPermissions: jest.fn().mockResolvedValue(perms) } as unknown as AccessService;
}

describe("WorkflowService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(projectRow: unknown | null, transitionRows: unknown[]) {
    const limit = jest.fn().mockResolvedValue(transitionRows);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return {
      db: {
        query: { projects: { findFirst: jest.fn().mockResolvedValue(projectRow) } },
        select,
      } as unknown as Db,
    };
  }

  it("throws NotFoundException for listTransitions when project not in org (cross-tenant isolation)", async () => {
    const { db } = makeDb(null, []);
    const svc = new WorkflowService(db, audit, makeAccess());
    await expect(svc.listTransitions(makeU(ATTACKER_ORG), 99)).rejects.toThrow(NotFoundException);
  });

  it("returns transitions for the owning org (org owner bypasses membership check)", async () => {
    const transition = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Start" };
    const limit = jest.fn().mockResolvedValue([transition]);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const db = {
      query: { projects: { findFirst: jest.fn() } },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
    const svc = new WorkflowService(db, audit, makeAccess());
    const result = await svc.listTransitions(makeU(OWNER_ORG, true), 1);
    expect(result).toHaveLength(1);
  });
});

describe("WorkflowService — project membership gate", () => {
  function makeGateDbNonMember(): Db {
    const membershipLimit = jest.fn().mockResolvedValue([]);
    const membershipWhere = jest.fn().mockReturnValue({ limit: membershipLimit });
    const membershipInnerJoin = jest.fn().mockReturnValue({ where: membershipWhere });
    const membershipFrom = jest.fn().mockReturnValue({ innerJoin: membershipInnerJoin });

    const teamInnerJoin2 = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    });
    const teamInnerJoin1 = jest.fn().mockReturnValue({ innerJoin: teamInnerJoin2 });
    const teamFrom = jest.fn().mockReturnValue({ innerJoin: teamInnerJoin1 });

    const select = jest.fn()
      .mockReturnValueOnce({ from: membershipFrom })
      .mockReturnValueOnce({ from: teamFrom });

    return {
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }),
        },
      },
      select,
    } as unknown as Db;
  }

  function makeGateDbMember(): Db {
    const membershipLimit = jest.fn().mockResolvedValue([{ role: "MEMBER" }]);
    const membershipWhere = jest.fn().mockReturnValue({ limit: membershipLimit });
    const membershipInnerJoin = jest.fn().mockReturnValue({ where: membershipWhere });
    const membershipFrom = jest.fn().mockReturnValue({ innerJoin: membershipInnerJoin });

    const transitionWhere = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    const transitionFrom = jest.fn().mockReturnValue({ where: transitionWhere });

    const select = jest.fn()
      .mockReturnValueOnce({ from: membershipFrom })
      .mockReturnValue({ from: transitionFrom });

    return {
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }),
        },
      },
      select,
    } as unknown as Db;
  }

  it("rejects a non-member (isOrgOwner=false, no build:manage, no membership row)", async () => {
    const db = makeGateDbNonMember();
    const access = makeAccess();
    const svc = new WorkflowService(db, audit, access);
    await expect(svc.listTransitions(makeU("org-1", false), 1)).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member past the gate", async () => {
    const db = makeGateDbMember();
    const access = makeAccess();
    const svc = new WorkflowService(db, audit, access);
    await expect(svc.listTransitions(makeU("org-1", false), 1)).resolves.toEqual([]);
  });

  it("gate is load-bearing: resolveUserPermissions is called for non-owner callers", async () => {
    const db = makeGateDbNonMember();
    const access = makeAccess();
    const svc = new WorkflowService(db, audit, access);
    await expect(svc.listTransitions(makeU("org-1", false), 1)).rejects.toThrow(ForbiddenException);
    expect((access.resolveUserPermissions as jest.Mock)).toHaveBeenCalledWith("org-1", "user-1");
  });
});
