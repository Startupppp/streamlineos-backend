const NON_DELEGABLE_PERMISSION_PREFIXES = [
  "billing:",
  "ownership:",
  "settings:",
] as const;

/** High-risk account and organization administration is interactive-only. */
export function isPersonalTokenPermissionDelegable(
  permissionKey: string,
): boolean {
  return !NON_DELEGABLE_PERMISSION_PREFIXES.some((prefix) =>
    permissionKey.startsWith(prefix),
  );
}
