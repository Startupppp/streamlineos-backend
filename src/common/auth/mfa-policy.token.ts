export const MFA_POLICY = Symbol("MFA_POLICY");

export interface IMfaPolicy {
  resolve(orgId: string, userId: string): Promise<{ enforced: boolean; satisfied: boolean }>;
}
