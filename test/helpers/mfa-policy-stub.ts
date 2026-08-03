import type { MfaPolicyService } from "../../src/modules/access/mfa-policy.service";

export function makeMfaPolicyStub(): MfaPolicyService {
  return {
    resolve: jest.fn().mockResolvedValue({ enforced: false, satisfied: true }),
    invalidateOrg: jest.fn().mockResolvedValue(undefined),
    invalidateUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as MfaPolicyService;
}
