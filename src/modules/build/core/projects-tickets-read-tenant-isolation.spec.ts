import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { resolveProjectAccess } from "./project-access";

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

function makeUser(orgId: string, membershipId: number): CurrentUserContext {
  return {
    orgId,
    userId: "u1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId, isOrgOwner: false },
  } as unknown as CurrentUserContext;
}

describe("resolveProjectAccess — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  it("throws NotFoundException for a project in a different org (cross-tenant isolation)", async () => {
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue(null) } },
      select: jest.fn().mockReturnValue({ from: memberThenTeamChain([], []) }),
    } as unknown as Db;
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) } as never;
    const u = makeUser(ATTACKER_ORG, 1);
    await expect(resolveProjectAccess(db, access, u, 99)).rejects.toThrow("Project not found");
  });

  it("returns hasAccess=true for the owning org when caller has build:manage (same-tenant control)", async () => {
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) } },
      select: jest.fn().mockReturnValue({ from: memberThenTeamChain([], []) }),
    } as unknown as Db;
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as never;
    const u = makeUser(OWNER_ORG, 1);
    const result = await resolveProjectAccess(db, access, u, 1);
    expect(result.hasAccess).toBe(true);
  });
});

describe("resolveProjectAccess — direct-member org-status gate", () => {
  const ORG = "org-a";
  const PROJECT_ID = 5;
  const MEMBERSHIP_ID = 1;

  function makeDb(memberRows: unknown[], teamRows: unknown[] = []) {
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 99 }) },
      },
      select: jest.fn().mockReturnValue({ from: memberThenTeamChain(memberRows, teamRows) }),
    } as unknown as Db;
  }

  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) } as never;

  it("denies a user with no project membership (DENY)", async () => {
    const db = makeDb([]);
    const u = makeUser(ORG, MEMBERSHIP_ID);
    const result = await resolveProjectAccess(db, access, u, PROJECT_ID);
    expect(result.hasAccess).toBe(false);
  });

  it("grants access to a direct project member (CONTROL)", async () => {
    const db = makeDb([{ id: 1, role: "CONTRIBUTOR" }]);
    const u = makeUser(ORG, MEMBERSHIP_ID);
    const result = await resolveProjectAccess(db, access, u, PROJECT_ID);
    expect(result.hasAccess).toBe(true);
    expect(result.role).toBe("CONTRIBUTOR");
  });

  it("grants access via team membership when direct membership is absent (team branch)", async () => {
    const db = makeDb([], [{ id: 7 }]);
    const u = makeUser(ORG, MEMBERSHIP_ID);
    const result = await resolveProjectAccess(db, access, u, PROJECT_ID);
    expect(result.hasAccess).toBe(true);
    expect(result.role).toBe("MEMBER");
  });
});
