import type { ExecutionContext } from "@nestjs/common";
import {
  createAuthContext,
  type AuthContext,
  type AuthContextLookups,
} from "src/common/auth/auth-context";
import { humanSessionPrincipal } from "src/common/auth/principal";
import type { AuthContextFactory } from "src/common/auth/auth-context.factory";
import type { CurrentUserContext } from "src/common/auth/backend-claims";
import type { MembershipState } from "src/common/auth/membership-state.service";
import type { MfaState } from "src/common/auth/mfa-policy.token";
import type { ModuleAvailabilityResult } from "src/common/rbac/module-availability";

export const MODULE_AVAILABLE: ModuleAvailabilityResult = { available: true };

export const MODULE_DISABLED: ModuleAvailabilityResult = {
  available: false,
  reason: "org-disabled",
};

export const ACTIVE_MEMBERSHIP: MembershipState = {
  active: true,
  isOwner: false,
  role: "MEMBER",
  membershipId: 1,
};

export const MFA_SATISFIED: MfaState = { enforced: false, satisfied: true };

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

/** Defaults every lookup so a spec only states the fact it is about. */
export function testAuthContext(
  actor: CurrentUserContext,
  lookups: Partial<AuthContextLookups> = {},
  resolvedMembership?: MembershipState,
): AuthContext {
  return createAuthContext(
    actor,
    {
      moduleAvailability: async () => MODULE_AVAILABLE,
      membershipState: async () => ACTIVE_MEMBERSHIP,
      mfaState: async () => MFA_SATISFIED,
      ...lookups,
    },
    resolvedMembership,
  );
}

export function makeGuardRequest(
  user: Partial<CurrentUserContext>,
  availability: ModuleAvailabilityResult = MODULE_DISABLED,
): { user: CurrentUserContext; authContext: AuthContext } {
  const actor = testActor(user);
  return {
    user: actor,
    authContext: testAuthContext(actor, {
      moduleAvailability: async () => availability,
    }),
  };
}

/** A fake JwtAuthGuard that sets only `req.user` makes gated routes 401, not 403 — ADR 0004. */
export function attachTestAuthContext(
  req: { user?: CurrentUserContext; authContext?: AuthContext },
  actor: CurrentUserContext,
  availability: ModuleAvailabilityResult = MODULE_AVAILABLE,
): void {
  req.user = actor;
  req.authContext = testAuthContext(actor, {
    moduleAvailability: async () => availability,
  });
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

/** A factory double for `JwtAuthGuard`; the real one is only needed in composition specs. */
export function makeAuthContextFactory(
  lookups: Partial<AuthContextLookups> = {},
): AuthContextFactory {
  return {
    create: (actor: CurrentUserContext, resolvedMembership?: MembershipState) =>
      testAuthContext(actor, lookups, resolvedMembership),
  } as unknown as AuthContextFactory;
}
