import type { MfaPolicyService } from "../../src/modules/access/mfa-policy.service";

/**
 * Neutral `MfaPolicyService` for unit tests: the organization does not enforce
 * MFA, so the policy never changes the behaviour under test.
 */
export function makeMfaPolicyStub(): MfaPolicyService {
  return {
    resolve: jest.fn().mockResolvedValue({ enforced: false, satisfied: true }),
    invalidateOrg: jest.fn().mockResolvedValue(undefined),
    invalidateUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as MfaPolicyService;
}
