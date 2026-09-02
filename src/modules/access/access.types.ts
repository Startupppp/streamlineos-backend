import type { DataScope } from "../../common/rbac/data-scope";

export type { DataScope };

export interface VersionEntry {
  version: number;
  expiresAt: number;
}

export interface PermsEntry {
  perms: Record<string, DataScope>;
  expiresAt: number;
}

export interface CachedPermissions {
  perms: Record<string, DataScope>;
  validUntil: number;
}

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
