import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  OnModuleInit,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { moduleOwnerships, modulesCatalog, orgModules, organizationMembers, organizations, pmWorkspaces } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import { PLAN_LOCKED_MODULES } from "../billing/core/plan-entitlements.constants";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import { ADMINISTRABLE_MODULES, MODULE_CATALOG } from "../../common/rbac/module-vocabulary";
import {
  coreModuleIds,
  isCoreModuleKey,
  moduleIdFromStored,
} from "../../common/rbac/module-registry";
import { moduleAvailabilityResolver, type ModuleAvailabilityResolver } from "../../common/rbac/module-availability";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { ACCESS_MANAGED_MODULES } from "../rbac/permissions";
import { assignModuleOwnerRole } from "../ownership/module-owner-role.helper";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";

export { MODULE_CATALOG };

// Keep this export stable for existing callers while the registry owns the
// implementation. Availability and delegation are deliberately separate facts.
export { isCoreModuleKey } from "../../common/rbac/module-registry";

const OWNERSHIP_MANAGED_MODULES = new Set<string>(ACCESS_MANAGED_MODULES);

export interface ModuleStatus {
  moduleKey: string;
  enabled: boolean;
  core?: true;
}

function isMissingRelationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "42P01") return true;
  if (
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("does not exist")
  ) {
    return true;
  }
  if ("cause" in error) return isMissingRelationError(error.cause);
  return false;
}

interface ModuleMapEntry {
  map: Record<string, boolean>;
  expiresAt: number;
}

const MODULE_MAP_LOCAL_TTL_MS = 15_000;

