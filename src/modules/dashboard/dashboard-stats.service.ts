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
import { buildOrgSectionCacheKey } from "./dashboard-cache-key";
import { settleSection } from "./dashboard-section-settle";

@Injectable()
export class DashboardStatsService {
  private readonly logger = new Logger(DashboardStatsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async getDashboardStats(orgId: string, u: CurrentUserContext) {
    const settle = <T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> =>
      settleSection({ name, run, fallback, logger: this.logger, context: `org ${orgId}` });

    const flagsPromise = resolveDashboardStatsFlags(this.access, u);
    const employeesKeyPromise = buildOrgSectionCacheKey(this.access, orgId, "stats-employees");
    const projectsKeyPromise = buildOrgSectionCacheKey(this.access, orgId, "stats-projects");

    const orgDataPromise = settle(
      "org",
      async () => {
        const orgKey = await buildOrgSectionCacheKey(this.access, orgId, "stats", "org");
        return this.cache.cachedForOrg(
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
        );
      },
      { orgName: "Organization", orgSlug: orgId.slice(0, 8), orgTz: "UTC" },
    );

    /**
     * The gate is deadline-protected too, and it FAILS CLOSED.
     *
     * `await flagsPromise` was bare. It does real database work —
     * `access.scopeFor` -> `resolveUserPermissions` -> `getPermissionsVersion`
     * -> cache -> Postgres — and it gates all three counts, so when the
     * permissions cache stampedes on a version bump or Redis times out into a
     * slow database the handler parked here with no ceiling, and the response
     * hung even though the org section (started above, and deadline-protected
     * since PRD-C144) had already answered. The ceiling was applied one layer
     * below the thing that actually blocks.
     *
     * `flagsPromise` is still started before the org section, so racing it
     * against the deadline here costs no concurrency; it only bounds the wait.
     * The fallback denies — an unresolvable permission gate must never read as
     * "granted" — so a degraded gate yields null counts rather than another
     * tenant's numbers.
     */
    const flags = await settle(
      "moduleFlags",
      () => flagsPromise,
      { employees: false, attendance: false, projects: false },
    );

    const [orgData, totalEmployees, activeProjects, presentToday] = await Promise.all([
      orgDataPromise,
      flags.employees
        ? settle(
            "employees",
            async () =>
              this.cache.cachedForOrg(
                orgId,
                await employeesKeyPromise,
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
            async () =>
              this.cache.cachedForOrg(
                orgId,
                await projectsKeyPromise,
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
            async () => {
              const orgTz = (await orgDataPromise).orgTz;
              const localDate = formatInTimeZone(new Date(), orgTz, "yyyy-MM-dd");
              const attendanceKey = await buildOrgSectionCacheKey(
                this.access,
                orgId,
                "stats-attendance",
                `${orgTz}:${localDate}`,
              );
              return this.cache.cachedForOrg(
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
              );
            },
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
