export function hasRoleOrPrivileged(
  u: { isOrgOwner: boolean; isPlatformAdmin: boolean; role: string },
  roles: readonly string[],
): boolean {
  return u.isOrgOwner || u.isPlatformAdmin || roles.includes(u.role);
}
