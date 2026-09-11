import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { isStructuralOrgAdminContext } from "../../../common/rbac/is-structural-org-admin";
import { queryAiUsage } from "./ai-usage.query";

@Injectable()
export class AiUsageService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Org-wide AI spend, latency and acceptance.
   *
   * The structural check stays beside the permission key rather than replacing
   * it: spend is org-level financial data, and CLAUDE.md §5 forbids proving org
   * admin by asking for a settings key, so the key opens the route and
   * `organizationMembers.role`/`isOwner` decides who actually sees the numbers.
   */
  getOrgUsage(u: CurrentUserContext) {
    if (!isStructuralOrgAdminContext(u)) throw new ForbiddenException("Forbidden");
    return queryAiUsage(this.db, u.orgId);
  }
}
