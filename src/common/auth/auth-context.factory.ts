import { Inject, Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "./backend-claims";
import {
  createAuthContext,
  type AuthContext,
  type AuthContextLookups,
  type ModuleAvailabilityLookup,
} from "./auth-context";
import {
  MembershipStateService,
  type MembershipState,
} from "./membership-state.service";
import { MFA_POLICY, type IMfaPolicy } from "./mfa-policy.token";
import { MODULE_AVAILABILITY_LOOKUP } from "./module-availability-lookup.token";

@Injectable()
export class AuthContextFactory {
  private readonly lookups: AuthContextLookups;

  constructor(
    @Inject(MODULE_AVAILABILITY_LOOKUP)
    moduleAccess: ModuleAvailabilityLookup,
    membership: MembershipStateService,
    @Inject(MFA_POLICY) mfaPolicy: IMfaPolicy,
  ) {
    this.lookups = {
      moduleAvailability: (user, moduleKey) =>
        moduleAccess.moduleAvailability(user, moduleKey),
      membershipState: (userId, orgId) => membership.resolve(userId, orgId),
      mfaState: (orgId, userId) => mfaPolicy.resolve(orgId, userId),
    };
  }

  create(
    actor: CurrentUserContext,
    resolvedMembership?: MembershipState,
  ): AuthContext {
    return createAuthContext(actor, this.lookups, resolvedMembership);
  }
}
