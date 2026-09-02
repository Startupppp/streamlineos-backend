export interface KbAclDimension {
  readonly permissionsVersion: number;
  readonly membershipId: number | null;
}

export function kbAclCacheKey(userId: string, acl: KbAclDimension): string {
  if (!Number.isInteger(acl.permissionsVersion) || acl.permissionsVersion < 1)
    throw new Error(
      "KB cache keys require a resolved permissionsVersion — an ACL-blind key keeps serving spaces a revoked role no longer reaches",
    );
  if (!userId) throw new Error("KB cache keys require a userId");
  return `p${acl.permissionsVersion}:m${acl.membershipId ?? "none"}:u${userId}`;
}
