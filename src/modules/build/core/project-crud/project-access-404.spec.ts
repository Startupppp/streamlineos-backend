import { NotFoundException } from "@nestjs/common";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { assertProjectInOrg, resolveProjectAccess } from "./project-access";
import { projectAccessRow, principalAccess } from "./__tests__/project-access-doubles";
import { queuedSelectDb } from "./__tests__/project-access-db";

describe("build project access — a projectId outside the caller's org is a 404 even for an org owner", () => {
  const ATTACKER_ORG = "org-attacker";

  const owner: CurrentUserContext = {
    orgId: ATTACKER_ORG,
    userId: "u-1",
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(3, true),
  };

  it("resolveProjectAccess refuses a foreign project for an org owner rather than granting OWNER", async () => {
    const { db } = queuedSelectDb({ selects: [[]] });
    await expect(resolveProjectAccess(db, principalAccess(), owner, 1)).rejects.toThrow(NotFoundException);
  });

  it("resolveProjectAccess still grants the org owner access to a project the org owns (control)", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow()]] });
    await expect(resolveProjectAccess(db, principalAccess(), owner, 1)).resolves.toEqual({
      hasAccess: true,
      role: "OWNER",
      state: "ACTIVE",
      bypassesWorkflow: true,
    });
  });

  it("assertProjectInOrg refuses a project the org does not own", async () => {
    const { db } = queuedSelectDb({ inOrg: undefined });
    await expect(assertProjectInOrg(db, ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
  });

  it("assertProjectInOrg passes for a project the org owns (control)", async () => {
    const { db } = queuedSelectDb({ inOrg: { id: 1 } });
    await expect(assertProjectInOrg(db, ATTACKER_ORG, 1)).resolves.toBeUndefined();
  });
});
