import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  OnModuleInit,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { moduleOwnerships, modulesCatalog, orgModules, organizations, pmWorkspaces } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { PLAN_LOCKED_MODULES } from "../billing/plan-entitlements.constants";
import { PlanLimitsService } from "../billing/plan-limits.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import { MODULE_CATALOG } from "../../common/rbac/module-vocabulary";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { ACCESS_MANAGED_MODULES } from "../rbac/permissions";
import { assignModuleOwnerRole } from "../ownership/module-owner-role.helper";

export { MODULE_CATALOG };

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

const FALLBACK_CORE_MODULE_KEYS: ReadonlySet<string> = new Set<string>(["kb", "chat"]);

@Injectable()
export class EntitlementsService implements OnModuleInit {
  private missingTableLogged = false;
  private moduleTableUnavailable = false;
  private readonly moduleMapCache = new Map<string, ModuleMapEntry>();
  private coreModuleKeys: ReadonlySet<string> = FALLBACK_CORE_MODULE_KEYS;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.db.query.modulesCatalog.findMany({
        where: eq(modulesCatalog.isCore, true),
        columns: { moduleKey: true },
      });
      this.coreModuleKeys = new Set(rows.map((r) => r.moduleKey));
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
          "entitlements: org_modules table missing, defaulting to allow",
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

    const key = `entitlements:modules:${orgId}`;
    const map = await this.cache.cached(
      key,
      async () => {
        const rows = await this.safeRead(
          () =>
            this.db.query.orgModules.findMany({
              where: eq(orgModules.orgId, orgId),
            }),
          [],
        );
        const result: Record<string, boolean> = {};
        for (const row of rows) result[row.moduleKey] = row.enabled;
        return result;
      },
      30,
    );
    this.moduleMapCache.set(orgId, {
      map,
      expiresAt: Date.now() + MODULE_MAP_LOCAL_TTL_MS,
    });
    return map;
  }

  async isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean> {
    if (this.coreModuleKeys.has(moduleKey)) return true;
    const map = await this.getModuleMap(orgId);
    const enabled = map[moduleKey];
    if (enabled === undefined) return this.moduleTableUnavailable;
    return enabled;
  }

  async setModuleEnabled(
    orgId: string,
    moduleKey: string,
    enabled: boolean,
    enabledBy: string,
  ): Promise<void> {
    if (this.coreModuleKeys.has(moduleKey)) {
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
    await this.db.transaction(async (tx) => {
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
    });

    this.moduleMapCache.delete(orgId);
    await this.cache.invalidate(`entitlements:module:${orgId}:${moduleKey}`);
    await this.cache.invalidate(`entitlements:modules:${orgId}`);
    await this.cache.invalidate(CACHE_KEYS.userSession(enabledBy));
  }

  async listModules(orgId: string): Promise<ModuleStatus[]> {
    const map = await this.getModuleMap(orgId);
    const hasConfig = Object.keys(map).length > 0;
    return MODULE_CATALOG.map((moduleKey): ModuleStatus => {
      if (this.coreModuleKeys.has(moduleKey))
        return { moduleKey, enabled: true, core: true };

      if (!hasConfig) return { moduleKey, enabled: true };

      return { moduleKey, enabled: map[moduleKey] ?? true };
    });
  }
}
