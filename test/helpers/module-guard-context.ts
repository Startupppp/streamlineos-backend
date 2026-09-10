import type { ExecutionContext } from "@nestjs/common";
import { createAuthContext } from "src/common/auth/auth-context";
import { humanSessionPrincipal } from "src/common/auth/principal";
import type { CurrentUserContext } from "src/common/auth/backend-claims";
import type { ModuleAvailabilityResult } from "src/common/rbac/module-availability";

export const MODULE_AVAILABLE: ModuleAvailabilityResult = { available: true };

export const MODULE_DISABLED: ModuleAvailabilityResult = {
  available: false,
  reason: "org-disabled",
};

export function testActor(
  user: Partial<CurrentUserContext> = {},
): CurrentUserContext {
  return {
    userId: "u-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...user,
  };
}

export function makeGuardRequest(
  user: Partial<CurrentUserContext>,
  availability: ModuleAvailabilityResult = MODULE_DISABLED,
): { user: CurrentUserContext; authContext: ReturnType<typeof createAuthContext> } {
  const actor = testActor(user);
  return {
    user: actor,
    authContext: createAuthContext(actor, {
      moduleAvailability: async () => availability,
    }),
  };
}

export function makeGuardCtx(
  ctrl: Function,
  methodName: string,
  user: Partial<CurrentUserContext>,
  availability: ModuleAvailabilityResult = MODULE_DISABLED,
): ExecutionContext {
  const handler = (ctrl.prototype as Record<string, unknown>)[
    methodName
  ] as Function;
  const req = makeGuardRequest(user, availability);
  return {
    getHandler: () => handler,
    getClass: () => ctrl,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}
