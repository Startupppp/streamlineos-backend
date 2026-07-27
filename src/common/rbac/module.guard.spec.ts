import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ModuleGuard } from "./module.guard";
import { ModuleDisabledException } from "../http/api-exceptions";
import type { CurrentUserContext } from "../auth/backend-claims";

function ctx(user: Partial<CurrentUserContext>): ExecutionContext {
  const req = { user: { enabledModules: [], isPlatformAdmin: false, isOrgOwner: false, ...user } };
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
  const guard = new ModuleGuard(reflector);

  it("passes through when no @RequireModule is set", () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(ctx({}))).toBe(true);
  });

  it("allows when the module is enabled", () => {
    reflector.getAllAndOverride.mockReturnValue("crm");
    expect(guard.canActivate(ctx({ enabledModules: ["crm"] }))).toBe(true);
  });

  it("allows platform admins regardless of enabled modules", () => {
    reflector.getAllAndOverride.mockReturnValue("crm");
    expect(guard.canActivate(ctx({ enabledModules: [], isPlatformAdmin: true }))).toBe(true);
  });

  it("throws ModuleDisabledException when module not enabled and not admin", () => {
    reflector.getAllAndOverride.mockReturnValue("crm");
    expect(() => guard.canActivate(ctx({ enabledModules: ["hr"] }))).toThrow(ModuleDisabledException);
  });

  it("allows org owners regardless of enabled modules", () => {
    reflector.getAllAndOverride.mockReturnValue("crm");
    expect(guard.canActivate(ctx({ enabledModules: [], isOrgOwner: true }))).toBe(true);
  });

  it("accepts the legacy PROJECTS projection for the build module", () => {
    reflector.getAllAndOverride.mockReturnValue("build");
    expect(guard.canActivate(ctx({ enabledModules: ["PROJECTS"] }))).toBe(true);
  });

  it("accepts the migrated BUILD projection for the build module", () => {
    reflector.getAllAndOverride.mockReturnValue("build");
    expect(guard.canActivate(ctx({ enabledModules: ["BUILD"] }))).toBe(true);
  });

  it("accepts the HELPDESK projection for the support module", () => {
    reflector.getAllAndOverride.mockReturnValue("support");
    expect(guard.canActivate(ctx({ enabledModules: ["HELPDESK"] }))).toBe(true);
  });

  it("accepts the FINANCE projection for the accounting module", () => {
    reflector.getAllAndOverride.mockReturnValue("accounting");
    expect(guard.canActivate(ctx({ enabledModules: ["FINANCE"] }))).toBe(true);
  });

  it("does not widen across modules via aliases", () => {
    reflector.getAllAndOverride.mockReturnValue("build");
    expect(() => guard.canActivate(ctx({ enabledModules: ["HELPDESK", "FINANCE"] }))).toThrow(
      ModuleDisabledException,
    );
  });
});
