import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { orgModules, pmWorkspaces } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { PLAN_LOCKED_MODULES } from "../billing/plan-entitlements.constants";
import { PlanLimitsService } from "../billing/plan-limits.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";

export const MODULE_CATALOG = [
  "hr",
  "crm",
  "projects",
  "accounting",
  "inventory",
  "kb",
  "support",
  "surveys",
  "payroll",
  "sign",
] as const;

const MODULE_KEY_TO_ORG_MODULE: Readonly<Record<string, string>> = {
  hr: "HR",
  crm: "CRM",
  projects: "PROJECTS",
  inventory: "INVENTORY",
  accounting: "FINANCE",
  support: "HELPDESK",
  surveys: "SURVEYS",
  payroll: "PAYROLL",
  sign: "SIGN",
};

const CORE_MODULE_KEYS: ReadonlySet<string> = new Set(
  MODULE_CATALOG.filter((k) => !MODULE_KEY_TO_ORG_MODULE[k]),
);

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
export class EntitlementsService {
  private missingTableLogged = false;
  private readonly moduleMapCache = new Map<string, ModuleMapEntry>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  private async safeRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      if (!isMissingRelationError(error)) throw error;
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
    const map = await this.getModuleMap(orgId);
    if (!(moduleKey in map)) return true;
    return map[moduleKey] ?? true;
  }

  async setModuleEnabled(
    orgId: string,
    moduleKey: string,
    enabled: boolean,
    enabledBy: string,
  ): Promise<void> {
    if (CORE_MODULE_KEYS.has(moduleKey)) {
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
    const orgModuleName = MODULE_KEY_TO_ORG_MODULE[moduleKey];

    await this.db.transaction(async (tx) => {
      await tx
        .insert(orgModules)
        .values({ orgId, moduleKey, enabled, enabledBy })
        .onConflictDoUpdate({
          target: [orgModules.orgId, orgModules.moduleKey],
          set: { enabled, enabledBy },
        });

      if (orgModuleName) {
        if (enabled) {
          await tx.execute(
            sql`UPDATE organizations SET enabled_modules = array_append(COALESCE(enabled_modules, '{}'), ${orgModuleName}) WHERE id = ${orgId} AND NOT (${orgModuleName} = ANY(COALESCE(enabled_modules, '{}')))`,
          );
        } else {
          await tx.execute(
            sql`UPDATE organizations SET enabled_modules = array_remove(COALESCE(enabled_modules, '{}'), ${orgModuleName}) WHERE id = ${orgId}`,
          );
        }
      }

      if (moduleKey === "projects" && enabled) {
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
      if (CORE_MODULE_KEYS.has(moduleKey))
        return { moduleKey, enabled: true, core: true };

      if (!hasConfig) return { moduleKey, enabled: true };

      return { moduleKey, enabled: map[moduleKey] ?? true };
    });
  }
}
