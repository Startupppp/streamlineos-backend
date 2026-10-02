import { and, eq } from "drizzle-orm";
import { organizationMembers, userModuleAccess } from "../../db/schema";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { Db } from "../../db/drizzle.module";
import type { ReadAccessTable } from "./access-permission.resolver";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";

const DENIED_MODULES_CACHE_TTL_MS = 15_000;

export class DeniedModulesResolver {
  private readonly cache = new Map<string, { modules: Set<string>; expiresAt: number }>();

  constructor(
    private readonly getDb: () => Db,
    private readonly readTable: ReadAccessTable,
    private readonly getVersion: (orgId: string) => Promise<number>,
    private readonly isCoreModule: (moduleKey: string) => boolean,
  ) {}

  getCached(orgId: string, userId: string, version: number): Set<string> | null {
    const key = `${orgId}:${userId}:${version}`;
    const entry = this.cache.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.modules;
  }

  async resolve(orgId: string, userId: string): Promise<Set<string>> {
    const version = await this.getVersion(orgId);
    const cacheKey = `${orgId}:${userId}:${version}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.modules;
    const db = this.getDb();
    const rows = await runInTenantTransaction(
      db,
      () =>
        this.readTable(
          () =>
            db
              .select({
                moduleKey: userModuleAccess.moduleKey,
                role: organizationMembers.role,
                isOwner: organizationMembers.isOwner,
              })
              .from(userModuleAccess)
              .innerJoin(
                organizationMembers,
                and(
                  eq(organizationMembers.orgId, userModuleAccess.orgId),
                  eq(organizationMembers.id, userModuleAccess.organizationMembershipId),
                ),
              )
              .where(
                and(
                  eq(userModuleAccess.orgId, orgId),
                  eq(organizationMembers.userId, userId),
                  eq(userModuleAccess.enabled, false),
                ),
              )
              .limit(100),
        ),
      { orgId },
    );
    const modules = new Set(
      rows
        .filter((row) => !row.isOwner && row.role !== ORG_MEMBER_ROLES.ORG_ADMIN)
        .map((row) => row.moduleKey)
        .filter((moduleKey) => !this.isCoreModule(moduleKey)),
    );
    this.cache.set(cacheKey, { modules, expiresAt: Date.now() + DENIED_MODULES_CACHE_TTL_MS });
    return modules;
  }

  clearForOrg(orgId: string): void {
    const prefix = `${orgId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }
}
