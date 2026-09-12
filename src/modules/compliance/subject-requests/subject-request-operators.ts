/**
 * Who may run a subject request, on top of holding the permission.
 *
 * The permission key is necessary and not sufficient, and the reason is
 * specific rather than defensive. `access.service.ts:655` reads
 * `if (user.isOrgOwner) return "all"` — every organisation owner on the platform
 * is authorised for every catalogued key without a grant row existing, and
 * `ROLE_DEFAULT_PERMISSIONS.ORG_ADMIN` is literally `ALL_PERMISSION_NAMES`. A
 * subject request is cross-tenant by design (`subject_requests` is deliberately
 * not org-scoped, because one person has one right across every organisation
 * they appear in). Put those two facts together and cataloguing
 * `compliance:subject-requests:execute` hands every owner of every tenant a
 * button that deletes any email address across the whole platform, and hands
 * every owner an export of any address's data.
 *
 * There is no platform-operator concept in this codebase to gate on —
 * `CurrentUserContext` carries `userId`, `orgId`, `role`, `isOrgOwner` and
 * nothing above the tenant. So the second gate is an explicit, deployment-level
 * declaration of who the operators are, and it FAILS CLOSED: unset means nobody,
 * not everybody. An unconfigured deployment answers 403 and says what is
 * missing, which is the correct behaviour for a destructive cross-tenant
 * operation whose authorisation nobody has stated.
 *
 * User ids rather than email addresses, because an id is what the request
 * carries and matching on a claim the token does not hold would mean a lookup
 * that could itself be spoofed.
 */

/**
 * Named here rather than read here. The value arrives through `APP_CONFIG`, the
 * one validated configuration seam; this constant exists so the error message
 * can tell an operator which variable to set.
 */
export const SUBJECT_REQUEST_OPERATORS_ENV = "COMPLIANCE_SUBJECT_REQUEST_OPERATORS";

/** Comma-separated user ids. Blank entries dropped so a trailing comma is harmless. */
export function parseOperators(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function isDeclaredOperator(userId: string, operators: readonly string[]): boolean {
  // An empty declaration authorises nobody. Written as its own line rather than
  // left to `includes` on an empty array, because the failure being prevented --
  // an unconfigured deployment authorising everyone -- is worth stating.
  if (operators.length === 0) return false;
  return operators.includes(userId);
}
