export type DataScope = "all" | "team" | "own" | "none";

export type DenyReason = "UNAUTHENTICATED" | "NO_MODULE" | "FORBIDDEN";

export interface AuthResult {
  allow: boolean;
  scope: DataScope;
  reason?: DenyReason;
}

export interface MfaState {
  enforced: boolean;
  satisfied: boolean;
}

export interface AccessSnapshot {
  scopes: Record<string, DataScope>;
  modules: Record<string, boolean>;
  isOrgOwner: boolean;
  canManageOrganizationMembership: boolean;
  mfa: MfaState;
  version: number;
}
