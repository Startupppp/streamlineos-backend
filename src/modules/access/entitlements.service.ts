import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { organizations, orgModules } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";

const MODULE_CATALOG = [
  "hr",
  "crm",
  "projects",
  "accounting",
  "inventory",
  "kb",
  "blog",
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
  return "message" in error && typeof error.message === "string" && error.message.includes("does not exist");
}

@Injectable()
export class EntitlementsService {
  private missingTableLogged = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private async safeRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      if (!isMissingRelationError(error)) throw error;
      if (!this.missingTableLogged) {
        this.missingTableLogged = true;
        logger.warn("entitlements: org_modules table missing, defaulting to allow", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return fallback;
    }
  }

  async isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean> {
    const key = `entitlements:module:${orgId}:${moduleKey}`;
    return this.cache.cached(key, async () => {
      const row = await this.safeRead(
        () =>
          this.db.query.orgModules.findFirst({
            where: and(eq(orgModules.orgId, orgId), eq(orgModules.moduleKey, moduleKey)),
          }),
        undefined,
      );
      if (row === undefined) return true;
      return row?.enabled ?? true;
    }, 30);
  }

  async setModuleEnabled(
    orgId: string,
    moduleKey: string,
    enabled: boolean,
    enabledBy: string,
  ): Promise<void> {
    if (CORE_MODULE_KEYS.has(moduleKey)) {
      throw new BadRequestException(`Module "${moduleKey}" is always-on and cannot be toggled`);
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
    });

    await this.cache.invalidate(`entitlements:module:${orgId}:${moduleKey}`);
    await this.cache.invalidate(`entitlements:modules:${orgId}`);
    await this.cache.invalidate(CACHE_KEYS.userSession(enabledBy));
  }

  async listModules(orgId: string): Promise<ModuleStatus[]> {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { enabledModules: true },
    });
    const orgArray = org?.enabledModules ?? null;
    return MODULE_CATALOG.map((moduleKey): ModuleStatus => {
      const orgName = MODULE_KEY_TO_ORG_MODULE[moduleKey];
      if (!orgName) {
        return { moduleKey, enabled: true, core: true };
      }
      if (orgArray === null) {
        return { moduleKey, enabled: true };
      }
      return { moduleKey, enabled: orgArray.includes(orgName) };
    });
  }
}
