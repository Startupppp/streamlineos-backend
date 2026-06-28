import type { CurrentUserContext } from "../../common/auth/backend-claims";

export function canManagePerformance(u: CurrentUserContext): boolean {
  return u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:performance:manage");
}

export function canManageDocuments(u: CurrentUserContext): boolean {
  return u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:documents:manage");
}
