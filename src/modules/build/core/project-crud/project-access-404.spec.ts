import { NotFoundException } from "@nestjs/common";
import { assertProjectInOrg, resolveProjectAccess } from "./project-access";
import type { Db } from "../../../../db/drizzle.types";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

describe("build project access — a projectId outside the caller's org is a 404 even for an org owner", () => {
  const ATTACKER_ORG = "org-attacker";

  function makeDb(project: { managerMembershipId: number | null } | undefined) {
    return {
      query: { projects: { findFirst: jest.fn().mockResolvedValue(project) } },
    } as unknown as Db;
  }

  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) } as unknown as AccessService;

  const owner = {
    orgId: ATTACKER_ORG,
    userId: "u-1",
    isOrgOwner: true,
    principal: { kind: "human-session", membershipId: 3 },
  } as unknown as CurrentUserContext;

  it("resolveProjectAccess refuses a foreign project for an org owner rather than granting OWNER", async () => {
    await expect(resolveProjectAccess(makeDb(undefined), access, owner, 1)).rejects.toThrow(NotFoundException);
  });

  it("resolveProjectAccess still grants the org owner access to a project the org owns (control)", async () => {
    await expect(resolveProjectAccess(makeDb({ managerMembershipId: null }), access, owner, 1)).resolves.toEqual({
      hasAccess: true,
      role: "OWNER",
    });
  });

  it("assertProjectInOrg refuses a project the org does not own", async () => {
    await expect(assertProjectInOrg(makeDb(undefined), ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
  });

  it("assertProjectInOrg passes for a project the org owns (control)", async () => {
    await expect(assertProjectInOrg(makeDb({ managerMembershipId: null }), ATTACKER_ORG, 1)).resolves.toBeUndefined();
  });
});
