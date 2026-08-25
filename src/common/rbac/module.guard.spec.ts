import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ModuleGuard } from "./module.guard";
import { REQUIRE_MODULE } from "./require-module.decorator";
import { IS_PUBLIC } from "../auth/public.decorator";
import { ModuleDisabledException } from "../http/api-exceptions";
import type { CurrentUserContext } from "../auth/backend-claims";
import type { EntitlementsService } from "../../modules/access/entitlements.service";
import type { AccessService } from "../../modules/access/access.service";
import { moduleAvailabilityResolver } from "./module-availability";

function ctx(user: Partial<CurrentUserContext>): ExecutionContext {
  const req = {
    user: { enabledModules: [], isOrgOwner: false, orgId: "org-1", userId: "user-1", ...user },
  };
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

describe("ModuleGuard", () => {
  const reflector: jest.Mocked<Reflector> = {
    get: jest.fn(),
    getAll: jest.fn(),
    getAllAndMerge: jest.fn(),
    getAllAndOverride: jest.fn(),
  } as jest.Mocked<Reflector>;

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

  // Expressed as the org's module map because that is what the guard now reads.
  const orgHasModules = (map: Record<string, boolean>): void => {
    entitlements.isCoreModule.mockReturnValue(false);
    entitlements.getModuleMap.mockResolvedValue(map);
    entitlements.getPlanLockedModules.mockResolvedValue([]);
  };

  const guard = new ModuleGuard(
    reflector,
    entitlements as unknown as EntitlementsService,
    {
      buildModuleAvailabilityResolver: (getModuleMap: (orgId: string) => Promise<Record<string, boolean>>) =>
        moduleAvailabilityResolver(
          {
            isCoreModule: entitlements.isCoreModule,
            getModuleMap,
            getPlanLockedModules: entitlements.getPlanLockedModules,
          },
        ),
    } as unknown as AccessService,
  );

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
});
