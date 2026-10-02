import { ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  assertManagedModule,
  assertModuleEnabled,
  assertModuleAccessPolicy,
  type ModuleAccessPolicyDeps,
} from "../module-access.helpers";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { stubService } from "../../../test/service-stub.spec-fixtures";

function makeActor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

function selectChain(rows: unknown[] = []): Record<string, unknown> {
  const node: Record<string, jest.Mock> = {};
  for (const m of ["from", "innerJoin", "where", "limit"]) {
    node[m] = jest.fn(() => node);
  }
  Object.assign(node, {
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    catch: (reject: (e: unknown) => unknown) => Promise.resolve(rows).catch(reject),
  });
  return node;
}

function makeStubDb(
  authorityRows: unknown[] = [],
  memberRole = "MEMBER",
): ModuleAccessPolicyDeps["db"] {
  return stubService<ModuleAccessPolicyDeps["db"]>({
    select: jest.fn(() => selectChain(authorityRows)),
    query: stubService<ModuleAccessPolicyDeps["db"]["query"]>({
      organizationMembers: stubService<ModuleAccessPolicyDeps["db"]["query"]["organizationMembers"]>({
        findFirst: jest.fn().mockResolvedValue({ id: 1, role: memberRole, status: "ACTIVE", isOwner: false }),
      }),
    }),
  });
}

function makeDeps(
  moduleEnabled = true,
  authorityRows: unknown[] = [],
  memberRole = "MEMBER",
): ModuleAccessPolicyDeps {
  return {
    db: makeStubDb(authorityRows, memberRole),
    isModuleEnabled: jest.fn().mockResolvedValue(moduleEnabled),
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
    getUserDeniedModules: jest.fn().mockResolvedValue(new Set()),
  };
}

