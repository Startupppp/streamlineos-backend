import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

/**
 * Who may operate the platform, as distinct from who may administer a tenant.
 *
 * Admitting somebody off the waitlist is not a tenant operation. RBAC in this
 * codebase is scoped to an organisation, so a permission key would let any
 * organisation's admin grant themselves the right to create *other people's*
 * organisations -- which is the opposite of what a gated waitlist is for.
 *
 * The allowlist is hardcoded and deliberately so, matching the reasoning already
 * written into `waitlist.service.ts` about its notification recipients: an
 * environment variable that is unset fails open into "nobody is an operator", or
 * worse, is set wrongly and silently makes somebody one. The cost is that
 * changing the list is a code change and a deploy, which for the small set of
 * people who can admit strangers is the right cost.
 */
export const PLATFORM_OPERATORS: readonly string[] = [
  "tarunchintakunta@gmail.com",
  "adityachalla01@gmail.com",
];

export function isPlatformOperator(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalised = email.trim().toLowerCase();
  return PLATFORM_OPERATORS.some((operator) => operator.toLowerCase() === normalised);
}

@Injectable()
export class PlatformOperatorGuard implements CanActivate {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The email comes from the database, not from the token.
   *
   * `BackendClaims` carries `sub`, `orgId` and `sessionId` and deliberately no
   * email -- so reading `request.user.email` gets `undefined` and this guard
   * would refuse everybody, which is the failure that looks like working
   * security right up until the feature is needed. Worse, a claims-carried email
   * would be an authorisation decision made from something the token minter
   * controls.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserContext }>();

    const userId = request.user?.userId;
    if (!userId) {
      throw new ForbiddenException("Only a platform operator can admit from the waitlist.");
    }

    const rows = await this.db.execute(
      sql`SELECT email FROM users WHERE id = ${userId} LIMIT 1`,
    );
    const email = rows[0]?.["email"];

    if (!isPlatformOperator(typeof email === "string" ? email : null)) {
      // Not a 404: the caller is authenticated and the route is not a tenant
      // resource, so there is no cross-tenant existence to hide here.
      throw new ForbiddenException("Only a platform operator can admit from the waitlist.");
    }

    return true;
  }
}
