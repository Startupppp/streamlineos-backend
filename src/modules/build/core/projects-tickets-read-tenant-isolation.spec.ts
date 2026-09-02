import type { Db } from "../../../db/drizzle.module";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";

function memberThenTeamChain(memberRows: unknown[], teamRows: unknown[]): jest.Mock {
  const memberChain = {
    innerJoin: jest.fn(() => ({
      where: jest.fn(() => ({ limit: jest.fn().mockResolvedValue(memberRows) })),
    })),
  };
  const teamChain = {
    innerJoin: jest.fn(() => ({
      innerJoin: jest.fn(() => ({
        where: jest.fn(() => ({ limit: jest.fn().mockResolvedValue(teamRows) })),
      })),
    })),
  };
  return jest.fn().mockReturnValueOnce(memberChain).mockReturnValue(teamChain);
}

describe("ProjectsTicketsReadService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as never;

  function makeDb(projectRow: unknown | null, memberRows: unknown[]) {
    return {
      db: {
        query: { projects: { findFirst: jest.fn().mockResolvedValue(projectRow) } },
        select: jest.fn().mockReturnValue({ from: memberThenTeamChain(memberRows, []) }),
      } as unknown as Db,
    };
  }

  it("returns hasAccess=false for project in a different org (cross-tenant isolation)", async () => {
    const { db } = makeDb(null, []);
    const svc = new ProjectsTicketsReadService(db, access);
    const result = await svc.checkProjectAccess(ATTACKER_ORG, "u1", 99);
    expect(result.hasAccess).toBe(false);
  });

  it("returns hasAccess=true for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG, managerId: "u1" };
    const { db } = makeDb(project, []);
    const svc = new ProjectsTicketsReadService(db, access);
    const result = await svc.checkProjectAccess(OWNER_ORG, "u1", 1);
    expect(result.hasAccess).toBe(true);
  });
});

describe("checkProjectAccess — direct-member org-status gate", () => {
  const ORG = "org-a";
  const USER_ID = "user-1";
  const PROJECT_ID = 5;

  function makeDbForMemberPath(memberRows: unknown[], teamRows: unknown[] = []) {
    return {
      access: { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) } as never,
      db: {
        query: {
          projects: { findFirst: jest.fn().mockResolvedValue({ managerId: "other-manager" }) },
        },
        select: jest.fn().mockReturnValue({ from: memberThenTeamChain(memberRows, teamRows) }),
      } as unknown as Db,
    };
  }

  it("denies a suspended org member even when present in projectMembers (DENY)", async () => {
    const { db, access } = makeDbForMemberPath([]);
    const svc = new ProjectsTicketsReadService(db, access);
    const result = await svc.checkProjectAccess(ORG, USER_ID, PROJECT_ID);
    expect(result.hasAccess).toBe(false);
  });

  it("grants access to an active org member present in projectMembers (CONTROL)", async () => {
    const { db, access } = makeDbForMemberPath([{ id: 1, role: "CONTRIBUTOR" }]);
    const svc = new ProjectsTicketsReadService(db, access);
    const result = await svc.checkProjectAccess(ORG, USER_ID, PROJECT_ID);
    expect(result.hasAccess).toBe(true);
    expect(result.role).toBe("CONTRIBUTOR");
  });
});
