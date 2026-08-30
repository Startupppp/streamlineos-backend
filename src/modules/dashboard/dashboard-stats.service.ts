import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import {
  attendance,
  organizationMembers,
  organizations,
  projects,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { getTodayString } from "../../common/date";
import { resolveDashboardStatsFlags } from "./dashboard-scope";
import { buildOrgDashboardCacheKey } from "./dashboard-cache-key";

@Injectable()
export class DashboardStatsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async getDashboardStats(orgId: string, u: CurrentUserContext) {
    const [statsKey, flags] = await Promise.all([
      buildOrgDashboardCacheKey(this.access, orgId, "stats"),
      resolveDashboardStatsFlags(this.access, u),
    ]);

    const full = await this.cache.cachedForOrg(
      orgId,
      statsKey,
      async () => {
        const today = getTodayString();
        const [
          org,
          memberCountResult,
          projectCountResult,
          attendanceCountResult,
        ] = await Promise.all([
          this.db.query.organizations.findFirst({
            where: eq(organizations.id, orgId),
          }),
          this.db
            .select({ count: count() })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.status, "ACTIVE"),
              ),
            ),
          this.db
            .select({ count: count() })
            .from(projects)
            .where(
              and(eq(projects.orgId, orgId), isNull(projects.deletedAt)),
            ),
          this.db
            .select({ count: count() })
            .from(attendance)
            .where(
              and(eq(attendance.orgId, orgId), eq(attendance.date, today)),
            ),
        ]);

        return {
          orgName: org?.name || "Organization",
          totalEmployees: Number(memberCountResult[0]?.count || 0),
          activeProjects: Number(projectCountResult[0]?.count || 0),
          presentToday: Number(attendanceCountResult[0]?.count || 0),
          orgSlug: org?.slug || orgId.slice(0, 8),
        };
      },
      CACHE_TTL.SHORT,
    );

    return {
      orgName: full.orgName,
      orgSlug: full.orgSlug,
      totalEmployees: flags.employees ? full.totalEmployees : null,
      presentToday: flags.attendance ? full.presentToday : null,
      activeProjects: flags.projects ? full.activeProjects : null,
    };
  }
}
