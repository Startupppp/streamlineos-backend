import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { organizationMembers, userModuleAccess } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import {
  ADMINISTRABLE_MODULES,
} from "../../common/rbac/module-vocabulary";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { EntitlementsService } from "./entitlements.service";
import { MANAGEABLE_MODULE_SET } from "./access-policy";

const DENIED_MODULES_TTL_MS = 15_000;

function isMissingRelationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "42P01") return true;
  if (
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("does not exist")
  )
    return true;
  if ("cause" in error) return isMissingRelationError(error.cause);
  return false;
}

@Injectable()
export class UserModuleAccessService {
  private missingTablesLogged = false;
  private readonly deniedModulesCache = new Map<
    string,
    { modules: Set<string>; expiresAt: number }
  >();

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly cache: CacheService,
  ) {}

  clearCacheForOrg(orgId: string): void {
    const prefix = `${orgId}:`;
    for (const key of this.deniedModulesCache.keys()) {
      if (key.startsWith(prefix)) this.deniedModulesCache.delete(key);
    }
  }

  private async safeRead<T>(read: () => PromiseLike<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      if (!isMissingRelationError(error)) throw error;
      if (!this.missingTablesLogged) {
        this.missingTablesLogged = true;
        logger.warn("user-module-access: tables missing, returning empty set", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return fallback;
    }
  }

  async getUserDeniedModules(orgId: string, userId: string): Promise<Set<string>> {
    const cacheKey = `${orgId}:${userId}`;
    const cached = this.deniedModulesCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.modules;

    const rows = await runInTenantTransaction(
      this.db,
      () =>
        this.safeRead(
          () =>
            this.db
              .select({ moduleKey: userModuleAccess.moduleKey })
              .from(userModuleAccess)
              .innerJoin(
                organizationMembers,
                and(
                  eq(organizationMembers.orgId, userModuleAccess.orgId),
                  eq(
                    organizationMembers.id,
                    userModuleAccess.organizationMembershipId,
                  ),
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
          [] as { moduleKey: string }[],
        ),
      { orgId },
    );

    const modules = new Set(
      rows
        .map((row) => row.moduleKey)
        .filter((moduleKey) => !this.entitlements.isCoreModule(moduleKey)),
    );
    this.deniedModulesCache.set(cacheKey, {
      modules,
      expiresAt: Date.now() + DENIED_MODULES_TTL_MS,
    });
    return modules;
  }

  async getUserModuleAccess(
    orgId: string,
    userId: string,
  ): Promise<{ moduleKey: string; enabled: boolean; core: boolean }[]> {
    const member = await runInTenantTransaction(
      this.db,
      () =>
        this.db.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, userId),
          ),
          columns: { id: true },
        }),
      { orgId },
    );
    if (!member)
      throw new NotFoundException("User is not a member of this organization");

    const denied = await this.getUserDeniedModules(orgId, userId);
    return ADMINISTRABLE_MODULES.map((moduleKey) => ({
      moduleKey,
      enabled: !denied.has(moduleKey),
      core: this.entitlements.isCoreModule(moduleKey),
    }));
  }

  async setUserModuleAccess(
    orgId: string,
    userId: string,
    moduleKey: string,
    enabled: boolean,
    updatedBy: string,
  ): Promise<{ moduleKey: string; enabled: boolean; core: boolean }[]> {
    if (!MANAGEABLE_MODULE_SET.has(moduleKey))
      throw new BadRequestException(`Unknown module "${moduleKey}"`);

    const isCoreModule = this.entitlements.isCoreModule(moduleKey);

    if (isCoreModule) {
      const member = await runInTenantTransaction(
        this.db,
        () =>
          this.db.query.organizationMembers.findFirst({
            where: and(
              eq(organizationMembers.orgId, orgId),
              eq(organizationMembers.userId, userId),
            ),
            columns: { userId: true, status: true },
          }),
        { orgId },
      );
      if (!member)
        throw new NotFoundException("User is not a member of this organization");
      if (member.status !== "ACTIVE")
        throw new BadRequestException(
          "Module access can only be changed for active members",
        );
      if (!enabled)
        throw new BadRequestException(
          `Module "${moduleKey}" is always available to organization members`,
        );
      this.clearCacheForMember(orgId, userId);
      return this.getUserModuleAccess(orgId, userId);
    }

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const member = await tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, userId),
          ),
          columns: { id: true, userId: true, status: true },
        });
        if (!member)
          throw new NotFoundException(
            "User is not a member of this organization",
          );
        if (member.status !== "ACTIVE")
          throw new BadRequestException(
            "Module access can only be changed for active members",
          );
        await tx
          .insert(userModuleAccess)
          .values({
            orgId,
            organizationMembershipId: member.id,
            moduleKey,
            enabled,
            updatedBy,
          })
          .onConflictDoUpdate({
            target: [
              userModuleAccess.orgId,
              userModuleAccess.organizationMembershipId,
              userModuleAccess.moduleKey,
            ],
            set: { enabled, updatedBy },
          });
        await bumpPermissionsVersion(tx, orgId);
      },
      { orgId },
    );

    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    return this.getUserModuleAccess(orgId, userId);
  }

  private clearCacheForMember(orgId: string, userId: string): void {
    const key = `${orgId}:${userId}`;
    this.deniedModulesCache.delete(key);
  }
}
