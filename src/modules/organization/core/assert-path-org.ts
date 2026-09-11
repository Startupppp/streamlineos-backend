import { NotFoundException } from "@nestjs/common";

/**
 * Refuses a request whose path names an organisation other than the caller's token org.
 *
 * `POST /organization/:orgId/purge/schedule` and `DELETE /organization/:orgId/purge` both declared
 * the parameter, ignored it, and acted on `u.orgId`. The live cross-tenant sweep measured 200 for
 * another organisation's id — nothing crossed, because the handler had already substituted the
 * caller's own org, which is exactly what makes it dangerous in the other direction: the caller
 * believes they addressed the organisation in the URL and the server acts on a different one. On
 * the two most destructive operations in the product, a decorative parameter is a trap, not a
 * cosmetic flaw.
 *
 * The refusal is NotFound, never Forbidden: a 403 here would confirm that the organisation in the
 * path exists.
 */
export function assertPathOrgIsCallerOrg(pathOrgId: string, callerOrgId: string): void {
  if (pathOrgId !== callerOrgId) throw new NotFoundException("Organization not found");
}
