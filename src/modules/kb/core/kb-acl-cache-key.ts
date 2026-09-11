export interface KbAclDimension {
  readonly orgId: string;
  readonly permissionsVersion: number;
  readonly membershipId: number | null;
}

export function kbAclCacheKey(userId: string, acl: KbAclDimension): string {
  if (!Number.isInteger(acl.permissionsVersion) || acl.permissionsVersion < 1)
    throw new Error(
      "KB cache keys require a resolved permissionsVersion — an ACL-blind key keeps serving spaces a revoked role no longer reaches",
    );
  if (!userId) throw new Error("KB cache keys require a userId");
  if (!acl.orgId)
    throw new Error(
      "KB cache keys require an orgId — a userId is globally unique and one person can hold memberships in several organisations, so a tenant-blind key serves one org's spaces under another",
    );
  return `o${acl.orgId}:p${acl.permissionsVersion}:m${acl.membershipId ?? "none"}:u${userId}`;
}
