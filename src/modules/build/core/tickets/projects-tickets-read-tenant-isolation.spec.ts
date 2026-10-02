import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { resolveProjectAccess } from "../project-crud/project-access";
import { MEMBER_STANDING, projectAccessRow, standingAccess } from "../../__tests__/project-access-doubles";
import { queuedSelectDb } from "../../__tests__/project-access-db";

function makeUser(orgId: string, membershipId: number): CurrentUserContext {
  return {
    orgId,
    userId: "u1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, false),
  };
}

describe("resolveProjectAccess — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  it("throws NotFoundException for a project in a different org (cross-tenant isolation)", async () => {
    const { db } = queuedSelectDb({ selects: [[]] });
    const access = standingAccess({ "build:manage": "all" });
    await expect(resolveProjectAccess(db, access, makeUser(ATTACKER_ORG, 1), 99)).rejects.toThrow("Project not found");
  });

  it("returns hasAccess=true for the owning org when caller has build:manage at all scope (same-tenant control)", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow()]] });
    const access = standingAccess({ "build:manage": "all" });
    const result = await resolveProjectAccess(db, access, makeUser(OWNER_ORG, 1), 1);
    expect(result.hasAccess).toBe(true);
  });
});

describe("resolveProjectAccess — direct and team membership", () => {
  const ORG = "org-a";
  const PROJECT_ID = 5;
  const MEMBERSHIP_ID = 1;
  const access = standingAccess(MEMBER_STANDING);

  it("denies a user with no project membership (DENY)", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow()]] });
    const result = await resolveProjectAccess(db, access, makeUser(ORG, MEMBERSHIP_ID), PROJECT_ID);
    expect(result.hasAccess).toBe(false);
  });

  it("grants access to a direct project member (CONTROL)", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow({ memberRole: "CONTRIBUTOR" })]] });
    const result = await resolveProjectAccess(db, access, makeUser(ORG, MEMBERSHIP_ID), PROJECT_ID);
    expect(result.hasAccess).toBe(true);
    expect(result.role).toBe("CONTRIBUTOR");
  });

  it("grants access via team membership when direct membership is absent (team branch)", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow({ onTeam: true })]] });
    const result = await resolveProjectAccess(db, access, makeUser(ORG, MEMBERSHIP_ID), PROJECT_ID);
    expect(result.hasAccess).toBe(true);
    expect(result.role).toBe("MEMBER");
  });
});
