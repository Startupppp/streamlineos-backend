import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ModuleGuard } from "./module.guard";
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes through when no @RequireModule is set", async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(await guard.canActivate(ctx({}))).toBe(true);
    expect(entitlements.isModuleEnabled).not.toHaveBeenCalled();
  });

  it("allows when the module is enabled", async () => {
    reflector.getAllAndOverride.mockReturnValue("crm");
    entitlements.isModuleEnabled.mockResolvedValue(true);
    expect(await guard.canActivate(ctx({}))).toBe(true);
    expect(entitlements.isModuleEnabled).toHaveBeenCalledWith("org-1", "crm");
  });


  it("throws ModuleDisabledException when module not enabled and not admin", async () => {
    reflector.getAllAndOverride.mockReturnValue("crm");
    entitlements.isModuleEnabled.mockResolvedValue(false);
    await expect(guard.canActivate(ctx({}))).rejects.toThrow(ModuleDisabledException);
  });

  it("denies org owners when the module is disabled", async () => {
    reflector.getAllAndOverride.mockReturnValue("crm");
    entitlements.isModuleEnabled.mockResolvedValue(false);
    await expect(guard.canActivate(ctx({ isOrgOwner: true }))).rejects.toThrow(
      ModuleDisabledException,
    );
    expect(entitlements.isModuleEnabled).toHaveBeenCalledWith("org-1", "crm");
  });

  it("denies org admins when the module is disabled", async () => {
    reflector.getAllAndOverride.mockReturnValue("crm");
    entitlements.isModuleEnabled.mockResolvedValue(false);
    await expect(guard.canActivate(ctx({}))).rejects.toThrow(ModuleDisabledException);
    expect(entitlements.isModuleEnabled).toHaveBeenCalledWith("org-1", "crm");
  });

  it("normalizes the required key to lowercase before querying", async () => {
    reflector.getAllAndOverride.mockReturnValue("BUILD");
    entitlements.isModuleEnabled.mockResolvedValue(true);
    expect(await guard.canActivate(ctx({}))).toBe(true);
    expect(entitlements.isModuleEnabled).toHaveBeenCalledWith("org-1", "build");
  });

  it("queries the DB for the build module — not legacy PROJECTS alias", async () => {
    reflector.getAllAndOverride.mockReturnValue("build");
    entitlements.isModuleEnabled.mockResolvedValue(true);
    expect(await guard.canActivate(ctx({}))).toBe(true);
    expect(entitlements.isModuleEnabled).toHaveBeenCalledWith("org-1", "build");
  });

  it("requires every module when @RequireModule receives an array", async () => {
    reflector.getAllAndOverride.mockReturnValue(["crm", "inventory"]);
    entitlements.isModuleEnabled.mockResolvedValue(true);
    expect(await guard.canActivate(ctx({}))).toBe(true);
    expect(entitlements.isModuleEnabled).toHaveBeenCalledTimes(2);
    expect(entitlements.isModuleEnabled).toHaveBeenNthCalledWith(1, "org-1", "crm");
    expect(entitlements.isModuleEnabled).toHaveBeenNthCalledWith(2, "org-1", "inventory");
  });

  it("throws when any required module in the array is disabled", async () => {
    reflector.getAllAndOverride.mockReturnValue(["crm", "inventory"]);
    entitlements.isModuleEnabled.mockImplementation(async (_orgId, key) => key === "crm");
    await expect(guard.canActivate(ctx({}))).rejects.toThrow(ModuleDisabledException);
    expect(entitlements.isModuleEnabled).toHaveBeenCalledWith("org-1", "inventory");
  });
});
