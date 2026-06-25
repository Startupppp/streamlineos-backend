import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AbilityGuard } from "./ability.guard";
import { AbilityDeniedException } from "../http/api-exceptions";
import type { CurrentUserContext } from "../auth/backend-claims";

function ctx(user: Partial<CurrentUserContext>): ExecutionContext {
  const req = { user: { permissions: [], enabledModules: [], isPlatformAdmin: false, isOrgOwner: false, ...user } };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe("AbilityGuard", () => {
  const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
  const guard = new AbilityGuard(reflector);

  it("passes through when no @CheckAbility is set", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);
    expect(guard.canActivate(ctx({}))).toBe(true);
  });

  it("allows when the user has the permission", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({ verb: "read", subject: "crm:leads" });
    expect(guard.canActivate(ctx({ permissions: ["crm:leads:read"] }))).toBe(true);
  });

  it("throws AbilityDeniedException when lacking permission", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue({ verb: "delete", subject: "crm:leads" });
    expect(() => guard.canActivate(ctx({ permissions: ["crm:leads:read"] }))).toThrow(AbilityDeniedException);
  });
});
