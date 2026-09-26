import { testAuthContext } from "../../../test/helpers/module-guard-context";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ModuleGuard } from "./module.guard";
import { REQUIRE_MODULE } from "./require-module.decorator";
import { IS_PUBLIC } from "../auth/public.decorator";
import { ModuleDisabledException } from "../http/api-exceptions";
import type { ModuleAvailabilityLookup } from "../auth/auth-context";
import { humanSessionPrincipal } from "../auth/principal";
import type { CurrentUserContext } from "../auth/backend-claims";
import type { EntitlementsService } from "../../modules/access/entitlements.service";
import type { ModuleAvailabilityResult } from "./module-availability";

const entitlements: jest.Mocked<
  Pick<
    EntitlementsService,
    "isCoreModule" | "getModuleMap" | "getPlanLockedModules"
  >
> = {
  isCoreModule: jest.fn().mockReturnValue(false),
  getModuleMap: jest.fn().mockResolvedValue({}),
  getPlanLockedModules: jest.fn().mockResolvedValue([]),
};

const lookup: ModuleAvailabilityLookup = {
  moduleAvailability: async (_user: CurrentUserContext, moduleKey: string) => {
    if (entitlements.isCoreModule(moduleKey)) return { available: true };
    const map = await entitlements.getModuleMap("org-1");
    if (map[moduleKey] === true) return { available: true };
    if (map[moduleKey] === false) return { available: false, reason: "org-disabled" };
    const locked = await entitlements.getPlanLockedModules("org-1");
    return locked.includes(moduleKey)
      ? { available: false, reason: "not-in-plan" }
      : { available: false, reason: "org-disabled" };
  },
};

function ctx(user: Partial<CurrentUserContext>): ExecutionContext {
  const actor: CurrentUserContext = {
    userId: "user-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...user,
  };
  const req = { user: actor, authContext: testAuthContext(actor, lookup) };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as Partial<ExecutionContext> as ExecutionContext;
}

function publicCtx(): ExecutionContext {
  const req = {};
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as Partial<ExecutionContext> as ExecutionContext;
}

