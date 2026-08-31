import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
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
import { resolveDashboardStatsFlags } from "./dashboard-scope";
import { buildOrgDashboardCacheKey } from "./dashboard-cache-key";

@Injectable()
export class DashboardStatsService {
  private readonly logger = new Logger(DashboardStatsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async getDashboardStats(orgId: string, u: CurrentUserContext) {
    const flags = await resolveDashboardStatsFlags(this.access, u);

    const settle = async <T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await run();
      } catch (error: unknown) {
        this.logger.error(
          `Stats section "${name}" failed for org ${orgId}`,
          error instanceof Error ? error.stack : String(error),
        );
        return fallback;
      }
    };

    const orgKey = await buildOrgDashboardCacheKey(this.access, orgId, "stats-org");
    const orgData = await settle(
      "org",
      () =>
        this.cache.cachedForOrg(
          orgId,
          orgKey,
          async () => {
            const org = await this.db.query.organizations.findFirst({
              where: eq(organizations.id, orgId),
              columns: { name: true, slug: true, timezone: true },
            });
            return {
              orgName: org?.name ?? "Organization",
              orgSlug: org?.slug ?? orgId.slice(0, 8),
              orgTz: org?.timezone ?? "UTC",
            };
          },
          CACHE_TTL.SHORT,
        ),
      { orgName: "Organization", orgSlug: orgId.slice(0, 8), orgTz: "UTC" },
    );

    const orgTz = orgData?.orgTz ?? "UTC";
    const localDate = formatInTimeZone(new Date(), orgTz, "yyyy-MM-dd");

    const [employeesKey, projectsKey, attendanceKey] = await Promise.all([
      buildOrgDashboardCacheKey(this.access, orgId, "stats-employees"),
      buildOrgDashboardCacheKey(this.access, orgId, "stats-projects"),
      buildOrgDashboardCacheKey(this.access, orgId, "stats-attendance", `${orgTz}:${localDate}`),
    ]);

    const [totalEmployees, activeProjects, presentToday] = await Promise.all([
      flags.employees
        ? settle(
            "employees",
            () =>
              this.cache.cachedForOrg(
                orgId,
                employeesKey,
                async () => {
                  const [r] = await this.db
                    .select({ cnt: count() })
                    .from(organizationMembers)
                    .where(
                      and(
                        eq(organizationMembers.orgId, orgId),
                        eq(organizationMembers.status, "ACTIVE"),
                      ),
                    );
                  return Number(r?.cnt ?? 0);
                },
                CACHE_TTL.SHORT,
              ),
            null,
          )
        : Promise.resolve(null),
      flags.projects
        ? settle(
            "projects",
            () =>
              this.cache.cachedForOrg(
                orgId,
                projectsKey,
                async () => {
                  const [r] = await this.db
                    .select({ cnt: count() })
                    .from(projects)
                    .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)));
                  return Number(r?.cnt ?? 0);
                },
                CACHE_TTL.SHORT,
              ),
            null,
          )
        : Promise.resolve(null),
      flags.attendance
        ? settle(
            "attendance",
            () =>
              this.cache.cachedForOrg(
                orgId,
                attendanceKey,
                async () => {
                  const [r] = await this.db
                    .select({ cnt: count() })
                    .from(attendance)
                    .where(and(eq(attendance.orgId, orgId), eq(attendance.date, localDate)));
                  return Number(r?.cnt ?? 0);
                },
                CACHE_TTL.SHORT,
              ),
            null,
          )
        : Promise.resolve(null),
    ]);

    return {
      orgName: orgData.orgName,
      orgSlug: orgData.orgSlug,
      totalEmployees,
      activeProjects,
      presentToday,
    };
  }
}
