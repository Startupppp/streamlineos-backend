import type { DataScope, ScopePredicate } from "../../common/rbac/data-scope";
import type { MfaState } from "../../common/auth/mfa-policy.token";

export type { DataScope, MfaState, ScopePredicate };

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

export interface AccessSnapshot {
  /**
   * The caller's own membership in this organisation, or null for a principal
   * that has none (an agent token, a system job, an account-only session).
   *
   * The frontend needs it to say whose approvals it is showing when a delegate
   * is acting for someone: every actor column holds an `organization_members.id`
   * since the cutover, and nothing else the client can reach carries one.
   * `/me` does not, and `GET organizations/members` is gated on settings:view,
   * which a plain delegate need not hold.
   *
   * Safe to cache under the snapshot's (org, user, version) key: for a human
   * session or a personal token this is that user's membership in that org, and
   * every other principal kind takes the uncached path or resolves to null.
   */
  membershipId: number | null;
  scopes: Record<string, DataScope>;
  modules: Record<string, boolean>;
  isOrgOwner: boolean;
  canManageOrganizationMembership: boolean;
  mfa: MfaState;
  version: number;
}