@Injectable()
export class EntitlementsService implements OnModuleInit {
  private missingTableLogged = false;
  private moduleTableUnavailable = false;
  private readonly moduleMapCache = new Map<string, ModuleMapEntry>();
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
    @Inject(APP_CONFIG)
    private readonly config: Pick<AppConfig, "RBAC_MIGRATION_MODE">,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.db.query.modulesCatalog.findMany({
        where: eq(modulesCatalog.isCore, true),
        columns: { moduleKey: true },
        limit: 100,
      });
      const declared = new Set(coreModuleIds());
      const stored = new Set(rows.map((r) => r.moduleKey));
      const missingFromCatalog = [...declared].filter((key) => !stored.has(key));
      const extraInCatalog = [...stored].filter((key) => !declared.has(key));
      if (missingFromCatalog.length > 0 || extraInCatalog.length > 0)
        logger.warn(
          "entitlements: modules_catalog disagrees with the module registry about which modules are core",
          { missingFromCatalog, extraInCatalog },
        );
    } catch {
      logger.warn("entitlements: modules_catalog unavailable at init, using compile-time core fallback");
    }
  }

  private async safeRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      if (!isMissingRelationError(error)) throw error;
      this.moduleTableUnavailable = true;
      if (!this.missingTableLogged) {
        this.missingTableLogged = true;
        logger.warn(
          this.config.RBAC_MIGRATION_MODE === "degrade"
            ? "entitlements: org_modules table missing, migration mode permits temporary access"
            : "entitlements: org_modules table missing, denying gated module access",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return fallback;
    }
  }

  async getModuleMap(orgId: string): Promise<Record<string, boolean>> {
    const local = this.moduleMapCache.get(orgId);
    if (local && local.expiresAt > Date.now()) return local.map;

    const map = await this.cache.cachedForOrg(
      orgId,
      "entitlements:modules",
      () =>
        runInTenantTransaction(
          this.db,
          async () => {
            const rows = await this.safeRead(
              () =>
                this.db.query.orgModules.findMany({
                  where: eq(orgModules.orgId, orgId),
                  limit: 100,
                }),
              [],
            );
            const result: Record<string, boolean> = {};
            for (const row of rows)
              result[moduleIdFromStored(row.moduleKey)] = row.enabled;
            return result;
          },
          { orgId },
        ),
      30,
    );
    this.moduleMapCache.set(orgId, {
      map,
      expiresAt: Date.now() + MODULE_MAP_LOCAL_TTL_MS,
    });
    return map;
  }

  async isModuleEnabled(orgId: string, rawModuleKey: string): Promise<boolean> {
    const moduleKey = moduleIdFromStored(rawModuleKey);
    if (isCoreModuleKey(moduleKey)) return true;
    const map = await this.getModuleMap(orgId);
    const enabled = map[moduleKey];
    if (enabled === undefined) {
      return (
        this.moduleTableUnavailable &&
        this.config.RBAC_MIGRATION_MODE === "degrade"
      );
    }
    return enabled;
  }

  /** Absent stays `undefined` so availability can tell "no row" from "disabled" and reach the plan check. */
  async getModuleState(
    orgId: string,
    rawModuleKey: string,
  ): Promise<boolean | undefined> {
    const moduleKey = moduleIdFromStored(rawModuleKey);
    if (isCoreModuleKey(moduleKey)) return true;
    const map = await this.getModuleMap(orgId);
    const enabled = map[moduleKey];
    if (enabled === undefined)
      return this.moduleTableUnavailable &&
        this.config.RBAC_MIGRATION_MODE === "degrade"
        ? true
        : undefined;
    return enabled;
  }

  isCoreModule(moduleKey: string): boolean {
    return isCoreModuleKey(moduleKey);
  }

  async getPlanLockedModules(orgId: string): Promise<readonly string[]> {
    const { tier } = await this.planLimits.resolveTier(orgId);
    return PLAN_LOCKED_MODULES[tier];
  }

  buildModuleAvailabilityResolver(
    getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
    getUserDeniedModules?: (orgId: string, userId: string) => Promise<Set<string>>,
  ): ModuleAvailabilityResolver {
    return moduleAvailabilityResolver(
      {
        isCoreModule: (moduleKey) => this.isCoreModule(moduleKey),
        getModuleMap,
        getPlanLockedModules: (orgId) => this.getPlanLockedModules(orgId),
      },
      getUserDeniedModules ? { getUserDeniedModules } : undefined,
    );
  }

  async setModuleEnabled(
    orgId: string,
    moduleKey: string,
    enabled: boolean,
    enabledBy: string,
  ): Promise<void> {
    if (this.isCoreModule(moduleKey)) {
      throw new BadRequestException(
        `Module "${moduleKey}" is always-on and cannot be toggled`,
      );
    }
    if (enabled) {
      const { tier } = await this.planLimits.resolveTier(orgId);
      if (PLAN_LOCKED_MODULES[tier].includes(moduleKey)) {
        const label = moduleKey.charAt(0).toUpperCase() + moduleKey.slice(1);
        throw new ForbiddenException(
          `The ${label} module requires a paid plan. Upgrade to enable it.`,
        );
      }
    }
    const affectedMembers = await runInTenantTransaction(this.db, async (tx) => {
      await tx
        .insert(orgModules)
        .values({ orgId, moduleKey, enabled, enabledBy })
        .onConflictDoUpdate({
          target: [orgModules.orgId, orgModules.moduleKey],
          set: { enabled, enabledBy },
        });

      if (moduleKey === "build" && enabled) {
        const [existing] = await tx
          .select({ id: pmWorkspaces.pmWorkspaceId })
          .from(pmWorkspaces)
          .where(
            and(
              eq(pmWorkspaces.orgId, orgId),
              eq(pmWorkspaces.isDefault, true),
              isNull(pmWorkspaces.deletedAt),
            ),
          )
          .limit(1);
        if (!existing) {
          await tx
            .insert(pmWorkspaces)
            .values({
              orgId,
              name: "Default Workspace",
              slug: "default",
              isDefault: true,
              status: "active",
            })
            .onConflictDoNothing();
        }
      }

      if (enabled && OWNERSHIP_MANAGED_MODULES.has(moduleKey)) {
        const [orgRow] = await tx
          .select({ ownerMembershipId: organizations.ownerMembershipId })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1);

        const ownerMembershipId = orgRow?.ownerMembershipId;
        if (ownerMembershipId !== null && ownerMembershipId !== undefined) {
          await tx
            .insert(moduleOwnerships)
            .values({ orgId, moduleKey, ownerMembershipId })
            .onConflictDoNothing();

          await assignModuleOwnerRole(tx, orgId, moduleKey, ownerMembershipId);
        }
      }

      await bumpPermissionsVersion(tx, orgId);

      return tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, "ACTIVE")))
        .limit(10000);
    }, { orgId });

    this.moduleMapCache.delete(orgId);
    await this.cache.invalidateForOrg(orgId, `entitlements:module:${moduleKey}`);
    await this.cache.invalidateForOrg(orgId, "entitlements:modules");
    await Promise.all(
      affectedMembers.map((m) => this.cache.invalidate(CACHE_KEYS.userSession(m.userId))),
    );
  }

  /**
   * Effective on/off state of every toggleable catalog module for an org.
   *
   * Deny-by-default: a module with no `org_modules` row is NOT enabled, so an
   * org runs exactly what it turned on during setup or in Settings → Modules.
   * This mirrors `isModuleEnabled` (the guard) so the modules a user is shown
   * and the modules the API actually serves can never disagree.
   */
  async getEffectiveModuleMap(orgId: string): Promise<Record<string, boolean>> {
    const map = await this.getModuleMap(orgId);
    const effective: Record<string, boolean> = {};
    for (const moduleKey of ADMINISTRABLE_MODULES) {
      effective[moduleKey] = this.isCoreModule(moduleKey)
        ? true
        : (map[moduleKey] ??
          (this.moduleTableUnavailable &&
            this.config.RBAC_MIGRATION_MODE === "degrade"));
    }
    return effective;
  }

  async listModules(orgId: string): Promise<ModuleStatus[]> {
    const effective = await this.getEffectiveModuleMap(orgId);
    return ADMINISTRABLE_MODULES.map((moduleKey): ModuleStatus =>
      this.isCoreModule(moduleKey)
        ? { moduleKey, enabled: true, core: true }
        : { moduleKey, enabled: effective[moduleKey] ?? false },
    );
  }
}
