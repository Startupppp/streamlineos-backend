import "reflect-metadata";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { UsersController } from "./users.controller";
import { DirectoryController } from "../directory/directory.controller";
import { HR_ROLE_TEMPLATES } from "../rbac/role-templates-hr.constants";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions/catalog";
import { EMPLOYEE_SELF_SERVICE_GRANTS } from "../access/access-policy";

function usersGate(method: keyof UsersController): string | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION, UsersController.prototype[method]);
}

function directoryGate(method: keyof DirectoryController): string | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION, DirectoryController.prototype[method]);
}

describe("P14 — exact endpoint permission gates (verbatim backend catalog keys)", () => {
  describe("UsersController — membership administration gates", () => {
    const membershipAdminKey = "settings:organization:manage";

    it("POST /users (direct add) requires settings:organization:manage", () => {
      expect(usersGate("createUser")).toBe(membershipAdminKey);
    });

    it("POST /users/invite requires settings:organization:manage", () => {
      expect(usersGate("inviteUser")).toBe(membershipAdminKey);
    });

    it("POST /users/bulk-invite requires settings:organization:manage", () => {
      expect(usersGate("bulkInvite")).toBe(membershipAdminKey);
    });

    it("POST /users/invitations/:id/resend requires settings:organization:manage", () => {
      expect(usersGate("resendInvite")).toBe(membershipAdminKey);
    });

    it("DELETE /users/invitations/:id (cancel) requires settings:organization:manage", () => {
      expect(usersGate("cancelInvite")).toBe(membershipAdminKey);
    });

    it("PATCH /users/invitations/:id/role requires settings:organization:manage", () => {
      expect(usersGate("changeInviteRole")).toBe(membershipAdminKey);
    });
  });

  describe("DirectoryController — people directory mutation gates", () => {
    it("POST /directory/people requires directory:people:create", () => {
      expect(directoryGate("createPerson")).toBe("directory:people:create");
    });

    it("PATCH /directory/people/:id requires directory:people:update", () => {
      expect(directoryGate("updatePerson")).toBe("directory:people:update");
    });

    it("DELETE /directory/people/:id requires directory:people:delete", () => {
      expect(directoryGate("deletePerson")).toBe("directory:people:delete");
    });

    it("GET /directory/workers requires directory:workers:view", () => {
      expect(directoryGate("listWorkers")).toBe("directory:workers:view");
    });

    it("GET /directory/workers/:id requires directory:workers:view", () => {
      expect(directoryGate("getWorker")).toBe("directory:workers:view");
    });

    it("POST /directory/workers requires directory:workers:manage", () => {
      expect(directoryGate("createWorker")).toBe("directory:workers:manage");
    });

    it("GET /directory/workers/:id/engagements requires directory:workers:view", () => {
      expect(directoryGate("listEngagements")).toBe("directory:workers:view");
    });

    it("POST /directory/workers/:id/engagements requires directory:workers:manage", () => {
      expect(directoryGate("createEngagement")).toBe("directory:workers:manage");
    });

    it("PATCH /directory/engagements/:id requires directory:workers:manage", () => {
      expect(directoryGate("updateEngagement")).toBe("directory:workers:manage");
    });

    it("POST /directory/engagements/:id/cancel requires directory:workers:manage", () => {
      expect(directoryGate("cancelEngagement")).toBe("directory:workers:manage");
    });

    it("POST /directory/engagements/:id/terminate requires directory:workers:terminate", () => {
      expect(directoryGate("terminateEngagement")).toBe("directory:workers:terminate");
    });
  });

  describe("P14 — directory read routes are universal (no permission gate)", () => {
    it("GET /directory/people carries no RequirePermission (universal route)", () => {
      expect(directoryGate("listPeople")).toBeUndefined();
    });

    it("GET /directory/people/:id carries no RequirePermission (universal route)", () => {
      expect(directoryGate("getPerson")).toBeUndefined();
    });
  });

  describe("P14 — the people directory is platform core, the workforce is not", () => {
    const universalKeys = new Set(
      EMPLOYEE_SELF_SERVICE_GRANTS.map((grant) => grant.permissionKey),
    );

    it("every active member holds directory:people:view, so the client gate is not an entitlement gate", () => {
      expect(universalKeys.has("directory:people:view")).toBe(true);
      expect(
        EMPLOYEE_SELF_SERVICE_GRANTS.find(
          (grant) => grant.permissionKey === "directory:people:view",
        )?.scope,
      ).toBe("all");
    });

    it("directory:workers:view is not universal, so a member can legitimately be denied the workforce", () => {
      expect(universalKeys.has("directory:workers:view")).toBe(false);
    });

    it("no directory mutation key is universal — the actions stay gated, the surface does not", () => {
      for (const key of [
        "directory:people:create",
        "directory:people:update",
        "directory:people:delete",
        "directory:workers:manage",
        "directory:workers:terminate",
      ])
        expect(universalKeys.has(key)).toBe(false);
    });

    it("organization membership administration is never universal", () => {
      expect(universalKeys.has("settings:organization:manage")).toBe(false);
    });
  });

  describe("P14 — permission catalog cross-check: each gate key exists in the backend catalog", () => {
    const gatesToCheck = [
      "settings:organization:manage",
      "directory:people:create",
      "directory:people:update",
      "directory:people:delete",
      "directory:workers:view",
      "directory:workers:manage",
      "directory:workers:terminate",
    ] as const;

    it.each(gatesToCheck)("%s is in the backend permission catalog", (key) => {
      expect(ALL_PERMISSION_NAMES).toContain(key);
    });
  });

  describe("P14 — HR module power must NOT grant organization membership administration", () => {
    it("HR_ADMIN template does not include settings:organization:manage (coordinator handoff if this fails)", () => {
      const hrAdminTemplate = HR_ROLE_TEMPLATES.find((t) => t.slug === "HR_ADMIN");
      expect(hrAdminTemplate).toBeDefined();
      expect(hrAdminTemplate?.permissions).not.toContain("settings:organization:manage");
    });

    it("BRANCH_HR template does not include settings:organization:manage", () => {
      const branchHr = HR_ROLE_TEMPLATES.find((t) => t.slug === "BRANCH_HR");
      expect(branchHr).toBeDefined();
      expect(branchHr?.permissions).not.toContain("settings:organization:manage");
    });

    it("RECRUITER template does not include settings:organization:manage", () => {
      const recruiter = HR_ROLE_TEMPLATES.find((t) => t.slug === "RECRUITER");
      expect(recruiter).toBeDefined();
      expect(recruiter?.permissions).not.toContain("settings:organization:manage");
    });
  });
});
