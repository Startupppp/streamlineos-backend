import type { CurrentUserContext } from "./backend-claims";
import type { MembershipState } from "./membership-state.service";
import type { MfaState } from "./mfa-policy.token";
import type { ModuleAvailabilityResult } from "../rbac/module-availability";

export interface ModuleAvailabilityLookup {
  moduleAvailability(
    user: CurrentUserContext,
    moduleKey: string,
  ): Promise<ModuleAvailabilityResult>;
}

export interface AuthContextLookups extends ModuleAvailabilityLookup {
  membershipState(userId: string, orgId: string): Promise<MembershipState>;
  mfaState(orgId: string, userId: string): Promise<MfaState>;
}

/** Every fact is resolved once per request and reused — ADR 0004. */
export interface AuthContext {
  readonly actor: CurrentUserContext;
  moduleAvailable(moduleKey: string): Promise<ModuleAvailabilityResult>;
  membership(): Promise<MembershipState>;
  mfa(): Promise<MfaState>;
}

const NO_MEMBERSHIP: MembershipState = {
  active: false,
  isOwner: false,
  role: "",
  membershipId: null,
};

const NO_ORG_MFA: MfaState = { enforced: true, satisfied: false };

export function createAuthContext(
  actor: CurrentUserContext,
  lookups: AuthContextLookups,
  resolvedMembership?: MembershipState,
): AuthContext {
  const modules = new Map<string, Promise<ModuleAvailabilityResult>>();
  let membership: Promise<MembershipState> | null =
    resolvedMembership === undefined
      ? null
      : Promise.resolve(resolvedMembership);
  let mfa: Promise<MfaState> | null = null;

  return {
    actor,
    moduleAvailable(moduleKey: string): Promise<ModuleAvailabilityResult> {
      const key = moduleKey.trim().toLowerCase();
      const existing = modules.get(key);
      if (existing) return existing;
      const pending = lookups.moduleAvailability(actor, key);
      modules.set(key, pending);
      return pending;
    },
    membership(): Promise<MembershipState> {
      if (membership) return membership;
      // No organization means no membership row to read, and no tenant to read it under.
      membership = actor.orgId
        ? lookups.membershipState(actor.userId, actor.orgId)
        : Promise.resolve(NO_MEMBERSHIP);
      return membership;
    },
    mfa(): Promise<MfaState> {
      if (mfa) return mfa;
      mfa = actor.orgId
        ? lookups.mfaState(actor.orgId, actor.userId)
        : Promise.resolve(NO_ORG_MFA);
      return mfa;
    },
  };
}