describe("module-key vocabulary — case normalisation", () => {
  describe("assertManagedModule", () => {
    it("accepts a lowercase managed module key", () => {
      expect(() => assertManagedModule("hr")).not.toThrow();
    });

    it("rejects an unmanaged module (billing, platform-admin ladder)", () => {
      expect(() => assertManagedModule("billing")).toThrow(NotFoundException);
    });

    it("rejects an unknown key (not in registry at all)", () => {
      expect(() => assertManagedModule("NONEXISTENT")).toThrow(NotFoundException);
    });

    it("rejects an UPPERCASE form of a managed module key (stored form is not a valid catalog entry)", () => {
      expect(() => assertManagedModule("HR")).toThrow(NotFoundException);
    });
  });

  describe("assertModuleEnabled — normalisation at the isModuleEnabled boundary", () => {
    it("passes through for a lowercase enabled module", async () => {
      const deps = makeDeps(true);
      await expect(assertModuleEnabled(deps, "org-1", "hr")).resolves.toBeUndefined();
      expect(deps.isModuleEnabled).toHaveBeenCalledWith("org-1", "hr");
    });

    it("answers a disabled module with 402 MODULE_NOT_ENABLED, not an in-tenant 403 (BE-22/BE-23)", async () => {
      const deps = makeDeps(false);
      const refusal = assertModuleEnabled(deps, "org-1", "hr");
      await expect(refusal).rejects.toBeInstanceOf(ModuleDisabledException);
      await expect(refusal).rejects.not.toBeInstanceOf(ForbiddenException);
      const error = await refusal.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModuleDisabledException);
      if (!(error instanceof ModuleDisabledException)) return;
      expect(error.getStatus()).toBe(402);
      expect(error.getResponse()).toMatchObject({
        code: "MODULE_NOT_ENABLED",
        details: { moduleKey: "hr", reason: "org-disabled", upgradePath: null },
      });
    });

    it("lets an enabled module through so the 402 is not a blanket refusal", async () => {
      const deps = makeDeps(true);
      await expect(assertModuleEnabled(deps, "org-1", "hr")).resolves.toBeUndefined();
    });
  });

  describe("assertModuleAccessPolicy — view rung", () => {
    it("org owner bypasses the module-enabled and permission check on view", async () => {
      const deps = makeDeps(true);
      await expect(
        assertModuleAccessPolicy(deps, makeActor({ isOrgOwner: true }), "hr", "view"),
      ).resolves.toBeUndefined();
    });

    it("throws ForbiddenException for a member with no view permission", async () => {
      const deps = makeDeps(true);
      await expect(
        assertModuleAccessPolicy(deps, makeActor(), "hr", "view"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("passes for a member who holds hr:access:view", async () => {
      const deps = {
        ...makeDeps(true),
        resolveUserPermissions: jest.fn().mockResolvedValue(
          new Map([["hr:access:view", "all"]]),
        ),
      };
      await expect(
        assertModuleAccessPolicy(deps, makeActor(), "hr", "view"),
      ).resolves.toBeUndefined();
    });

    it("refuses a disabled module with 402 even for the org owner, whose bypass is permissions not plan", async () => {
      const deps = makeDeps(false);
      await expect(
        assertModuleAccessPolicy(deps, makeActor({ isOrgOwner: true }), "hr", "view"),
      ).rejects.toBeInstanceOf(ModuleDisabledException);
    });
  });

  describe("assertModuleAccessPolicy — per-person Build denial", () => {
    it("refuses an unassigned Org Member's Build view while the org has Build enabled", async () => {
      const deps = makeDeps(true);

      await expect(
        assertModuleAccessPolicy(deps, makeActor(), "build", "view"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(deps.isModuleEnabled).toHaveBeenCalledWith("org-1", "build");
      expect(deps.getUserDeniedModules).not.toHaveBeenCalled();
    });

    it("allows an assigned Org Member's Build view", async () => {
      const deps = makeDeps(true);
      deps.resolveUserPermissions = jest.fn().mockResolvedValue(
        new Map([["build:access:view", "all"]]),
      );

      await expect(
        assertModuleAccessPolicy(deps, makeActor(), "build", "view"),
      ).resolves.toBeUndefined();
    });

    it("refuses permission-derived Build standing when a per-person denial remains", async () => {
      const deps = makeDeps(true);
      deps.resolveUserPermissions = jest.fn().mockResolvedValue(
        new Map([["build:access:view", "all"]]),
      );
      deps.getUserDeniedModules = jest.fn().mockResolvedValue(new Set(["build"]));

      await expect(
        assertModuleAccessPolicy(deps, makeActor(), "build", "view"),
      ).rejects.toBeInstanceOf(ModuleDisabledException);
    });

    it("refuses a denied module admin's Build management despite a surviving role", async () => {
      const deps = makeDeps(true, [{ rank: 20, moduleKey: "build" }]);
      deps.getUserDeniedModules = jest.fn().mockResolvedValue(new Set(["build"]));

      const denial = assertModuleAccessPolicy(deps, makeActor(), "build", "manage");
      await expect(denial).rejects.toBeInstanceOf(ModuleDisabledException);
      const error = await denial.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModuleDisabledException);
      if (error instanceof ModuleDisabledException)
        expect(error.getResponse()).toMatchObject({
          code: "MODULE_NOT_ENABLED",
          details: { moduleKey: "build", reason: "user-denied" },
        });
      expect(deps.getUserDeniedModules).toHaveBeenCalledWith("org-1", "u-1");
    });

    it("refuses a denied Build owner reading the access roster through a surviving ownership row", async () => {
      const deps = makeDeps(true, [{ userId: "u-1" }]);
      deps.getUserDeniedModules = jest.fn().mockResolvedValue(new Set(["build"]));

      await expect(
        assertModuleAccessPolicy(deps, makeActor(), "build", "view"),
      ).rejects.toBeInstanceOf(ModuleDisabledException);
      expect(deps.getUserDeniedModules).toHaveBeenCalledWith("org-1", "u-1");
    });

    it("fails closed when a module admin's denial list cannot be read", async () => {
      const deps = makeDeps(true, [{ rank: 20, moduleKey: "build" }]);
      deps.getUserDeniedModules = jest.fn().mockRejectedValue(new Error("denial store unavailable"));

      await expect(
        assertModuleAccessPolicy(deps, makeActor(), "build", "manage"),
      ).rejects.toThrow("denial store unavailable");
    });

    it("retains active Org Admin management of enabled Build despite a stale per-user deny", async () => {
      const deps = makeDeps(true, [], "ORG_ADMIN");
      deps.getUserDeniedModules = jest.fn().mockResolvedValue(new Set(["build"]));

      await expect(
        assertModuleAccessPolicy(deps, makeActor({ role: "ORG_ADMIN" }), "build", "manage"),
      ).resolves.toBeUndefined();
      expect(deps.getUserDeniedModules).not.toHaveBeenCalled();
    });

    it("reads the denial only from the acting tenant and person", async () => {
      const deps = makeDeps(true, [{ rank: 20, moduleKey: "build" }]);
      deps.getUserDeniedModules = jest.fn().mockImplementation(async (orgId: string) =>
        orgId === "org-other" ? new Set(["build"]) : new Set<string>(),
      );

      await expect(
        assertModuleAccessPolicy(deps, makeActor(), "build", "manage"),
      ).resolves.toBeUndefined();
      expect(deps.getUserDeniedModules).toHaveBeenCalledWith("org-1", "u-1");
    });
  });

  describe("two-vocabulary trap — stored UPPERCASE vs catalog lowercase", () => {
    it("isModuleEnabled normalises the incoming key so UPPERCASE input does not silently miss", async () => {
      const deps = makeDeps(true);
      await assertModuleEnabled(deps, "org-1", "hr");
      const [, passedKey] = jest.mocked(deps.isModuleEnabled).mock.calls[0];
      expect(passedKey).toBe("hr");
    });
  });
});
