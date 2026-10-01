import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { assertProjectAccess, assertCanManageProject } from "./project-access";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { systemActor } from "../../../../common/auth/system-actor";
import { MEMBER_STANDING, projectAccessRow, principalAccess, type ProjectAccessRow } from "./__tests__/project-access-doubles";
import { queuedSelectDb } from "./__tests__/project-access-db";

function dbWith(row: ProjectAccessRow | undefined) {
  return queuedSelectDb({ selects: [row === undefined ? [] : [row]] }).db;
}

function user(isOrgOwner = false): CurrentUserContext {
  return {
    orgId: "org-1",
    userId: "u-1",
    role: "MEMBER",
    isOrgOwner,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, isOrgOwner),
  };
}

const member = () => principalAccess(MEMBER_STANDING);
const orgAdmin = () => principalAccess({ ...MEMBER_STANDING, "build:manage": "all" });

describe("project-access conformance matrix — assertProjectAccess", () => {
  describe("cross-tenant miss: project not in caller org → 404 regardless of actor standing", () => {
    it("throws NotFoundException for an org owner when the project is absent from their org", async () => {
      await expect(assertProjectAccess(dbWith(undefined), member(), user(true), 1)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException for an org admin (build:manage all) when the project is absent from their org", async () => {
      await expect(assertProjectAccess(dbWith(undefined), orgAdmin(), user(), 1)).rejects.toThrow(NotFoundException);
    });
  });

  describe("allowed actors: org owner, org admin, manager, ADMIN member, CONTRIBUTOR member, team member", () => {
    it("resolves for an org owner on a project in their org", async () => {
      await expect(assertProjectAccess(dbWith(projectAccessRow()), member(), user(true), 1)).resolves.toBeUndefined();
    });

    it("resolves for a holder of build:manage at all scope with no relationship", async () => {
      await expect(assertProjectAccess(dbWith(projectAccessRow()), orgAdmin(), user(), 1)).resolves.toBeUndefined();
    });

    it("resolves for the project manager", async () => {
      await expect(
        assertProjectAccess(dbWith(projectAccessRow({ manages: true })), member(), user(), 1),
      ).resolves.toBeUndefined();
    });

    it.each(["ADMIN", "CONTRIBUTOR"])("resolves for a direct project member with %s role", async (memberRole) => {
      await expect(
        assertProjectAccess(dbWith(projectAccessRow({ memberRole })), member(), user(), 1),
      ).resolves.toBeUndefined();
    });

    it("resolves for a team member even without direct project membership", async () => {
      await expect(
        assertProjectAccess(dbWith(projectAccessRow({ onTeam: true })), member(), user(), 1),
      ).resolves.toBeUndefined();
    });
  });

  describe("denied actors: outsider in same org → 403 (not 404, because project exists)", () => {
    it("throws ForbiddenException, not NotFoundException, for an in-org user with no relationship", async () => {
      const err = await assertProjectAccess(dbWith(projectAccessRow()), member(), user(), 1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err).not.toBeInstanceOf(NotFoundException);
    });
  });
});

describe("project-access conformance matrix — assertCanManageProject", () => {
  it("throws NotFoundException for an org owner when the project is absent from their org", async () => {
    await expect(assertCanManageProject(dbWith(undefined), member(), user(true), 1)).rejects.toThrow(NotFoundException);
  });

  describe("allowed actors: org owner, org admin, project manager, ADMIN direct member", () => {
    it("resolves for an org owner on a project in their org", async () => {
      await expect(assertCanManageProject(dbWith(projectAccessRow()), member(), user(true), 1)).resolves.toBeUndefined();
    });

    it("resolves for a holder of build:manage at all scope without a project relationship", async () => {
      await expect(assertCanManageProject(dbWith(projectAccessRow()), orgAdmin(), user(), 1)).resolves.toBeUndefined();
    });

    it("resolves for the project manager", async () => {
      await expect(
        assertCanManageProject(dbWith(projectAccessRow({ manages: true })), member(), user(), 1),
      ).resolves.toBeUndefined();
    });

    it("resolves for a direct project member with ADMIN role", async () => {
      await expect(
        assertCanManageProject(dbWith(projectAccessRow({ memberRole: "ADMIN" })), member(), user(), 1),
      ).resolves.toBeUndefined();
    });
  });

  describe("denied actors: CONTRIBUTOR member, team member, outsider → 403 (project exists)", () => {
    it("throws ForbiddenException for a direct project member with CONTRIBUTOR role", async () => {
      await expect(
        assertCanManageProject(dbWith(projectAccessRow({ memberRole: "CONTRIBUTOR" })), member(), user(), 1),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException for a team member who has view access but not management authority", async () => {
      await expect(
        assertCanManageProject(dbWith(projectAccessRow({ onTeam: true })), member(), user(), 1),
      ).rejects.toThrow(ForbiddenException);
    });

    it("denies an in-org user with no relationship as 403 rather than 404", async () => {
      const err = await assertCanManageProject(dbWith(projectAccessRow()), member(), user(), 1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err).not.toBeInstanceOf(NotFoundException);
    });
  });
});

describe("project-access conformance matrix — system-job principal path", () => {
  it("resolves for a system-job whose ceiling includes build:tickets:view (build.automation.apply-action)", async () => {
    const actor = systemActor("build.automation.apply-action", "org-1");
    await expect(assertProjectAccess(dbWith(projectAccessRow()), member(), actor, 1)).resolves.toBeUndefined();
  });

  it("throws ForbiddenException for a system-job whose ceiling includes neither build:manage nor build:tickets:view (payroll.run.finalize-posting)", async () => {
    const actor = systemActor("payroll.run.finalize-posting", "org-1");
    await expect(assertProjectAccess(dbWith(projectAccessRow()), member(), actor, 1)).rejects.toThrow(ForbiddenException);
  });

  it("throws NotFoundException when the project is absent from the org, even for a privileged system-job", async () => {
    const actor = systemActor("build.automation.apply-action", "org-1");
    await expect(assertProjectAccess(dbWith(undefined), member(), actor, 1)).rejects.toThrow(NotFoundException);
  });

  it("lets a system-job whose ceiling carries build:manage reach the project (build.daily-snapshots)", async () => {
    const actor = systemActor("build.daily-snapshots", "org-1");
    await expect(assertProjectAccess(dbWith(projectAccessRow()), member(), actor, 1)).resolves.toBeUndefined();
  });

  it("decides a system-job from its ceiling alone and never asks scopeFor for a membership capability", async () => {
    const access = member();
    await assertProjectAccess(dbWith(projectAccessRow()), access, systemActor("build.automation.apply-action", "org-1"), 1);
    expect(access.scopeFor).not.toHaveBeenCalled();
  });
});
