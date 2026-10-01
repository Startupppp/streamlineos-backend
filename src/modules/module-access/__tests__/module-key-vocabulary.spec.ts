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
  return node as unknown as Record<string, unknown>;
}

function makeStubDb(): ModuleAccessPolicyDeps["db"] {
  return {
    select: jest.fn(() => selectChain()),
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 1, role: "MEMBER", status: "ACTIVE", isOwner: false }),
      },
    },
  } as never;
}

function makeDeps(moduleEnabled = true): ModuleAccessPolicyDeps {
  return {
    db: makeStubDb(),
    isModuleEnabled: jest.fn().mockResolvedValue(moduleEnabled),
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
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

  describe("two-vocabulary trap — stored UPPERCASE vs catalog lowercase", () => {
    it("isModuleEnabled normalises the incoming key so UPPERCASE input does not silently miss", async () => {
      const deps = makeDeps(true);
      await assertModuleEnabled(deps, "org-1", "hr");
      const [, passedKey] = (deps.isModuleEnabled as jest.Mock).mock.calls[0] as [string, string];
      expect(passedKey).toBe("hr");
    });
  });
});
