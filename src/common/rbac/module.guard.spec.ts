import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ModuleGuard } from "./module.guard";
import { REQUIRE_MODULE } from "./require-module.decorator";
import { IS_PUBLIC } from "../auth/public.decorator";
import { ModuleDisabledException } from "../http/api-exceptions";
import type { CurrentUserContext } from "../auth/backend-claims";
import type { EntitlementsService } from "../../modules/access/entitlements.service";

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

  const entitlements: jest.Mocked<Pick<EntitlementsService, "isModuleEnabled">> = {
    isModuleEnabled: jest.fn(),
  };

  const guard = new ModuleGuard(
    reflector,
    entitlements as unknown as EntitlementsService,
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
    expect(entitlements.isModuleEnabled).not.toHaveBeenCalled();
  });

  it("lets a @Public() route through even though its class carries @RequireModule", async () => {
    setMetadata("support", true);
    expect(await guard.canActivate(publicCtx())).toBe(true);
    expect(entitlements.isModuleEnabled).not.toHaveBeenCalled();
  });

  it("does not throw reading orgId when there is no authenticated user", async () => {
    setMetadata("support");
    await expect(guard.canActivate(publicCtx())).resolves.toBe(true);
  });

  it("allows when the module is enabled", async () => {
    setMetadata("crm");
    entitlements.isModuleEnabled.mockResolvedValue(true);
    expect(await guard.canActivate(ctx({}))).toBe(true);
    expect(entitlements.isModuleEnabled).toHaveBeenCalledWith("org-1", "crm");
  });


  it("throws ModuleDisabledException when module not enabled and not admin", async () => {
    setMetadata("crm");
    entitlements.isModuleEnabled.mockResolvedValue(false);
    await expect(guard.canActivate(ctx({}))).rejects.toThrow(ModuleDisabledException);
  });

  it("denies org owners when the module is disabled", async () => {
    setMetadata("crm");
    entitlements.isModuleEnabled.mockResolvedValue(false);
    await expect(guard.canActivate(ctx({ isOrgOwner: true }))).rejects.toThrow(
      ModuleDisabledException,
    );
    expect(entitlements.isModuleEnabled).toHaveBeenCalledWith("org-1", "crm");
  });

  it("denies org admins when the module is disabled", async () => {
    setMetadata("crm");
    entitlements.isModuleEnabled.mockResolvedValue(false);
    await expect(guard.canActivate(ctx({}))).rejects.toThrow(ModuleDisabledException);
    expect(entitlements.isModuleEnabled).toHaveBeenCalledWith("org-1", "crm");
  });

  it("normalizes the required key to lowercase before querying", async () => {
    setMetadata("BUILD");
    entitlements.isModuleEnabled.mockResolvedValue(true);
    expect(await guard.canActivate(ctx({}))).toBe(true);
    expect(entitlements.isModuleEnabled).toHaveBeenCalledWith("org-1", "build");
  });

  it("queries the DB for the build module — not legacy PROJECTS alias", async () => {
    setMetadata("build");
    entitlements.isModuleEnabled.mockResolvedValue(true);
    expect(await guard.canActivate(ctx({}))).toBe(true);
    expect(entitlements.isModuleEnabled).toHaveBeenCalledWith("org-1", "build");
  });

  it("requires every module when @RequireModule receives an array", async () => {
    setMetadata(["crm", "inventory"]);
    entitlements.isModuleEnabled.mockResolvedValue(true);
    expect(await guard.canActivate(ctx({}))).toBe(true);
    expect(entitlements.isModuleEnabled).toHaveBeenCalledTimes(2);
    expect(entitlements.isModuleEnabled).toHaveBeenNthCalledWith(1, "org-1", "crm");
    expect(entitlements.isModuleEnabled).toHaveBeenNthCalledWith(2, "org-1", "inventory");
  });

  it("throws when any required module in the array is disabled", async () => {
    setMetadata(["crm", "inventory"]);
    entitlements.isModuleEnabled.mockImplementation(async (_orgId, key) => key === "crm");
    await expect(guard.canActivate(ctx({}))).rejects.toThrow(ModuleDisabledException);
    expect(entitlements.isModuleEnabled).toHaveBeenCalledWith("org-1", "inventory");
  });
});
