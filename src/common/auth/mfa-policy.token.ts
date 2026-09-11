export const MFA_POLICY = Symbol("MFA_POLICY");

export interface MfaState {
  enforced: boolean;
  satisfied: boolean;
}

export interface IMfaPolicy {
  resolve(orgId: string, userId: string): Promise<MfaState>;
}