function userWithoutAuthContextCtx(): ExecutionContext {
  const req = {
    user: {
      userId: "user-1",
      orgId: "org-1",
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "session-1",
      tokenScopes: null,
      principal: humanSessionPrincipal(1, false),
    } satisfies CurrentUserContext,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as Partial<ExecutionContext> as ExecutionContext;
}

describe("ModuleGuard", () => {
  const reflector: jest.Mocked<Reflector> = {
    get: jest.fn(),
    getAll: jest.fn(),
    getAllAndMerge: jest.fn(),
    getAllAndOverride: jest.fn(),
  } as jest.Mocked<Reflector>;

  // Expressed as the org's module map because that is what the guard now reads.
  const orgHasModules = (map: Record<string, boolean>): void => {
    entitlements.isCoreModule.mockReturnValue(false);
    entitlements.getModuleMap.mockResolvedValue(map);
    entitlements.getPlanLockedModules.mockResolvedValue([]);
  };

  const guard = new ModuleGuard(reflector);

  /**
   * The real Reflector answers per key; a mock that returns one value for every
   * key made the guard's IS_PUBLIC lookup read back the module name.
   */
  const setMetadata = (
    required: string | readonly string[] | undefined,
    isPublic = false,
  ): void => {
    reflector.getAllAndOverride.mockImplementation((key: unknown) => {
      if (key === REQUIRE_MODULE) return required;
      if (key === IS_PUBLIC) return isPublic;
      return undefined;
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes through when no @RequireModule is set", async () => {
    setMetadata(undefined);
    expect(await guard.canActivate(ctx({}))).toBe(true);
    expect(entitlements.getModuleMap).not.toHaveBeenCalled();
  });

  it("lets a @Public() route through even though its class carries @RequireModule", async () => {
    setMetadata("support", true);
    expect(await guard.canActivate(publicCtx())).toBe(true);
    expect(entitlements.getModuleMap).not.toHaveBeenCalled();
  });

  it("does not throw reading orgId when there is no authenticated user", async () => {
    setMetadata("support");
    await expect(guard.canActivate(publicCtx())).resolves.toBe(true);
  });

  describe("a missing authContext is only safe when nothing authenticated the request", () => {
    it("denies a @RequireModule route whose request carries an authenticated user but no authContext, because no entitlement was resolved and the module gate would otherwise be nothing", async () => {
      setMetadata("crm");
      await expect(
        guard.canActivate(userWithoutAuthContextCtx()),
      ).rejects.toThrow(ForbiddenException);
    });

    it("still admits a @RequireModule route whose request has neither user nor authContext, which is the portal principal guard's shape because route-level guards run after the global ones", async () => {
      setMetadata("crm");
      await expect(guard.canActivate(publicCtx())).resolves.toBe(true);
    });
  });

  it("allows when the module is enabled", async () => {
    setMetadata("crm");
    orgHasModules({ crm: true });
    expect(await guard.canActivate(ctx({}))).toBe(true);
    expect(entitlements.getModuleMap).toHaveBeenCalledWith("org-1");
  });


  it("throws ModuleDisabledException when module not enabled and not admin", async () => {
    setMetadata("crm");
    orgHasModules({ crm: false });
    await expect(guard.canActivate(ctx({}))).rejects.toThrow(ModuleDisabledException);
  });

  it("denies org owners when the module is disabled", async () => {
    setMetadata("crm");
    orgHasModules({ crm: false });
    await expect(guard.canActivate(ctx({ isOrgOwner: true }))).rejects.toThrow(
      ModuleDisabledException,
    );
  });

  it("denies org admins when the module is disabled", async () => {
    setMetadata("crm");
    orgHasModules({ crm: false });
    await expect(guard.canActivate(ctx({}))).rejects.toThrow(ModuleDisabledException);
  });

  it("normalizes the required key to lowercase before querying", async () => {
    setMetadata("BUILD");
    orgHasModules({ build: true });
    expect(await guard.canActivate(ctx({}))).toBe(true);
  });

  it("queries the DB for the build module — not legacy PROJECTS alias", async () => {
    setMetadata("build");
    orgHasModules({ build: true });
    expect(await guard.canActivate(ctx({}))).toBe(true);
    await expect(guard.canActivate(ctx({}))).resolves.toBe(true);
    orgHasModules({ projects: true });
    await expect(guard.canActivate(ctx({}))).rejects.toThrow(ModuleDisabledException);
  });

  it("requires every module when @RequireModule receives an array", async () => {
    setMetadata(["crm", "inventory"]);
    orgHasModules({ crm: true, inventory: true });
    expect(await guard.canActivate(ctx({}))).toBe(true);
  });

  it("throws when any required module in the array is disabled", async () => {
    setMetadata(["crm", "inventory"]);
    orgHasModules({ crm: true, inventory: false });
    await expect(guard.canActivate(ctx({}))).rejects.toThrow(ModuleDisabledException);
  });

  it("lets a core module through even when the org has no row for it", async () => {
    setMetadata("chat");
    entitlements.isCoreModule.mockReturnValue(true);
    entitlements.getModuleMap.mockResolvedValue({});
    expect(await guard.canActivate(ctx({}))).toBe(true);
  });

  const requiredModuleAvailability = new Map<string, ModuleAvailabilityResult>();

  function buildGuardForRequiredModule(
    moduleKey: string,
    availability: ModuleAvailabilityResult,
  ): ModuleGuard {
    setMetadata(moduleKey);
    requiredModuleAvailability.set(moduleKey, availability);
    return guard;
  }

  function contextFor(moduleKey: string): ExecutionContext {
    const actor: CurrentUserContext = {
      userId: "user-1",
      orgId: "org-1",
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "session-1",
      tokenScopes: null,
      principal: humanSessionPrincipal(1, false),
    };
    const req = {
      user: actor,
      authContext: testAuthContext(actor, {
        moduleAvailability: async (_user, key) =>
          requiredModuleAvailability.get(key) ?? { available: true },
      }),
    };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as Partial<ExecutionContext> as ExecutionContext;
  }

  describe("ModuleGuard denial reason reaches the wire", () => {
    it("reports org-disabled as enable, not as upgrade, so a free module is never sold", async () => {
      const guard = buildGuardForRequiredModule("feedbucket", {
        available: false,
        reason: "org-disabled",
      });

      await expect(guard.canActivate(contextFor("feedbucket"))).rejects.toMatchObject({
        response: {
          code: "MODULE_NOT_ENABLED",
          details: { moduleKey: "feedbucket", reason: "org-disabled", upgradePath: null },
        },
      });
    });

    it("offers an upgrade path only when the plan is the actual blocker", async () => {
      const guard = buildGuardForRequiredModule("payroll", {
        available: false,
        reason: "not-in-plan",
      });

      await expect(guard.canActivate(contextFor("payroll"))).rejects.toMatchObject({
        response: {
          details: { moduleKey: "payroll", reason: "not-in-plan", upgradePath: "/settings/billing" },
        },
      });
    });

    it("does not tell an individually denied user to enable a module that is already on", async () => {
      const guard = buildGuardForRequiredModule("hr", {
        available: false,
        reason: "user-denied",
      });

      await expect(guard.canActivate(contextFor("hr"))).rejects.toMatchObject({
        response: { details: { reason: "user-denied", upgradePath: null } },
      });
    });
  });
});
