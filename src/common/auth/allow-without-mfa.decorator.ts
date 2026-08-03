import { SetMetadata } from "@nestjs/common";

export const ALLOW_WITHOUT_MFA = "allow_without_mfa";

/**
 * Exempts a handler (or a whole controller) from `MfaGuard`. Reserved for the
 * routes a user must reach in order to satisfy the policy — MFA enrolment, the
 * access snapshot that tells the client to redirect, and signing out.
 */
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA, true);
